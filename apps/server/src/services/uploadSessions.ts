import { getDb, nowIso } from '../db/index.js';
import { randomId, pseudonymizeIp } from '../lib/crypto.js';

/**
 * Protokoll der Upload-Sitzungen - ein Datensatz je Besuch auf der
 * Upload-Seite.
 *
 * Warum das noetig ist: Fehlschlaege meldet die Upload-Seite selbst, mit allen
 * Einzelheiten (siehe /api/u/:token/report). Der schlimmste Fall meldet sich
 * aber nie - wird der Tab weggewischt, ist der Akku leer oder wirft Android
 * die Seite aus dem Speicher, kommt gar nichts mehr an. Von aussen ist das
 * nicht von "der Gast hat es sich anders ueberlegt" zu unterscheiden.
 *
 * Diese Sitzung schliesst die Luecke, weil sie den *Plan* kennt: Die Seite
 * meldet beim Auswaehlen, wie viele Dateien kommen sollen, und danach alle
 * zwanzig Sekunden ein Lebenszeichen. Kommen nur drei von zwoelf an und das
 * Lebenszeichen bleibt aus, steht das im Datensatz - ohne dass das Geraet
 * noch etwas sagen muesste.
 *
 * Vertrauensmodell: Die Zaehler fuer angekommene Dateien setzt der Server
 * selbst (aus onUploadFinish), nicht die Seite. Vom Client kommen nur der
 * Plan und das Lebenszeichen. Jede Schreiboperation ist auf den Link bzw. das
 * Album eingeschraenkt, mit dem sie hereinkommt - eine geratene Sitzungs-ID
 * aus einem anderen Album trifft keine Zeile.
 *
 * Datenschutz: Die IP wird nur pseudonymisiert abgelegt, die Geraetekennung
 * gekuerzt. Nach SESSION_RETENTION_DAYS raeumt das taegliche Aufraeumen die
 * Zeilen weg.
 */

/** Aufbewahrungsfrist. Danach loescht cleanupIncoming() die Sitzung. */
export const SESSION_RETENTION_DAYS = 90;

/**
 * Ab wann eine Sitzung als verstummt gilt.
 *
 * Das Lebenszeichen kommt alle 20 Sekunden. Drei verpasste in Folge sind kein
 * Funkloch mehr, sondern eine Seite, die nicht mehr da ist.
 */
export const SILENT_AFTER_MS = 90_000;

export interface UploadSessionRow {
  id: string;
  share_link_id: string;
  uploader_id: string | null;
  created_at: string;
  last_seen_at: string;
  ip_hash: string | null;
  user_agent: string | null;
  bytes_uploaded: number;
  files_uploaded: number;
  selected_files: number;
  selected_bytes: number;
  failed_files: number;
  last_error: string | null;
  finished_at: string | null;
}

/**
 * Wie die Sitzung ausgegangen ist.
 *
 *  fertig       Die Seite hat sich selbst abgemeldet.
 *  laeuft       Lebenszeichen ist frisch.
 *  abgebrochen  Verstummt, obwohl noch Dateien offen waren. Der Fall, um den
 *               es hier ueberhaupt geht.
 *  verstummt    Verstummt, nachdem alles abgearbeitet war - vermutlich hat der
 *               Gast die Seite einfach geschlossen.
 *  leer         Link geoeffnet, nie etwas ausgewaehlt.
 */
export type SessionOutcome = 'fertig' | 'laeuft' | 'abgebrochen' | 'verstummt' | 'leer';

export function sessionOutcome(row: UploadSessionRow, now = Date.now()): SessionOutcome {
  const handled = row.files_uploaded + row.failed_files;
  const open = Math.max(0, row.selected_files - handled);
  const silent = now - Date.parse(row.last_seen_at) > SILENT_AFTER_MS;

  // Die Zaehler haben Vorrang vor der Abmeldung: Waehlt der Gast nach einem
  // "Fertig!" noch einmal Dateien aus und bricht dann ab, steht die alte
  // Abmeldung noch in der Zeile - offen ist trotzdem offen.
  if (row.finished_at && open === 0) return 'fertig';
  if (!silent) return 'laeuft';
  if (open > 0) return 'abgebrochen';
  if (row.selected_files === 0 && handled === 0) return 'leer';
  return row.finished_at ? 'fertig' : 'verstummt';
}

/** Legt eine Sitzung an. Der Aufrufer hat das Token schon aufgeloest. */
export function startSession(args: {
  linkId: string;
  ip: string;
  userAgent: string | null;
}): UploadSessionRow {
  const db = getDb();
  const id = randomId();
  const now = nowIso();

  db.prepare(
    `INSERT INTO upload_sessions (id, share_link_id, created_at, last_seen_at, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, args.linkId, now, now, pseudonymizeIp(args.ip), args.userAgent?.slice(0, 400) ?? null);

  const created = getSessionForLink(id, args.linkId);
  if (!created) throw new Error('Sitzung konnte nicht angelegt werden.');
  return created;
}

/** Holt die Sitzung, aber nur wenn sie zu diesem Link gehoert. */
export function getSessionForLink(id: string, linkId: string): UploadSessionRow | null {
  return (
    (getDb()
      .prepare('SELECT * FROM upload_sessions WHERE id = ? AND share_link_id = ?')
      .get(id, linkId) as UploadSessionRow | undefined) ?? null
  );
}

/**
 * Lebenszeichen und Plan.
 *
 * Der Plan wird nur nach oben genommen: Waehlt der Gast nach dem ersten
 * Schwung noch einmal Dateien aus, waechst die Zahl - eine Seite, die sich
 * selbst zuruecksetzt, soll den Abbruch dagegen nicht verstecken koennen.
 */
export function touchSession(
  id: string,
  linkId: string,
  patch: { selectedFiles?: number; selectedBytes?: number; finished?: boolean } = {},
): UploadSessionRow | null {
  const session = getSessionForLink(id, linkId);
  if (!session) return null;

  const now = nowIso();
  getDb()
    .prepare(
      `UPDATE upload_sessions
          SET last_seen_at   = ?,
              selected_files = MAX(selected_files, ?),
              selected_bytes = MAX(selected_bytes, ?),
              finished_at    = COALESCE(finished_at, ?)
        WHERE id = ?`,
    )
    .run(
      now,
      Math.max(0, Math.floor(patch.selectedFiles ?? 0)),
      Math.max(0, Math.floor(patch.selectedBytes ?? 0)),
      patch.finished ? now : null,
      id,
    );

  return getSessionForLink(id, linkId);
}

/**
 * Zaehlt eine angekommene Datei - vom Server aus, nicht vom Client.
 *
 * Die Sitzungs-ID kommt aus den tus-Metadaten und ist damit unbestaetigt.
 * Deshalb die Einschraenkung auf das Album: Eine fremde oder geratene ID
 * trifft keine Zeile, und der Upload laeuft davon unbeeindruckt weiter.
 */
export function recordUploadedFile(
  sessionId: string,
  albumId: string,
  args: { bytes: number; uploaderId: string },
): void {
  getDb()
    .prepare(
      `UPDATE upload_sessions
          SET files_uploaded = files_uploaded + 1,
              bytes_uploaded = bytes_uploaded + ?,
              uploader_id    = COALESCE(uploader_id, ?),
              last_seen_at   = ?
        WHERE id = ?
          AND share_link_id IN (SELECT id FROM share_links WHERE album_id = ?)`,
    )
    .run(Math.max(0, Math.floor(args.bytes)), args.uploaderId, nowIso(), sessionId, albumId);
}

/** Haelt einen endgueltigen Fehlschlag in der Sitzung fest. */
export function recordFailedFile(sessionId: string, linkId: string, message: string): void {
  getDb()
    .prepare(
      `UPDATE upload_sessions
          SET failed_files = failed_files + 1,
              last_error   = ?,
              last_seen_at = ?
        WHERE id = ? AND share_link_id = ?`,
    )
    .run(message.slice(0, 500), nowIso(), sessionId, linkId);
}

export interface UploadSessionInfo {
  id: string;
  startedAt: string;
  lastSeenAt: string;
  finishedAt: string | null;
  outcome: SessionOutcome;
  uploaderName: string | null;
  device: string;
  userAgent: string | null;
  selectedFiles: number;
  selectedBytes: number;
  filesUploaded: number;
  bytesUploaded: number;
  failedFiles: number;
  lastError: string | null;
}

/** Sitzungen eines Albums, neueste zuerst. */
export function listSessions(albumId: string, limit = 50): UploadSessionInfo[] {
  const rows = getDb()
    .prepare(
      `SELECT s.*, u.name AS uploader_name
         FROM upload_sessions s
         JOIN share_links l ON l.id = s.share_link_id
    LEFT JOIN uploaders  u ON u.id = s.uploader_id
        WHERE l.album_id = ?
        ORDER BY s.created_at DESC
        LIMIT ?`,
    )
    .all(albumId, Math.min(500, Math.max(1, limit))) as Array<
    UploadSessionRow & { uploader_name: string | null }
  >;

  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    startedAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    finishedAt: r.finished_at,
    outcome: sessionOutcome(r, now),
    uploaderName: r.uploader_name,
    device: describeDevice(r.user_agent),
    userAgent: r.user_agent,
    selectedFiles: r.selected_files,
    selectedBytes: r.selected_bytes,
    filesUploaded: r.files_uploaded,
    bytesUploaded: r.bytes_uploaded,
    failedFiles: r.failed_files,
    lastError: r.last_error,
  }));
}

/**
 * Macht aus der Geraetekennung etwas Lesbares.
 *
 * Absichtlich grob: Fuer die Frage "scheitert das nur auf iPhones?" genuegen
 * System und Browser. Die vollstaendige Kennung bleibt daneben stehen, damit
 * nichts verloren geht.
 */
export function describeDevice(ua: string | null): string {
  if (!ua) return 'unbekannt';

  const system = /iPad/i.test(ua)
    ? 'iPad'
    : /iPhone/i.test(ua)
      ? 'iPhone'
      : /Android/i.test(ua)
        ? 'Android'
        : /Windows/i.test(ua)
          ? 'Windows'
          : /Macintosh/i.test(ua)
            ? 'Mac'
            : /Linux/i.test(ua)
              ? 'Linux'
              : 'unbekannt';

  // Die Reihenfolge zaehlt: Die eingebauten Browser nennen sich zusaetzlich
  // Chrome oder Safari, und Chrome nennt sich auch Safari.
  const browser = /(FBAN|FBAV)/i.test(ua)
    ? 'Facebook'
    : /Instagram/i.test(ua)
      ? 'Instagram'
      : /WhatsApp/i.test(ua)
        ? 'WhatsApp'
        : /EdgA?\//i.test(ua)
          ? 'Edge'
          : /SamsungBrowser/i.test(ua)
            ? 'Samsung Internet'
            : /Firefox|FxiOS/i.test(ua)
              ? 'Firefox'
              : /CriOS|Chrome/i.test(ua)
                ? 'Chrome'
                : /Safari/i.test(ua)
                  ? 'Safari'
                  : 'unbekannt';

  return `${system} · ${browser}`;
}

/** Raeumt Sitzungen ab, die aelter sind als die Aufbewahrungsfrist. */
export function deleteOldSessions(days = SESSION_RETENTION_DAYS): number {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const res = getDb().prepare('DELETE FROM upload_sessions WHERE last_seen_at < ?').run(cutoff);
  return res.changes;
}
