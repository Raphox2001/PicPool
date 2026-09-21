import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { getConfig } from '../config.js';
import { getDb, nowIso } from '../db/index.js';
import { pseudonymizeIp } from '../lib/crypto.js';
import {
  adminCount,
  createAdmin,
  verifyLogin,
  verifyTotp,
  beginTotpSetup,
  enableTotp,
  disableTotp,
  createSession,
  resolveSession,
  destroySession,
  checkCsrf,
  changePassword,
  getAdminById,
  checkPasswordStrength,
  type AdminUser,
} from '../services/auth.js';

/**
 * Anmeldung und Kontoverwaltung des Adminbereichs.
 *
 * Das Panel ist oeffentlich erreichbar, daher gilt hier durchgehend: keine
 * Auskunft nach aussen, die einem Angreifer weiterhilft. Ob ein Benutzername
 * existiert, ob ein Konto gesperrt ist oder ob das Passwort stimmte und nur
 * der zweite Faktor fehlte - all das bleibt in der Antwort ununterscheidbar,
 * soweit es der Ablauf zulaesst.
 */

const SESSION_COOKIE = 'picpool_session';
const PENDING_TTL_MS = 5 * 60_000;

declare module 'fastify' {
  interface FastifyRequest {
    adminUser?: AdminUser;
    adminCsrf?: string;
  }
}

export function sessionCookieOptions(req: FastifyRequest) {
  // Secure nur setzen, wenn die Verbindung tatsaechlich verschluesselt ist.
  // Sonst funktioniert der interne Zugriff ueber http://<nas-ip> nicht mehr,
  // weil der Browser das Cookie verwerfen wuerde.
  const secure = req.protocol === 'https';
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure,
    maxAge: 14 * 86400,
  };
}

/**
 * Zwischenschritt bei aktivem zweitem Faktor.
 *
 * Statt den halb angemeldeten Zustand serverseitig zu speichern, wird ein
 * kurzlebiger, signierter Wert ausgegeben. Er belegt nur, dass das Passwort
 * stimmte, gilt fuenf Minuten und ist an den Benutzer gebunden.
 */
function makePendingToken(userId: string): string {
  const expires = Date.now() + PENDING_TTL_MS;
  const payload = `${userId}.${expires}`;
  const sig = crypto
    .createHmac('sha256', getConfig().secretKey)
    .update(`pending:${payload}`)
    .digest('base64url');
  return `${payload}.${sig}`;
}

function readPendingToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [userId, expiresRaw, sig] = parts as [string, string, string];
  const expected = crypto
    .createHmac('sha256', getConfig().secretKey)
    .update(`pending:${userId}.${expiresRaw}`)
    .digest('base64url');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(expiresRaw) < Date.now()) return null;

  return userId;
}

function audit(
  req: FastifyRequest,
  action: string,
  detail?: unknown,
  actor?: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO audit_log (at, actor, action, target_type, target_id, ip, detail)
       VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(
      nowIso(),
      actor ?? req.adminUser?.username ?? 'unbekannt',
      action,
      pseudonymizeIp(req.ip),
      detail ? JSON.stringify(detail).slice(0, 2000) : null,
    );
}

// ---------------------------------------------------------------------------
// Absicherung fuer alle Adminrouten
// ---------------------------------------------------------------------------

/**
 * Prueft Sitzung und - bei veraendernden Anfragen - das CSRF-Token.
 *
 * SameSite=Lax verhindert bereits das meiste; das zusaetzliche Token deckt
 * die Faelle ab, die Lax offenlaesst, und kostet fast nichts.
 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  const session = resolveSession(token);

  if (!session) {
    await reply.code(401).send({ ok: false, message: 'Nicht angemeldet.' });
    return;
  }

  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (mutating) {
    const presented = req.headers['x-picpool-csrf'];
    if (typeof presented !== 'string' || !checkCsrf(token, presented)) {
      await reply.code(403).send({ ok: false, message: 'Sicherheitsmerkmal fehlt oder passt nicht.' });
      return;
    }
  }

  req.adminUser = session.user;
  req.adminCsrf = session.csrfToken;
}

// ---------------------------------------------------------------------------

export function registerAdminAuthRoutes(app: FastifyInstance): void {
  const cfg = getConfig();
  const loginLimit = { rateLimit: { max: cfg.limits.loginRatePerIpPerMin, timeWindow: '1 minute' } };

  /** Zustand fuer die Anmeldemaske: gibt es ueberhaupt schon ein Konto? */
  app.get('/api/admin/state', async (req) => {
    const session = resolveSession(req.cookies[SESSION_COOKIE]);
    return {
      ok: true,
      setupNeeded: adminCount() === 0,
      loggedIn: Boolean(session),
      user: session
        ? {
            username: session.user.username,
            totpEnabled: session.user.totp_enabled === 1,
            lastLoginAt: session.user.last_login_at,
          }
        : null,
      csrfToken: session?.csrfToken ?? null,
    };
  });

  /**
   * Ersteinrichtung.
   *
   * Nur moeglich, solange kein Konto existiert. Danach ist der Endpunkt tot -
   * sonst koennte sich jemand ein zweites Konto anlegen und waere drin.
   */
  app.post<{ Body: { username?: string; password?: string } }>(
    '/api/admin/setup',
    { config: loginLimit },
    async (req, reply) => {
      if (adminCount() > 0) {
        return reply.code(409).send({ ok: false, message: 'Es ist bereits ein Konto eingerichtet.' });
      }

      const { username = '', password = '' } = req.body ?? {};
      try {
        const user = await createAdmin(username, password);
        const { token, csrfToken } = createSession(user.id, {
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        audit(req, 'admin_setup', { username: user.username }, user.username);

        return reply
          .setCookie(SESSION_COOKIE, token, sessionCookieOptions(req))
          .send({ ok: true, csrfToken, user: { username: user.username, totpEnabled: false } });
      } catch (err) {
        return reply
          .code(400)
          .send({ ok: false, message: err instanceof Error ? err.message : 'Anlegen fehlgeschlagen.' });
      }
    },
  );

  app.post<{ Body: { username?: string; password?: string } }>(
    '/api/admin/login',
    { config: loginLimit },
    async (req, reply) => {
      const { username = '', password = '' } = req.body ?? {};

      if (!username || !password) {
        return reply.code(400).send({ ok: false, message: 'Benutzername und Passwort angeben.' });
      }

      const result = await verifyLogin(username, password);

      if (result.status === 'locked') {
        const seconds = Math.max(1, Math.ceil((new Date(result.until).getTime() - Date.now()) / 1000));
        app.log.warn({ username, ip: pseudonymizeIp(req.ip) }, 'Anmeldung waehrend Sperre');
        audit(req, 'login_locked', { username }, username);
        return reply.code(429).send({
          ok: false,
          message: `Zu viele Fehlversuche. Bitte in ${seconds} Sekunden erneut versuchen.`,
        });
      }

      if (result.status === 'invalid') {
        app.log.warn({ ip: pseudonymizeIp(req.ip) }, 'Anmeldung fehlgeschlagen');
        audit(req, 'login_failed', { username }, username);
        return reply.code(401).send({ ok: false, message: 'Benutzername oder Passwort stimmt nicht.' });
      }

      if (result.status === 'totp_required') {
        return reply.send({
          ok: true,
          totpRequired: true,
          pendingToken: makePendingToken(result.user.id),
        });
      }

      const { token, csrfToken } = createSession(result.user.id, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      audit(req, 'login_ok', undefined, result.user.username);

      return reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(req)).send({
        ok: true,
        csrfToken,
        user: { username: result.user.username, totpEnabled: result.user.totp_enabled === 1 },
      });
    },
  );

  app.post<{ Body: { pendingToken?: string; code?: string } }>(
    '/api/admin/login/totp',
    { config: loginLimit },
    async (req, reply) => {
      const { pendingToken = '', code = '' } = req.body ?? {};

      const userId = readPendingToken(pendingToken);
      if (!userId) {
        return reply
          .code(401)
          .send({ ok: false, message: 'Die Anmeldung ist abgelaufen. Bitte neu beginnen.' });
      }

      const user = getAdminById(userId);
      if (!user || !verifyTotp(user, code)) {
        app.log.warn({ ip: pseudonymizeIp(req.ip) }, 'Zweiter Faktor falsch');
        audit(req, 'totp_failed', undefined, user?.username);
        return reply.code(401).send({ ok: false, message: 'Der Code stimmt nicht.' });
      }

      const { token, csrfToken } = createSession(user.id, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      audit(req, 'login_ok_totp', undefined, user.username);

      return reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(req)).send({
        ok: true,
        csrfToken,
        user: { username: user.username, totpEnabled: true },
      });
    },
  );

  app.post('/api/admin/logout', { preHandler: requireAdmin }, async (req, reply) => {
    audit(req, 'logout');
    destroySession(req.cookies[SESSION_COOKIE]);
    return reply
      .clearCookie(SESSION_COOKIE, { path: '/' })
      .send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Kontoeinstellungen
  // -------------------------------------------------------------------------

  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    '/api/admin/password',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const user = req.adminUser!;
      const { currentPassword = '', newPassword = '' } = req.body ?? {};

      // Das alte Passwort wird erneut geprueft: ein uebernommenes Browserfenster
      // soll nicht genuegen, um das Konto zu uebernehmen.
      const check = await verifyLogin(user.username, currentPassword);
      if (check.status !== 'ok' && check.status !== 'totp_required') {
        return reply.code(401).send({ ok: false, message: 'Das aktuelle Passwort stimmt nicht.' });
      }

      const strength = checkPasswordStrength(newPassword);
      if (!strength.ok) {
        return reply.code(400).send({ ok: false, message: strength.problems.join(' ') });
      }

      await changePassword(user.id, newPassword);
      audit(req, 'password_changed');

      // changePassword beendet alle Sitzungen, auch die eigene.
      return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({
        ok: true,
        message: 'Passwort geändert. Bitte neu anmelden.',
      });
    },
  );

  /** Startet die Einrichtung des zweiten Faktors und liefert den QR-Code. */
  app.post('/api/admin/totp/setup', { preHandler: requireAdmin }, async (req, reply) => {
    const user = req.adminUser!;
    if (user.totp_enabled) {
      return reply.code(409).send({ ok: false, message: 'Der zweite Faktor ist bereits aktiv.' });
    }

    const { secret, uri } = beginTotpSetup(user);
    const qrDataUrl = await QRCode.toDataURL(uri, { width: 320, margin: 2 });

    return { ok: true, secret, uri, qrDataUrl };
  });

  app.post<{ Body: { code?: string } }>(
    '/api/admin/totp/enable',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const user = getAdminById(req.adminUser!.id)!;

      if (!verifyTotp(user, req.body?.code ?? '')) {
        return reply.code(400).send({ ok: false, message: 'Der Code stimmt nicht. Noch einmal versuchen.' });
      }

      enableTotp(user.id);
      audit(req, 'totp_enabled');
      return { ok: true };
    },
  );

  app.post<{ Body: { password?: string } }>(
    '/api/admin/totp/disable',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const user = req.adminUser!;

      // Abschalten des zweiten Faktors ist eine Schwaechung - dafuer wird das
      // Passwort verlangt.
      const check = await verifyLogin(user.username, req.body?.password ?? '');
      if (check.status !== 'ok' && check.status !== 'totp_required') {
        return reply.code(401).send({ ok: false, message: 'Das Passwort stimmt nicht.' });
      }

      disableTotp(user.id);
      audit(req, 'totp_disabled');
      app.log.warn({ user: user.username }, 'Zweiter Faktor abgeschaltet');
      return { ok: true };
    },
  );
}
