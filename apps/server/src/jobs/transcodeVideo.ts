import fsp from 'node:fs/promises';
import path from 'node:path';
import { getDb, nowIso } from '../db/index.js';
import { getConfig } from '../config.js';
import { randomId } from '../lib/crypto.js';
import { assertWithinRoot } from '../lib/slug.js';
import { transcodeToH264 } from '../lib/media.js';
import { absolutePathOf } from '../services/assets.js';

/**
 * Erzeugt die H.264-Fassung eines Videos.
 *
 * Laeuft mit niedriger Prioritaet, damit Bilder und frische Uploads nicht
 * dahinter warten muessen. Auf der DS923+ ohne iGPU dauert die Umwandlung
 * laenger als das Video selbst - das ist eingeplant, aber es soll niemandem
 * im Weg stehen.
 */

interface Payload {
  assetId: string;
}

/**
 * Sehr lange Videos werden uebersprungen.
 *
 * Eine halbe Stunde Aufnahme wuerde auf zwei Kernen Stunden beanspruchen und
 * die NAS dabei durchgehend belasten. Wer so etwas ansehen will, laedt es
 * herunter - dafuer gibt es das Original.
 */
const MAX_DURATION_MS = 15 * 60_000;

export async function transcodeVideo(payload: unknown): Promise<void> {
  const { assetId } = payload as Payload;
  const db = getDb();
  const cfg = getConfig();

  const asset = db
    .prepare(
      `SELECT id, album_id, kind, original_path, duration_ms, video_codec
         FROM assets
        WHERE id = ? AND deleted_at IS NULL AND kind = 'video'`,
    )
    .get(assetId) as
    | {
        id: string;
        album_id: string;
        original_path: string;
        duration_ms: number | null;
        video_codec: string | null;
      }
    | undefined;

  if (!asset) return;

  if (asset.duration_ms !== null && asset.duration_ms > MAX_DURATION_MS) {
    db.prepare(`UPDATE assets SET transcode_status = 'skipped' WHERE id = ?`).run(asset.id);
    return;
  }

  db.prepare(`UPDATE assets SET transcode_status = 'running' WHERE id = ?`).run(asset.id);

  const outDir = path.join(cfg.paths.derivatives, asset.album_id, asset.id);
  assertWithinRoot(cfg.paths.derivatives, outDir);
  await fsp.mkdir(outDir, { recursive: true });

  const outPath = path.join(outDir, 'video-h264.mp4');
  // Erst unter Zwischennamen schreiben: bricht die Umwandlung ab, bleibt
  // keine halbe Datei liegen, die spaeter als fertig missverstanden wird.
  const tmpPath = `${outPath}.part`;

  try {
    await transcodeToH264(absolutePathOf(asset.original_path), tmpPath);
    await fsp.rename(tmpPath, outPath);

    const stat = await fsp.stat(outPath);
    const rel = path.relative(cfg.paths.root, outPath).split(path.sep).join('/');

    db.prepare(
      `INSERT INTO derivatives (id, asset_id, variant, path, mime, bytes, created_at)
       VALUES (?, ?, 'video_h264', ?, 'video/mp4', ?, ?)
       ON CONFLICT (asset_id, variant) DO UPDATE SET
         path = excluded.path, bytes = excluded.bytes, created_at = excluded.created_at`,
    ).run(randomId(), asset.id, rel, stat.size, nowIso());

    db.prepare(`UPDATE assets SET transcode_status = 'ready' WHERE id = ?`).run(asset.id);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => undefined);
    db.prepare(`UPDATE assets SET transcode_status = 'failed' WHERE id = ?`).run(asset.id);
    throw err;
  }
}
