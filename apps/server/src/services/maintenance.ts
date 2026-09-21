import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getDb, nowIso } from '../db/index.js';
import { getConfig } from '../config.js';
import { assertWithinRoot } from '../lib/slug.js';

/**
 * Betriebsaufgaben: Sicherung und Aufraeumen.
 */

// ---------------------------------------------------------------------------
// Sicherung
// ---------------------------------------------------------------------------

export interface BackupResult {
  file: string;
  bytes: number;
  durationMs: number;
}

/**
 * Schreibt eine konsistente Kopie der Datenbank.
 *
 * Die Datei bei laufendem Betrieb einfach zu kopieren geht schief: Im
 * WAL-Modus kann ein erheblicher Teil der Daten noch im Write-Ahead-Log
 * liegen und gar nicht in der Hauptdatei stehen. Beobachtet wurden 1,7 MB im
 * WAL gegenueber 168 KB in der Datenbankdatei. SQLite meldet auf so einer
 * Kopie "database disk image is malformed", obwohl nichts kaputt ist.
 *
 * Die Backup-API von SQLite loest das: Sie liest einen in sich stimmigen
 * Stand, auch waehrend geschrieben wird.
 */
export async function backupDatabase(targetPath?: string): Promise<BackupResult> {
  const cfg = getConfig();
  const started = Date.now();

  const dir = targetPath ? path.dirname(path.resolve(targetPath)) : path.join(cfg.paths.root, 'backups');
  await fsp.mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = targetPath
    ? path.resolve(targetPath)
    : path.join(dir, `picpool-${stamp}.db`);

  await getDb().backup(file);

  const stat = await fsp.stat(file);
  return { file, bytes: stat.size, durationMs: Date.now() - started };
}

/** Entfernt alte Sicherungen und behaelt die neuesten. */
export async function pruneBackups(keep = 7): Promise<number> {
  const dir = path.join(getConfig().paths.root, 'backups');
  if (!fs.existsSync(dir)) return 0;

  const files = (await fsp.readdir(dir))
    .filter((f) => /^picpool-.*\.db$/.test(f))
    .sort()
    .reverse();

  let removed = 0;
  for (const f of files.slice(keep)) {
    await fsp.unlink(path.join(dir, f)).catch(() => undefined);
    removed++;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Aufraeumen
// ---------------------------------------------------------------------------

/** Abgebrochene Uploads gelten nach dieser Zeit als aufgegeben. */
const INCOMING_MAX_AGE_MS = 48 * 3600_000;

export interface CleanupResult {
  incomingRemoved: number;
  incomingBytes: number;
  orphanDerivatives: number;
}

/**
 * Raeumt liegengebliebene Dateien auf.
 *
 * Zwei Faelle:
 *
 *  - Angefangene Uploads, die nie zu Ende gefuehrt wurden. tus laesst sie
 *    bewusst liegen, damit sie fortgesetzt werden koennen - aber nicht
 *    unbegrenzt. Zwei Tage sind grosszuegig genug, dass niemand seinen
 *    Upload verliert, und verhindern trotzdem, dass incoming/ volllaeuft.
 *
 *  - Derivate ohne zugehoeriges Asset. Sollte nicht vorkommen, kann aber
 *    nach einem Absturz mitten in der Verarbeitung passieren.
 */
export async function cleanupIncoming(): Promise<CleanupResult> {
  const cfg = getConfig();
  const result: CleanupResult = { incomingRemoved: 0, incomingBytes: 0, orphanDerivatives: 0 };

  // --- incoming/ ---
  if (fs.existsSync(cfg.paths.incoming)) {
    const cutoff = Date.now() - INCOMING_MAX_AGE_MS;

    for (const name of await fsp.readdir(cfg.paths.incoming)) {
      const abs = path.join(cfg.paths.incoming, name);
      try {
        assertWithinRoot(cfg.paths.incoming, abs);
        const stat = await fsp.stat(abs);
        if (!stat.isFile() || stat.mtimeMs > cutoff) continue;

        result.incomingBytes += stat.size;
        await fsp.unlink(abs);
        result.incomingRemoved++;
      } catch {
        /* nicht lesbar oder schon weg */
      }
    }
  }

  // --- verwaiste Derivate ---
  const orphans = getDb()
    .prepare(
      `SELECT d.id, d.path FROM derivatives d
        WHERE NOT EXISTS (
          SELECT 1 FROM assets a WHERE a.id = d.asset_id AND a.deleted_at IS NULL
        )`,
    )
    .all() as Array<{ id: string; path: string }>;

  for (const o of orphans) {
    const abs = path.join(cfg.paths.root, o.path);
    try {
      assertWithinRoot(cfg.paths.root, abs);
      await fsp.unlink(abs);
    } catch {
      /* schon weg */
    }
    getDb().prepare('DELETE FROM derivatives WHERE id = ?').run(o.id);
    result.orphanDerivatives++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Update-Markierung
// ---------------------------------------------------------------------------

/**
 * Datei, die eine Aktualisierung anfordert.
 *
 * Der Container kann sich nicht selbst aktualisieren - das braeuchte Zugriff
 * auf den Docker-Socket, und der ist gleichbedeutend mit Root auf der ganzen
 * NAS. Das wuerde die gesamte Kapselung aushebeln.
 *
 * Stattdessen schreibt das Panel nur diese Markierung. Eine DSM-Aufgabe, die
 * einmalig eingerichtet wird, prueft darauf und fuehrt Pull und Neustart aus.
 * Der privilegierte Teil liegt damit in DSM, wo er hingehoert.
 */
export function updateFlagPath(): string {
  return path.join(getConfig().paths.root, 'update-requested');
}

export function requestUpdate(requestedBy: string, targetVersion: string | null): void {
  fs.writeFileSync(
    updateFlagPath(),
    JSON.stringify({ requestedAt: nowIso(), requestedBy, targetVersion }, null, 2),
    'utf8',
  );
}

export function readUpdateRequest(): { requestedAt: string; requestedBy: string } | null {
  try {
    return JSON.parse(fs.readFileSync(updateFlagPath(), 'utf8')) as {
      requestedAt: string;
      requestedBy: string;
    };
  } catch {
    return null;
  }
}

export function clearUpdateRequest(): void {
  try {
    fs.unlinkSync(updateFlagPath());
  } catch {
    /* war nicht da */
  }
}
