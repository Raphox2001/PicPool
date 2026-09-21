import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileTypeFromFile } from 'file-type';
import { kindForMime, type AssetKind } from '@picpool/shared';
import { getDb, nowIso } from '../db/index.js';
import { getConfig } from '../config.js';
import { randomId } from '../lib/crypto.js';
import { safeExtension, assertWithinRoot } from '../lib/slug.js';
import { enqueue } from '../jobs/queue.js';
import type { Album } from './albums.js';
import type { Uploader } from './uploaders.js';

export interface Asset {
  id: string;
  album_id: string;
  uploader_id: string | null;
  kind: AssetKind;
  original_path: string;
  original_filename: string;
  mime: string;
  bytes: number;
  content_hash: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  orientation: number | null;
  thumbhash: string | null;
  taken_at: string | null;
  taken_at_source: string | null;
  status: string;
  error: string | null;
  created_at: string;
  processed_at: string | null;
  deleted_at: string | null;
}

export class RejectedUpload extends Error {
  constructor(readonly userMessage: string, readonly code: string) {
    super(`${code}: ${userMessage}`);
    this.name = 'RejectedUpload';
  }
}

/** Streamt die Datei und bildet den SHA-256. Auch Videos im GB-Bereich bleiben so speicherneutral. */
async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Bestimmt den tatsaechlichen Dateityp anhand der Magic Bytes.
 *
 * Der vom Browser gemeldete Content-Type und die Dateiendung sind beide frei
 * waehlbar und werden hier bewusst ignoriert. Eine als "urlaub.jpg"
 * deklarierte PHP-Datei faellt damit auf.
 */
async function detectMime(filePath: string): Promise<string | null> {
  const ft = await fileTypeFromFile(filePath);
  if (!ft) return null;

  // file-type meldet HEIC teils als 'image/heif'; beides ist zugelassen und
  // nimmt ohnehin denselben ffmpeg-Pfad.
  return ft.mime;
}

export interface IngestInput {
  tempPath: string;
  originalFilename: string;
  album: Album;
  uploader: Uploader;
}

export interface IngestResult {
  asset: Asset;
  /** true, wenn die Datei bereits im Album lag und nicht erneut abgelegt wurde. */
  duplicate: boolean;
}

/**
 * Uebernimmt eine fertig hochgeladene Datei aus dem incoming-Verzeichnis in
 * den Bestand.
 *
 * Reihenfolge ist wichtig: erst pruefen, dann hashen, dann deduplizieren und
 * erst zuletzt verschieben. Eine abgelehnte Datei soll den Zielbaum gar nicht
 * erst beruehren.
 */
export async function ingestUpload(input: IngestInput): Promise<IngestResult> {
  const cfg = getConfig();
  const { tempPath, album, uploader } = input;

  const stat = await fsp.stat(tempPath);
  if (stat.size === 0) {
    await safeUnlink(tempPath);
    throw new RejectedUpload('Die Datei ist leer.', 'empty_file');
  }
  if (stat.size > cfg.limits.maxFileBytes) {
    await safeUnlink(tempPath);
    throw new RejectedUpload('Die Datei ist zu gross.', 'too_large');
  }

  const mime = await detectMime(tempPath);
  if (!mime) {
    await safeUnlink(tempPath);
    throw new RejectedUpload('Dateityp nicht erkannt.', 'unknown_type');
  }

  const kind = kindForMime(mime);
  if (!kind) {
    await safeUnlink(tempPath);
    throw new RejectedUpload(
      'Es werden nur Fotos und Videos angenommen.',
      'disallowed_type',
    );
  }

  const contentHash = await hashFile(tempPath);

  // Deduplizierung: dieselbe Datei im selben Album gibt es genau einmal.
  const existing = getDb()
    .prepare(
      `SELECT * FROM assets
        WHERE album_id = ? AND content_hash = ? AND deleted_at IS NULL`,
    )
    .get(album.id, contentHash) as Asset | undefined;

  if (existing) {
    await safeUnlink(tempPath);
    return { asset: existing, duplicate: true };
  }

  const ext = safeExtension(input.originalFilename, mime);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const filename = `${stamp}_${contentHash.slice(0, 8)}.${ext}`;

  const relDir = path.join('originals', album.slug, uploader.slug);
  const absDir = path.join(cfg.paths.root, relDir);
  const absPath = path.join(absDir, filename);

  // Letzte Absicherung vor dem Schreiben. slugify sollte das bereits
  // verhindern; diese Pruefung kostet nichts und faengt kuenftige Fehler ab.
  assertWithinRoot(cfg.paths.originals, absPath);

  await fsp.mkdir(absDir, { recursive: true });
  await moveFile(tempPath, absPath);

  const id = randomId();
  const now = nowIso();
  const relPath = path.join(relDir, filename).split(path.sep).join('/');

  getDb()
    .prepare(
      `INSERT INTO assets (id, album_id, uploader_id, kind, original_path, original_filename,
                           mime, bytes, content_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      id,
      album.id,
      uploader.id,
      kind,
      relPath,
      input.originalFilename.slice(0, 255),
      mime,
      stat.size,
      contentHash,
      now,
    );

  // Bilder zuerst: die Galerie soll schnell etwas zeigen. Videos brauchen
  // laenger und duerfen warten.
  enqueue('process_asset', { assetId: id }, { priority: kind === 'image' ? 50 : 100 });

  const asset = getDb().prepare('SELECT * FROM assets WHERE id = ?').get(id) as Asset;
  return { asset, duplicate: false };
}

/**
 * Verschiebt die Datei. rename() scheitert ueber Dateisystemgrenzen hinweg -
 * incoming und originals liegen zwar im selben Volume, aber darauf soll sich
 * der Code nicht verlassen.
 */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
    await fsp.copyFile(from, to);
    await safeUnlink(from);
  }
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch {
    /* schon weg - nicht weiter schlimm */
  }
}

export function getAsset(id: string): Asset | null {
  return (getDb().prepare('SELECT * FROM assets WHERE id = ?').get(id) as Asset | undefined) ?? null;
}

export function absolutePathOf(relPath: string): string {
  const cfg = getConfig();
  const abs = path.join(cfg.paths.root, relPath);
  assertWithinRoot(cfg.paths.root, abs);
  return abs;
}
