import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import exifReader from 'exif-reader';
import { rgbaToThumbHash } from 'thumbhash';
import { Buffer } from 'node:buffer';
import { getDb, nowIso } from '../db/index.js';
import { getConfig } from '../config.js';
import { randomId } from '../lib/crypto.js';
import { assertWithinRoot } from '../lib/slug.js';
import { openImage, probeVideo, extractPosterFrame, needsH264Fallback } from '../lib/media.js';
import { getAlbumById } from '../services/albums.js';
import { enqueue } from './queue.js';
import { getAsset, absolutePathOf, type Asset } from '../services/assets.js';

/**
 * Erzeugt die Derivate zu einem Asset.
 *
 * Drei Stufen pro Bild:
 *   thumb   ~320px  - das Raster in der Galerie
 *   preview ~2048px - die Lightbox, also die "gut aufgeloest, aber schnell"-Stufe
 *   Original         - unangetastet, nur fuer den Download
 *
 * Die Derivate tragen bewusst KEINE Metadaten: sharp uebernimmt EXIF nur auf
 * ausdrueckliche Anforderung. Damit verlassen die GPS-Koordinaten der Gaeste
 * das Haus nicht, ohne dass dafuer eigener Code noetig waere. Die Drehung wird
 * stattdessen fest in die Pixel gerechnet.
 */

interface ProcessPayload {
  assetId: string;
}

export async function processAsset(payload: unknown): Promise<void> {
  const { assetId } = payload as ProcessPayload;
  const asset = getAsset(assetId);

  if (!asset) {
    // Kann vorkommen, wenn der Admin das Asset vor der Verarbeitung geloescht
    // hat. Kein Fehler, nur nichts mehr zu tun.
    return;
  }
  if (asset.deleted_at) return;

  markStatus(asset.id, 'processing', null);

  try {
    if (asset.kind === 'image') await processImage(asset);
    else await processVideo(asset);

    getDb()
      .prepare(`UPDATE assets SET status = 'ready', processed_at = ?, error = NULL WHERE id = ?`)
      .run(nowIso(), asset.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markStatus(asset.id, 'failed', message.slice(0, 1000));
    throw err;
  }
}

function markStatus(id: string, status: string, error: string | null): void {
  getDb().prepare('UPDATE assets SET status = ?, error = ? WHERE id = ?').run(status, error, id);
}

// ---------------------------------------------------------------------------
// Bilder
// ---------------------------------------------------------------------------

async function processImage(asset: Asset): Promise<void> {
  const cfg = getConfig();
  const abs = absolutePathOf(asset.original_path);

  // openImage nimmt fuer HEIC den ffmpeg-Umweg, weil sharp kein HEVC kann.
  const image = await openImage(abs, asset.mime);
  const meta = await image.metadata();

  const takenAt = extractExifDate(meta.exif) ?? (await fileMtime(abs));
  const takenAtSource = extractExifDate(meta.exif) ? 'exif' : 'mtime';

  const outDir = derivativeDir(asset);
  await fsp.mkdir(outDir, { recursive: true });

  // rotate() ohne Argument wendet die EXIF-Ausrichtung an. Ohne das lieferten
  // hochkant fotografierte Bilder querliegende Vorschauen. Beim HEIC-Pfad hat
  // ffmpeg die Drehung meist schon angewandt; dann ist der Aufruf wirkungslos.
  const previewBuf = await image
    .clone()
    .rotate()
    .resize(cfg.derivatives.previewSize, cfg.derivatives.previewSize, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 82 })
    .toBuffer();

  const thumbBuf = await image
    .clone()
    .rotate()
    .resize(cfg.derivatives.thumbSize, cfg.derivatives.thumbSize, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 75 })
    .toBuffer();

  await writeDerivative(asset, 'preview', outDir, 'preview.webp', previewBuf);
  await writeDerivative(asset, 'thumb', outDir, 'thumb.webp', thumbBuf);

  const hash = await computeThumbhash(previewBuf);

  // Masse nach der Drehung, damit die Galerie das Seitenverhaeltnis korrekt
  // reserviert und beim Laden nicht springt.
  const rotated = await sharp(previewBuf).metadata();

  getDb()
    .prepare(
      `UPDATE assets SET width = ?, height = ?, orientation = ?, thumbhash = ?,
                         taken_at = ?, taken_at_source = ? WHERE id = ?`,
    )
    .run(
      rotated.width ?? null,
      rotated.height ?? null,
      meta.orientation ?? null,
      hash,
      takenAt,
      takenAtSource,
      asset.id,
    );
}

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

async function processVideo(asset: Asset): Promise<void> {
  const cfg = getConfig();
  const abs = absolutePathOf(asset.original_path);

  const info = await probeVideo(abs);
  const poster = await extractPosterFrame(abs, info.durationMs);

  const outDir = derivativeDir(asset);
  await fsp.mkdir(outDir, { recursive: true });

  const base = sharp(poster, { limitInputPixels: cfg.limits.maxImagePixels });

  // Die Drehung steckt bei Handyvideos in der Display-Matrix, nicht in den
  // Pixeln. ffprobe liest sie aus; hier wird sie ins Standbild gerechnet.
  const oriented = info.rotation === 0 ? base : base.rotate(info.rotation);

  const posterBuf = await oriented
    .clone()
    .resize(cfg.derivatives.previewSize, cfg.derivatives.previewSize, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 82 })
    .toBuffer();

  const thumbBuf = await oriented
    .clone()
    .resize(cfg.derivatives.thumbSize, cfg.derivatives.thumbSize, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 75 })
    .toBuffer();

  await writeDerivative(asset, 'poster', outDir, 'poster.webp', posterBuf);
  await writeDerivative(asset, 'thumb', outDir, 'thumb.webp', thumbBuf);

  const hash = await computeThumbhash(posterBuf);
  const takenAt = parseIsoLike(info.creationTime) ?? (await fileMtime(abs));

  // Ob eine H.264-Fassung noetig ist, entscheidet sich am Codec. Ohne ihn
  // abgelegt zu haben, liesse sich das spaeter nicht mehr beantworten, ohne
  // jede Datei erneut zu untersuchen.
  const fallbackNeeded = needsH264Fallback(info.codec);
  const album = getAlbumById(asset.album_id);
  const albumWants = album?.transcode_videos === 1;

  getDb()
    .prepare(
      `UPDATE assets SET width = ?, height = ?, duration_ms = ?, thumbhash = ?,
                         taken_at = ?, taken_at_source = ?, video_codec = ?,
                         transcode_status = ? WHERE id = ?`,
    )
    .run(
      info.width,
      info.height,
      info.durationMs,
      hash,
      takenAt,
      info.creationTime ? 'exif' : 'mtime',
      info.codec,
      fallbackNeeded && albumWants ? 'pending' : null,
      asset.id,
    );

  if (fallbackNeeded && albumWants) {
    // Niedrigste Prioritaet: Bilder und frische Uploads gehen vor. Auf zwei
    // Kernen ohne Hardware-Unterstuetzung dauert das ohnehin.
    enqueue('transcode_video', { assetId: asset.id }, { priority: 900, maxAttempts: 2 });
  }
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function derivativeDir(asset: Asset): string {
  const cfg = getConfig();
  const dir = path.join(cfg.paths.derivatives, asset.album_id, asset.id);
  assertWithinRoot(cfg.paths.derivatives, dir);
  return dir;
}

async function writeDerivative(
  asset: Asset,
  variant: 'thumb' | 'preview' | 'poster' | 'video_h264',
  dir: string,
  filename: string,
  buf: Buffer,
): Promise<void> {
  const abs = path.join(dir, filename);
  await fsp.writeFile(abs, buf);

  const meta = await sharp(buf).metadata().catch(() => ({ width: null, height: null }));
  const cfg = getConfig();
  const rel = path.relative(cfg.paths.root, abs).split(path.sep).join('/');

  // Ein erneuter Durchlauf desselben Assets soll die vorhandene Zeile
  // aktualisieren statt am Unique-Index zu scheitern.
  getDb()
    .prepare(
      `INSERT INTO derivatives (id, asset_id, variant, path, mime, bytes, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (asset_id, variant) DO UPDATE SET
         path = excluded.path, mime = excluded.mime, bytes = excluded.bytes,
         width = excluded.width, height = excluded.height, created_at = excluded.created_at`,
    )
    .run(
      randomId(),
      asset.id,
      variant,
      rel,
      'image/webp',
      buf.length,
      meta.width ?? null,
      meta.height ?? null,
      nowIso(),
    );
}

/**
 * Erzeugt den ThumbHash: eine etwa 25 Byte grosse Repraesentation des Bildes,
 * die als unscharfer Platzhalter sofort angezeigt werden kann, waehrend das
 * eigentliche Thumbnail noch laedt. Spuerbar angenehmer als graue Kaesten.
 */
async function computeThumbhash(buf: Buffer): Promise<string | null> {
  try {
    const { data, info } = await sharp(buf)
      .resize(100, 100, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const hash = rgbaToThumbHash(info.width, info.height, data);
    return Buffer.from(hash).toString('base64');
  } catch {
    // Ein fehlender Platzhalter ist ein Schoenheitsfehler, kein Grund, die
    // gesamte Verarbeitung scheitern zu lassen.
    return null;
  }
}

/**
 * Liest das Aufnahmedatum aus den EXIF-Daten.
 *
 * Achtung: EXIF-Zeitstempel tragen in aller Regel keine Zeitzone. Sie werden
 * hier als Wanduhrzeit uebernommen. Fuer ein gemeinsames Event ist das genau
 * richtig; bei Kameras aus verschiedenen Zeitzonen entsteht ein Versatz, den
 * spaeter eine Korrektur pro Uploader ausgleichen kann.
 */
function extractExifDate(exif: Buffer | undefined): string | null {
  if (!exif) return null;
  try {
    const parsed = exifReader(exif);
    const d =
      parsed.Photo?.DateTimeOriginal ??
      parsed.Photo?.DateTimeDigitized ??
      parsed.Image?.DateTime;
    if (!d) return null;
    const date = d instanceof Date ? d : new Date(String(d));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

function parseIsoLike(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function fileMtime(abs: string): Promise<string> {
  const stat = await fsp.stat(abs);
  return stat.mtime.toISOString();
}
