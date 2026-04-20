# my-homepage is a pure static frontend served by a minimal Node+Express
# backend. No server-side logic — the Express server only does static file
# serving + SPA fallback. Kept on Node (rather than nginx/caddy) to match
# the house pattern across every other app in the cluster.
#
# config.js is generated at CI time by frontend/generate-config.sh before
# this Dockerfile copies the frontend/ dir.
FROM node:20-alpine

WORKDIR /app

# Install backend deps first (cache layer — only invalidated on lockfile change).
COPY backend/package*.json backend/
RUN cd backend && npm install --omit=dev

# Bring the backend source and the static frontend into the runtime image.
COPY backend/ backend/
COPY frontend/ frontend/

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "backend/server.js"]
