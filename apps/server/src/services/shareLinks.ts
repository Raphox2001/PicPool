import type { ShareLinkKind } from '@picpool/shared';
import { getDb, nowIso } from '../db/index.js';
import { generateToken, hashToken, randomId, encryptAtRest, decryptAtRest } from '../lib/crypto.js';
import { getConfig } from '../config.js';
import { getAlbumById, type Album } from './albums.js';

export interface ShareLink {
  id: string;
  album_id: string;
  kind: ShareLinkKind;
  token_hash: string;
  token_enc: string;
  label: string | null;
  pin_hash: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
}

export interface CreatedShareLink {
  link: ShareLink;
  /** Klartext-Token. Wird nicht gespeichert, nur verschluesselt abgelegt. */
  token: string;
  url: string;
}

export function createShareLink(
  albumId: string,
  kind: ShareLinkKind,
  opts: { label?: string; expiresAt?: string | null } = {},
): CreatedShareLink {
  const db = getDb();
  const token = generateToken();
  const id = randomId();

  db.prepare(
    `INSERT INTO share_links (id, album_id, kind, token_hash, token_enc, label, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    albumId,
    kind,
    hashToken(token),
    encryptAtRest(token, 'share-token'),
    opts.label ?? null,
    opts.expiresAt ?? null,
    nowIso(),
  );

  const link = db.prepare('SELECT * FROM share_links WHERE id = ?').get(id) as ShareLink;
  return { link, token, url: buildUrl(kind, token) };
}

export function buildUrl(kind: ShareLinkKind, token: string): string {
  const base = getConfig().publicUrl;
  return kind === 'upload' ? `${base}/u/${token}` : `${base}/g/${token}`;
}

/**
 * Macht das Klartext-Token fuer die Admin-Anzeige wieder verfuegbar.
 *
 * Das ist der Grund, warum Tokens zusaetzlich zum Hash auch verschluesselt
 * abgelegt werden: ein QR-Code muss Wochen spaeter erneut ausgedruckt werden
 * koennen, ohne den Link zu erneuern. Ein gestohlenes Datenbank-Backup allein
 * nuetzt trotzdem nichts, solange der Schluessel nicht daneben liegt.
 */
export function revealToken(link: ShareLink): string {
  return decryptAtRest(link.token_enc, 'share-token');
}

export type ResolveFailure =
  | 'not_found'
  | 'revoked'
  | 'expired'
  | 'wrong_kind'
  | 'album_missing'
  | 'album_archived';

export type ResolveResult =
  | { ok: true; link: ShareLink; album: Album }
  | { ok: false; reason: ResolveFailure };

/**
 * Loest ein Token auf und prueft alle Gueltigkeitsbedingungen.
 *
 * Nach aussen werden die Gruende NICHT unterschieden: ein Angreifer soll aus
 * der Antwort nicht ablesen koennen, ob ein geratenes Token existiert und nur
 * abgelaufen ist. Die Unterscheidung dient allein dem Log.
 */
export function resolveToken(token: string, expectedKind: ShareLinkKind): ResolveResult {
  const db = getDb();

  const link = db
    .prepare('SELECT * FROM share_links WHERE token_hash = ?')
    .get(hashToken(token)) as ShareLink | undefined;

  if (!link) return { ok: false, reason: 'not_found' };
  if (link.kind !== expectedKind) return { ok: false, reason: 'wrong_kind' };
  if (link.revoked_at) return { ok: false, reason: 'revoked' };
  if (link.expires_at && link.expires_at < nowIso()) return { ok: false, reason: 'expired' };

  const album = getAlbumById(link.album_id);
  if (!album) return { ok: false, reason: 'album_missing' };
  if (album.archived_at) return { ok: false, reason: 'album_archived' };

  return { ok: true, link, album };
}

export function recordUse(linkId: string): void {
  getDb()
    .prepare('UPDATE share_links SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?')
    .run(nowIso(), linkId);
}

export function revokeShareLink(linkId: string): void {
  getDb().prepare('UPDATE share_links SET revoked_at = ? WHERE id = ?').run(nowIso(), linkId);
}

export function listShareLinks(albumId: string): ShareLink[] {
  return getDb()
    .prepare('SELECT * FROM share_links WHERE album_id = ? ORDER BY created_at')
    .all(albumId) as ShareLink[];
}
