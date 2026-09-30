import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
// Nur der Typ - Typimporte werden zur Laufzeit entfernt und laden das Modul
// daher nicht vor der Konfiguration.
import type { UploadSessionRow } from './uploadSessions.js';

/**
 * Tests des Sitzungsprotokolls.
 *
 * Der Kern ist die Frage, die ohne dieses Protokoll unbeantwortbar war:
 * Hat der Gast abgebrochen, oder ist seine Seite gestorben? Genau das prueft
 * hier der Abschnitt "Ausgang einer Sitzung".
 *
 * Wie in den anderen Tests muss die Konfiguration vor dem ersten Import
 * stehen; jeder Lauf bekommt ein eigenes Datenverzeichnis.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picpool-sessions-'));
process.env.PICPOOL_DATA_DIR = tmp;
process.env.PICPOOL_PUBLIC_URL = 'http://127.0.0.1:8080';
process.env.PICPOOL_SECRET_KEY = crypto.randomBytes(32).toString('base64');

const sessions = await import('./uploadSessions.js');
const albums = await import('./albums.js');
const shareLinks = await import('./shareLinks.js');
const uploaders = await import('./uploaders.js');
const { closeDb, getDb } = await import('../db/index.js');

let albumId = '';
let linkId = '';
let otherLinkId = '';
let uploaderId = '';
let foreignSessionId = '';

before(() => {
  const album = albums.createAlbum({ name: 'Sitzungstest' });
  albumId = album.id;
  linkId = shareLinks.createShareLink(album.id, 'upload').link.id;
  uploaderId = uploaders.findOrCreateUploader(album.id, 'Oma Erika').id;

  const other = albums.createAlbum({ name: 'Fremdes Album' });
  otherLinkId = shareLinks.createShareLink(other.id, 'upload').link.id;
  foreignSessionId = sessions.startSession({
    linkId: otherLinkId,
    ip: '10.9.9.9',
    userAgent: null,
  }).id;
});

after(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Setzt last_seen_at zurueck, um Funkstille zu erzeugen. */
function silence(id: string, secondsAgo = 300): void {
  const at = new Date(Date.now() - secondsAgo * 1000).toISOString();
  getDb().prepare('UPDATE upload_sessions SET last_seen_at = ? WHERE id = ?').run(at, id);
}

function reload(id: string): UploadSessionRow {
  const row = sessions.getSessionForLink(id, linkId);
  assert.ok(row, 'Sitzung nicht gefunden');
  return row;
}

describe('Sitzung anlegen und fortschreiben', () => {
  test('legt eine Sitzung an und speichert die IP nur pseudonymisiert', () => {
    const s = sessions.startSession({
      linkId,
      ip: '192.168.0.42',
      userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130',
    });

    assert.equal(s.files_uploaded, 0);
    assert.equal(s.selected_files, 0);
    assert.ok(s.ip_hash && !s.ip_hash.includes('192.168'), 'IP im Klartext gespeichert');
  });

  test('zaehlt angekommene Dateien und merkt sich den Absender', () => {
    const s = sessions.startSession({ linkId, ip: '10.0.0.1', userAgent: null });

    sessions.recordUploadedFile(s.id, albumId, { bytes: 2_000_000, uploaderId });
    sessions.recordUploadedFile(s.id, albumId, { bytes: 1_000_000, uploaderId });

    const after1 = reload(s.id);
    assert.equal(after1.files_uploaded, 2);
    assert.equal(after1.bytes_uploaded, 3_000_000);
    assert.equal(after1.uploader_id, uploaderId);
  });

  test('der Plan waechst, schrumpft aber nicht', () => {
    const s = sessions.startSession({ linkId, ip: '10.0.0.2', userAgent: null });

    sessions.touchSession(s.id, linkId, { selectedFiles: 12, selectedBytes: 340_000_000 });
    assert.equal(reload(s.id).selected_files, 12);

    // Eine Seite, die sich selbst zuruecksetzt, darf den Abbruch nicht
    // verstecken koennen.
    sessions.touchSession(s.id, linkId, { selectedFiles: 1, selectedBytes: 10 });
    const row = reload(s.id);
    assert.equal(row.selected_files, 12);
    assert.equal(row.selected_bytes, 340_000_000);
  });

  test('haelt Fehlschlaege mit der letzten Meldung fest', () => {
    const s = sessions.startSession({ linkId, ip: '10.0.0.3', userAgent: null });

    sessions.recordFailedFile(s.id, linkId, 'IMG_1.jpg: Datei nicht mehr lesbar');
    const row = reload(s.id);

    assert.equal(row.failed_files, 1);
    assert.match(row.last_error ?? '', /nicht mehr lesbar/);
  });
});

describe('Fremde Sitzungen bleiben unberuehrt', () => {
  test('eine Kennung aus einem anderen Album trifft keine Zeile', () => {
    const foreign = sessions.startSession({ linkId: otherLinkId, ip: '10.0.0.4', userAgent: null });

    // So wuerde ein manipulierter Client es versuchen: fremde Sitzungs-ID,
    // eigenes Album.
    sessions.recordUploadedFile(foreign.id, albumId, { bytes: 999, uploaderId });
    sessions.recordFailedFile(foreign.id, linkId, 'untergeschoben');

    const row = sessions.getSessionForLink(foreign.id, otherLinkId);
    assert.ok(row);
    assert.equal(row.files_uploaded, 0);
    assert.equal(row.failed_files, 0);
  });

  test('getSessionForLink liefert nichts fuer den falschen Link', () => {
    const s = sessions.startSession({ linkId, ip: '10.0.0.5', userAgent: null });
    assert.equal(sessions.getSessionForLink(s.id, otherLinkId), null);
  });
});

describe('Ausgang einer Sitzung', () => {
  test('frisches Lebenszeichen heisst laeuft', () => {
    const s = sessions.startSession({ linkId, ip: '10.0.1.1', userAgent: null });
    sessions.touchSession(s.id, linkId, { selectedFiles: 5 });
    assert.equal(sessions.sessionOutcome(reload(s.id)), 'laeuft');
  });

  test('abgemeldet heisst fertig', () => {
    const s = sessions.startSession({ linkId, ip: '10.0.1.2', userAgent: null });
    sessions.touchSession(s.id, linkId, { selectedFiles: 1 });
    sessions.recordUploadedFile(s.id, albumId, { bytes: 10, uploaderId });
    sessions.touchSession(s.id, linkId, { finished: true });

    silence(s.id);
    assert.equal(sessions.sessionOutcome(reload(s.id)), 'fertig');
  });

  test('Funkstille mit offenen Dateien heisst abgebrochen', () => {
    const s = sessions.startSession({ linkId, ip: '10.0.1.3', userAgent: null });
    sessions.touchSession(s.id, linkId, { selectedFiles: 12 });
    sessions.recordUploadedFile(s.id, albumId, { bytes: 10, uploaderId });
    sessions.recordUploadedFile(s.id, albumId, { bytes: 10, uploaderId });

    silence(s.id);

    // Das ist der Fall, um den es geht: zwei von zwoelf, und das Geraet sagt
    // nichts mehr. Ohne Fehlerbericht, ohne Zutun des Gastes.
    assert.equal(sessions.sessionOutcome(reload(s.id)), 'abgebrochen');
  });

  test('ein Fehlschlag gilt als abgearbeitet, nicht als Abbruch', () => {
    const s = sessions.startSession({ linkId, ip: '10.0.1.4', userAgent: null });
    sessions.touchSession(s.id, linkId, { selectedFiles: 2 });
    sessions.recordUploadedFile(s.id, albumId, { bytes: 10, uploaderId });
    sessions.recordFailedFile(s.id, linkId, 'IMG_2.jpg: abgelehnt');

    silence(s.id);
    assert.equal(sessions.sessionOutcome(reload(s.id)), 'verstummt');
  });

  test('nach einem Fertig noch ausgewaehlte Dateien schlagen wieder durch', () => {
    const s = sessions.startSession({ linkId, ip: '10.0.1.5', userAgent: null });
    sessions.touchSession(s.id, linkId, { selectedFiles: 1 });
    sessions.recordUploadedFile(s.id, albumId, { bytes: 10, uploaderId });
    sessions.touchSession(s.id, linkId, { finished: true });

    // Der Gast waehlt noch einmal aus und bricht dann ab. Die alte Abmeldung
    // darf das nicht verdecken.
    sessions.touchSession(s.id, linkId, { selectedFiles: 4 });
    silence(s.id);

    assert.equal(sessions.sessionOutcome(reload(s.id)), 'abgebrochen');
  });

  test('Link geoeffnet, nichts ausgewaehlt', () => {
    const s = sessions.startSession({ linkId, ip: '10.0.1.6', userAgent: null });
    silence(s.id);
    assert.equal(sessions.sessionOutcome(reload(s.id)), 'leer');
  });
});

describe('Anzeige und Aufbewahrung', () => {
  test('listSessions liefert die Sitzungen des Albums mit Ausgang', () => {
    const list = sessions.listSessions(albumId, 500);
    assert.ok(list.length > 0);
    assert.ok(list.every((s) => typeof s.outcome === 'string'));
    // Die Sitzung des fremden Albums darf nicht dabei sein.
    assert.ok(list.every((s) => s.id !== foreignSessionId));
  });

  test('erkennt Geraete grob, aber verlaesslich', () => {
    assert.equal(
      sessions.describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Safari/605'),
      'iPhone · Safari',
    );
    assert.equal(
      sessions.describeDevice('Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/130 Mobile Safari/537'),
      'Android · Chrome',
    );
    // Der eingebaute Browser nennt sich zusaetzlich Chrome - hier muss
    // WhatsApp gewinnen, sonst sieht der Fall aus wie ein normaler Browser.
    assert.equal(
      sessions.describeDevice('Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537 WhatsApp/2.24'),
      'Android · WhatsApp',
    );
    assert.equal(sessions.describeDevice(null), 'unbekannt');
  });

  test('raeumt nur Sitzungen ab, die aelter sind als die Frist', () => {
    const alt = sessions.startSession({ linkId, ip: '10.0.2.1', userAgent: null });
    const neu = sessions.startSession({ linkId, ip: '10.0.2.2', userAgent: null });

    silence(alt.id, 100 * 24 * 3600);

    const removed = sessions.deleteOldSessions(90);
    assert.ok(removed >= 1);
    assert.equal(sessions.getSessionForLink(alt.id, linkId), null);
    assert.ok(sessions.getSessionForLink(neu.id, linkId), 'frische Sitzung wurde mitgeloescht');
  });
});
