# PicPool

Selbstgehostetes Einsammeln von Fotos und Videos nach Events, Urlauben und Feiern.

Pro Album gibt es zwei Links samt QR-Code:

- **Upload-Link** — bewusst so einfach gehalten, dass er ohne Erklärung bedienbar ist
- **Galerie-Link** — schnelle Ansicht, chronologisch sortiert, nach Uploader filterbar

Läuft als Docker-Container auf einer Synology NAS. Der Anlass für das Projekt ist der
Synology-eigene Photo Request, der bei größeren Dateien und auf einem Teil der Handys
still abbricht.

## Stand

| Phase | Inhalt | Status |
|---|---|---|
| **P0** | Fundament: Konfiguration, Datenbank, Job-Queue, Docker, Health-Checks | **fertig** |
| **P1** | Upload-Kern: tus, Derivate, HEIC, Dedupe, Upload-Seite | **fertig** |
| **P2** | Galerie, Download, ZIP | **fertig** |
| P3 | Admin, Login, 2FA, QR-Codes | offen |
| P4 | Videos: Poster-Frames, Wiedergabe | offen |
| P5 | Deployment auf der NAS, Härtung, Backup, Update-Mechanismus | offen |

### Geplant für P5: Updates aus dem Adminpanel

Das Panel soll Updates anstoßen können, ohne dafür Rechte zu bekommen, die es
gefährlich machen. Ein Container, der sich selbst aktualisiert, braucht Zugriff
auf den Docker-Socket — und der ist gleichbedeutend mit Root auf der ganzen
NAS. Das würde die gesamte Kapselung aushebeln (Worker ohne Netzwerk,
`cap_drop: ALL`, schreibgeschütztes Dateisystem, ein einziger Mount).

Stattdessen wird der privilegierte Teil dorthin verlagert, wo er hingehört:

1. Das Panel fragt die GitHub-Releases ab und zeigt verfügbare Versionen samt
   Änderungsliste an.
2. „Jetzt aktualisieren" schreibt lediglich eine Markierungsdatei ins
   Datenverzeichnis. Mehr kann der Container nicht, und mehr braucht er nicht.
3. Eine **DSM-Aufgabenplanung**, einmalig eingerichtet, prüft regelmäßig auf
   diese Datei und führt dann Image-Pull und Neustart aus.

Die Datenbank-Migrationen laufen beim Start ohnehin automatisch; ein Update ist
damit nur ein Image-Tausch. Die vollständige Einrichtungsanleitung für die
DSM-Aufgabe kommt mit P5 in dieses README.

## Aufbau

```
apps/server/          Fastify-Backend, zugleich Worker-Prozess
  src/config.ts       Konfiguration, beim Start validiert
  src/db/             SQLite-Zugriff und Migrationen
  src/jobs/queue.ts   Job-Queue in SQLite
  src/lib/crypto.ts   Tokens, Verschlüsselung at rest
  src/lib/media.ts    HEIC-/Video-Dekodierung über ffmpeg
  src/worker.ts       Worker-Prozess ohne Netzwerkzugang
packages/shared/      Gemeinsame Typen und die MIME-Allowlist
docker/               Dockerfile und docker-compose.yml
```

## Entwicklung

Voraussetzungen: Node 22+ und ffmpeg im `PATH`.

```bash
npm install
npm run build --workspace packages/shared
```

Konfiguration anlegen:

```bash
cp .env.example .env
```

In der `.env` mindestens `PICPOOL_SECRET_KEY` setzen:

```bash
openssl rand -base64 32
```

Starten:

```bash
npm run dev:server
npm run dev:worker
```

Prüfen:

```bash
curl http://127.0.0.1:8080/readyz
```

`/readyz` meldet `degraded`, wenn die Medien-Toolchain unvollständig ist — insbesondere
wenn der HEVC-Decoder fehlt. Das ist Absicht, siehe unten.

## Zwei Entscheidungen, die leicht zu übersehen sind

### HEIC braucht ffmpeg, nicht sharp

Die vorgebauten sharp/libvips-Binaries enthalten libheif **ohne** HEVC-Decoder
(Patentlizenzierung). Tückisch daran: `sharp.metadata()` liest eine iPhone-HEIC
anstandslos und meldet sogar `compression: "hevc"` — erst die Pixel-Dekodierung
scheitert. Wer nur die Metadaten prüft, merkt das Problem erst in Produktion, und
zwar bei jedem iPhone-Foto.

PicPool dekodiert HEIC deshalb über ffmpeg (MJPEG als Zwischenformat) und prüft die
Verfügbarkeit des HEVC-Decoders beim Start. Details in `apps/server/src/lib/media.ts`.

### Der Worker hat kein Netzwerk

Das Parsen fremder Bild- und Videodateien ist die klassische Stelle für
Decoder-Schwachstellen. Der Worker läuft deshalb in einem eigenen Container mit
`network_mode: none`, als unprivilegierter Benutzer, mit schreibgeschütztem
Wurzeldateisystem und Zugriff auf genau ein Verzeichnis. Die Verständigung mit der
App läuft ausschließlich über die Jobs-Tabelle.

## Ablage auf der NAS

```
/volume1/picpool/
  originals/<album>/<uploader>/<zeitstempel>_<hash>.<ext>
  derivatives/<album-id>/<asset-id>/
  incoming/
  db/picpool.db
```

Originale liegen als gewöhnliche Dateien in einer lesbaren Struktur — kein Blob-Store.
Sie lassen sich im File Station verschieben, per Hyper Backup sichern oder in die
Synology-Photos-Bibliothek übernehmen, ohne dass PicPool beteiligt sein muss.

### Wichtig für Sicherungen: die Datenbank nicht einfach mitkopieren

Die Datenbank läuft im WAL-Modus. Ein erheblicher Teil der Daten kann dabei in
`picpool.db-wal` liegen und noch nicht in der Hauptdatei stehen — beobachtet
wurden 1,7 MB im WAL gegenüber 168 KB in der Datenbankdatei.

Wer nur `picpool.db` kopiert oder sie bei laufendem Server von einem zweiten
Prozess aus liest, bekommt einen unvollständigen Stand. SQLite meldet dann
`database disk image is malformed`, obwohl die Datenbank in Ordnung ist. Nach
einem sauberen Checkpoint lieferte dieselbe Datei `integrity_check: ok`.

Für Sicherungen gilt deshalb:

- entweder die SQLite-Backup-API benutzen (kommt in P5 als CLI-Befehl),
- oder den Container kurz anhalten und erst dann kopieren,
- oder **alle drei Dateien** sichern: `picpool.db`, `-wal` und `-shm`.

Die Bilder selbst sind davon nicht betroffen — die liegen als gewöhnliche
Dateien und lassen sich jederzeit kopieren.

## Galerie (P2)

Der Galerie-Link zeigt das Album ohne Anmeldung, nur über das Token.

- **Chronologisch**, nach Kalendertagen gruppiert. Grundlage ist das
  EXIF-Aufnahmedatum, ersatzweise das Dateidatum.
- **Filter nach Person** — erscheint nur, wenn mehr als eine beigetragen hat.
- **ThumbHash-Platzhalter**: ein unscharfes Vorschaubild steht sofort, ohne
  einen einzigen Netzabruf, und wird ersetzt, sobald das Thumbnail da ist.
  Dadurch springt beim Laden nichts.
- **Videos** mit Abspielsymbol, Dauer und Poster-Frame; abgespielt wird in der
  Lightbox direkt aus dem Original.
- **Download** einzeln, als Mehrfachauswahl (langes Drücken) oder als ZIP.

### Abgestufte Auflösung

Gemessen an einem Foto aus dem Gerätetest:

| Stufe | Größe | Wofür |
|---|---|---|
| Thumbnail | 4,6 KB | Raster |
| Vorschau | 78 KB | Lightbox |
| Original | 1,38 MB | nur beim Download |

Das Raster eines ganzen Albums kostet damit einen Bruchteil dessen, was die
Originale wiegen.

### ZIP-Download

Ohne Kompression (Store-Modus): JPEG, HEIC und MP4 sind bereits komprimiert,
ein Deflate-Durchlauf brächte praktisch nichts, kostet auf dem Ryzen der NAS
aber spürbar Rechenzeit. Der Archivstrom geht direkt an den Client, es entsteht
keine Zwischendatei und der Speicherverbrauch bleibt flach.

Im Archiv liegen die Dateien nach Person in Ordnern, mit dem Aufnahmedatum im
Namen — `raphael/2026-09-20-08-47-14_1000162875.jpg` statt der nichtssagenden
Kameranummer.

### Zugriffsregeln

| | Ansehen | Original / Download |
|---|---|---|
| Downloads erlaubt | ja | ja |
| Downloads gesperrt | ja | **403** |
| Downloads gesperrt, aber im LAN und freigegeben | ja | ja |

Die LAN-Erkennung vergleicht die Client-Adresse mit den konfigurierten
Subnetzen. Sie ist nur verlässlich, weil `trustProxy` eng auf den Reverse Proxy
begrenzt ist — sonst könnte sich ein Gast per `X-Forwarded-For` eine LAN-Adresse
andichten. Die Prüfung ist in `apps/server/src/lib/network.test.ts` abgedeckt.

## Verwaltung von der Kommandozeile

Solange es die Admin-Oberfläche noch nicht gibt (P3), läuft die Verwaltung über die CLI.
Auf der NAS:

```bash
docker exec picpool-app node apps/server/dist/cli.js album:create "Sommerfest 2026" --datum 2026-07-14
```

Das legt das Album an und gibt beide Links sofort aus. Weitere Befehle zeigt
`cli.js` ohne Argumente.

## Was in P1 geprüft wurde

Der Upload-Weg ist der Kern des Projekts, deshalb wurde er nicht nur gebaut,
sondern nachgewiesen:

| Prüfung | Ergebnis |
|---|---|
| tus-Upload mit simuliertem Verbindungsabbruch, Fortsetzung per `HEAD`-Offset | fortgesetzt ab Byte 179529, Datei vollständig |
| 23 MB aus dem echten Browser-Client | in 4 PATCH-Anfragen zerlegt, fehlerfrei |
| iPhone-HEIC über den ffmpeg-Pfad | dekodiert, Derivate erzeugt |
| EXIF-Aufnahmedatum | korrekt als Aufnahmezeit übernommen |
| GPS-Koordinaten in den Derivaten | keine — Original behält EXIF, Derivate nicht |
| Hochformat | bleibt hochformatig |
| Video | Poster-Frame, Maße und Dauer erkannt |
| Doppelter Upload derselben Datei | als Duplikat erkannt, keine zweite Kopie |
| PHP-Datei mit `.jpg`-Endung | mit 415 abgewiesen |
| Ungültiges Token | mit 403 abgewiesen |
| `incoming/` nach den Uploads | leer, keine Reste |

Nachgestellt wurde das mit `apps/server/scripts/e2e-upload.mjs`, das das
tus-Protokoll direkt über HTTP spricht — ohne Client-Bibliothek, damit wirklich
der Server geprüft wird.

Die Anleitung dazu steht in [docs/geraetetest.md](docs/geraetetest.md) — starten mit `npm run dev:lan`, QR-Code scannen.

## Gerätetest: Pixel 7 (21.09.2026)

Der erste Durchlauf schlug fehl und deckte einen echten Fehler auf.

**Symptom:** Die ersten Dateien liefen durch, danach scheiterte jeder weitere
Upload mit `ProgressEvent`, `response code: n/a` — also gar keine HTTP-Antwort.
HEAD- und POST-Anfragen (beide ohne Körper) funktionierten die ganze Zeit
weiter, nur die großen Übertragungen brachen weg. Ein 12,5-MB-Video blieb bei
96 % stehen, ein 2-MB-Foto bei 0 Bytes.

**Ursache:** Fastify setzt `keepAliveTimeout` auf 72 s, aber `headersTimeout`
auf 60 s. Der Server kündigt dem Browser per `Keep-Alive: timeout=72` an, die
Verbindung 72 Sekunden offen zu halten, zerstört sie aber nach 60. Wer in
diesem Fenster auf einer solchen Verbindung sendet, bekommt einen Abbruch ohne
Antwort. `headersTimeout` muss größer sein als `keepAliveTimeout` — siehe
`apps/server/src/app.ts`.

**Behoben durch drei Änderungen gemeinsam:**

1. Zeitgrenzen korrigiert (`keepAliveTimeout` 65 s, `headersTimeout` 70 s)
2. Gleichzeitige Uploads 3 → 2, Paketgröße 6 MB → 2 MB
   (gleichzeitig unterwegs: 18 MB → 4 MB)
3. Automatische Paket-Verkleinerung als Sicherheitsnetz: 2 MB → 512 KB → 128 KB

**Ergebnis des zweiten Durchlaufs:** 14 Dateien, 40,2 MB, alle `ready`, keine
Fehlermeldung. 28 PATCH-Anfragen — **und null HEAD-Anfragen**, also keine
einzige Wiederaufnahme. Die Paketverteilung entsprach exakt 2-MB-Paketen; die
Verkleinerung musste nicht eingreifen.

Da drei Änderungen zusammen eingingen, lässt sich der Erfolg nicht einer
einzelnen zuschreiben. Die Zeitgrenzen-Fehlkonfiguration war aber nachweisbar
vorhanden und erklärt das Fehlerbild vollständig.

**Noch offen:** iPhone (HEIC aus echter Kamera), WhatsApp-Browser, großes Video
über Mobilfunk, Flugmodus mitten im Upload. Anleitung: [docs/geraetetest.md](docs/geraetetest.md)
