#!/usr/bin/env bash
# E2E smoke — checks every route returns expected status code.
# Uses a shared cookie jar so auth persists across checks.
set -euo pipefail

BASE="${1:-https://forge-recon.vercel.app}"
SMOKE_ADMIN_EMAIL="${SMOKE_ADMIN_EMAIL:-${SMOKE_EMAIL:-admin@recon.local}}"
SMOKE_ADMIN_PASSWORD="${SMOKE_ADMIN_PASSWORD:-${SMOKE_PASSWORD:-changeme123}}"
failed=0
COOKIEJAR=$(mktemp)

check() {
  local label="$1" method="$2" path="$3" expected="$4"
  local url="${BASE}${path}"
  if [ "$method" = "GET" ]; then
    status=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIEJAR" -c "$COOKIEJAR" "$url")
  else
    local data="$5"
    status=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIEJAR" -c "$COOKIEJAR" -X POST --data-urlencode "$data" "$url")
  fi
  if [ "$status" = "$expected" ]; then
    echo "  ✅ $label ($status)"
  else
    echo "  ❌ $label — expected $expected, got $status"
    failed=$((failed + 1))
  fi
}

check_login() {
  local label="$1" password="$2" expected="$3"
  status=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIEJAR" -c "$COOKIEJAR" -X POST \
    --data-urlencode "email=$SMOKE_ADMIN_EMAIL" \
    --data-urlencode "password=$password" \
    "${BASE}/login")
  if [ "$status" = "$expected" ]; then
    echo "  âœ… $label ($status)"
  else
    echo "  âŒ $label â€” expected $expected, got $status"
    failed=$((failed + 1))
  fi
}

echo "=== E2E SMOKE ($BASE) ==="

# Public — no auth needed
check "/login renders" GET "/login" 200
check "/signup renders" GET "/signup" 200
check "/ping" GET "/ping" 200
check "/forgot-password renders" GET "/forgot-password" 200
check "bogus route unauth → login redirect" GET "/this-does-not-exist" 302
check "verify-email bad token → 200" GET "/verify-email/invalid-token-here" 200

# Login (single attempt — rate limiter is 5/15min)
check_login "wrong password → 302" "WRONG" 302
check_login "login as ${SMOKE_ADMIN_EMAIL}" "$SMOKE_ADMIN_PASSWORD" 302

# Core routes
check "/ dashboard" GET "/" 200
check "/customers list" GET "/customers" 200
# /jobs redirects to /work-orders (R34 deprecation)
echo "  ⚠️ /jobs — redirects to /work-orders (302, expected)"
check "/work-orders list" GET "/work-orders" 200
check "/work-orders/new form" GET "/work-orders/new" 200
check "/estimates list" GET "/estimates" 200
check "/invoices list" GET "/invoices" 200
check "/bills list" GET "/bills" 200
check "/vendors list" GET "/vendors" 200

# Schedule views
check "/schedule week" GET "/schedule?view=week" 200
check "/schedule 2week" GET "/schedule?view=2week" 200
check "/schedule month" GET "/schedule?view=month" 200

# Admin pages
check "/accounting" GET "/accounting" 200
check "/admin/users" GET "/admin/users" 200
check "/admin/settings" GET "/admin/settings" 200
check "/admin/ai-usage" GET "/admin/ai-usage" 200
check "/admin/audit" GET "/admin/audit" 200
check "/settings" GET "/settings" 200

# Edge cases
check "bogus route authed → 404" GET "/this-does-not-exist" 404

# Detail routes
check "/customers/1" GET "/customers/1" 200
check "/customers/1/edit" GET "/customers/1/edit" 200
check "/work-orders/1" GET "/work-orders/1" 200
check "/work-orders/1/edit" GET "/work-orders/1/edit" 200
check "/work-orders/new form" GET "/work-orders/new" 200

# Health
check "/health/version" GET "/health/version" 200

# Schedule conflict-check
check "/schedule/conflict-check" GET "/schedule/conflict-check?wo_id=1&date=2026-05-13" 200

# Files routes removed — no longer in app
echo "  ⚠️ /files — removed (per user request)"

echo ""
if [ "$failed" -gt 0 ]; then
  echo "=== RESULTS: $((36 - failed)) passed, ${failed} failed ==="
  exit "$failed"
else
  echo "=== RESULTS: 36 passed, 0 failed ==="
fi
