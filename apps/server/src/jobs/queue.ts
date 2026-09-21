import { getDb, nowIso } from '../db/index.js';
import { randomId } from '../lib/crypto.js';

export type JobType = 'process_asset' | 'transcode_video' | 'cleanup_incoming';

export interface Job {
  id: string;
  type: JobType;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

interface JobRow {
  id: string;
  type: JobType;
  payload: string;
  attempts: number;
  max_attempts: number;
}

/** Jobs, die laenger als das hier haengen, gelten als verwaist. */
const STALE_LOCK_MS = 30 * 60 * 1000;

export function enqueue(
  type: JobType,
  payload: unknown,
  opts: { priority?: number; runAfter?: Date; maxAttempts?: number } = {},
): string {
  const db = getDb();
  const id = randomId();
  const now = nowIso();

  db.prepare(
    `INSERT INTO jobs (id, type, payload, priority, state, attempts, max_attempts,
                       run_after, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
  ).run(
    id,
    type,
    JSON.stringify(payload),
    opts.priority ?? 100,
    opts.maxAttempts ?? 3,
    (opts.runAfter ?? new Date()).toISOString(),
    now,
    now,
  );

  return id;
}

/**
 * Holt den naechsten faelligen Job und markiert ihn atomar als laufend.
 *
 * SQLite serialisiert Schreibvorgaenge, daher genuegt eine Transaktion, um zu
 * verhindern, dass zwei Worker denselben Job greifen.
 */
export function claimNext(workerId: string): Job | null {
  const db = getDb();

  const claim = db.transaction((): JobRow | null => {
    const row = db
      .prepare(
        `SELECT id, type, payload, attempts, max_attempts
           FROM jobs
          WHERE state = 'queued' AND run_after <= ?
          ORDER BY priority ASC, run_after ASC
          LIMIT 1`,
      )
      .get(nowIso()) as JobRow | undefined;

    if (!row) return null;

    db.prepare(
      `UPDATE jobs
          SET state = 'running', locked_at = ?, locked_by = ?,
              attempts = attempts + 1, updated_at = ?
        WHERE id = ?`,
    ).run(nowIso(), workerId, nowIso(), row.id);

    return row;
  });

  const row = claim.immediate();
  if (!row) return null;

  return {
    id: row.id,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    attempts: row.attempts + 1,
    max_attempts: row.max_attempts,
  };
}

export function completeJob(id: string): void {
  getDb()
    .prepare(`UPDATE jobs SET state = 'done', locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?`)
    .run(nowIso(), id);
}

/**
 * Bei Fehlschlag: erneut einreihen mit exponentiellem Backoff, bis die
 * Versuche aufgebraucht sind. Danach bleibt der Job als 'failed' stehen -
 * sichtbar im Admin statt still verschwunden.
 */
export function failJob(job: Job, error: unknown): void {
  const db = getDb();
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.max_attempts;

  if (exhausted) {
    db.prepare(
      `UPDATE jobs SET state = 'failed', last_error = ?, locked_at = NULL,
                       locked_by = NULL, updated_at = ? WHERE id = ?`,
    ).run(message.slice(0, 2000), nowIso(), job.id);
    return;
  }

  const backoffMs = Math.min(2 ** job.attempts * 5_000, 10 * 60 * 1000);
  db.prepare(
    `UPDATE jobs SET state = 'queued', last_error = ?, run_after = ?,
                     locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?`,
  ).run(
    message.slice(0, 2000),
    new Date(Date.now() + backoffMs).toISOString(),
    nowIso(),
    job.id,
  );
}

/**
 * Gibt Jobs frei, deren Worker abgestuerzt ist. Ohne das blieben sie nach
 * einem Container-Neustart fuer immer auf 'running' stehen.
 */
export function requeueStale(): number {
  const cutoff = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  const res = getDb()
    .prepare(
      `UPDATE jobs SET state = 'queued', locked_at = NULL, locked_by = NULL, updated_at = ?
        WHERE state = 'running' AND locked_at < ?`,
    )
    .run(nowIso(), cutoff);
  return res.changes;
}

export function queueStats(): Record<string, number> {
  const rows = getDb()
    .prepare(`SELECT state, COUNT(*) AS n FROM jobs GROUP BY state`)
    .all() as Array<{ state: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}
