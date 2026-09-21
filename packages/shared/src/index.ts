/** Gemeinsame Typen und Konstanten fuer Server, Galerie und Upload-Seite. */

export const ASSET_KINDS = ['image', 'video'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_STATUS = ['pending', 'processing', 'ready', 'failed'] as const;
export type AssetStatus = (typeof ASSET_STATUS)[number];

export const SHARE_LINK_KINDS = ['upload', 'gallery'] as const;
export type ShareLinkKind = (typeof SHARE_LINK_KINDS)[number];

export const DERIVATIVE_VARIANTS = ['thumb', 'preview', 'poster', 'video_h264'] as const;
export type DerivativeVariant = (typeof DERIVATIVE_VARIANTS)[number];

/**
 * Erlaubte Upload-Typen. Bewusst als Allowlist gefuehrt und beim Upload gegen
 * die Magic Bytes geprueft, nicht gegen die Dateiendung.
 *
 * SVG fehlt absichtlich: SVG ist ausfuehrbares XML und waere ein XSS-Vektor,
 * sobald es im Browser gerendert wird.
 */
export const ALLOWED_IMAGE_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/tiff',
] as const;

export const ALLOWED_VIDEO_MIME = [
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
  'video/3gpp',
] as const;

export const ALLOWED_MIME = [...ALLOWED_IMAGE_MIME, ...ALLOWED_VIDEO_MIME] as const;
export type AllowedMime = (typeof ALLOWED_MIME)[number];

export function kindForMime(mime: string): AssetKind | null {
  if ((ALLOWED_IMAGE_MIME as readonly string[]).includes(mime)) return 'image';
  if ((ALLOWED_VIDEO_MIME as readonly string[]).includes(mime)) return 'video';
  return null;
}

/** HEIC/HEIF muessen ueber ffmpeg dekodiert werden - sharp kann kein HEVC. */
export function needsFfmpegDecode(mime: string): boolean {
  return mime === 'image/heic' || mime === 'image/heif';
}

export interface PublicAsset {
  id: string;
  kind: AssetKind;
  uploaderName: string | null;
  takenAt: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbhash: string | null;
  originalFilename: string;
  bytes: number;
}

export interface PublicAlbum {
  name: string;
  description: string | null;
  eventDate: string | null;
  allowDownloads: boolean;
  assetCount: number;
}
