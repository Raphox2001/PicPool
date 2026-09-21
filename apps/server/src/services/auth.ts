import { hash as argonHash, verify as argonVerify, Algorithm } from '@node-rs/argon2';
import { TOTP, Secret } from 'otpauth';
import crypto from 'node:crypto';
import { getDb, nowIso } from '../db/index.js';
import {
  randomId,
  hashToken,
  generateToken,
  encryptAtRest,
  decryptAtRest,
  safeEqual,
} from '../lib/crypto.js';

/**
 * Anmeldung am Adminbereich.
 *
 * Das Panel ist auf ausdruecklichen Wunsch oeffentlich erreichbar. Damit ist
 * die Anmeldemaske dauerhaft dem Internet ausgesetzt, und alles hier ist
 * entsprechend ausgelegt:
 *
 *  - argon2id statt eines schnellen Hashverfahrens
 *  - Sperre nach Fehlversuchen, gestaffelt und pro Konto
 *  - Sitzungstoken werden nur gehasht abgelegt, wie die Share-Tokens auch
 *  - TOTP als zweiter Faktor, dringend empfohlen
 *  - gleiche Antwort bei falschem Benutzernamen und falschem Passwort
 */

/**
 * Argon2id-Parameter.
 *
 * 64 MB Speicher und drei Durchlaeufe sind ein guter Mittelweg: deutlich
 * ueber den Empfehlungen fuer Mindestsicherheit, aber auf dem Ryzen der NAS
 * noch in unter einer Sekunde zu berechnen. Die Anmeldung ist ein seltener
 * Vorgang, hier darf es ruhig etwas kosten.
 */
const ARGON = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

/**
 * Gestaffelte Sperre.
 *
 * Kein sofortiges Aussperren: Wer sich schlicht vertippt, soll nicht
 * ausgesperrt sein. Ab dem fuenften Fehlversuch wird es unangenehm, ab dem
 * zehnten praktisch aussichtslos.
 */
function lockoutMs(failedAttempts: number): number {
  if (failedAttempts < 5) return 0;
  if (failedAttempts < 8) return 30_000;
  if (failedAttempts < 10) return 5 * 60_000;
  return 30 * 60_000;
}

const SESSION_DAYS = 14;

export interface AdminUser {
  id: string;
  username: string;
  password_hash: string;
  totp_secret_enc: string | null;
  totp_enabled: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  failed_attempts: number;
  locked_until: string | null;
}

// ---------------------------------------------------------------------------
// Benutzer
// ---------------------------------------------------------------------------

export function adminCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM admin_users').get() as { n: number }).n;
}

export function getAdminByName(username: string): AdminUser | null {
  return (
    (getDb()
      .prepare('SELECT * FROM admin_users WHERE username = ?')
      .get(username.trim().toLowerCase()) as AdminUser | undefined) ?? null
  );
}

export function getAdminById(id: string): AdminUser | null {
  return (
    (getDb().prepare('SELECT * FROM admin_users WHERE id = ?').get(id) as AdminUser | undefined) ??
    null
  );
}

export interface PasswordCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Mindestanforderungen an das Passwort.
 *
 * Bewusst nur Laenge statt Zeichenklassen-Vorschriften: Laenge traegt mehr
 * zur Sicherheit bei, und erzwungene Sonderzeichen fuehren erfahrungsgemaess
 * zu "Passwort1!" statt zu besseren Passwoertern.
 */
export function checkPasswordStrength(password: string): PasswordCheck {
  const problems: string[] = [];
  if (password.length < 12) problems.push('Mindestens 12 Zeichen.');
  if (/^\d+$/.test(password)) problems.push('Nicht nur Ziffern.');
  if (/^(.)\1*$/.test(password)) problems.push('Nicht immer dasselbe Zeichen.');
  return { ok: problems.length === 0, problems };
}

export async function createAdmin(username: string, password: string): Promise<AdminUser> {
  const name = username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(name)) {
    throw new Error('Benutzername: 3 bis 32 Zeichen, nur a-z, 0-9, Punkt, Bindestrich, Unterstrich.');
  }

  const strength = checkPasswordStrength(password);
  if (!strength.ok) throw new Error(strength.problems.join(' '));
  if (getAdminByName(name)) throw new Error('Diesen Benutzernamen gibt es bereits.');

  const id = randomId();
  const now = nowIso();

  getDb()
    .prepare(
      `INSERT INTO admin_users (id, username, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, name, await argonHash(password, ARGON), now, now);

  return getAdminById(id)!;
}

export async function changePassword(userId: string, password: string): Promise<void> {
  const strength = checkPasswordStrength(password);
  if (!strength.ok) throw new Error(strength.problems.join(' '));

  getDb()
    .prepare('UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(await argonHash(password, ARGON), nowIso(), userId);

  // Nach einer Passwortaenderung sind alle bestehenden Sitzungen hinfaellig -
  // sonst bliebe ein Angreifer angemeldet, obwohl das Passwort gewechselt wurde.
  revokeAllSessions(userId);
}

// ---------------------------------------------------------------------------
// Anmeldung
// ---------------------------------------------------------------------------

export type LoginResult =
  | { status: 'ok'; user: AdminUser }
  | { status: 'totp_required'; user: AdminUser }
  | { status: 'invalid' }
  | { status: 'locked'; until: string };

/**
 * Prueft Benutzername und Passwort.
 *
 * Bei unbekanntem Benutzernamen wird trotzdem ein Hash berechnet. Ohne das
 * waere an der Antwortzeit ablesbar, welche Benutzernamen existieren.
 */
export async function verifyLogin(username: string, password: string): Promise<LoginResult> {
  const db = getDb();
  const user = getAdminByName(username);

  if (!user) {
    await argonHash(password, ARGON);
    return { status: 'invalid' };
  }

  if (user.locked_until && user.locked_until > nowIso()) {
    return { status: 'locked', until: user.locked_until };
  }

  let valid = false;
  try {
    valid = await argonVerify(user.password_hash, password);
  } catch {
    valid = false;
  }

  if (!valid) {
    const attempts = user.failed_attempts + 1;
    const wait = lockoutMs(attempts);
    db.prepare('UPDATE admin_users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(
      attempts,
      wait > 0 ? new Date(Date.now() + wait).toISOString() : null,
      user.id,
    );
    return { status: 'invalid' };
  }

  // Erfolgreiche Passwortpruefung setzt den Zaehler zurueck - auch wenn noch
  // der zweite Faktor fehlt.
  db.prepare('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(
    user.id,
  );

  const fresh = getAdminById(user.id)!;
  return fresh.totp_enabled ? { status: 'totp_required', user: fresh } : { status: 'ok', user: fresh };
}

// ---------------------------------------------------------------------------
// Zweiter Faktor
// ---------------------------------------------------------------------------

function totpFor(secretBase32: string, username: string): TOTP {
  return new TOTP({
    issuer: 'PicPool',
    label: username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

/** Erzeugt ein neues, noch nicht aktiviertes Geheimnis samt Einrichtungs-URI. */
export function beginTotpSetup(user: AdminUser): { secret: string; uri: string } {
  const secret = new Secret({ size: 20 }).base32;
  const uri = totpFor(secret, user.username).toString();

  // Erst nach erfolgreicher Bestaetigung wird totp_enabled gesetzt. Bis dahin
  // liegt das Geheimnis zwar da, ist aber wirkungslos - so sperrt sich niemand
  // aus, weil die Einrichtung auf halber Strecke abgebrochen wurde.
  getDb()
    .prepare('UPDATE admin_users SET totp_secret_enc = ?, updated_at = ? WHERE id = ?')
    .run(encryptAtRest(secret, 'totp-secret'), nowIso(), user.id);

  return { secret, uri };
}

/**
 * Prueft einen Code.
 *
 * Ein Fenster von einem Zeitschritt in jede Richtung gleicht Uhrenabweichungen
 * zwischen Handy und NAS aus.
 */
export function verifyTotp(user: AdminUser, code: string): boolean {
  if (!user.totp_secret_enc) return false;

  const cleaned = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;

  let secret: string;
  try {
    secret = decryptAtRest(user.totp_secret_enc, 'totp-secret');
  } catch {
    return false;
  }

  const delta = totpFor(secret, user.username).validate({ token: cleaned, window: 1 });
  return delta !== null;
}

export function enableTotp(userId: string): void {
  getDb()
    .prepare('UPDATE admin_users SET totp_enabled = 1, updated_at = ? WHERE id = ?')
    .run(nowIso(), userId);
}

export function disableTotp(userId: string): void {
  getDb()
    .prepare(
      'UPDATE admin_users SET totp_enabled = 0, totp_secret_enc = NULL, updated_at = ? WHERE id = ?',
    )
    .run(nowIso(), userId);
}

// ---------------------------------------------------------------------------
// Sitzungen
// ---------------------------------------------------------------------------

export interface SessionInfo {
  user: AdminUser;
  csrfToken: string;
}

/**
 * Legt eine Sitzung an und liefert das Klartext-Token fuer das Cookie.
 *
 * Gespeichert wird nur der Hash - ein gestohlenes Datenbank-Backup liefert
 * damit keine uebernehmbaren Sitzungen.
 */
export function createSession(
  userId: string,
  meta: { ip?: string; userAgent?: string } = {},
): { token: string; csrfToken: string } {
  // Zwei Tokens aneinander: 256 Bit Entropie fuer ein Sitzungstoken, das
  // vierzehn Tage gilt.
  const token = `${generateToken()}${generateToken()}`;
  const now = nowIso();

  getDb()
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      hashToken(token),
      userId,
      now,
      new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString(),
      now,
      meta.ip ?? null,
      (meta.userAgent ?? '').slice(0, 300),
    );

  getDb().prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').run(now, userId);

  // Das CSRF-Token gehoert zur Sitzung; es wird aus dem Sitzungstoken
  // abgeleitet statt gespeichert, damit es ohne weitere Tabelle auskommt.
  return { token, csrfToken: deriveCsrf(token) };
}

/** Leitet das CSRF-Token deterministisch aus dem Sitzungstoken ab. */
export function deriveCsrf(sessionToken: string): string {
  return crypto.createHash('sha256').update(`csrf:${sessionToken}`).digest('base64url').slice(0, 32);
}

export function resolveSession(token: string | undefined): SessionInfo | null {
  if (!token) return null;

  const db = getDb();
  const row = db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?')
    .get(hashToken(token)) as { user_id: string; expires_at: string } | undefined;

  if (!row) return null;

  if (row.expires_at < nowIso()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
    return null;
  }

  const user = getAdminById(row.user_id);
  if (!user) return null;

  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), hashToken(token));

  return { user, csrfToken: deriveCsrf(token) };
}

export function checkCsrf(sessionToken: string | undefined, presented: string | undefined): boolean {
  if (!sessionToken || !presented) return false;
  return safeEqual(deriveCsrf(sessionToken), presented);
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
}

export function revokeAllSessions(userId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Raeumt abgelaufene Sitzungen auf. */
export function purgeExpiredSessions(): number {
  return getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso()).changes;
}
