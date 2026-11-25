# ---- Build -----------------------------------------------------------------
# Plain Dockerfile on purpose: builds with BuildKit (GitHub Actions) and with the
# classic builder Portainer uses when you build the image on the server itself.
FROM node:22-bookworm-slim AS build
WORKDIR /src

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --workspace server --workspace web --include-workspace-root --ignore-scripts --no-audit --no-fund

COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web
RUN npm run build -w web && npm run build -w server

# ---- Runtime ---------------------------------------------------------------
# Just Node, one bundled server file, and the built web app. No node_modules.
FROM node:22-alpine
ENV NODE_ENV=production \
    TUNA_PORT=7778 \
    TUNA_DATA_DIR=/config \
    PUID=1000 \
    PGID=1000
WORKDIR /app
COPY --from=build /src/server/dist/server.cjs ./server.cjs
COPY --from=build /src/web/dist ./public
COPY docker/entrypoint.sh /entrypoint.sh
# su-exec: start as root only to fix the data folder's owner, then run as PUID:PGID.
# ffmpeg: measures each song once for Now Playing's waveform.
RUN apk add --no-cache su-exec ffmpeg && chmod +x /entrypoint.sh && mkdir -p /config
EXPOSE 7778
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7778/api/health >/dev/null || exit 1
ENTRYPOINT ["/entrypoint.sh"]
