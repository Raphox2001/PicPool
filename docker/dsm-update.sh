#!/bin/sh
# ---------------------------------------------------------------------------
# PicPool: Aktualisierung ausfuehren, wenn das Panel darum gebeten hat.
#
# Dieses Skript laeuft ALS DSM-AUFGABE, nicht im Container. Genau das ist der
# Punkt: Der Container darf sich nicht selbst aktualisieren, weil er dafuer
# Zugriff auf den Docker-Socket braeuchte - und der ist gleichbedeutend mit
# Root auf der gesamten NAS.
#
# Das Panel schreibt nur eine Markierungsdatei. Alles Privilegierte passiert
# hier, unter deiner Kontrolle.
#
# Einrichtung in DSM:
#   Systemsteuerung -> Aufgabenplaner -> Erstellen -> Geplante Aufgabe
#     -> Benutzerdefiniertes Skript
#   Benutzer   : root
#   Zeitplan   : alle 5 Minuten (oder taeglich, wenn dir das reicht)
#   Befehl     : sh /volume1/picpool/dsm-update.sh
#
# Das Skript ist absichtlich in /bin/sh geschrieben, nicht in bash: DSM
# bringt bash nicht auf jedem Modell mit.
# ---------------------------------------------------------------------------

set -eu

# --- Anpassen, falls deine Pfade abweichen ---------------------------------
DATA_DIR="/volume1/picpool"

# Verzeichnis mit der docker-compose.yml. Bei einem Projekt aus dem Container
# Manager ist das /volume1/docker/<Projektname>.
COMPOSE_DIR="/volume1/docker/picpool"
# ---------------------------------------------------------------------------

FLAG="$DATA_DIR/update-requested"
LOG="$DATA_DIR/update.log"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S')  $*" >> "$LOG"
}

# Ohne Anforderung ist nichts zu tun. Der haeufigste Fall - deshalb zuerst
# und ohne jede Ausgabe, damit das Log nicht volllaeuft.
[ -f "$FLAG" ] || exit 0

log "Aktualisierung angefordert: $(cat "$FLAG" 2>/dev/null | tr -d '\n')"

# Die Markierung wird ZUERST entfernt. Schlaegt das Update fehl, soll es nicht
# alle fuenf Minuten erneut versuchen und dabei die NAS beschaeftigen - lieber
# einmal scheitern und im Log stehen.
rm -f "$FLAG"

cd "$COMPOSE_DIR" || { log "FEHLER: $COMPOSE_DIR nicht gefunden"; exit 1; }

# Sicherung vor dem Update. Kostet Sekunden und erspart im Zweifel alles.
if docker ps --format '{{.Names}}' | grep -q '^picpool-app$'; then
  log "Sicherung der Datenbank …"
  docker exec picpool-app node apps/server/dist/cli.js backup >> "$LOG" 2>&1 \
    || log "WARNUNG: Sicherung fehlgeschlagen, Update wird trotzdem versucht"
fi

# docker compose (mit Leerzeichen) auf neueren DSM-Versionen,
# docker-compose (mit Bindestrich) auf aelteren.
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  COMPOSE="docker-compose"
fi

log "Hole das neue Image …"
# Faellt der Abruf aus, bleibt das bisherige Image liegen und die laufende
# Version unveraendert - deshalb hier abbrechen und nicht trotzdem neu starten.
$COMPOSE pull >> "$LOG" 2>&1 || {
  log "FEHLER: Abruf fehlgeschlagen - die laufende Version bleibt unveraendert"
  exit 1
}

log "Starte die Container neu …"
$COMPOSE up -d >> "$LOG" 2>&1 || {
  log "FEHLER: Neustart fehlgeschlagen"
  exit 1
}

# Kurz warten und pruefen, ob die Anwendung wieder antwortet.
i=0
while [ "$i" -lt 30 ]; do
  if docker exec picpool-app node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    log "Aktualisierung abgeschlossen, Anwendung antwortet wieder."
    # Alte, nicht mehr benutzte Images aufraeumen.
    docker image prune -f >> "$LOG" 2>&1 || true
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

log "WARNUNG: Anwendung antwortet nach 60 Sekunden nicht. Bitte pruefen:"
log "  docker logs picpool-app --tail 50"
exit 1
