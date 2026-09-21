import type { FastifyInstance, FastifyRequest } from 'fastify';
import fsp from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { getConfig } from '../config.js';
import { getDb, nowIso } from '../db/index.js';
import { pseudonymizeIp } from '../lib/crypto.js';
import { assertWithinRoot } from '../lib/slug.js';
import { requireAdmin } from './adminAuth.js';
import {
  createAlbum,
  listAlbums,
  getAlbumById,
  getAlbumUsage,
  type Album,
} from '../services/albums.js';
import {
  createShareLink,
  listShareLinks,
  revealToken,
  buildUrl,
  revokeShareLink,
} from '../services/shareLinks.js';
import { listUploadersWithCounts } from '../services/uploaders.js';
import { listGalleryAssets } from '../services/gallery.js';
import { queueStats } from '../jobs/queue.js';

/**
 * Verwaltung fuer den Betreiber.
 *
 * Jede Route liegt hinter requireAdmin; veraendernde Anfragen zusaetzlich
 * hinter der CSRF-Pruefung. Was hier passiert, landet im Audit-Log - nicht
 * aus Misstrauen, sondern damit spaeter nachvollziehbar ist, warum ein Link
 * nicht mehr geht oder ein Bild verschwunden ist.
 */

function audit(req: FastifyRequest, action: string, targetType: string | null, targetId: string | null, detail?: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO audit_log (at, actor, action, target_type, target_id, ip, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      nowIso(),
      req.adminUser?.username ?? 'unbekannt',
      action,
      targetType,
      targetId,
      pseudonymizeIp(req.ip),
      detail ? JSON.stringify(detail).slice(0, 2000) : null,
    );
}

function albumSummary(album: Album) {
  const usage = getAlbumUsage(album.id);
  const links = listShareLinks(album.id);

  return {
    id: album.id,
    slug: album.slug,
    name: album.name,
    description: album.description,
    eventDate: album.event_date,
    createdAt: album.created_at,
    archivedAt: album.archived_at,
    files: usage.files,
    bytes: usage.bytes,
    settings: {
      allowDownloads: album.allow_downloads === 1,
      allowOriginalsOnLan: album.allow_originals_on_lan === 1,
      stripGps: album.strip_gps === 1,
      maxFiles: album.max_files,
      maxBytes: album.max_bytes,
    },
    links: links.map((l) => ({
      id: l.id,
      kind: l.kind,
      label: l.label,
      url: l.revoked_at ? null : buildUrl(l.kind, revealToken(l)),
      revokedAt: l.revoked_at,
      expiresAt: l.expires_at,
      useCount: l.use_count,
      lastUsedAt: l.last_used_at,
    })),
  };
}

export function registerAdminRoutes(app: FastifyInstance): void {
  const cfg = getConfig();

  // Alle Routen dieses Bereichs verlangen eine gueltige Sitzung.
  const guard = { preHandler: requireAdmin };

  // -------------------------------------------------------------------------
  // Überblick
  // -------------------------------------------------------------------------

  app.get('/api/admin/overview', guard, async () => {
    const albums = listAlbums();
    const totals = albums.reduce(
      (acc, a) => {
        const u = getAlbumUsage(a.id);
        return { files: acc.files + u.files, bytes: acc.bytes + u.bytes };
      },
      { files: 0, bytes: 0 },
    );

    const failed = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM assets WHERE status = 'failed' AND deleted_at IS NULL`)
      .get() as { n: number };

    const recentErrors = getDb()
      .prepare(
        `SELECT at, detail FROM audit_log WHERE action = 'upload_failed' ORDER BY id DESC LIMIT 10`,
      )
      .all() as Array<{ at: string; detail: string }>;

    return {
      ok: true,
      albums: albums.length,
      files: totals.files,
      bytes: totals.bytes,
      failedAssets: failed.n,
      jobs: queueStats(),
      recentUploadErrors: recentErrors.map((r) => {
        let d: Record<string, unknown> = {};
        try {
          d = JSON.parse(r.detail) as Record<string, unknown>;
        } catch {
          /* unlesbar */
        }
        return { at: r.at, filename: d.filename, message: d.message, context: d.context };
      }),
    };
  });

  // -------------------------------------------------------------------------
  // Alben
  // -------------------------------------------------------------------------

  app.get('/api/admin/albums', guard, async () => ({
    ok: true,
    albums: listAlbums().map(albumSummary),
  }));

  app.post<{
    Body: {
      name?: string;
      description?: string | null;
      eventDate?: string | null;
      maxFiles?: number | null;
      maxGb?: number | null;
    };
  }>('/api/admin/albums', guard, async (req, reply) => {
    const name = (req.body?.name ?? '').trim();
    if (name.length < 2) {
      return reply.code(400).send({ ok: false, message: 'Bitte einen Namen angeben.' });
    }

    const album = createAlbum({
      name,
      description: req.body?.description ?? null,
      eventDate: req.body?.eventDate ?? null,
      maxFiles: req.body?.maxFiles ?? null,
      maxBytes: req.body?.maxGb ? Math.round(req.body.maxGb * 1024 ** 3) : null,
    });

    // Beide Links gleich mitanlegen - genau dafuer wird ein Album erstellt.
    createShareLink(album.id, 'upload', { label: 'Standard' });
    createShareLink(album.id, 'gallery', { label: 'Standard' });

    audit(req, 'album_created', 'album', album.id, { name: album.name });
    return { ok: true, album: albumSummary(getAlbumById(album.id)!) };
  });

  app.get<{ Params: { id: string } }>('/api/admin/albums/:id', guard, async (req, reply) => {
    const album = getAlbumById(req.params.id);
    if (!album) return reply.code(404).send({ ok: false });

    return {
      ok: true,
      album: albumSummary(album),
      uploaders: listUploadersWithCounts(album.id),
      assets: listGalleryAssets(album.id),
    };
  });

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string | null;
      eventDate?: string | null;
      allowDownloads?: boolean;
      allowOriginalsOnLan?: boolean;
      stripGps?: boolean;
      maxFiles?: number | null;
      maxGb?: number | null;
      archived?: boolean;
    };
  }>('/api/admin/albums/:id', guard, async (req, reply) => {
    const album = getAlbumById(req.params.id);
    if (!album) return reply.code(404).send({ ok: false });

    const b = req.body ?? {};
    const sets: string[] = [];
    const values: unknown[] = [];

    const put = (col: string, value: unknown): void => {
      sets.push(`${col} = ?`);
      values.push(value);
    };

    if (typeof b.name === 'string' && b.name.trim().length >= 2) put('name', b.name.trim());
    if (b.description !== undefined) put('description', b.description);
    if (b.eventDate !== undefined) put('event_date', b.eventDate);
    if (typeof b.allowDownloads === 'boolean') put('allow_downloads', b.allowDownloads ? 1 : 0);
    if (typeof b.allowOriginalsOnLan === 'boolean') put('allow_originals_on_lan', b.allowOriginalsOnLan ? 1 : 0);
    if (typeof b.stripGps === 'boolean') put('strip_gps', b.stripGps ? 1 : 0);
    if (b.maxFiles !== undefined) put('max_files', b.maxFiles);
    if (b.maxGb !== undefined) put('max_bytes', b.maxGb === null ? null : Math.round(b.maxGb * 1024 ** 3));
    if (typeof b.archived === 'boolean') put('archived_at', b.archived ? nowIso() : null);

    if (sets.length === 0) return reply.code(400).send({ ok: false, message: 'Nichts zu ändern.' });

    put('updated_at', nowIso());
    getDb()
      .prepare(`UPDATE albums SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, album.id);

    audit(req, 'album_updated', 'album', album.id, b);
    return { ok: true, album: albumSummary(getAlbumById(album.id)!) };
  });

  /**
   * Loescht ein Album mitsamt Dateien.
   *
   * Unwiderruflich, daher muss der Albumname zur Bestaetigung mitgeschickt
   * werden. Ein versehentlicher Klick soll nicht die Bilder eines ganzen
   * Events vernichten.
   */
  app.delete<{ Params: { id: string }; Body: { confirmName?: string } }>(
    '/api/admin/albums/:id',
    guard,
    async (req, reply) => {
      const album = getAlbumById(req.params.id);
      if (!album) return reply.code(404).send({ ok: false });

      if ((req.body?.confirmName ?? '').trim() !== album.name) {
        return reply.code(400).send({
          ok: false,
          message: 'Zur Bestätigung bitte den Albumnamen genau so eingeben.',
        });
      }

      const usage = getAlbumUsage(album.id);

      // Erst die Dateien, dann die Datenbankeintraege. Andersherum bliebe bei
      // einem Fehler verwaistes Material auf der Platte liegen, das niemand
      // mehr zuordnen kann.
      for (const dir of [
        path.join(cfg.paths.originals, album.slug),
        path.join(cfg.paths.derivatives, album.id),
      ]) {
        try {
          assertWithinRoot(cfg.paths.root, dir);
          await fsp.rm(dir, { recursive: true, force: true });
        } catch (err) {
          app.log.error({ err, dir }, 'Konnte Verzeichnis nicht loeschen');
        }
      }

      // Alles Abhaengige haengt per ON DELETE CASCADE daran.
      getDb().prepare('DELETE FROM albums WHERE id = ?').run(album.id);

      audit(req, 'album_deleted', 'album', album.id, { name: album.name, files: usage.files });
      app.log.warn({ album: album.name, files: usage.files }, 'Album geloescht');
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Links und QR-Codes
  // -------------------------------------------------------------------------

  app.post<{ Params: { id: string }; Body: { kind?: string; label?: string; expiresAt?: string | null } }>(
    '/api/admin/albums/:id/links',
    guard,
    async (req, reply) => {
      const album = getAlbumById(req.params.id);
      if (!album) return reply.code(404).send({ ok: false });

      const kind = req.body?.kind;
      if (kind !== 'upload' && kind !== 'gallery') {
        return reply.code(400).send({ ok: false, message: 'Art muss upload oder gallery sein.' });
      }

      const created = createShareLink(album.id, kind, {
        label: req.body?.label,
        expiresAt: req.body?.expiresAt ?? null,
      });

      audit(req, 'link_created', 'album', album.id, { kind });
      return { ok: true, url: created.url, id: created.link.id };
    },
  );

  app.delete<{ Params: { linkId: string } }>('/api/admin/links/:linkId', guard, async (req, reply) => {
    const link = getDb()
      .prepare('SELECT id, album_id, kind FROM share_links WHERE id = ?')
      .get(req.params.linkId) as { id: string; album_id: string; kind: string } | undefined;

    if (!link) return reply.code(404).send({ ok: false });

    revokeShareLink(link.id);
    audit(req, 'link_revoked', 'album', link.album_id, { kind: link.kind });
    return { ok: true };
  });

  /**
   * QR-Code zu einem Link, als PNG zum Ausdrucken.
   *
   * Bewusst grosszuegig dimensioniert: Der Code haengt spaeter womoeglich
   * ausgedruckt an einer Wand und wird aus zwei Metern Entfernung gescannt.
   */
  app.get<{ Params: { linkId: string }; Querystring: { size?: string } }>(
    '/api/admin/links/:linkId/qr.png',
    guard,
    async (req, reply) => {
      const row = getDb()
        .prepare('SELECT * FROM share_links WHERE id = ?')
        .get(req.params.linkId) as Parameters<typeof revealToken>[0] & { revoked_at: string | null };

      if (!row) return reply.code(404).send({ ok: false });
      if (row.revoked_at) {
        return reply.code(410).send({ ok: false, message: 'Dieser Link wurde zurückgezogen.' });
      }

      const size = Math.min(2000, Math.max(200, Number(req.query.size ?? 800)));
      const png = await QRCode.toBuffer(buildUrl(row.kind, revealToken(row)), {
        type: 'png',
        width: size,
        margin: 3,
        errorCorrectionLevel: 'M',
      });

      return reply
        .type('image/png')
        .header('Cache-Control', 'no-store')
        .header('Content-Disposition', `inline; filename="picpool-${row.kind}-qr.png"`)
        .send(png);
    },
  );

  // -------------------------------------------------------------------------
  // Moderation
  // -------------------------------------------------------------------------

  /**
   * Entfernt ein einzelnes Asset.
   *
   * Der Datenbankeintrag bleibt mit deleted_at stehen, die Dateien werden
   * geloescht. So bleibt nachvollziehbar, dass da etwas war - und ein
   * erneuter Upload derselben Datei wird nicht faelschlich als Dublette
   * abgewiesen, weil der Dedupe-Index geloeschte Eintraege ausnimmt.
   */
  app.delete<{ Params: { assetId: string } }>('/api/admin/assets/:assetId', guard, async (req, reply) => {
    const db = getDb();
    const asset = db
      .prepare('SELECT id, album_id, original_path, original_filename FROM assets WHERE id = ? AND deleted_at IS NULL')
      .get(req.params.assetId) as
      | { id: string; album_id: string; original_path: string; original_filename: string }
      | undefined;

    if (!asset) return reply.code(404).send({ ok: false });

    const derivatives = db
      .prepare('SELECT path FROM derivatives WHERE asset_id = ?')
      .all(asset.id) as Array<{ path: string }>;

    for (const rel of [asset.original_path, ...derivatives.map((d) => d.path)]) {
      const abs = path.join(cfg.paths.root, rel);
      try {
        assertWithinRoot(cfg.paths.root, abs);
        await fsp.unlink(abs);
      } catch {
        /* schon weg - nicht weiter schlimm */
      }
    }

    db.prepare('DELETE FROM derivatives WHERE asset_id = ?').run(asset.id);
    db.prepare('UPDATE assets SET deleted_at = ? WHERE id = ?').run(nowIso(), asset.id);

    audit(req, 'asset_deleted', 'asset', asset.id, {
      album: asset.album_id,
      filename: asset.original_filename,
    });
    return { ok: true };
  });

  /** Stellt fehlgeschlagene Verarbeitungen erneut in die Warteschlange. */
  app.post('/api/admin/reprocess-failed', guard, async (req) => {
    const db = getDb();
    const failed = db
      .prepare(`SELECT id FROM assets WHERE status = 'failed' AND deleted_at IS NULL`)
      .all() as Array<{ id: string }>;

    const { enqueue } = await import('../jobs/queue.js');
    for (const a of failed) {
      db.prepare(`UPDATE assets SET status = 'pending', error = NULL WHERE id = ?`).run(a.id);
      enqueue('process_asset', { assetId: a.id }, { priority: 50 });
    }

    audit(req, 'reprocess_failed', null, null, { count: failed.length });
    return { ok: true, count: failed.length };
  });
}
