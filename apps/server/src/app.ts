import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fs from 'node:fs';
import { getConfig } from './config.js';
import { getDb } from './db/index.js';
import { probeCapabilities, capabilityWarnings, type MediaCapabilities } from './lib/media.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerUploadRoutes } from './routes/upload.js';
import { registerPageRoutes } from './routes/pages.js';
import { registerNetTestRoutes } from './routes/nettest.js';

/** Legt die Verzeichnisstruktur im Datenvolume an, falls sie noch fehlt. */
export function ensureDataDirs(): void {
  const { paths } = getConfig();
  for (const dir of [paths.originals, paths.derivatives, paths.incoming]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const cfg = getConfig();

  const app = Fastify({
    logger: {
      level: cfg.logLevel,
      redact: ['req.headers.cookie', 'req.headers.authorization'],
    },
    // Eng gefasst: nur dem konfigurierten Reverse Proxy wird X-Forwarded-For
    // geglaubt. Waere das offen, koennte sich jeder Gast per Header eine
    // LAN-IP andichten und damit die Originalaufloesung freischalten.
    trustProxy: cfg.trustProxyCidrs.length > 0 ? cfg.trustProxyCidrs : false,
    bodyLimit: 1024 * 1024, // JSON-APIs; Uploads laufen ueber tus, nicht hierueber

    /**
     * Zeitgrenzen der Verbindung.
     *
     * Fastify liefert standardmaessig keepAliveTimeout 72 s, aber
     * headersTimeout 60 s. Der Server kuendigt dem Browser per
     * "Keep-Alive: timeout=72" also 72 Sekunden an und zerstoert die
     * Verbindung trotzdem nach 60. Sendet der Browser in diesem Fenster auf
     * einer solchen Verbindung, bekommt er einen Abbruch ganz ohne
     * HTTP-Antwort - fuer den Gast sieht das wie ein Netzproblem aus.
     *
     * headersTimeout muss deshalb GROESSER sein als keepAliveTimeout.
     */
    keepAliveTimeout: 65_000,
    connectionTimeout: 0,
  });

  // Fastify reicht headersTimeout nicht als Option durch, also direkt setzen.
  app.server.headersTimeout = 70_000;
  // Ein grosser Upload darf beliebig lange dauern; abgebrochene Verbindungen
  // faengt tus ueber die Wiederaufnahme ab, nicht ein harter Zeitablauf.
  app.server.requestTimeout = 0;

  await app.register(helmet, {
    contentSecurityPolicy: {
      // useDefaults: false ist wichtig. Helmet setzt sonst
      // upgrade-insecure-requests, was den internen Zugriff ueber
      // http://<nas-ip>:8080 zwangsweise auf HTTPS umbiegt und damit bricht.
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // HSTS setzt der Reverse Proxy; hier wuerde es bei internem HTTP-Zugriff
    // ueber die NAS-IP nur stoeren.
    strictTransportSecurity: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  await app.register(cookie, {
    parseOptions: { httpOnly: true, sameSite: 'lax', path: '/' },
  });

  await app.register(rateLimit, {
    global: false,
    max: cfg.limits.uploadRatePerIpPerMin,
    timeWindow: '1 minute',
  });

  // Datenbank frueh oeffnen, damit Migrationsfehler beim Start auffallen
  // und nicht erst beim ersten Request.
  getDb();

  const caps = await probeCapabilities();
  for (const warning of capabilityWarnings(caps)) {
    app.log.error({ capabilities: caps }, warning);
  }
  if (caps.ffmpeg && caps.hevcDecoder) {
    app.log.info({ ffmpeg: caps.ffmpegVersion }, 'Medien-Toolchain bereit (HEVC/HEIC verfuegbar)');
  }

  registerHealthRoutes(app, caps);
  registerPublicRoutes(app);
  await registerUploadRoutes(app);
  await registerPageRoutes(app);

  if (cfg.netTestEnabled) {
    registerNetTestRoutes(app);
    app.log.warn("Netzwerktest unter /nettest aktiv - im Regelbetrieb abschalten (PICPOOL_NETTEST)");
  }

  return app;
}

function registerHealthRoutes(app: FastifyInstance, caps: MediaCapabilities): void {
  /** Liveness: beantwortet nur, ob der Prozess laeuft. Bewusst ohne Details. */
  app.get('/healthz', async () => ({ status: 'ok' }));

  /**
   * Readiness mit Diagnose. Meldet "degraded", wenn die Medien-Toolchain
   * unvollstaendig ist - dann nimmt die Instanz zwar Requests an, koennte aber
   * iPhone-Fotos nicht verarbeiten.
   */
  app.get('/readyz', async (_req, reply) => {
    const db = getDb();
    let dbOk = true;
    try {
      db.prepare('SELECT 1').get();
    } catch {
      dbOk = false;
    }

    const warnings = capabilityWarnings(caps);
    const healthy = dbOk && warnings.length === 0;

    reply.code(healthy ? 200 : 503);
    return {
      status: healthy ? 'ok' : 'degraded',
      db: dbOk,
      media: caps,
      warnings,
    };
  });
}
