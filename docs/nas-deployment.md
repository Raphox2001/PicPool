# PicPool auf der Synology einrichten

Eine Datei einfügen, vier Werte ausfüllen, starten. Rechne mit einer
Viertelstunde.

Es wird **kein SSH gebraucht** und **kein Quellcode auf der NAS**. Das
Container-Image kommt fertig aus der GitHub Container Registry; die NAS zieht
es und startet es, wie sie es mit jedem anderen Container auch tut.

## 1. Ordner für die Daten anlegen

Systemsteuerung → **Gemeinsamer Ordner** → **Erstellen**:

- Name: `picpool`
- Papierkorb: nach Geschmack
- **Verschlüsselung: nein** — ein verschlüsselter Ordner ist nach einem
  Neustart der NAS nicht eingehängt, und die Container starten dann ins Leere

Dorthin kommen die Bilder, die Datenbank und die Sicherungen. Der Ordner wächst
mit deinen Alben.

Warum ein **eigener** gemeinsamer Ordner und nicht ein Unterordner von
`docker/`: Ein gemeinsamer Ordner ist bei Synology die Einheit für Hyper
Backup, Snapshots und Kontingente. Lägen die Bilder unter `docker/`, zöge dein
Container-Backup plötzlich hunderte Gigabyte Fotos mit, und Snapshots ließen
sich nicht getrennt planen. Dazu kommt, dass der `docker`-Ordner oft engere
Rechte hat, während du hier ausdrücklich im File Station arbeiten können
willst.

## 2. UID und GID ermitteln

Die Container laufen als ein bestimmter Benutzer, und die hochgeladenen Bilder
gehören dann diesem Benutzer. Genau darum geht es bei PicPool: Die Originale
sollen gewöhnliche Dateien bleiben, die du im File Station verschieben oder in
die Synology-Photos-Bibliothek ziehen kannst. Liefe alles als root — wie bei
vielen anderen Containern —, kämst du ohne Umwege nicht an deine eigenen Fotos.

**Mit SSH** ist es ein Befehl:

```bash
id
```

**Ohne SSH** über den Aufgabenplaner: Systemsteuerung → **Aufgabenplaner** →
Erstellen → Geplante Aufgabe → **Benutzerdefiniertes Skript**:

| | |
|---|---|
| Aufgabe | `UID ermitteln` |
| Benutzer | **dein eigener Benutzer** — nicht root |
| Zeitplan | Haken bei „Aktiviert" entfernen |
| Befehl | `id > /volume1/picpool/meine-uid.txt` |

Speichern, die Aufgabe markieren, oben auf **Ausführen** klicken. Dann File
Station → Ordner `picpool` → Rechtsklick auf `meine-uid.txt` → **In
Text-Editor öffnen**.

Die Ausgabe sieht so aus:

```
uid=1026(raphael) gid=100(users) groups=100(users),101(administrators)
```

**1026** und **100** brauchst du gleich. Die Datei danach löschen.

> Läuft die Aufgabe als root, steht dort `uid=0(root)` — und genau das soll
> nicht in die Compose-Datei.

Dein eigener Benutzer genügt völlig. Ein **eigener** Benutzer nur für PicPool
ist zusätzliche Absicherung: Wird die Anwendung übernommen, sitzt der Angreifer
in einem Konto, das außer diesem einen Ordner nichts erreicht. Wenn du das
möchtest: Systemsteuerung → Benutzer & Gruppe → Erstellen, Berechtigung nur auf
`picpool`, alle Anwendungen verweigern.

## 3. Schlüssel erzeugen

PicPool braucht 32 Byte Zufall. Der Schlüssel verschlüsselt die Share-Tokens
und die 2FA-Geheimnisse.

Du erzeugst ihn selbst, es gibt keinen vorgegebenen. Bei einer neuen
Installation ist frei, was du einträgst — ab dem ersten Start ist es *der*
Schlüssel dieser Installation und muss so bleiben. Richtest du PicPool auf
vorhandenen Daten neu ein, gehört dort wieder der alte Wert hinein.

**Mit SSH:**

```bash
openssl rand -base64 32
```

**Ohne SSH**, am PC in PowerShell:

```powershell
$b = New-Object byte[] 32; $r = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $r.GetBytes($b); $r.Dispose(); [Convert]::ToBase64String($b)
```

Beides liefert eine Zeile mit 44 Zeichen, meist auf `=` endend.

> Nimm dafür **nicht** `Get-Random`. Das ist kein kryptografisch sicherer
> Zufall, und dieser Schlüssel schützt die Share-Tokens und die
> 2FA-Geheimnisse.

> **Bewahre ihn getrennt von der Datenbanksicherung auf.** Liegen beide
> zusammen, ist die Verschlüsselung wirkungslos. Geht er verloren, lassen sich
> vorhandene QR-Codes nicht mehr anzeigen und der zweite Faktor muss neu
> eingerichtet werden — die Bilder bleiben unberührt.

## 4. Projekt im Container Manager anlegen

Paket-Zentrum → **Container Manager** installieren, falls noch nicht geschehen.

Dann Container Manager → **Projekt** → **Erstellen**:

| | |
|---|---|
| Projektname | `picpool` |
| Pfad | anlegen lassen, z. B. `/volume1/docker/picpool` |
| Quelle | **docker-compose.yml erstellen** |

In das Textfeld den Inhalt von
[docker-compose.yml](../docker-compose.yml) einfügen. Darin sind vier Stellen
mit `ANPASSEN` markiert:

| | Was |
|---|---|
| 1 | `PICPOOL_PUBLIC_URL` — fürs Erste `http://<nas-ip>:8080`, ohne Schrägstrich am Ende |
| 2 | `PICPOOL_SECRET_KEY` — der Schlüssel aus Schritt 3 |
| 3 | `PICPOOL_LAN_CIDRS` — dein Heimnetz, z. B. `192.168.0.0/24` |
| 4 | `user:` und der Volume-Pfad — UID/GID aus Schritt 2, Ordner aus Schritt 1 |

Die Werte stehen bewusst **in der Compose-Datei** und nicht in einer `.env`:
Im Container Manager fügst du nur YAML ein, eine zweite Datei danebenzulegen
wäre ein Sonderweg über das File Station.

> `user:` und der Volume-Pfad kommen **zweimal** vor, einmal für `app` und
> einmal für `worker`. Beide müssen übereinstimmen. Die übrigen Werte stehen
> dank YAML-Anker nur einmal ganz oben.

Dann **Weiter** und **Fertig**. Der Container Manager zieht das Image und
startet beide Container. Der erste Abruf dauert ein bis zwei Minuten.

## 5. Prüfen

Container Manager → Container → `picpool-app` → **Protokoll**. Dort sollte
stehen:

```
Medien-Toolchain bereit (HEVC/HEIC verfuegbar)
Upload-Seite gefunden
Galerie gefunden
Verwaltung gefunden
PicPool bereit
```

Dann im Browser `http://<nas-ip>:8080` aufrufen.

**Was stattdessen dort stehen kann:**

| Meldung | Bedeutung |
|---|---|
| `Konfiguration ungueltig` | Ein Wert fehlt. Die Meldung nennt das Feld. Bei `PICPOOL_SECRET_KEY fehlt` ist der Wert leer geblieben. |
| `EACCES` / `permission denied` | UID/GID passen nicht, oder der Ordner aus Schritt 1 gehört root. |
| `ffmpeg hat keinen HEVC-Decoder` | iPhone-Fotos würden scheitern. Siehe unten. |
| Sofortiger Neustart in Schleife | Meist ein nicht eingehängter gemeinsamer Ordner. |

## 6. Erste Anmeldung

`http://<nas-ip>:8080/admin` aufrufen. Beim ersten Mal wird die Maske zur
Ersteinrichtung; dieser Weg schließt sich, sobald ein Konto existiert.

**Danach sofort:** Im Panel unter *Konto* den **zweiten Faktor einrichten** —
spätestens, bevor das Panel aus dem Internet erreichbar wird.

## 7. Reverse Proxy und HTTPS

Erst jetzt, wenn feststeht, dass alles läuft.

Systemsteuerung → **Anmeldeportal** → **Reverse Proxy** → Erstellen:

| | |
|---|---|
| Beschreibung | PicPool |
| Quelle: Protokoll | HTTPS |
| Quelle: Hostname | `bilder.deine-domain.de` |
| Quelle: Port | 443 |
| Ziel: Protokoll | HTTP |
| Ziel: Hostname | `localhost` |
| Ziel: Port | 8080 |

Unter **Benutzerdefinierte Kopfzeile** → Erstellen → **WebSocket** hinzufügen.

> Prüfe unter *Erweiterte Einstellungen*, dass keine Begrenzung der
> Anfragegröße aktiv ist. Uploads laufen zwar abschnittsweise in Paketen von
> 2 MB, aber eine sehr niedrig gesetzte Grenze würde auch die blockieren.

**Zertifikat:** Systemsteuerung → Zertifikat → Hinzufügen → Let's Encrypt.
Danach unter *Konfigurieren* dem Reverse-Proxy-Eintrag zuweisen.

**Am Router:** Nur **Port 443** auf die NAS weiterleiten. Die DSM-Ports 5000
und 5001 bleiben geschlossen — sonst steht deine NAS-Anmeldung im Internet.

Von einem Gerät **außerhalb** deines Netzes prüfen:

```bash
nmap -Pn -p 443,5000,5001 deine-domain.de
```

Erwartet: 443 offen, 5000 und 5001 gefiltert oder geschlossen.

**Danach zwei Änderungen in der Compose-Datei** (Container Manager → Projekt →
Bearbeiten):

```yaml
  PICPOOL_PUBLIC_URL: "https://bilder.deine-domain.de"
```

und, damit PicPool nur noch über den Proxy erreichbar ist:

```yaml
    ports:
      - "127.0.0.1:8080:8080"
```

Die Änderung an `PICPOOL_PUBLIC_URL` ist gefahrlos: Links und QR-Codes werden
bei jedem Aufruf neu aus diesem Wert gebaut, vorhandene Tokens bleiben gültig.
Bereits **ausgedruckte** QR-Codes zeigen allerdings weiter auf die alte
Adresse.

## 8. Updates

Der Container aktualisiert sich **nicht** selbst. Dafür bräuchte er Zugriff auf
den Docker-Socket, und der ist gleichbedeutend mit Root auf der ganzen NAS —
womit die gesamte Kapselung hinfällig wäre.

Von Hand geht es jederzeit über Container Manager → Projekt → **Aktion** →
*Erstellen* (zieht das aktuelle Image und startet neu).

**Auf Knopfdruck aus dem Panel** braucht es eine DSM-Aufgabe. Das Panel schreibt
nur eine Markierungsdatei; alles Privilegierte passiert in DSM, unter deiner
Kontrolle.

Systemsteuerung → Aufgabenplaner → Erstellen → Geplante Aufgabe →
Benutzerdefiniertes Skript:

| | |
|---|---|
| Aufgabe | PicPool Update |
| Benutzer | **root** |
| Zeitplan | Täglich, alle 5 Minuten wiederholen |

Als Befehl das hier einfügen — die beiden Pfade oben anpassen, falls deine
abweichen:

```sh
DATA=/volume1/picpool
PROJ=/volume1/docker/picpool
[ -f "$DATA/update-requested" ] || exit 0
rm -f "$DATA/update-requested"
cd "$PROJ" || exit 1
docker exec picpool-app node apps/server/dist/cli.js backup >> "$DATA/update.log" 2>&1
docker compose pull >> "$DATA/update.log" 2>&1 || exit 1
docker compose up -d >> "$DATA/update.log" 2>&1
docker image prune -f >> "$DATA/update.log" 2>&1
```

Die Aufgabe tut nichts, solange keine Markierung vorliegt — sie kann also
beliebig oft laufen. Wird eine Aktualisierung angefordert, sichert sie zuerst
die Datenbank, holt dann das neue Image und startet die Container durch.

Protokoll: `/volume1/picpool/update.log`

Eine ausführlichere Fassung mit Zeitstempeln und Gesundheitsprüfung liegt als
[docker/dsm-update.sh](../docker/dsm-update.sh) im Repo.

## 9. Sicherungen

**Die Bilder** liegen als gewöhnliche Dateien unter
`/volume1/picpool/originals/` und lassen sich jederzeit kopieren oder mit Hyper
Backup sichern.

**Die Datenbank** braucht Sorgfalt: Sie läuft im WAL-Modus, ein erheblicher
Teil der Daten kann im Write-Ahead-Log liegen. Wer nur `picpool.db` kopiert,
bekommt einen unvollständigen Stand, und SQLite meldet später
`database disk image is malformed`.

Richtig ist der CLI-Befehl — als tägliche DSM-Aufgabe (Benutzer: **root**):

```bash
docker exec picpool-app node apps/server/dist/cli.js backup --behalten 14
```

Das schreibt eine in sich stimmige Kopie nach `/volume1/picpool/backups/`.
**Hyper Backup** kann dann einfach den ganzen Ordner `/volume1/picpool`
sichern.

> Denk daran, den Schlüssel getrennt aufzubewahren. Liegt er im selben Backup
> wie die Datenbank, bringt die Verschlüsselung der Tokens nichts.

## Wenn etwas schiefgeht

Die Befehle in diesem Abschnitt brauchen SSH (Systemsteuerung → Terminal &
SNMP → SSH-Dienst aktivieren) oder eine Aufgabe im Aufgabenplaner als root.

### `ffmpeg hat keinen HEVC-Decoder`

Dann scheitern alle iPhone-Fotos im HEIC-Format. Prüfen mit:

```bash
sudo docker exec picpool-app ffmpeg -hide_banner -decoders | grep hevc
```

Kommt nichts zurück, ist das ein Fehler im veröffentlichten Image — bitte im
Repo melden. Debians ffmpeg bringt den Decoder eigentlich mit.

### `NanoCPUs can not be set`

Der Synology-Kernel kennt den CFS-Scheduler nicht, eine CPU-Obergrenze lässt
sich dort nicht setzen. In der Compose-Datei steht deshalb keine mehr. Taucht
die Meldung auf, ist der Stand veraltet.

### Uploads scheitern auf einem Gerät

```bash
sudo docker exec picpool-app node apps/server/dist/cli.js fehler
```

Zeigt die von den Geräten gemeldeten Fehler mit Dateiname, übertragenen Bytes,
Browsermeldung und den Umständen. Dasselbe steht im Panel unter „Alben" bei den
Kennzahlen.

### Wenn das Passwort verloren geht

```bash
sudo docker exec picpool-app node apps/server/dist/cli.js admin:password <name>
```

Erzeugt ein neues Passwort und beendet alle Sitzungen.

### Alles auf einen Blick

```bash
sudo docker exec picpool-app node apps/server/dist/cli.js status
```

## Aus dem Quellcode bauen

Nur nötig, wenn du etwas geändert hast oder kein fertiges Image nutzen willst.
Dann braucht es doch Git und SSH:

```bash
cd /volume1/docker && sudo git clone https://github.com/Raphox2001/PicPool.git picpool
cd picpool && sudo cp .env.example .env && sudo vi .env
sudo docker compose -f docker-compose.build.yml up -d --build
```

Diese Variante liest ihre Werte aus der `.env`, nicht aus der Compose-Datei.
Der Build dauert auf einer DS923+ einige Minuten und braucht Arbeitsspeicher,
den die NAS neben den anderen Containern knapp hat.

## Was danach noch fehlt

Vier Prüfungen aus [docs/geraetetest.md](geraetetest.md) sind noch offen und
lassen sich jetzt live machen:

- iPhone mit echter HEIC-Datei aus der Kamera
- Link aus WhatsApp heraus geöffnet
- großes Video über Mobilfunk statt WLAN
- Flugmodus mitten im Upload

Erst über HTTPS lässt sich außerdem die Wake-Lock-Funktion prüfen, die den
Bildschirm während des Uploads wachhält — sie ist von Browsern nur in
gesicherten Verbindungen freigegeben.
