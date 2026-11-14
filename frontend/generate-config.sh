#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Default to the production fzt-frontend service. Override with FZT_API_BASE
# if a staging deployment needs to point elsewhere.
FZT_API_BASE="${FZT_API_BASE:-https://fzt-frontend.home.romaine.life}"

# Homepage version is the release version CI numbers the build with
# (actions/release-version), or "dev" for local runs without it set.
HOMEPAGE_VERSION="${HOMEPAGE_VERSION:-dev}"

cat <<EOF > "$SCRIPT_DIR/config.js"
export const CONFIG = {
  fztApiBase: "${FZT_API_BASE}",
  homepageVersion: "${HOMEPAGE_VERSION}",
};
EOF

echo "Generated config.js with FZT_API_BASE=${FZT_API_BASE} HOMEPAGE_VERSION=${HOMEPAGE_VERSION}"
