# Gerätetest (Gate für P1)

Alles Bisherige wurde auf dem Entwicklungsrechner geprüft. Was sich dort **nicht**
prüfen lässt, ist genau das, woran Synologys Photo Request scheitert: echte Handys,
echte Dateiformate, echter Mobilfunk. Dieser Test schließt die Lücke.

## Starten

Im Projektverzeichnis:

```bash
npm run dev:lan
```

Das Skript erledigt alles: es ermittelt die LAN-Adresse dieses Rechners, legt beim
ersten Mal eine `.env` mit dauerhaftem Schlüssel an, baut das Projekt, sorgt für ein
Album namens „Geraetetest", startet Server und Worker und zeigt den Upload-Link als
**QR-Code im Terminal**.

Handy-Kamera draufhalten, antippen — fertig. Kein Abtippen nötig.

> **Das Handy muss im selben Netzwerk sein** wie dieser Rechner. Bei getrennten
> Gäste-WLANs oder aktiviertem AP-Isolation-Modus im Router klappt es nicht.

Den QR-Code später erneut anzeigen:

```bash
node apps/server/dist/cli.js qr geraetetest upload
```

## Wenn das Handy die Seite nicht lädt

In dieser Reihenfolge prüfen:

1. **Gleiches WLAN?** Handy nicht im Gäste-WLAN, nicht über Mobilfunk.
2. **Erreichbarkeit:** Im Handy-Browser `http://192.168.0.168:8080/healthz` öffnen.
   Kommt `{"status":"ok"}`, steht die Verbindung.
3. **Firewall:** Es existieren bereits Inbound-Regeln für Node.js im Profil „Privat",
   das sollte reichen. Falls doch blockiert, in einer **Administrator**-PowerShell:

```powershell
New-NetFirewallRule -DisplayName "PicPool Dev" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private
```

4. **IP geändert?** Die Adresse kommt per DHCP und kann wechseln. `npm run dev:lan`
   erzeugt die Links immer mit der aktuellen Adresse — nach einem IP-Wechsel also
   neu starten und neu scannen.

## Die Prüfliste

### iPhone — der wichtigste Fall

Vorher in den iPhone-Einstellungen sicherstellen, dass auch wirklich HEIC entsteht:

- **Einstellungen → Kamera → Formate → „Hohe Effizienz"** (nicht „Maximale Kompatibilität")
- **Einstellungen → Fotos → ganz unten → „Originale behalten"** (nicht „Automatisch")

Steht dort „Automatisch", wandelt iOS beim Upload selbst in JPEG um — dann wird der
HEIC-Pfad gar nicht getestet, und der kritischste Fall bliebe ungeprüft.

| # | Test | Erwartung |
|---|---|---|
| 1 | 5–10 Fotos auswählen und hochladen | alle mit grünem Haken, „Fertig!" |
| 2 | Ein Foto aus der Kamera-App, direkt aufgenommen | wird angenommen, erscheint korrekt gedreht |
| 3 | **Hochkant fotografiertes Bild** | bleibt in der Galerie hochkant |
| 4 | Ein Video von mindestens 30 Sekunden | Fortschritt läuft, am Ende Haken |
| 5 | Live Photo hochladen | mindestens das Standbild kommt an |

### Älteres Android-Gerät

| # | Test | Erwartung |
|---|---|---|
| 6 | Mehrere Fotos auf einmal auswählen | Mehrfachauswahl funktioniert |
| 7 | Name eintragen, Seite schließen, neu öffnen | Name ist noch vorgemerkt |

### Die Abbruch-Fälle — das eigentliche Kernstück

| # | Test | Erwartung |
|---|---|---|
| 8 | Großes Video über **Mobilfunk** (WLAN am Handy aus) | läuft durch, ggf. langsam |
| 9 | Mitten im Upload **Flugmodus an**, 10 Sek. warten, wieder aus | Upload läuft selbstständig weiter, kein Fehler |
| 10 | Mitten im Upload **Bildschirm sperren**, 30 Sek., entsperren | Upload setzt fort (siehe Einschränkung unten) |
| 11 | Mitten im Upload **Seite neu laden** | angefangene Datei wird fortgesetzt, nicht neu begonnen |
| 12 | Mitten im Upload **Zurück-Taste** drücken | Warnung „Möchten Sie die Seite verlassen?" |
| 13 | Dieselben Fotos ein zweites Mal hochladen | Haken mit „war schon da", keine Dubletten |

### WhatsApp-Browser

| # | Test | Erwartung |
|---|---|---|
| 14 | Link sich selbst per WhatsApp schicken, dort antippen | gelber Hinweis „Öffne diese Seite lieber in Safari oder Chrome" |
| 15 | Trotzdem im WhatsApp-Browser hochladen | funktioniert, oder scheitert mit verständlicher Meldung |

### Der Boomer-Test

Der aussagekräftigste von allen: Jemandem das Handy mit dem geöffneten Link in die
Hand drücken und **nichts erklären**. Nur zuschauen.

Wenn gefragt wird „und was mach ich jetzt?", ist die Seite noch nicht fertig.

## Wenn Uploads scheitern

Zwei Werkzeuge stehen bereit:

### 1. Fehlerberichte der Geräte

```bash
node apps/server/dist/cli.js fehler
```

Zeigt pro Fehlschlag Dateiname, übertragene Bytes, Versuchszahl, die echte
Browser-Fehlermeldung und die Umstände: ob die Seite im Hintergrund war,
welche Netzwerkart aktiv war, wie viele Uploads gleichzeitig liefen. Dasselbe
steht auch direkt auf dem Handy unter „Technische Einzelheiten".

### 2. Netzwerktest

Am Handy `http://<adresse>:8080/nettest` öffnen. Die Seite schickt Datenmengen
verschiedener Größe an den Server — ohne PicPool dazwischen. Damit lässt sich
trennen, ob die Anwendung oder die Funkstrecke das Problem ist:

| Test | Wenn er scheitert, dann … |
|---|---|
| **1** — nacheinander 1, 2, 4, 8, 16 MB | … liegt es ab einer bestimmten Größe an der Strecke, nicht an PicPool |
| **2** — drei gleichzeitig je 6 MB | … ist Gleichzeitigkeit das Problem |
| **3** — zehn nacheinander je 4 MB | … erschöpft sich etwas über die Zeit: Verbindungen, Speicher oder eine Sperre im Netzwerkpfad |

Der Netzwerktest ist nur aktiv, wenn `PICPOOL_NETTEST` gesetzt ist. Das
Startskript setzt es für die Entwicklung; im Regelbetrieb bleibt er aus — ein
offen erreichbarer Endpunkt, der beliebige Datenmengen annimmt, hat auf einer
privaten NAS nichts verloren.

## Ergebnisse ansehen

In einem zweiten Terminal:

```bash
node apps/server/dist/cli.js album:show geraetetest
```

Zeigt Anzahl, Belegung, wer beigetragen hat und beide Links.

```bash
node apps/server/dist/cli.js status
```

Zeigt auch die Job-Warteschlange. Steht dort etwas bei `failed`, ist bei der
Verarbeitung etwas schiefgegangen — dann lohnt ein Blick ins Worker-Log.

Die Dateien selbst liegen unter `data/originals/geraetetest/<name>/`.

## Bekannte Einschränkung dieses Testaufbaus

**Test 10 (Bildschirm sperren) lässt sich hier nur eingeschränkt prüfen.**

Die Wake-Lock-Funktion, die den Bildschirm während des Uploads wachhält, ist von
Browsern nur in einem *secure context* freigegeben. Das ist bei `https://` der Fall
und bei `http://localhost` — **nicht** aber bei `http://192.168.0.168:8080`.
Nachgemessen: über `127.0.0.1` meldet der Browser `isSecureContext: true` und
`navigator.wakeLock` ist vorhanden; über die LAN-IP ist beides nicht gegeben.

Der Code fängt das ab und läuft ohne Wake Lock weiter — der Bildschirm kann sich
beim LAN-Test also trotzdem abschalten. Ob die **Wiederaufnahme danach** klappt,
ist trotzdem aussagekräftig und sollte geprüft werden; nur das Wachhalten selbst
lässt sich erst nach dem Deployment auf der NAS mit echtem HTTPS testen.

## Was du mir danach sagen solltest

- Welche Tests durchgefallen sind, und was auf dem Bildschirm stand
- Ob Uploads **still** hängen geblieben sind (ohne Fehlermeldung) — das wäre der
  schlimmste Fall und genau das Verhalten, das wir ablösen wollen
- Ob irgendwo unklar war, was zu tun ist
- Bei Fehlern: die Ausgabe von `node apps/server/dist/cli.js status`
