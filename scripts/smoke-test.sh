#!/usr/bin/env bash
# End-to-end check through the gateway: register -> login -> /me -> refresh -> logout.
# Usage: scripts/smoke-test.sh [base_url]
set -euo pipefail

BASE_URL="${1:-http://localhost:8080}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

EMAIL="smoke-$(date +%s)-$RANDOM@shop.dev"
PASSWORD="SmokeTest123"
JSON=(-H "Content-Type: application/json")

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1" >&2; exit 1; }

if curl -fsS -o /dev/null "$BASE_URL/health"; then pass "gateway health"; else fail "gateway health"; fi

if curl -fsS -o /dev/null -X POST "$BASE_URL/api/users/register" "${JSON[@]}" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"full_name\":\"Smoke Test\"}"; then
  pass "register"
else
  fail "register"
fi

if TOKEN="$(curl -fsS -c "$JAR" -X POST "$BASE_URL/api/users/login" "${JSON[@]}" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jq -er .access_token)"; then
  pass "login"
else
  fail "login"
fi

ME_EMAIL="$(curl -fsS "$BASE_URL/api/users/me" -H "Authorization: Bearer $TOKEN" | jq -er .email || true)"
if [[ "$ME_EMAIL" == "$EMAIL" ]]; then pass "GET /me returns the new user"; else fail "GET /me"; fi

if curl -fsS -b "$JAR" -c "$JAR" -X POST "$BASE_URL/api/users/refresh" | jq -e .access_token >/dev/null; then
  pass "refresh (token rotation)"
else
  fail "refresh"
fi

if curl -fsS -b "$JAR" -o /dev/null -X POST "$BASE_URL/api/users/logout"; then
  pass "logout"
else
  fail "logout"
fi

# The cookie jar still holds the revoked token, so this must be rejected.
if curl -fsS -b "$JAR" -o /dev/null -X POST "$BASE_URL/api/users/refresh" 2>/dev/null; then
  fail "refresh after logout should be rejected"
else
  pass "refresh after logout is rejected"
fi

echo "All smoke checks passed."
