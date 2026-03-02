#!/bin/bash
# Generates frontend/config.js from environment variables.
#
# Usage (local dev):
#   export API_URL="http://localhost:3000"
#   bash frontend/generate-config.sh
#
# Optional bypass variable (set in CI/CD for corporate firewall workaround):
#   export API_BYPASS_URL="https://app.region.azurecontainerapps.io"
#
# In the CI/CD pipeline, these variables should be set from Spacelift outputs
# before this script runs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

: "${API_URL:?ERROR: API_URL is not set}"

# Bypass URL falls back to the primary API URL when not set (local dev).
BYPASS_API="${API_BYPASS_URL:-${API_URL}}"

cat <<EOF > "$SCRIPT_DIR/config.js"
const _isBypass = window.location.hostname.includes("azurestaticapps.net");

export const CONFIG = {
  apiUrl: _isBypass ? "${BYPASS_API}" : "${API_URL}",
  isBypass: _isBypass,
};
EOF

echo "Successfully generated $SCRIPT_DIR/config.js"
