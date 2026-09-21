# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# PicPool - ein Image, zwei Rollen (App und Worker), gesteuert ueber command.
# ---------------------------------------------------------------------------

ARG NODE_VERSION=22-bookworm-slim

# --- Abhaengigkeiten --------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/

RUN npm ci

# --- Build ------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server

RUN npm run build --workspace packages/shared \
 && npm run build --workspace apps/server

# --- Produktions-Abhaengigkeiten --------------------------------------------
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/

RUN npm ci --omit=dev

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

ENV NODE_ENV=production \
    PICPOOL_DATA_DIR=/data

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/
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
