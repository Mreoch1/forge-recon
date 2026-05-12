#!/usr/bin/env bash
# E2E smoke test — run before every deploy
# Usage: bash scripts/e2e-smoke.sh
set -euo pipefail

BASE="${1:-https://forge-recon.vercel.app}"
COOKIE_JAR=$(mktemp)
PASS=0
FAIL=0

check() {
  local label="$1" method="$2" path="$3" expected="$4"
  shift 4
  local code
  if [ "$method" = "GET" ]; then
    code=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" "${BASE}${path}")
  else
    # Build --data-urlencode args from remaining params
    local args=""
    for v in "$@"; do args="$args --data-urlencode $v"; done
    code=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -X POST $args "${BASE}${path}")
  fi
  if [ "$code" = "$expected" ]; then
    echo "  ✅ $label ($code)"
    PASS=$((PASS+1))
  else
    echo "  ❌ $label — expected $expected, got $code"
    FAIL=$((FAIL+1))
  fi
}

echo "=== E2E SMOKE ==="

# Public
check "/login renders" GET "/login" 200
check "/signup renders" GET "/signup" 200
check "/ping" GET "/ping" 200
check "/forgot-password renders" GET "/forgot-password" 200

# Login
check "wrong password → 401" POST "/login" 401 "email=admin@recon.local" "password=WRONG"
curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" -o /dev/null -X POST --data-urlencode "email=admin@recon.local" --data-urlencode "password=changeme123" "${BASE}/login"

# Authenticated routes
check "/ dashboard" GET "/" 200
check "/customers list" GET "/customers" 200
check "/jobs redirects" GET "/jobs" 302
check "/work-orders list" GET "/work-orders" 200
check "/work-orders/new form" GET "/work-orders/new" 200
check "/estimates list" GET "/estimates" 200
check "/invoices list" GET "/invoices" 200
check "/bills list" GET "/bills" 200
check "/vendors list" GET "/vendors" 200
check "/schedule week" GET "/schedule?view=week" 200
check "/schedule 2week" GET "/schedule?view=2week" 200
check "/files" GET "/files" 200
check "/files/customers" GET "/files/customers" 200
check "/files/projects" GET "/files/projects" 200
check "/accounting" GET "/accounting" 200
check "/admin/users" GET "/admin/users" 200
check "/admin/settings" GET "/admin/settings" 200
check "/admin/ai-usage" GET "/admin/ai-usage" 200
check "/admin/audit" GET "/admin/audit" 200
check "/settings" GET "/settings" 200

# Detail routes
check "/customers/1" GET "/customers/1" 200
check "/customers/1/edit" GET "/customers/1/edit" 200
check "/work-orders/1" GET "/work-orders/1" 200
check "/work-orders/1/edit" GET "/work-orders/1/edit" 200
check "/work-orders/new form" GET "/work-orders/new" 200
check "/health/version" GET "/health/version" 200

echo ""
echo "=== RESULTS: $PASS passed, $FAIL failed ==="
rm -f "$COOKIE_JAR"
exit $FAIL
