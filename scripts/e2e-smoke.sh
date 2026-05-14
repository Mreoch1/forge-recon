#!/usr/bin/env bash
# E2E smoke wrapper. The route contract lives in smoke-manifest.json and the
# cross-platform Node runner so Windows, WSL, Linux, and CI all check the same
# expectations.
set -euo pipefail

BASE="${1:-${SMOKE_BASE:-https://forge-recon.vercel.app}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node "$SCRIPT_DIR/e2e-smoke.js" "$BASE"
