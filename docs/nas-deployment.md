# PicPool auf der Synology DS923+ einrichten

Einmal durcharbeiten, danach läuft es. Rechne mit etwa einer Stunde, der
Großteil davon Wartezeit beim ersten Build.

> **Wo läuft was:** Alle `bash`-Befehle in dieser Anleitung laufen **auf der
> NAS**, verbunden per SSH — nicht in PowerShell auf deinem PC. Die Klickwege
> (Systemsteuerung, Container Manager) erledigst du im Browser.
>
> **Ohne SSH geht es auch.** Für jeden Befehl gibt es einen Weg über die
> DSM-Oberfläche: [Einrichtung ohne SSH](#einrichtung-ohne-ssh) am Ende dieser
> Anleitung. SSH ist bequemer, aber keine Voraussetzung.

> **Vorher wissenswert:** Das Container-Image wurde bisher nie gebaut — dafür
> fehlte eine Docker-Umgebung. Der erste Build auf der NAS ist also zugleich
> der erste echte Test des Dockerfiles. Geprüft wurde vorab, dass `npm ci` mit
> den kopierten Manifesten durchläuft und alle `COPY`-Quellen existieren.
> Falls doch etwas klemmt: Abschnitt [Wenn etwas schiefgeht](#wenn-etwas-schiefgeht).

## Zwei Orte, nicht verwechseln

PicPool belegt zwei getrennte Verzeichnisse:

| Was | Wohin | Größe |
|---|---|---|
| **Code** — Compose-Datei, Dockerfile, Quellen | `/volume1/docker/picpool` | wenige MB |
| **Daten** — Bilder, Datenbank, Sicherungen | `/volume1/picpool` | wächst mit deinen Alben |

Der Code kommt zu deinen anderen Containern. Die Daten bekommen einen
**eigenen gemeinsamen Ordner** — nicht aus Prinzip, sondern weil ein
gemeinsamer Ordner bei Synology die Einheit für Hyper Backup, Snapshots und
Kontingente ist. Lägen die Bilder unter `docker/`, zöge dein
Container-Backup plötzlich hunderte Gigabyte Fotos mit, und Snapshots ließen
sich nicht getrennt planen. Dazu kommt, dass der `docker`-Ordner oft engere
Rechte hat, während du hier ausdrücklich im File Station arbeiten können
willst.

Wenn du trotzdem alles beisammen haben möchtest, geht das — es ist nur ein
Wert in der `.env`:

```bash
PICPOOL_HOST_DATA=/volume1/docker/picpool-data
```

Dann entfällt Schritt 1, und du verlierst lediglich die getrennte
Sicherungsstrategie.

## 1. Ordner anlegen, UID ermitteln

**Gemeinsamen Ordner für die Daten erstellen** — Systemsteuerung →
Gemeinsamer Ordner → Erstellen:

- Name: `picpool`
- Papierkorb: nach Geschmack
- **Verschlüsselung: nein** (sonst ist der Ordner nach einem Neustart nicht
  eingehängt und die Container starten ins Leere)

Hier landen später die Bilder. Der Code kommt in Schritt 3 an eine andere
Stelle.

### UID und GID ermitteln

> **Achtung:** Alle folgenden Befehle laufen **auf der NAS**, nicht auf deinem
> PC. `id`, `docker` und `git` sind Linux-Befehle — PowerShell kennt sie nicht
> und meldet „wurde nicht als Name eines Cmdlet … erkannt".

**SSH einschalten:** DSM → Systemsteuerung → Terminal & SNMP → Haken bei
**SSH-Dienst aktivieren** → Übernehmen.

**Verbinden** — von PowerShell, Terminal oder wo auch immer:

```bash
ssh DEIN-BENUTZER@192.168.0.XXX
```

Die Adresse ist dieselbe, unter der du DSM aufrufst. Beim ersten Mal fragt er
nach dem Fingerabdruck (`yes` eingeben), dann nach deinem DSM-Passwort.

Ab hier bist du auf der NAS. Erst jetzt:

```bash
id
```

Die Ausgabe sieht etwa so aus:

```
uid=1026(raphael) gid=100(users) groups=100(users),101(administrators)
```

**1026** und **100** brauchst du gleich für die `.env`.

Die SSH-Verbindung bleibt für den Rest der Einrichtung offen — `git clone`,
`docker compose` und später die Verwaltungsbefehle laufen alle dort.

### Muss das ein eigener Benutzer sein?

**Nein.** Dein eigener DSM-Benutzer reicht völlig — das ist der einfachste Weg.

Worum es überhaupt geht: Die Container laufen als der Benutzer, dessen UID du
einträgst, und die hochgeladenen Bilder gehören dann diesem Benutzer. Setzt man
gar keinen (wie es Immich und viele andere Container tun), läuft alles intern
als root, und die Dateien gehören root. Bei Immich stört das nicht, weil du
dort ohnehin nur über die App an die Bilder kommst.

Bei PicPool ist das anders: Der ganze Sinn ist, dass die Originale als
gewöhnliche Dateien dort liegen und du sie im File Station verschieben oder in
die Synology-Photos-Bibliothek ziehen kannst. Gehören sie root, kommst du ohne
Umwege nicht daran.

Ein **eigener** Benutzer nur für PicPool ist zusätzliche Absicherung — wird die
Anwendung übernommen, sitzt der Angreifer in einem Konto, das außer diesem einen
Ordner nichts erreicht. Wenn du das möchtest: Systemsteuerung → Benutzer &
Gruppe → Erstellen, Berechtigung nur auf den Ordner `picpool`, alle Anwendungen
verweigern. Dann `id picpool` statt `id`.

Beides funktioniert. Nimm im Zweifel deinen eigenen Benutzer.

## 2. Docker installieren

Paket-Zentrum → **Container Manager** installieren. Das bringt Docker und
Docker Compose mit.

## 3. Das Projekt auf die NAS holen

Der **Code** kommt in den `docker`-Ordner zu deinen anderen Containern — nicht
in den Datenordner aus Schritt 1:

```bash
sudo mkdir -p /volume1/docker
cd /volume1/docker
sudo git clone https://github.com/Raphox2001/PicPool.git picpool
cd picpool
```

Danach liegt die `docker-compose.yml` unter `/volume1/docker/picpool/`.

Falls `git` fehlt: Paket-Zentrum → **Git Server** installieren, oder das
Projekt als ZIP herunterladen und per File Station entpacken. Mit Git ist
später das Aktualisieren bequemer.

## 4. Konfiguration

```bash
sudo cp .env.example .env
sudo vi .env
```

Diese Werte müssen stimmen:

```bash
# Deine Domain, über die PicPool von außen erreichbar ist.
# OHNE abschließenden Schrägstrich.
PICPOOL_PUBLIC_URL=https://bilder.deine-domain.de

# 32 Byte Zufall. Erzeugen mit:  openssl rand -base64 32
# Ohne diesen Schlüssel startet PicPool nicht.
PICPOOL_SECRET_KEY=...

# Dein Heimnetz. Nur diese Geräte bekommen - sofern pro Album erlaubt -
# Originalauflösung direkt in der Galerie.
PICPOOL_LAN_CIDRS=192.168.0.0/24

# Dem Reverse Proxy wird X-Forwarded-For geglaubt. Eng fassen!
PICPOOL_TRUST_PROXY=172.16.0.0/12

# Aus  id  (dein eigener Benutzer genügt)
PICPOOL_UID=1026
PICPOOL_GID=100

# Der Datenordner aus Schritt 1 - NICHT das Verzeichnis mit dem Code.
PICPOOL_HOST_DATA=/volume1/picpool
```

> **Zum Schlüssel:** Er verschlüsselt die Share-Tokens und die
> 2FA-Geheimnisse. Geht er verloren, lassen sich vorhandene QR-Codes nicht
> mehr anzeigen und der zweite Faktor muss neu eingerichtet werden. Die Bilder
> bleiben davon unberührt. **Bewahre ihn getrennt von der Datenbanksicherung
> auf** — liegen beide zusammen, ist die Verschlüsselung wirkungslos.

## 5. Bauen und starten

Zwei Wege — such dir einen aus.

### Weg A: Über SSH

```bash
cd /volume1/docker/picpool
sudo docker compose up -d --build
```

Die `docker-compose.yml` liegt im Wurzelverzeichnis des Projekts, direkt neben
der `.env`. Das ist Absicht: Docker Compose sucht die `.env` im Verzeichnis der
Compose-Datei, und so findet sie sich ohne zusätzliche Schalter.

### Weg B: Über den Container Manager

Container Manager → **Projekt** → **Erstellen**:

| | |
|---|---|
| Projektname | `picpool` |
| Pfad | `/volume1/docker/picpool` |
| Quelle | **Vorhandene docker-compose.yml verwenden** |

Der Container Manager findet die Datei dort von allein, baut das Image und
startet beide Container. Danach siehst du sie in der Übersicht und kannst
Protokolle und Neustarts über die Oberfläche erledigen.

> Der Container Manager liest dieselbe `.env`. Sie muss also **vor** dem
> Anlegen des Projekts ausgefüllt sein — sonst bricht der Start mit
> `In .env eintragen - ermitteln mit: id` ab.

Der erste Build dauert einige Minuten — Node-Abhängigkeiten, ffmpeg und die
drei Oberflächen.

**Prüfen, ob es läuft:**

```bash
sudo docker compose ps
sudo docker logs picpool-app --tail 30
```

Im Log sollte stehen:

```
Medien-Toolchain bereit (HEVC/HEIC verfuegbar)
Upload-Seite gefunden
Galerie gefunden
Verwaltung gefunden
PicPool bereit
```

**Wenn stattdessen dort steht** `ffmpeg hat keinen HEVC-Decoder`: Dann
scheitern iPhone-Fotos. Siehe [Wenn etwas schiefgeht](#wenn-etwas-schiefgeht).

Erster Test von innen:

```bash
curl -s http://127.0.0.1:8080/readyz
```

## 6. Von innen erreichbar machen

Standardmäßig lauscht der Container nur auf `127.0.0.1` der NAS — von außen
also gar nicht. Für den Zugriff aus dem Heimnetz per NAS-IP die Portzeile in
`docker-compose.yml` ändern:

```yaml
    ports:
      - "8080:8080"      # statt "127.0.0.1:8080:8080"
```

Danach `up -d` erneut ausführen. PicPool ist dann unter
`http://<nas-ip>:8080` erreichbar.

## 7. Reverse Proxy und HTTPS

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

> **Wichtig:** Prüfe unter *Erweiterte Einstellungen*, dass keine Begrenzung
> der Anfragegröße aktiv ist. Uploads laufen zwar abschnittsweise in Paketen
> von 2 MB, aber eine sehr niedrig gesetzte Grenze würde auch die blockieren.

**Zertifikat:** Systemsteuerung → Zertifikat → Hinzufügen → Let's Encrypt.
Danach unter *Konfigurieren* dem Reverse-Proxy-Eintrag zuweisen.

**Am Router:** Nur **Port 443** auf die NAS weiterleiten. Die DSM-Ports 5000
und 5001 bleiben geschlossen — sonst steht deine NAS-Anmeldung im Internet.

Prüfen, dass das stimmt, von einem Gerät **außerhalb** deines Netzes:

```bash
nmap -Pn -p 443,5000,5001 deine-domain.de
```

Erwartet: 443 offen, 5000 und 5001 gefiltert oder geschlossen.

## 8. Erste Anmeldung

Im Browser `https://bilder.deine-domain.de/admin` aufrufen. Beim ersten
Aufruf wird die Maske zur Ersteinrichtung.

Alternativ über die Kommandozeile:

```bash
sudo docker exec picpool-app node apps/server/dist/cli.js admin:create raphael
```

Das erzeugt ein Passwort und zeigt es einmal an.

**Danach sofort:** Im Panel unter *Konto* den **zweiten Faktor einrichten**.
Das Panel ist aus dem Internet erreichbar; ohne zweiten Faktor hängt alles an
einem einzigen Passwort.

## 9. Updates einrichten

Das Panel kann Aktualisierungen anstoßen, hat dafür aber bewusst keine
Rechte — es schreibt nur eine Markierungsdatei. Den privilegierten Teil
erledigt eine DSM-Aufgabe.

**Skript bereitlegen:**

```bash
sudo cp /volume1/docker/picpool/docker/dsm-update.sh /volume1/picpool/
sudo chmod +x /volume1/picpool/dsm-update.sh
```

Falls deine Pfade abweichen, die Variablen am Skriptanfang anpassen.

**Aufgabe anlegen** — Systemsteuerung → Aufgabenplaner → Erstellen →
Geplante Aufgabe → Benutzerdefiniertes Skript:

| | |
|---|---|
| Aufgabe | PicPool Update |
| Benutzer | **root** |
| Zeitplan | Täglich, alle 5 Minuten wiederholen |
| Befehl | `sh /volume1/picpool/dsm-update.sh` |

Das Skript tut nichts, solange keine Markierung vorliegt — es kann also
beliebig oft laufen. Wird eine Aktualisierung angefordert, sichert es zuerst
die Datenbank, baut dann neu und startet die Container durch.

Protokoll: `/volume1/picpool/update.log`

## 10. Sicherungen

**Die Bilder** liegen als gewöhnliche Dateien unter
`/volume1/picpool/originals/` und lassen sich jederzeit kopieren oder mit
Hyper Backup sichern.

**Die Datenbank** braucht Sorgfalt: Sie läuft im WAL-Modus, ein erheblicher
Teil der Daten kann im Write-Ahead-Log liegen. Wer nur `picpool.db` kopiert,
bekommt einen unvollständigen Stand, und SQLite meldet später
`database disk image is malformed`.

Richtig:

```bash
sudo docker exec picpool-app node apps/server/dist/cli.js backup
```

Das schreibt eine in sich stimmige Kopie nach `/volume1/picpool/backups/` und
behält die letzten sieben.

**Als tägliche DSM-Aufgabe einrichten** (Benutzer: root):

```bash
docker exec picpool-app node apps/server/dist/cli.js backup --behalten 14
```

**Hyper Backup** kann dann einfach den ganzen Ordner `/volume1/picpool`
sichern — mitsamt der konsistenten Datenbankkopien.

> Denk daran, `PICPOOL_SECRET_KEY` getrennt aufzubewahren. Liegt er im selben
> Backup wie die Datenbank, bringt die Verschlüsselung der Tokens nichts.

## Wenn etwas schiefgeht

### Der Build schlägt fehl

```bash
sudo docker compose build --no-cache 2>&1 | tail -40
```

Häufige Ursachen:

- **Zu wenig Speicher beim Build.** Andere Container kurz anhalten.
- **`npm ci` bricht ab.** Meist eine veraltete `package-lock.json` — dann
  `git pull` und neu versuchen.

### `ffmpeg hat keinen HEVC-Decoder`

Dann scheitern alle iPhone-Fotos im HEIC-Format. Debians ffmpeg sollte den
Decoder mitbringen; prüfen mit:

```bash
sudo docker exec picpool-app ffmpeg -hide_banner -decoders | grep hevc
```

Kommt nichts zurück, hilft im Dockerfile `ffmpeg` durch
`ffmpeg libavcodec-extra` zu ersetzen und neu zu bauen.

### Container startet nicht

```bash
sudo docker logs picpool-app --tail 50
```

- **`Konfiguration ungueltig`** — in der `.env` fehlt etwas. Die Meldung nennt
  das Feld.
- **`EACCES` oder `permission denied`** — `PICPOOL_UID`/`PICPOOL_GID` passen
  nicht. Nochmal `id` prüfen und die Zahlen in die `.env` übernehmen.
- **Sofortiger Neustart in Schleife** — meist ein nicht eingehängter
  Shared Folder.

### Uploads scheitern auf einem Gerät

```bash
sudo docker exec picpool-app node apps/server/dist/cli.js fehler
```

Zeigt die von den Geräten gemeldeten Fehler mit Dateiname, übertragenen Bytes,
Browsermeldung und den Umständen.

### Alles auf einen Blick

```bash
sudo docker exec picpool-app node apps/server/dist/cli.js status
curl -s http://127.0.0.1:8080/readyz
```

## Einrichtung ohne SSH

Die gesamte Einrichtung lässt sich über die DSM-Oberfläche erledigen. Etwas
umständlicher als SSH, aber vollständig.

### UID und GID ermitteln

Systemsteuerung → **Aufgabenplaner** → Erstellen → Geplante Aufgabe →
**Benutzerdefiniertes Skript**:

| | |
|---|---|
| Aufgabe | `UID ermitteln` |
| Benutzer | **dein eigener Benutzer** — nicht root |
| Zeitplan | Haken bei „Aktiviert" entfernen |
| Befehl | `id > /volume1/picpool/meine-uid.txt` |

Speichern, die Aufgabe in der Liste markieren und oben auf **Ausführen**
klicken. Danach File Station → Ordner `picpool` → Rechtsklick auf
`meine-uid.txt` → **In Text-Editor öffnen**.

> Als Benutzer unbedingt deinen eigenen Account wählen. Läuft die Aufgabe als
> root, steht dort `uid=0(root)` — und genau das soll nicht in die `.env`.

Die Datei danach löschen, sie wird nicht mehr gebraucht.

### Code auf die NAS bringen

Auf GitHub → **Code** → **Download ZIP**. Die Datei im File Station nach
`/volume1/docker/` hochladen, Rechtsklick → **Entpacken**.

Der entpackte Ordner heißt `PicPool-main`. Umbenennen in `picpool`, damit die
Pfade in dieser Anleitung stimmen.

### `.env` anlegen und bearbeiten

Dateien mit führendem Punkt sind im File Station standardmäßig unsichtbar:
oben rechts **Einstellungen** → **Versteckte Dateien anzeigen** aktivieren.

Dann Rechtsklick auf `.env.example` → **Kopieren**, wieder einfügen und in
`.env` umbenennen. Rechtsklick → **In Text-Editor öffnen**, Werte eintragen,
speichern.

Den Schlüssel erzeugst du ohne SSH am einfachsten hier am PC, in PowerShell:

```powershell
$b = New-Object byte[] 32; $r = [System.Security.Cryptography.RNGCryptoServiceProvider]::new(); $r.GetBytes($b); $r.Dispose(); [Convert]::ToBase64String($b)
```

Getestet mit Windows PowerShell 5.1; liefert 32 Byte base64.

> Nimm dafür **nicht** `Get-Random`. Das ist kein kryptografisch sicherer
> Zufall, und dieser Schlüssel schützt die Share-Tokens und die
> 2FA-Geheimnisse.

### Starten

Container Manager → **Projekt** → **Erstellen**, Pfad
`/volume1/docker/picpool`, Quelle „Vorhandene docker-compose.yml verwenden".
Baut und startet beides.

### Laufenden Betrieb

| Aufgabe | Ohne SSH |
|---|---|
| Protokolle ansehen | Container Manager → Container → `picpool-app` → Protokoll |
| Neu starten | Container Manager → Projekt → Aktion → Neu starten |
| Erstes Adminkonto | Nicht nötig — `/admin` wird beim ersten Aufruf zur Einrichtung |
| Sicherung | Aufgabenplaner, Befehl: `docker exec picpool-app node apps/server/dist/cli.js backup` |
| Upload-Fehler ansehen | Im Panel unter „Alben", oben bei den Kennzahlen |

Für die Aufgabenplaner-Befehle mit `docker exec` muss die Aufgabe als **root**
laufen — anders als beim UID-Ermitteln oben.

### Wann SSH sich doch lohnt

Wenn beim ersten Build etwas schiefgeht. Der Container Manager zeigt
Build-Fehler nur verkürzt an, über SSH siehst du die vollständige Ausgabe:

```bash
sudo docker compose build --no-cache 2>&1 | tail -40
```

Einschalten kannst du es jederzeit nachträglich: Systemsteuerung →
Terminal & SNMP → SSH-Dienst aktivieren.

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
