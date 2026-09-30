import type { FastifyInstance } from 'fastify';
import { getConfig } from '../config.js';
import { resolveToken } from '../services/shareLinks.js';
import { getAlbumUsage } from '../services/albums.js';
import { getDb } from '../db/index.js';
import { pseudonymizeIp } from '../lib/crypto.js';
import { startSession, touchSession, recordFailedFile } from '../services/uploadSessions.js';

/**
 * Oeffentliche Endpunkte fuer Gaeste. Keine Anmeldung, nur das Token.
 *
 * Die Antworten enthalten bewusst so wenig wie moeglich: Albumname und
 * Grenzwerte. Keine IDs, keine Uploader-Liste, keine Zaehlerstaende anderer -
 * ein Upload-Link soll nicht verraten, wer sonst noch beigetragen hat.
 */
export function registerPublicRoutes(app: FastifyInstance): void {
  const cfg = getConfig();

  app.get<{ Params: { token: string } }>(
    '/api/u/:token',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        params: {
          type: 'object',
          properties: { token: { type: 'string', minLength: 10, maxLength: 64 } },
          required: ['token'],
        },
      },
    },
    async (req, reply) => {
      const resolved = resolveToken(req.params.token, 'upload');

      if (!resolved.ok) {
        app.log.info({ reason: resolved.reason }, 'Upload-Link nicht aufloesbar');
        // Ein einziger Grund nach aussen: sonst liesse sich aus den Antworten
        // ablesen, welche geratenen Tokens existieren.
        return reply.code(404).send({
          ok: false,
          message: 'Dieser Link ist nicht gueltig oder abgelaufen.',
        });
      }

      const { album } = resolved;
      const usage = getAlbumUsage(album.id);

      const remainingFiles =
        album.max_files === null ? null : Math.max(0, album.max_files - usage.files);
      const remainingBytes =
        album.max_bytes === null ? null : Math.max(0, album.max_bytes - usage.bytes);

      return {
        ok: true,
        album: {
          name: album.name,
          description: album.description,
          eventDate: album.event_date,
        },
        limits: {
          maxFileBytes: cfg.limits.maxFileBytes,
          remainingFiles,
          remainingBytes,
        },
      };
    },
  );

  /**
   * Meldet eine Upload-Sitzung an und haelt sie am Leben.
   *
   * Ein Aufruf ohne `id` legt eine Sitzung an und gibt ihre Kennung zurueck;
   * mit `id` ist es ein Lebenszeichen. Dieselbe Route nimmt auch den Plan
   * ("zwoelf Dateien, 340 MB ausgewaehlt") und die Abmeldung entgegen - mehr
   * Endpunkte braucht es dafuer nicht.
   *
   * Der Nutzen steckt im Plan: Ohne ihn sieht der Server nur, was ankommt.
   * Mit ihm ist ein Abbruch erkennbar, auch wenn das Geraet nichts mehr
   * melden kann - siehe services/uploadSessions.ts.
   */
  app.post<{
    Params: { token: string };
    Body: { id?: string; selectedFiles?: number; selectedBytes?: number; finished?: boolean };
  }>(
    '/api/u/:token/session',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', maxLength: 64 },
            // Obergrenzen, damit eine erfundene Meldung die Anzeige nicht
            // unbrauchbar macht. Die Zahlen sind ohnehin nur der Vergleichswert
            // zu dem, was der Server selbst gezaehlt hat.
            selectedFiles: { type: 'integer', minimum: 0, maximum: 10000 },
            selectedBytes: { type: 'integer', minimum: 0, maximum: 1099511627776 },
            finished: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const resolved = resolveToken(req.params.token, 'upload');
      if (!resolved.ok) return reply.code(404).send({ ok: false });

      const b = req.body ?? {};
      const patch = {
        selectedFiles: b.selectedFiles,
        selectedBytes: b.selectedBytes,
        finished: b.finished === true,
      };

      // Eine unbekannte Kennung wird nicht angemeckert, sondern ersetzt: Nach
      // einem Neustart des Servers oder abgelaufener Aufbewahrung haelt das
      // Handy noch eine alte ID in der Hand, und der Gast soll davon nichts
      // mitbekommen.
      const existing = b.id ? touchSession(b.id, resolved.link.id, patch) : null;
      if (existing) return { ok: true, id: existing.id };

      const session = startSession({
        linkId: resolved.link.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      const started = touchSession(session.id, resolved.link.id, patch);

      return { ok: true, id: (started ?? session).id };
    },
  );

  /**
   * Nimmt Fehlerberichte der Upload-Seite entgegen.
   *
   * Ohne das ist ein fehlgeschlagener Upload nicht nachvollziehbar: Der Fehler
   * passiert auf dem Handy eines Gastes, an dessen Entwicklerkonsole niemand
   * herankommt. Mit dem Bericht steht die Ursache im Serverlog.
   *
   * Der Inhalt kommt von aussen und wird entsprechend behandelt: feste
   * Feldlaengen, keine Auswertung, nur Protokollierung.
   */
  app.post<{
    Params: { token: string };
    Body: {
      filename?: string;
      fileSize?: number;
      fileType?: string;
      phase?: string;
      message?: string;
      httpStatus?: number;
      responseBody?: string;
      uploadUrl?: string;
      bytesSent?: number;
      attempt?: number;
      userAgent?: string;
      context?: string;
      sessionId?: string;
    };
  }>(
    '/api/u/:token/report',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            filename: { type: 'string', maxLength: 255 },
            fileSize: { type: 'number' },
            fileType: { type: 'string', maxLength: 100 },
            phase: { type: 'string', maxLength: 40 },
            message: { type: 'string', maxLength: 1000 },
            httpStatus: { type: 'number' },
            responseBody: { type: 'string', maxLength: 1000 },
            uploadUrl: { type: 'string', maxLength: 300 },
            bytesSent: { type: 'number' },
            attempt: { type: 'number' },
            userAgent: { type: 'string', maxLength: 400 },
            context: { type: 'string', maxLength: 600 },
            sessionId: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (req, reply) => {
      const resolved = resolveToken(req.params.token, 'upload');
      if (!resolved.ok) return reply.code(404).send({ ok: false });

      const b = req.body ?? {};

      app.log.error(
        {
          upload_fehler: {
            album: resolved.album.slug,
            datei: b.filename,
            groesse: b.fileSize,
            typ: b.fileType,
            phase: b.phase,
            gesendet: b.bytesSent,
            versuch: b.attempt,
            httpStatus: b.httpStatus,
            antwort: b.responseBody,
            uploadUrl: b.uploadUrl,
            meldung: b.message,
            userAgent: b.userAgent,
            umstaende: b.context,
          },
        },
        'Upload auf dem Geraet fehlgeschlagen',
      );

      // Auch in der Sitzung vermerken, damit eine Zeile in der Uebersicht die
      // ganze Geschichte erzaehlt und nicht erst der Abgleich mit dem Log.
      if (b.sessionId) {
        recordFailedFile(
          b.sessionId,
          resolved.link.id,
          `${b.filename ?? 'unbekannt'}: ${b.message ?? 'ohne Meldung'}`,
        );
      }

      getDb()
        .prepare(
          `INSERT INTO audit_log (at, actor, action, target_type, target_id, ip, detail)
           VALUES (?, 'guest', 'upload_failed', 'album', ?, ?, ?)`,
        )
        .run(
          new Date().toISOString(),
          resolved.album.id,
          pseudonymizeIp(req.ip),
          JSON.stringify(b).slice(0, 4000),
        );

      return { ok: true };
    },
  );

  /**
   * Meldet den Verarbeitungsstand hochgeladener Dateien.
   *
   * Die Upload-Seite fragt das nach Abschluss ab, damit sie erst dann
   * "fertig" meldet, wenn die Dateien tatsaechlich im Bestand sind - und
   * nicht schon, wenn nur die Bytes angekommen sind.
   */
  app.post<{ Params: { token: string }; Body: { assetIds?: string[] } }>(
    '/api/u/:token/status',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          properties: {
            assetIds: {
              type: 'array',
              maxItems: 500,
              items: { type: 'string', maxLength: 64 },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const resolved = resolveToken(req.params.token, 'upload');
      if (!resolved.ok) {
        return reply.code(404).send({ ok: false });
      }

      const ids = req.body?.assetIds ?? [];
      if (ids.length === 0) return { ok: true, assets: [] };

      const placeholders = ids.map(() => '?').join(',');
      const rows = getDb()
        .prepare(
          `SELECT id, status FROM assets
            WHERE album_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
        )
        .all(resolved.album.id, ...ids) as Array<{ id: string; status: string }>;

      return { ok: true, assets: rows };
    },
  );
}
