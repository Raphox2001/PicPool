import os from 'node:os';
import { getConfig } from './config.js';
import { getDb, closeDb } from './db/index.js';
import { ensureDataDirs } from './app.js';
import { probeCapabilities, capabilityWarnings } from './lib/media.js';
import { claimNext, completeJob, failJob, requeueStale, type Job, type JobType } from './jobs/queue.js';
import { processAsset } from './jobs/processAsset.js';
import { purgeExpiredSessions } from './services/auth.js';

/**
 * Worker-Prozess.
 *
 * Laeuft im eigenen Container OHNE Netzwerkzugang. Hier wird fremdes
 * Bildmaterial geparst - die klassische Stelle fuer Schwachstellen in
 * Decodern. Faellt hier etwas aus, sitzt es in einer Sackgasse: kein
 * Netzwerk, nur das eine Datenverzeichnis, unprivilegierter Benutzer.
 *
 * Die Kommunikation mit der App laeuft ausschliesslich ueber die Jobs-Tabelle.
 */

const WORKER_ID = `${os.hostname()}-${process.pid}`;
const IDLE_POLL_MS = 2_000;
const STALE_SWEEP_MS = 5 * 60 * 1000;

type Handler = (payload: unknown, job: Job) => Promise<void>;

const handlers: Partial<Record<JobType, Handler>> = {
  process_asset: async (payload) => processAsset(payload),
  cleanup_incoming: async () => {
    // Platzhalter: raeumt abgebrochene tus-Uploads auf (P5).
  },
};

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void {
  const line = { ts: new Date().toISOString(), level, worker: WORKER_ID, msg, ...(extra ? { extra } : {}) };
  const out = JSON.stringify(line);
  if (level === 'error') console.error(out);
  else console.log(out);
}

let running = true;

async function tick(): Promise<boolean> {
  const job = claimNext(WORKER_ID);
  if (!job) return false;

  const handler = handlers[job.type];
  if (!handler) {
    failJob(job, new Error(`Kein Handler fuer Job-Typ ${job.type}`));
    log('error', 'Unbekannter Job-Typ', { type: job.type, id: job.id });
    return true;
  }

  const started = Date.now();
  try {
    await handler(job.payload, job);
    completeJob(job.id);
    log('info', 'Job erledigt', { type: job.type, id: job.id, ms: Date.now() - started });
  } catch (err) {
    failJob(job, err);
    log('error', 'Job fehlgeschlagen', {
      type: job.type,
      id: job.id,
      attempt: job.attempts,
      of: job.max_attempts,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}

/** Eine Schleife pro Nebenlaeufigkeitsslot. */
async function loop(): Promise<void> {
  while (running) {
    let didWork = false;
    try {
      didWork = await tick();
    } catch (err) {
      log('error', 'Unerwarteter Fehler in der Worker-Schleife', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!didWork) await sleep(IDLE_POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const cfg = getConfig();
  ensureDataDirs();
  getDb();

  const caps = await probeCapabilities();
  const warnings = capabilityWarnings(caps);
  for (const w of warnings) log('error', w);
  if (warnings.length === 0) {
    log('info', 'Medien-Toolchain bereit', { ffmpeg: caps.ffmpegVersion });
  }

  const freed = requeueStale();
  if (freed > 0) log('warn', 'Verwaiste Jobs wieder eingereiht', { count: freed });

  const sweeper = setInterval(() => {
    const n = requeueStale();
    if (n > 0) log('warn', 'Verwaiste Jobs wieder eingereiht', { count: n });

    // Abgelaufene Sitzungen mitnehmen: sie sind wirkungslos, wuerden die
    // Tabelle aber auf Dauer volllaufen lassen.
    const s = purgeExpiredSessions();
    if (s > 0) log('info', 'Abgelaufene Sitzungen entfernt', { count: s });
  }, STALE_SWEEP_MS);

  const shutdown = (signal: string): void => {
    if (!running) return;
    running = false;
    clearInterval(sweeper);
    log('info', 'Fahre herunter', { signal });
    // Laufende Jobs duerfen zu Ende laufen; ihr Lock verfaellt notfalls
    // ueber requeueStale.
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 1_000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log('info', 'Worker gestartet', { concurrency: cfg.worker.concurrency });

  await Promise.all(Array.from({ length: cfg.worker.concurrency }, () => loop()));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
