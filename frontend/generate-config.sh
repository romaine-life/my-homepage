#!/bin/bash
# Generates frontend/config.js from environment variables.
#
# Usage (local dev):
#   export API_URL="http://localhost:3001"
#   export MICROSOFT_CLIENT_ID="your-client-id"
#   bash frontend/generate-config.sh
#
# Optional bypass variable (set in CI/CD for corporate firewall workaround):
#   export API_BYPASS_URL="https://app.region.azurecontainerapps.io"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

: "${API_URL:?ERROR: API_URL is not set}"
: "${MICROSOFT_CLIENT_ID:?ERROR: MICROSOFT_CLIENT_ID is not set}"

# Bypass URL falls back to the primary API URL when not set (local dev).
BYPASS_API="${API_BYPASS_URL:-${API_URL}}"

# apiRoot is API_URL with any trailing /homepage stripped so /fzt/* etc can
# hang off the same host. API_URL itself stays rooted at /homepage so legacy
# callers (auth, settings) keep working unchanged.
API_ROOT="${API_URL%/homepage}"
BYPASS_ROOT="${BYPASS_API%/homepage}"

cat <<EOF > "$SCRIPT_DIR/config.js"
const _isBypass = window.location.hostname.includes("azurestaticapps.net");

export const CONFIG = {
  apiUrl: _isBypass ? "${BYPASS_API}" : "${API_URL}",
  apiRoot: _isBypass ? "${BYPASS_ROOT}" : "${API_ROOT}",
  isBypass: _isBypass,
  microsoftClientId: "${MICROSOFT_CLIENT_ID}",
};
EOF

echo "Successfully generated $SCRIPT_DIR/config.js"
