#!/usr/bin/env bash
# Product-service end-to-end check through the gateway: authorization, CRUD, stock,
# and the Redis cache including invalidation after writes.
#
# Usage: scripts/smoke-test-products.sh [base_url]
# Admin credentials come from ADMIN_EMAIL / ADMIN_PASSWORD (environment) or from .env.
# Each run leaves one archived product and one category behind (names are unique per run).
set -euo pipefail

cd "$(dirname "$0")/.."
BASE_URL="${1:-http://localhost:8080}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

env_value() {
  if [[ -f .env ]]; then
    grep -E "^$1=" .env | head -n1 | cut -d= -f2- || true
  fi
}
ADMIN_EMAIL="${ADMIN_EMAIL:-$(env_value ADMIN_EMAIL)}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(env_value ADMIN_PASSWORD)}"
if [[ -z "$ADMIN_EMAIL" || -z "$ADMIN_PASSWORD" ]]; then
  echo "Set ADMIN_EMAIL and ADMIN_PASSWORD (environment or .env)" >&2
  exit 2
fi

HEADERS="$(mktemp)"
BODY="$(mktemp)"
trap 'rm -f "$HEADERS" "$BODY"' EXIT
STATUS=""

# request METHOD PATH [TOKEN] [JSON_BODY]  ->  sets STATUS; body in $BODY, headers in $HEADERS
request() {
  local method="$1" path="$2" token="${3:-}" data="${4:-}"
  local args=(-sS -o "$BODY" -D "$HEADERS" -w '%{http_code}' -X "$method" "$BASE_URL$path")
  if [[ -n "$token" ]]; then args+=(-H "Authorization: Bearer $token"); fi
  if [[ -n "$data" ]]; then args+=(-H "Content-Type: application/json" -d "$data"); fi
  STATUS="$(curl "${args[@]}")"
}

header() { grep -i "^$1:" "$HEADERS" | head -n1 | cut -d: -f2- | tr -d ' \r' || true; }

fail() {
  echo "FAIL  $1" >&2
  echo "      HTTP $STATUS: $(head -c 300 "$BODY")" >&2
  exit 1
}
expect_status() { if [[ "$STATUS" == "$2" ]]; then echo "PASS  $1"; else fail "$1 (expected HTTP $2)"; fi; }
expect_equal() { if [[ "$2" == "$3" ]]; then echo "PASS  $1"; else fail "$1 (expected '$3', got '$2')"; fi; }

RAND="$RANDOM$RANDOM"
JSON_LOGIN() { printf '{"email":"%s","password":"%s"}' "$1" "$2"; }

# --- tokens -----------------------------------------------------------------------------
request POST /api/users/login "" "$(JSON_LOGIN "$ADMIN_EMAIL" "$ADMIN_PASSWORD")"
expect_status "admin login" 200
ADMIN_TOKEN="$(jq -er .access_token "$BODY")"

CUSTOMER_EMAIL="smoke-products-$RAND@shop.dev"
request POST /api/users/register "" "{\"email\":\"$CUSTOMER_EMAIL\",\"password\":\"SmokeTest123\",\"full_name\":\"Smoke Customer\"}"
expect_status "customer register" 201
request POST /api/users/login "" "$(JSON_LOGIN "$CUSTOMER_EMAIL" SmokeTest123)"
CUSTOMER_TOKEN="$(jq -er .access_token "$BODY")"

# --- authorization: the product-service verifies the user-service's tokens ----------------
request POST /api/products "" '{"sku":"X","name":"x","price_minor":1}'
expect_status "anonymous cannot create a product" 401
request POST /api/products "$CUSTOMER_TOKEN" '{"sku":"X","name":"x","price_minor":1}'
expect_status "customer cannot create a product" 403

# --- create -------------------------------------------------------------------------------
request POST /api/products/categories "$ADMIN_TOKEN" "{\"name\":\"Smoke $RAND\"}"
expect_status "admin creates a category" 201
CATEGORY_ID="$(jq -er .id "$BODY")"

SKU="SMOKE-$RAND"
NAME="SmokeWidget$RAND"
PRODUCT_JSON="{\"sku\":\"$SKU\",\"name\":\"$NAME\",\"price_minor\":1000,\"stock\":5,\"category_id\":$CATEGORY_ID}"
request POST /api/products "$ADMIN_TOKEN" "$PRODUCT_JSON"
expect_status "admin creates a product" 201
ID="$(jq -er .id "$BODY")"
request POST /api/products "$ADMIN_TOKEN" "$PRODUCT_JSON"
expect_status "duplicate SKU is rejected" 409
request POST /api/products "$ADMIN_TOKEN" '{"price_minor":-1}'
expect_status "invalid body is rejected" 422

# --- caching ------------------------------------------------------------------------------
request GET "/api/products/$ID"
expect_status "public read of the product" 200
expect_equal "first read is a cache MISS" "$(header x-cache)" MISS
request GET "/api/products/$ID"
expect_equal "second read is a cache HIT" "$(header x-cache)" HIT

request GET "/api/products?q=$NAME"
expect_equal "search finds exactly the new product" "$(jq -er .total "$BODY")" 1
request GET "/api/products?q=$NAME"
expect_equal "repeated search is a cache HIT" "$(header x-cache)" HIT

# --- invalidation: a write must never leave stale data behind ------------------------------
request PATCH "/api/products/$ID" "$ADMIN_TOKEN" '{"price_minor":2000}'
expect_status "admin updates the price" 200
request GET "/api/products/$ID"
expect_equal "detail shows the new price" "$(jq -er .price_minor "$BODY")" 2000
expect_equal "detail cache was invalidated (MISS)" "$(header x-cache)" MISS
request GET "/api/products?q=$NAME"
expect_equal "cached search shows the new price" "$(jq -er '.items[0].price_minor' "$BODY")" 2000

# --- stock --------------------------------------------------------------------------------
request PATCH "/api/products/$ID/stock" "$ADMIN_TOKEN" '{"delta":-2}'
expect_equal "stock decreases atomically" "$(jq -er .stock "$BODY")" 3
request GET "/api/products/$ID"
expect_equal "detail reflects the new stock" "$(jq -er .stock "$BODY")" 3
request PATCH "/api/products/$ID/stock" "$ADMIN_TOKEN" '{"delta":-10}'
expect_status "removing more stock than exists is refused" 409

# --- archive ------------------------------------------------------------------------------
request DELETE "/api/products/$ID" "$ADMIN_TOKEN"
expect_status "admin archives the product" 204
request GET "/api/products/$ID"
expect_status "archived product is gone for the public" 404
request GET "/api/products?q=$NAME"
expect_equal "archived product leaves the listing" "$(jq -er .total "$BODY")" 0

echo "All product smoke checks passed."
