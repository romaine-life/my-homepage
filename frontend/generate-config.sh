#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Default to the production fzt-frontend service. Override with FZT_API_BASE
# if a staging deployment needs to point elsewhere.
FZT_API_BASE="${FZT_API_BASE:-https://fzt-frontend.romaine.life}"

cat <<EOF > "$SCRIPT_DIR/config.js"
export const CONFIG = {
  fztApiBase: "${FZT_API_BASE}",
};
EOF

echo "Generated config.js with FZT_API_BASE=${FZT_API_BASE}"
