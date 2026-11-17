# my-homepage is a pure static frontend served by a minimal Node+Express
# backend. No server-side logic — the Express server only does static file
# serving + SPA fallback. Kept on Node (rather than nginx/caddy) to match
# the house pattern across every other app in the cluster.
#
# config.js is generated at CI time by frontend/generate-config.sh before
# this Dockerfile copies the frontend/ dir.
FROM artifacts.home.romaine.life/dockerhub/library/node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

WORKDIR /app

# Install backend deps first (cache layer — only invalidated on lockfile change).
COPY backend/package*.json backend/
ARG NPM_CONFIG_REGISTRY=https://artifacts.home.romaine.life/npm/npm/
RUN cd backend && npm ci --omit=dev

# Bring the backend source and the static frontend into the runtime image.
COPY backend/ backend/
COPY frontend/ frontend/
# config.js names the release the suite builds the image as (a PR build has none), and the
# self-test checks it does.
ARG APP_VERSION=dev
ARG SOURCE_SHA=unknown
ENV APP_VERSION=$APP_VERSION SOURCE_SHA=$SOURCE_SHA
RUN HOMEPAGE_VERSION="$APP_VERSION" sh frontend/generate-config.sh
# version.json, for the CI dashboard: this release, its commit and the pinned fzt-browser.
COPY dependencies.lock /tmp/dependencies.lock
RUN fzt=$(awk '$1 == "frontend/fzt.wasm" { print $2 }' /tmp/dependencies.lock) && \
    printf '{"fztBrowser":"%s","version":"%s","sha":"%s","deployedAt":"%s"}\n' "$fzt" "$APP_VERSION" "$SOURCE_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > frontend/version.json && \
    rm /tmp/dependencies.lock

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# An entrypoint, so the image check's `--self-test` reaches the server.
ENTRYPOINT ["node", "backend/server.js"]
