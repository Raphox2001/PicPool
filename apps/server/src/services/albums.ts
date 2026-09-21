import { getDb, nowIso } from '../db/index.js';
import { randomId } from '../lib/crypto.js';
import { slugify } from '../lib/slug.js';

export interface Album {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  event_date: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  allow_downloads: number;
  allow_originals_on_lan: number;
  strip_gps: number;
  max_bytes: number | null;
  max_files: number | null;
  cover_asset_id: string | null;
  transcode_videos: number;
}

export interface CreateAlbumInput {
  name: string;
  description?: string | null;
  eventDate?: string | null;
  allowDownloads?: boolean;
  allowOriginalsOnLan?: boolean;
  stripGps?: boolean;
  maxBytes?: number | null;
  maxFiles?: number | null;
}

/**
 * Sucht einen freien Slug. Zwei Alben duerfen denselben Namen tragen - im
 * Dateisystem und in URLs muessen sie sich aber unterscheiden.
 */
function uniqueSlug(base: string): string {
  const db = getDb();
  const taken = db.prepare('SELECT 1 FROM albums WHERE slug = ?');

  if (!taken.get(base)) return base;

  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.get(candidate)) return candidate;
  }
  // Praktisch unerreichbar; lieber ein haesslicher Slug als eine Endlosschleife.
  return `${base}-${randomId().slice(0, 8)}`;
}

export function createAlbum(input: CreateAlbumInput): Album {
  const db = getDb();
  const id = randomId();
  const now = nowIso();
  const slug = uniqueSlug(slugify(input.name, 'album'));

  db.prepare(
    `INSERT INTO albums (id, slug, name, description, event_date, created_at, updated_at,
                         allow_downloads, allow_originals_on_lan, strip_gps, max_bytes, max_files)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    slug,
    input.name.trim(),
    input.description ?? null,
    input.eventDate ?? null,
    now,
    now,
    input.allowDownloads === false ? 0 : 1,
    input.allowOriginalsOnLan === false ? 0 : 1,
    input.stripGps === false ? 0 : 1,
    input.maxBytes ?? null,
    input.maxFiles ?? null,
  );

  return getAlbumById(id)!;
}

export function getAlbumById(id: string): Album | null {
  return (getDb().prepare('SELECT * FROM albums WHERE id = ?').get(id) as Album | undefined) ?? null;
}

export function listAlbums(): Album[] {
  return getDb()
    .prepare('SELECT * FROM albums ORDER BY COALESCE(event_date, created_at) DESC')
    .all() as Album[];
}

export interface AlbumUsage {
  files: number;
  bytes: number;
}

/** Aktuelle Belegung, fuer die Quota-Pruefung beim Upload. */
export function getAlbumUsage(albumId: string): AlbumUsage {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes
         FROM assets WHERE album_id = ? AND deleted_at IS NULL`,
    )
    .get(albumId) as { files: number; bytes: number };
  return { files: row.files, bytes: row.bytes };
}

export type QuotaResult = { ok: true } | { ok: false; reason: string };

/**
 * Prueft, ob eine weitere Datei der angegebenen Groesse noch ins Album passt.
 *
 * Bewusst vor dem Upload geprueft und nicht erst danach: einen Gast erst
 * zehn Minuten hochladen zu lassen und dann abzulehnen, waere die
 * schlechteste aller Varianten.
 */
export function checkQuota(album: Album, additionalBytes: number): QuotaResult {
  const usage = getAlbumUsage(album.id);

  if (album.max_files !== null && usage.files >= album.max_files) {
    return { ok: false, reason: `Dieses Album ist voll (max. ${album.max_files} Dateien).` };
  }
  if (album.max_bytes !== null && usage.bytes + additionalBytes > album.max_bytes) {
    return { ok: false, reason: 'Dieses Album hat seine Speichergrenze erreicht.' };
  }
  return { ok: true };
}
