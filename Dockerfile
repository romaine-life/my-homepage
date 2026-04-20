# my-homepage is a pure static frontend — nginx serves the files, no backend.
# config.js is generated at CI time by frontend/generate-config.sh before
# this Dockerfile copies the frontend/ dir.
FROM nginx:alpine

# Explicit default config is fine — serve the frontend dir with index.html
# as the fallback for the SPA-ish routes. The app uses history.replaceState
# rather than client routing, but the fallback keeps deep URLs safe.
COPY <<'EOF' /etc/nginx/conf.d/default.conf
server {
    listen 3000 default_server;
    listen [::]:3000 default_server;
    root /usr/share/nginx/html;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
    # Inherit the default mime.types map from nginx's http{} context —
    # do NOT declare a server-level types{} block here. An inner types{}
    # completely overrides the outer map (nginx quirk), leaving every
    # file served as application/octet-stream. application/wasm is
    # already in the stock mime.types on nginx ≥ 1.21.
}
EOF

COPY frontend/ /usr/share/nginx/html/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:3000/ || exit 1
