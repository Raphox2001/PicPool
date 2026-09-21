import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { getConfig } from '../config.js';
import { isInCidrs } from '../lib/network.js';
import { assertWithinRoot, slugify } from '../lib/slug.js';
import { resolveToken, recordUse } from '../services/shareLinks.js';
import { listUploadersWithCounts } from '../services/uploaders.js';
import { getAlbumUsage, type Album } from '../services/albums.js';
import {
  listGalleryAssets,
  getDerivative,
  getAssetForDelivery,
  listAssetsForZip,
  type AssetForDelivery,
} from '../services/gallery.js';

/**
 * Galerie fuer Gaeste.
 *
 * Abgestufte Aufloesung ist hier der Kern:
 *   thumb   ~320px   Raster
 *   preview ~2048px  Lightbox - gut aufgeloest, aber schnell geladen
 *   original         nur beim Download, oder im LAN wenn erlaubt
 *
 * Medien werden niemals direkt aus dem Dateisystem heraus bedient. Jede
 * Anfrage laeuft ueber diese Routen, wird gegen das Token geprueft und traegt
 * feste Header - sonst waere ein Ablagepfad zu erraten, und eine hochgeladene
 * Datei liesse sich im Browser als HTML ausfuehren.
 */

type Variant = 'thumb' | 'preview' | 'original';

const CACHE_PRIVATE = 'private, max-age=604800, immutable';

export function registerGalleryRoutes(app: FastifyInstance): void {
  const cfg = getConfig();

  /**
   * Gilt der Anfragende als "im lokalen Netz"?
   *
   * Nur verlaesslich, weil trustProxy in app.ts eng auf den Reverse Proxy
   * begrenzt ist. Ohne das koennte ein Gast per X-Forwarded-For eine
   * LAN-Adresse behaupten und sich Originalaufloesung erschleichen.
   */
  const isLan = (req: FastifyRequest): boolean => isInCidrs(req.ip, cfg.lanCidrs);

  /** Darf dieser Anfragende Originale sehen oder herunterladen? */
  const mayHaveOriginals = (album: Album, req: FastifyRequest): boolean => {
    if (album.allow_downloads) return true;
    return album.allow_originals_on_lan === 1 && isLan(req);
  };

  // -------------------------------------------------------------------------
  // Album-Inhalt
  // -------------------------------------------------------------------------

  app.get<{ Params: { token: string } }>(
    '/api/g/:token',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const resolved = resolveToken(req.params.token, 'gallery');
      if (!resolved.ok) {
        app.log.info({ reason: resolved.reason }, 'Galerie-Link nicht aufloesbar');
        return reply
          .code(404)
          .send({ ok: false, message: 'Dieser Link ist nicht gueltig oder abgelaufen.' });
      }

      const { album } = resolved;
      recordUse(resolved.link.id);

      const assets = listGalleryAssets(album.id);
      const usage = getAlbumUsage(album.id);
      const lan = isLan(req);

      return {
        ok: true,
        album: {
          name: album.name,
          description: album.description,
          eventDate: album.event_date,
          assetCount: assets.length,
          totalBytes: usage.bytes,
          allowDownloads: album.allow_downloads === 1,
          // Die Galerie zeigt den Hinweis "Originalaufloesung" nur, wenn sie
          // hier auch tatsaechlich zu bekommen ist.
          originalsAvailable: mayHaveOriginals(album, req),
          onLan: lan,
        },
        uploaders: listUploadersWithCounts(album.id),
        assets,
      };
    },
  );

  // -------------------------------------------------------------------------
  // Einzelne Medien
  // -------------------------------------------------------------------------

  app.get<{ Params: { token: string; assetId: string; variant: string } }>(
    '/api/g/:token/a/:assetId/:variant',
    { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const resolved = resolveToken(req.params.token, 'gallery');
      if (!resolved.ok) return reply.code(404).send({ ok: false });

      const variant = req.params.variant as Variant;
      if (!['thumb', 'preview', 'original'].includes(variant)) {
        return reply.code(400).send({ ok: false });
      }

      const asset = getAssetForDelivery(req.params.assetId);
      // Die Zugehoerigkeit zum Album ist entscheidend: ohne diese Pruefung
      // koennte ein gueltiger Galerie-Link jedes Asset jedes Albums abrufen.
      if (!asset || asset.album_id !== resolved.album.id) {
        return reply.code(404).send({ ok: false });
      }

      if (variant === 'original') {
        if (!mayHaveOriginals(resolved.album, req)) {
          return reply.code(403).send({ ok: false, message: 'Downloads sind fuer dieses Album nicht freigegeben.' });
        }
        return sendOriginal(reply, asset, req.query as { dl?: string });
      }

      // Videos haben kein "preview", sondern ein "poster" aus einem Standbild.
      const wanted = variant === 'preview' && asset.kind === 'video' ? 'poster' : variant;
      const derivative = getDerivative(asset.id, wanted);

      if (!derivative) {
        // Noch nicht verarbeitet oder Derivat verlorengegangen.
        return reply.code(404).send({ ok: false });
      }

      const abs = path.join(cfg.paths.root, derivative.path);
      assertWithinRoot(cfg.paths.root, abs);

      if (!fs.existsSync(abs)) return reply.code(404).send({ ok: false });

      return reply
        .type(derivative.mime)
        .header('Cache-Control', CACHE_PRIVATE)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .send(fs.createReadStream(abs));
    },
  );

  /**
   * Liefert das Original aus.
   *
   * Ohne ausdruecklichen Download-Wunsch wird inline ausgeliefert, damit ein
   * Video im Browser abspielbar bleibt. In beiden Faellen gilt: nosniff und
   * eine Sandbox-CSP, damit eine hochgeladene Datei nie als aktives Dokument
   * im Ursprung der Anwendung ausgefuehrt werden kann.
   */
  function sendOriginal(reply: FastifyReply, asset: AssetForDelivery, query: { dl?: string }) {
    const cfgLocal = getConfig();
    const abs = path.join(cfgLocal.paths.root, asset.original_path);
    assertWithinRoot(cfgLocal.paths.root, abs);

    if (!fs.existsSync(abs)) return reply.code(404).send({ ok: false });

    const download = query.dl === '1';
    const filename = downloadName(asset);

    return reply
      .type(asset.mime)
      .header('Cache-Control', CACHE_PRIVATE)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Length', String(asset.bytes))
      .header(
        'Content-Disposition',
        `${download ? 'attachment' : 'inline'}; filename="${asciiName(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      )
      .send(fs.createReadStream(abs));
  }

  // -------------------------------------------------------------------------
  // Sammel-Download
  // -------------------------------------------------------------------------

  app.get<{
    Params: { token: string };
    Querystring: { ids?: string; uploader?: string };
  }>(
    '/api/g/:token/zip',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const resolved = resolveToken(req.params.token, 'gallery');
      if (!resolved.ok) return reply.code(404).send({ ok: false });

      if (!mayHaveOriginals(resolved.album, req)) {
        return reply.code(403).send({ ok: false, message: 'Downloads sind fuer dieses Album nicht freigegeben.' });
      }

      const ids = req.query.ids
        ? req.query.ids.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 1000)
        : undefined;

      const assets = listAssetsForZip(resolved.album.id, {
        assetIds: ids,
        uploaderId: req.query.uploader,
      });

      if (assets.length === 0) return reply.code(404).send({ ok: false, message: 'Nichts zum Herunterladen.' });

      const zipName = `${slugify(resolved.album.name, 'album')}.zip`;

      /**
       * Keine Kompression ("store").
       *
       * JPEG, HEIC und MP4 sind bereits komprimiert; ein Deflate-Durchlauf
       * bringt praktisch nichts, kostet aber auf dem Ryzen der NAS spuerbar
       * Rechenzeit. Der Archivstrom geht direkt an den Client, es entsteht
       * also keine Zwischendatei und der Speicherverbrauch bleibt flach -
       * auch bei einem Album mit vielen Gigabyte.
       */
      const archive = new ZipArchive({ store: true, zlib: { level: 0 } });

      archive.on('warning', (err: unknown) => {
        // Fehlende Einzeldateien sollen den gesamten Download nicht kippen.
        app.log.warn({ err }, 'Warnung beim Erzeugen des Archivs');
      });
      archive.on('error', (err: unknown) => {
        app.log.error({ err }, 'Fehler beim Erzeugen des Archivs');
        reply.raw.destroy();
      });

      reply
        .header('Content-Type', 'application/zip')
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header(
          'Content-Disposition',
          `attachment; filename="${asciiName(zipName)}"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
        );

      // Namenskollisionen vermeiden: zwei Gaeste koennen dieselbe
      // Kameradatei-Nummer haben.
      const used = new Set<string>();

      for (const asset of assets) {
        const abs = path.join(cfg.paths.root, asset.original_path);
        try {
          assertWithinRoot(cfg.paths.root, abs);
        } catch {
          continue;
        }
        if (!fs.existsSync(abs)) continue;

        const folder = asset.uploader_slug ?? 'ohne-namen';
        let name = `${folder}/${downloadName(asset)}`;
        let n = 2;
        while (used.has(name)) {
          const base = downloadName(asset);
          const ext = path.extname(base);
          name = `${folder}/${base.slice(0, -ext.length)}-${n}${ext}`;
          n++;
        }
        used.add(name);

        archive.file(abs, { name });
      }

      void archive.finalize();
      return reply.send(archive);
    },
  );
}

/**
 * Baut einen sprechenden Dateinamen.
 *
 * Kameras liefern Namen wie "1000162882.mp4", die nach dem Entpacken
 * nichtssagend sind. Mit vorangestelltem Aufnahmedatum liegt das Album
 * anschliessend sortiert im Ordner.
 */
function downloadName(asset: AssetForDelivery): string {
  const ext = path.extname(asset.original_filename) || '';
  const base = path.basename(asset.original_filename, ext);
  const when = (asset.taken_at ?? asset.created_at).slice(0, 19).replace(/[:T]/g, '-');
  return `${when}_${slugify(base, 'datei')}${ext.toLowerCase()}`;
}

/**
 * Rueckfallname fuer Clients, die den UTF-8-Parameter nicht verstehen.
 * Alles ausserhalb von ASCII wird ersetzt, damit der Header gueltig bleibt.
 */
function asciiName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}
