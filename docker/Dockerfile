# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# PicPool - ein Image, zwei Rollen (App und Worker), gesteuert ueber command.
# ---------------------------------------------------------------------------

ARG NODE_VERSION=22-bookworm-slim

# --- Abhaengigkeiten --------------------------------------------------------
# Erst nur die Manifeste kopieren: solange sich an den Abhaengigkeiten nichts
# aendert, kommt dieser Schritt aus dem Cache, auch wenn der Quellcode sich
# geaendert hat.
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json   ./apps/server/
COPY apps/upload/package.json   ./apps/upload/
COPY apps/gallery/package.json  ./apps/gallery/
COPY apps/admin/package.json    ./apps/admin/

RUN npm ci

# --- Build ------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/server   ./apps/server
COPY apps/upload   ./apps/upload
COPY apps/gallery  ./apps/gallery
COPY apps/admin    ./apps/admin

# Reihenfolge ist wichtig: shared zuerst, danach die Oberflaechen, zuletzt der
# Server - dessen Build kopiert unter anderem die SQL-Migrationen mit.
RUN npm run build

# --- Produktions-Abhaengigkeiten --------------------------------------------
# Die Oberflaechen sind zu diesem Zeitpunkt fertig gebuendelt; ihre
# Abhaengigkeiten stehen deshalb als devDependencies und fallen hier weg.
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json   ./apps/server/
COPY apps/upload/package.json   ./apps/upload/
COPY apps/gallery/package.json  ./apps/gallery/
COPY apps/admin/package.json    ./apps/admin/

# Die Verzeichnisse werden angelegt, auch wenn npm sie nicht braucht: In einem
# Workspace hebt npm die meisten Pakete nach oben, sodass ein
# workspace-eigenes node_modules fehlen kann. Ein COPY auf einen nicht
# vorhandenen Pfad laesst den Build scheitern.
RUN npm ci --omit=dev \
 && mkdir -p packages/shared/node_modules apps/server/node_modules

# --- Laufzeit ---------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

# ffmpeg wird fuer zwei Dinge gebraucht:
#   1. Video-Poster und optionales Transcoding
#   2. HEIC-Dekodierung - sharp/libvips kann das NICHT, siehe src/lib/media.ts
# Debians ffmpeg bringt den nativen HEVC-Decoder mit; der Selbsttest beim Start
# prueft das und meldet es laut, falls es doch fehlt.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# HOME zeigt auf /tmp, weil das Wurzeldateisystem zur Laufzeit
# schreibgeschuetzt ist und Node sonst beim Anlegen seiner Caches scheitert.
ENV NODE_ENV=production \
    PICPOOL_DATA_DIR=/data \
    HOME=/tmp

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules

COPY --from=build /app/packages/shared/dist         ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/apps/server/dist             ./apps/server/dist
COPY --from=build /app/apps/server/package.json     ./apps/server/

# Die drei Oberflaechen sind statische Dateien. Der Server findet sie ueber
# apps/<name>/dist - dieselbe Struktur wie im Entwicklungsbetrieb.
COPY --from=build /app/apps/upload/dist  ./apps/upload/dist
COPY --from=build /app/apps/gallery/dist ./apps/gallery/dist
COPY --from=build /app/apps/admin/dist   ./apps/admin/dist

COPY package.json ./

# Das Datenverzeichnis wird zur Laufzeit gemountet. Der Container laeuft als
# unprivilegierter Benutzer; die konkrete UID/GID setzt docker-compose, damit
# die Dateien auf der NAS dem dortigen picpool-Benutzer gehoeren und im File
# Station normal sichtbar sind.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PICPOOL_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
