import { getDb } from '../db/index.js';
import type { AssetKind } from '@picpool/shared';

/**
 * Leseseite der Galerie.
 *
 * Die Abfragen liefern bewusst nur, was die Galerie anzeigen muss. Interne
 * Kennungen wie der Inhalts-Hash oder der Ablagepfad bleiben draussen: Gaeste
 * sollen aus der Antwort nicht auf die Ablagestruktur der NAS schliessen
 * koennen.
 */

export interface GalleryAsset {
  id: string;
  kind: AssetKind;
  uploaderId: string | null;
  uploaderName: string | null;
  takenAt: string | null;
  takenAtSource: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbhash: string | null;
  originalFilename: string;
  bytes: number;
  hasPreview: number;
  videoCodec: string | null;
  /** 1, wenn eine H.264-Fassung vorliegt. */
  hasH264: number;
}

/**
 * Alle fertig verarbeiteten Assets eines Albums, chronologisch.
 *
 * Sortiert wird nach Aufnahmezeitpunkt, mit dem Uploadzeitpunkt als
 * Rueckfallebene - sonst wuerden Dateien ohne auswertbares Datum
 * unvorhersehbar zwischen den anderen auftauchen.
 */
export function listGalleryAssets(albumId: string): GalleryAsset[] {
  return getDb()
    .prepare(
      `SELECT a.id, a.kind, a.uploader_id AS uploaderId, u.name AS uploaderName,
              a.taken_at AS takenAt, a.taken_at_source AS takenAtSource,
              a.width, a.height, a.duration_ms AS durationMs,
              a.thumbhash, a.original_filename AS originalFilename, a.bytes,
              a.video_codec AS videoCodec,
              EXISTS (
                SELECT 1 FROM derivatives d
                 WHERE d.asset_id = a.id AND d.variant IN ('preview','poster')
              ) AS hasPreview,
              EXISTS (
                SELECT 1 FROM derivatives d2
                 WHERE d2.asset_id = a.id AND d2.variant = 'video_h264'
              ) AS hasH264
         FROM assets a
         LEFT JOIN uploaders u ON u.id = a.uploader_id
        WHERE a.album_id = ?
          AND a.deleted_at IS NULL
          AND a.status = 'ready'
        ORDER BY COALESCE(a.taken_at, a.created_at) ASC, a.id ASC`,
    )
    .all(albumId) as GalleryAsset[];
}

export interface DerivativeRow {
  path: string;
  mime: string;
  bytes: number;
}

export function getDerivative(
  assetId: string,
  variant: 'thumb' | 'preview' | 'poster' | 'video_h264',
): DerivativeRow | null {
  return (
    (getDb()
      .prepare('SELECT path, mime, bytes FROM derivatives WHERE asset_id = ? AND variant = ?')
      .get(assetId, variant) as DerivativeRow | undefined) ?? null
  );
}

export interface AssetForDelivery {
  id: string;
  album_id: string;
  kind: AssetKind;
  original_path: string;
  original_filename: string;
  mime: string;
  bytes: number;
  uploader_slug: string | null;
  taken_at: string | null;
  created_at: string;
}

/**
 * Laedt ein Asset zur Auslieferung - immer zusammen mit der Album-Kennung,
 * damit der Aufrufer pruefen kann, ob es ueberhaupt zum vorgelegten Token
 * gehoert. Ohne diese Pruefung waere jede Asset-Kennung aus jedem Album
 * abrufbar, sobald jemand irgendeinen gueltigen Galerie-Link besitzt.
 */
export function getAssetForDelivery(assetId: string): AssetForDelivery | null {
  return (
    (getDb()
      .prepare(
        `SELECT a.id, a.album_id, a.kind, a.original_path, a.original_filename,
                a.mime, a.bytes, u.slug AS uploader_slug, a.taken_at, a.created_at
           FROM assets a
           LEFT JOIN uploaders u ON u.id = a.uploader_id
          WHERE a.id = ? AND a.deleted_at IS NULL AND a.status = 'ready'`,
      )
      .get(assetId) as AssetForDelivery | undefined) ?? null
  );
}

/** Assets fuer den Sammel-Download, wahlweise gefiltert. */
export function listAssetsForZip(
  albumId: string,
  opts: { assetIds?: string[]; uploaderId?: string } = {},
): AssetForDelivery[] {
  const db = getDb();

  if (opts.assetIds && opts.assetIds.length > 0) {
    const placeholders = opts.assetIds.map(() => '?').join(',');
    return db
      .prepare(
        `SELECT a.id, a.album_id, a.kind, a.original_path, a.original_filename,
                a.mime, a.bytes, u.slug AS uploader_slug, a.taken_at, a.created_at
           FROM assets a
           LEFT JOIN uploaders u ON u.id = a.uploader_id
          WHERE a.album_id = ? AND a.deleted_at IS NULL AND a.status = 'ready'
            AND a.id IN (${placeholders})
          ORDER BY COALESCE(a.taken_at, a.created_at) ASC`,
      )
      .all(albumId, ...opts.assetIds) as AssetForDelivery[];
  }

  if (opts.uploaderId) {
    return db
      .prepare(
        `SELECT a.id, a.album_id, a.kind, a.original_path, a.original_filename,
                a.mime, a.bytes, u.slug AS uploader_slug, a.taken_at, a.created_at
           FROM assets a
           LEFT JOIN uploaders u ON u.id = a.uploader_id
          WHERE a.album_id = ? AND a.deleted_at IS NULL AND a.status = 'ready'
            AND a.uploader_id = ?
          ORDER BY COALESCE(a.taken_at, a.created_at) ASC`,
      )
      .all(albumId, opts.uploaderId) as AssetForDelivery[];
  }

  return db
    .prepare(
      `SELECT a.id, a.album_id, a.kind, a.original_path, a.original_filename,
              a.mime, a.bytes, u.slug AS uploader_slug, a.taken_at, a.created_at
         FROM assets a
         LEFT JOIN uploaders u ON u.id = a.uploader_id
        WHERE a.album_id = ? AND a.deleted_at IS NULL AND a.status = 'ready'
        ORDER BY COALESCE(a.taken_at, a.created_at) ASC`,
    )
    .all(albumId) as AssetForDelivery[];
}
