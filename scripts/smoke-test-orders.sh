#!/usr/bin/env bash
# Checkout-saga end-to-end check through the gateway: idempotent ordering, stock reservation,
# payment, compensation (declined card, out of stock), retry of a flaky provider, fulfilment.
#
# Usage: scripts/smoke-test-orders.sh [base_url]
# Admin credentials come from ADMIN_EMAIL / ADMIN_PASSWORD (environment) or from .env.
# Needs the stack running with messaging enabled (make up). Takes about 20 seconds because the
# flaky-provider case waits for one retry delay.
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

# request METHOD PATH [TOKEN] [JSON_BODY] [IDEMPOTENCY_KEY]
# -> sets STATUS; body in $BODY, response headers in $HEADERS
request() {
  local method="$1" path="$2" token="${3:-}" data="${4:-}" key="${5:-}"
  local args=(-sS -o "$BODY" -D "$HEADERS" -w '%{http_code}' -X "$method" "$BASE_URL$path")
  if [[ -n "$token" ]]; then args+=(-H "Authorization: Bearer $token"); fi
  if [[ -n "$data" ]]; then args+=(-H "Content-Type: application/json" -d "$data"); fi
  if [[ -n "$key" ]]; then args+=(-H "Idempotency-Key: $key"); fi
  STATUS="$(curl "${args[@]}")"
}

header() { grep -i "^$1:" "$HEADERS" | head -n1 | cut -d: -f2- | tr -d ' \r' || true; }

fail() {
  echo "FAIL  $1" >&2
  echo "      HTTP $STATUS: $(head -c 400 "$BODY")" >&2
  exit 1
}
expect_status() { if [[ "$STATUS" == "$2" ]]; then echo "PASS  $1"; else fail "$1 (expected HTTP $2)"; fi; }
expect_equal() { if [[ "$2" == "$3" ]]; then echo "PASS  $1"; else fail "$1 (expected '$3', got '$2')"; fi; }

# wait_for DESCRIPTION TIMEOUT_SECONDS COMMAND... : polls until the command succeeds.
wait_for() {
  local description="$1" timeout="$2"
  shift 2
  local waited=0
  until "$@"; do
    if (( waited >= timeout )); then fail "$description (timed out after ${timeout}s)"; fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "PASS  $description"
}

order_status_is() { # TOKEN ORDER_ID EXPECTED
  request GET "/api/orders/$2" "$1"
  [[ "$STATUS" == "200" && "$(jq -r .status "$BODY")" == "$3" ]]
}
stock_is() { # PRODUCT_ID EXPECTED
  request GET "/api/products/$1"
  [[ "$STATUS" == "200" && "$(jq -r .stock "$BODY")" == "$2" ]]
}

RAND="$RANDOM$RANDOM"
LOGIN() { printf '{"email":"%s","password":"%s"}' "$1" "$2"; }
ORDER_JSON() { printf '{"items":[{"product_id":%s,"quantity":%s}],"payment_method":"%s"}' "$1" "$2" "$3"; }

# --- people and products --------------------------------------------------------------------
request POST /api/users/login "" "$(LOGIN "$ADMIN_EMAIL" "$ADMIN_PASSWORD")"
expect_status "admin login" 200
ADMIN_TOKEN="$(jq -er .access_token "$BODY")"

new_customer() { # LABEL -> prints the access token
  local email="smoke-orders-$1-$RAND@shop.dev"
  request POST /api/users/register "" "{\"email\":\"$email\",\"password\":\"SmokeTest123\",\"full_name\":\"Smoke $1\"}"
  request POST /api/users/login "" "$(LOGIN "$email" SmokeTest123)"
  jq -er .access_token "$BODY"
}
ALICE="$(new_customer alice)"
BOB="$(new_customer bob)"

new_product() { # SKU_SUFFIX STOCK -> prints the product id
  request POST /api/products "$ADMIN_TOKEN" "{\"sku\":\"SMOKE-ORD-$1-$RAND\",\"name\":\"Order smoke $1\",\"price_minor\":50000,\"stock\":$2}"
  jq -er .id "$BODY"
}
WIDGET="$(new_product widget 10)"
SCARCE="$(new_product scarce 2)"
echo "PASS  created products $WIDGET (stock 10) and $SCARCE (stock 2)"

# --- idempotency key is mandatory ------------------------------------------------------------
request POST /api/orders "$ALICE" "$(ORDER_JSON "$WIDGET" 1 tok_success)"
expect_status "an order without an Idempotency-Key is rejected" 400

# --- happy path --------------------------------------------------------------------------------
KEY="smoke-$RAND-happy"
request POST /api/orders "$ALICE" "$(ORDER_JSON "$WIDGET" 2 tok_success)" "$KEY"
expect_status "order is accepted" 201
ORDER_ID="$(jq -er .id "$BODY")"
expect_equal "order starts as PENDING" "$(jq -r .status "$BODY")" PENDING
expect_equal "order total is computed server-side (2 x 500.00)" "$(jq -r .total_minor "$BODY")" 100000

wait_for "saga completes: order becomes PAID" 30 order_status_is "$ALICE" "$ORDER_ID" PAID
wait_for "stock was reserved: 10 -> 8" 10 stock_is "$WIDGET" 8

# --- idempotent retry ----------------------------------------------------------------------------
request POST /api/orders "$ALICE" "$(ORDER_JSON "$WIDGET" 2 tok_success)" "$KEY"
expect_status "retry with the same key returns 200" 200
expect_equal "retry returns the original order" "$(jq -r .id "$BODY")" "$ORDER_ID"
expect_equal "retry is flagged as a replay" "$(header Idempotent-Replayed)" true
request POST /api/orders "$ALICE" "$(ORDER_JSON "$WIDGET" 5 tok_success)" "$KEY"
expect_status "same key with a different body is rejected" 422
sleep 2
wait_for "retries did not reserve stock again" 5 stock_is "$WIDGET" 8

# --- payment record and privacy ----------------------------------------------------------------
request GET "/api/payments/orders/$ORDER_ID" "$ALICE"
expect_status "owner reads the payment" 200
expect_equal "payment succeeded" "$(jq -r .status "$BODY")" SUCCEEDED
expect_equal "payment amount matches the order" "$(jq -r .amount_minor "$BODY")" 100000
request GET "/api/orders/$ORDER_ID" "$BOB"
expect_status "another customer cannot see the order" 404
request GET "/api/payments/orders/$ORDER_ID" "$BOB"
expect_status "another customer cannot see the payment" 404

# --- compensation: declined card releases the stock -------------------------------------------
request POST /api/orders "$ALICE" "$(ORDER_JSON "$WIDGET" 3 tok_decline)" "smoke-$RAND-decline"
expect_status "order with a card that will be declined is accepted" 201
DECLINED_ID="$(jq -er .id "$BODY")"
wait_for "declined payment cancels the order" 30 order_status_is "$ALICE" "$DECLINED_ID" CANCELLED
request GET "/api/orders/$DECLINED_ID" "$ALICE"
expect_equal "cancel reason is payment_failed" "$(jq -r .cancel_reason "$BODY")" payment_failed
wait_for "compensation gave the reserved stock back (back to 8)" 30 stock_is "$WIDGET" 8

# --- out of stock: nothing is reserved, nothing is charged --------------------------------------
request POST /api/orders "$ALICE" "$(ORDER_JSON "$SCARCE" 5 tok_success)" "smoke-$RAND-oos"
expect_status "order for more than the stock is accepted (checked by the saga)" 201
OOS_ID="$(jq -er .id "$BODY")"
wait_for "order is cancelled for lack of stock" 30 order_status_is "$ALICE" "$OOS_ID" CANCELLED
request GET "/api/orders/$OOS_ID" "$ALICE"
expect_equal "cancel reason is out_of_stock" "$(jq -r .cancel_reason "$BODY")" out_of_stock
wait_for "scarce product stock is untouched" 5 stock_is "$SCARCE" 2
request GET "/api/payments/orders/$OOS_ID" "$ALICE"
expect_status "no payment was attempted for an out-of-stock order" 404

# --- flaky provider: the retry queue rescues the order ----------------------------------------
request POST /api/orders "$ALICE" "$(ORDER_JSON "$WIDGET" 1 tok_flaky)" "smoke-$RAND-flaky"
expect_status "order with a flaky provider is accepted" 201
FLAKY_ID="$(jq -er .id "$BODY")"
wait_for "provider failed once, the retry succeeded: order is PAID" 60 order_status_is "$ALICE" "$FLAKY_ID" PAID
wait_for "flaky order reserved its unit once (8 -> 7)" 10 stock_is "$WIDGET" 7

# --- fulfilment ----------------------------------------------------------------------------------
request POST "/api/orders/$ORDER_ID/ship" "$ALICE"
expect_status "a customer cannot ship an order" 403
request POST "/api/orders/$DECLINED_ID/ship" "$ADMIN_TOKEN"
expect_status "a cancelled order cannot be shipped" 409
request POST "/api/orders/$ORDER_ID/ship" "$ADMIN_TOKEN"
expect_status "admin ships a paid order" 200
expect_equal "order is SHIPPED" "$(jq -r .status "$BODY")" SHIPPED
request POST "/api/orders/$ORDER_ID/deliver" "$ADMIN_TOKEN"
expect_status "admin delivers it" 200
expect_equal "order is DELIVERED" "$(jq -r .status "$BODY")" DELIVERED

request GET "/api/orders/admin/list?status=DELIVERED" "$ADMIN_TOKEN"
expect_status "admin lists delivered orders" 200
request GET "/api/orders/admin/list" "$ALICE"
expect_status "a customer cannot use the admin list" 403

# --- tidy up: archive the products this run created ----------------------------------------------
request DELETE "/api/products/$WIDGET" "$ADMIN_TOKEN"
request DELETE "/api/products/$SCARCE" "$ADMIN_TOKEN"

echo
echo "All order smoke checks passed."
