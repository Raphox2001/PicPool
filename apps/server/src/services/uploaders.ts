import { getDb, nowIso } from '../db/index.js';
import { randomId } from '../lib/crypto.js';
import { slugify, normalizeName, cleanDisplayName } from '../lib/slug.js';

export interface Uploader {
  id: string;
  album_id: string;
  name: string;
  name_normalized: string;
  slug: string;
  first_seen_at: string;
  last_seen_at: string;
}

/**
 * Findet den Uploader anhand des Namens oder legt ihn an.
 *
 * Gaeste melden sich nicht an, sie tippen nur einen Namen. Wer am naechsten
 * Tag wiederkommt und erneut "Oma Erika" eintippt, soll derselbe Uploader
 * sein - sonst zerfaellt der Galerie-Filter in Dubletten. Der Abgleich laeuft
 * deshalb ueber die normalisierte Form.
 */
export function findOrCreateUploader(albumId: string, rawName: string): Uploader {
  const db = getDb();
  const name = cleanDisplayName(rawName);
  const normalized = normalizeName(name);

  const existing = db
    .prepare('SELECT * FROM uploaders WHERE album_id = ? AND name_normalized = ?')
    .get(albumId, normalized) as Uploader | undefined;

  if (existing) {
    db.prepare('UPDATE uploaders SET last_seen_at = ? WHERE id = ?').run(nowIso(), existing.id);
    return existing;
  }

  const id = randomId();
  const now = nowIso();
  const slug = uniqueUploaderSlug(albumId, slugify(name, 'gast'));

  try {
    db.prepare(
      `INSERT INTO uploaders (id, album_id, name, name_normalized, slug, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, albumId, name, normalized, slug, now, now);
  } catch (err) {
    // Zwei parallele Uploads derselben Person koennen gleichzeitig hier
    // ankommen. Der Unique-Index faengt das ab; dann gilt der andere Datensatz.
    const raced = db
      .prepare('SELECT * FROM uploaders WHERE album_id = ? AND name_normalized = ?')
      .get(albumId, normalized) as Uploader | undefined;
    if (raced) return raced;
    throw err;
  }

  return db.prepare('SELECT * FROM uploaders WHERE id = ?').get(id) as Uploader;
}

/**
 * Slugs muessen pro Album eindeutig sein, weil sie Verzeichnisnamen werden.
 * "Anna B." und "Anna-B" ergeben denselben Slug, sind aber zwei Personen.
 */
function uniqueUploaderSlug(albumId: string, base: string): string {
  const db = getDb();
  const taken = db.prepare('SELECT 1 FROM uploaders WHERE album_id = ? AND slug = ?');

  if (!taken.get(albumId, base)) return base;

  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.get(albumId, candidate)) return candidate;
  }
  return `${base}-${randomId().slice(0, 8)}`;
}

export function getUploader(id: string): Uploader | null {
  return (getDb().prepare('SELECT * FROM uploaders WHERE id = ?').get(id) as Uploader | undefined) ?? null;
}

export interface UploaderSummary {
  id: string;
  name: string;
  count: number;
}

/** Fuer die Filter-Chips in der Galerie. */
export function listUploadersWithCounts(albumId: string): UploaderSummary[] {
  return getDb()
    .prepare(
      `SELECT u.id, u.name, COUNT(a.id) AS count
         FROM uploaders u
         LEFT JOIN assets a
           ON a.uploader_id = u.id AND a.deleted_at IS NULL AND a.status = 'ready'
        WHERE u.album_id = ?
        GROUP BY u.id, u.name
       HAVING count > 0
        ORDER BY u.name COLLATE NOCASE`,
    )
    .all(albumId) as UploaderSummary[];
}
