import type { FastifyInstance } from 'fastify';
import type http from 'node:http';
import fsp from 'node:fs/promises';
import { Server as TusServer, MemoryLocker, type Upload } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { getConfig } from '../config.js';
import { nowIso } from '../db/index.js';
import { resolveToken, recordUse } from '../services/shareLinks.js';
import { findOrCreateUploader, getUploader } from '../services/uploaders.js';
import { checkQuota } from '../services/albums.js';
import { ingestUpload, RejectedUpload } from '../services/assets.js';
import { cleanDisplayName } from '../lib/slug.js';

/**
 * Upload ueber das tus-Protokoll.
 *
 * Warum tus und nicht ein gewoehnlicher POST: Handyvideos sind regelmaessig
 * mehrere hundert Megabyte gross. Ein einzelner POST darueber bricht im
 * Mobilfunk an Timeouts ab - und genau daran scheitert der Photo Request von
 * Synology. tus zerlegt die Datei in Abschnitte, kann nach einem Abbruch an
 * der Unterbrechungsstelle weitermachen und uebersteht Netzwechsel,
 * gesperrte Bildschirme und neu geladene Seiten.
 *
 * Vertrauensmodell der Metadaten: Was der Client beim Anlegen schickt, gilt
 * als unbestaetigt. onUploadCreate loest das Token serverseitig auf und
 * ueberschreibt albumId und uploaderId mit den ermittelten Werten. Spaetere
 * PATCH-Anfragen koennen die Metadaten nicht mehr aendern, sie liegen im
 * Datastore. Was in onUploadFinish ankommt, stammt also vom Server.
 */

interface ValidatedMeta {
  albumId: string;
  uploaderId: string;
  token: string;
  filename: string;
}

function readMeta(upload: Upload): ValidatedMeta | null {
  const m = upload.metadata ?? {};
  if (!m.albumId || !m.uploaderId || !m.token) return null;
  return {
    albumId: m.albumId,
    uploaderId: m.uploaderId,
    token: m.token,
    filename: m.filename ?? 'unbenannt',
  };
}

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  const cfg = getConfig();

  const tus = new TusServer({
    path: '/api/upload',
    datastore: new FileStore({ directory: cfg.paths.incoming }),
    locker: new MemoryLocker(),
    maxSize: cfg.limits.maxFileBytes,

    // Hinter dem Reverse Proxy muss die Location-URL auf den oeffentlichen
    // Namen zeigen, nicht auf den internen Container-Host.
    respectForwardedHeaders: true,

    async onUploadCreate(req, res, upload) {
      const meta = upload.metadata ?? {};

      const token = typeof meta.token === 'string' ? meta.token : '';
      const rawName = typeof meta.uploaderName === 'string' ? meta.uploaderName : '';
      const filename = typeof meta.filename === 'string' ? meta.filename : 'unbenannt';

      const resolved = resolveToken(token, 'upload');
      if (!resolved.ok) {
        // Nach aussen bewusst ein einziger, unspezifischer Grund: ob ein
        // geratenes Token existiert und nur abgelaufen ist, geht niemanden an.
        app.log.warn({ reason: resolved.reason }, 'Upload mit ungueltigem Token abgewiesen');
        throw { status_code: 403, body: 'Dieser Upload-Link ist nicht (mehr) gueltig.' };
      }

      const displayName = cleanDisplayName(rawName);
      if (displayName.length < 2) {
        throw { status_code: 400, body: 'Bitte zuerst einen Namen eintragen.' };
      }

      const quota = checkQuota(resolved.album, upload.size ?? 0);
      if (!quota.ok) {
        throw { status_code: 413, body: quota.reason };
      }

      const uploader = findOrCreateUploader(resolved.album.id, displayName);
      recordUse(resolved.link.id);

      // Die vom Server ermittelten Werte ueberschreiben alles, was der Client
      // geschickt hat.
      return {
        res,
        metadata: {
          ...meta,
          filename,
          albumId: resolved.album.id,
          uploaderId: uploader.id,
          token,
        },
      };
    },

    async onUploadFinish(req, res, upload) {
      const meta = readMeta(upload);
      if (!meta) {
        throw { status_code: 400, body: 'Dem Upload fehlen Angaben.' };
      }

      // Erneut pruefen: der Link kann waehrend eines langen Uploads
      // zurueckgezogen worden sein.
      const resolved = resolveToken(meta.token, 'upload');
      if (!resolved.ok || resolved.album.id !== meta.albumId) {
        await discardUpload(upload);
        throw { status_code: 403, body: 'Dieser Upload-Link ist nicht mehr gueltig.' };
      }

      const tempPath = upload.storage?.path;
      if (!tempPath) {
        throw { status_code: 500, body: 'Interner Fehler beim Ablegen der Datei.' };
      }

      const uploader = getUploader(meta.uploaderId);
      if (!uploader) {
        await discardUpload(upload);
        throw { status_code: 400, body: 'Unbekannter Absender.' };
      }

      try {
        const result = await ingestUpload({
          tempPath,
          originalFilename: meta.filename,
          album: resolved.album,
          uploader,
        });

        await removeTusSidecar(upload);

        return {
          res,
          status_code: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ok: true,
            assetId: result.asset.id,
            duplicate: result.duplicate,
            receivedAt: nowIso(),
          }),
        };
      } catch (err) {
        if (err instanceof RejectedUpload) {
          await removeTusSidecar(upload);
          app.log.warn({ code: err.code, filename: meta.filename }, 'Upload abgelehnt');
          throw { status_code: 415, body: err.userMessage };
        }
        throw err;
      }
    },

    async onResponseError(_req, _res, err) {
      // Unerwartete Fehler nach aussen verallgemeinern, damit keine internen
      // Details nach draussen gelangen.
      if (err instanceof Error) {
        app.log.error({ err }, 'Fehler im Upload-Endpunkt');
        return { status_code: 500, body: 'Der Upload ist fehlgeschlagen. Bitte noch einmal versuchen.' };
      }
      return undefined;
    },
  });

  // Fastify darf den Body nicht anfassen: tus liest direkt vom Rohstrom.
  app.addContentTypeParser(
    'application/offset+octet-stream',
    (_req, _payload, done) => done(null),
  );

  const handle = (req: { raw: http.IncomingMessage }, reply: { raw: http.ServerResponse; hijack: () => void }): void => {
    reply.hijack();
    void tus.handle(req.raw, reply.raw);
  };

  app.route({
    method: ['POST', 'OPTIONS'],
    url: '/api/upload',
    config: { rateLimit: { max: cfg.limits.uploadRatePerIpPerMin, timeWindow: '1 minute' } },
    handler: (req, reply) => handle(req, reply),
  });

  app.route({
    method: ['HEAD', 'PATCH', 'DELETE', 'GET', 'OPTIONS'],
    url: '/api/upload/*',
    // Kein enges Rate-Limit auf PATCH: ein grosses Video besteht aus vielen
    // Abschnitten, das ist normaler Betrieb und kein Missbrauch.
    handler: (req, reply) => handle(req, reply),
  });
}

/** Entfernt die Nutzdaten und die Begleitdatei eines verworfenen Uploads. */
async function discardUpload(upload: Upload): Promise<void> {
  const p = upload.storage?.path;
  if (p) await fsp.unlink(p).catch(() => undefined);
  await removeTusSidecar(upload);
}

/**
 * Der FileStore legt neben der Datei eine .json mit dem Upload-Zustand ab.
 * Nach der Uebernahme in den Bestand ist sie gegenstandslos; ohne Aufraeumen
 * wuerde incoming/ unbegrenzt volllaufen.
 */
async function removeTusSidecar(upload: Upload): Promise<void> {
  const p = upload.storage?.path;
  if (!p) return;
  await fsp.unlink(`${p}.json`).catch(() => undefined);
}
