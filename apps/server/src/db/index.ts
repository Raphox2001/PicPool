import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type Db = Database.Database;

let cached: Db | null = null;

/**
 * Oeffnet die Datenbank und wendet ausstehende Migrationen an.
 *
 * App- und Worker-Container greifen beide auf dieselbe Datei zu. WAL erlaubt
 * gleichzeitige Leser neben einem Schreiber; busy_timeout faengt die kurzen
 * Momente ab, in denen beide schreiben wollen.
 */
export function getDb(): Db {
  if (cached) return cached;

  const cfg = getConfig();
  fs.mkdirSync(path.dirname(cfg.paths.db), { recursive: true });

  const db = new Database(cfg.paths.db);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000');
  // NORMAL ist mit WAL crash-sicher gegen Prozessabstuerze und deutlich
  // schneller als FULL. Gegen Stromausfall schuetzt die USV bzw. das Backup.
  db.pragma('synchronous = NORMAL');

  migrate(db);

  cached = db;
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    )
  `);

  const dir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => (r as { name: string }).name),
  );

  const record = db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  );

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');

    // Jede Migration laeuft vollstaendig oder gar nicht. Ein Fehler auf halber
    // Strecke wuerde sonst ein Schema hinterlassen, das zu keiner Version passt.
    const run = db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    });

    try {
      run();
    } catch (err) {
      throw new Error(
        `Migration ${file} fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Nur fuer Tests: schliesst die Verbindung und verwirft den Cache. */
export function closeDb(): void {
  cached?.close();
  cached = null;
}

export function nowIso(): string {
  return new Date().toISOString();
}
