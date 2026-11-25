#!/usr/bin/env bash
# Notifications and observability end-to-end check through the gateway:
# an order creates in-app notifications and an email, /metrics is not exposed publicly,
# Prometheus is scraping every service.
#
# Usage: scripts/smoke-test-notifications.sh [base_url]
# Admin credentials come from ADMIN_EMAIL / ADMIN_PASSWORD (environment) or from .env.
# Needs the stack running (make up). MAILPIT_URL and PROMETHEUS_URL default to the localhost ports.
set -euo pipefail

cd "$(dirname "$0")/.."
BASE_URL="${1:-http://localhost:8080}"
MAILPIT_URL="${MAILPIT_URL:-http://localhost:8025}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9090}"
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

BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT
STATUS=""

request() { # METHOD PATH [TOKEN] [JSON_BODY] [IDEMPOTENCY_KEY]
  local method="$1" path="$2" token="${3:-}" data="${4:-}" key="${5:-}"
  local args=(-sS -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path")
  if [[ -n "$token" ]]; then args+=(-H "Authorization: Bearer $token"); fi
  if [[ -n "$data" ]]; then args+=(-H "Content-Type: application/json" -d "$data"); fi
  if [[ -n "$key" ]]; then args+=(-H "Idempotency-Key: $key"); fi
  STATUS="$(curl "${args[@]}")"
}
fail() {
  echo "FAIL  $1" >&2
  echo "      HTTP $STATUS: $(head -c 400 "$BODY")" >&2
  exit 1
}
expect_status() { if [[ "$STATUS" == "$2" ]]; then echo "PASS  $1"; else fail "$1 (expected HTTP $2)"; fi; }
expect_equal() { if [[ "$2" == "$3" ]]; then echo "PASS  $1"; else fail "$1 (expected '$3', got '$2')"; fi; }
wait_for() { # DESCRIPTION TIMEOUT COMMAND...
  local description="$1" timeout="$2" waited=0
  shift 2
  until "$@"; do
    if (( waited >= timeout )); then fail "$description (timed out after ${timeout}s)"; fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "PASS  $description"
}

RAND="$RANDOM$RANDOM"
EMAIL="smoke-notify-$RAND@shop.dev"

# --- setup: a customer and a product ---------------------------------------------------------
request POST /api/users/login "" "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}"
expect_status "admin login" 200
ADMIN_TOKEN="$(jq -er .access_token "$BODY")"
request POST /api/users/register "" "{\"email\":\"$EMAIL\",\"password\":\"SmokeTest123\",\"full_name\":\"Notify Smoke\"}"
request POST /api/users/login "" "{\"email\":\"$EMAIL\",\"password\":\"SmokeTest123\"}"
CUSTOMER="$(jq -er .access_token "$BODY")"
request POST /api/products "$ADMIN_TOKEN" "{\"sku\":\"SMOKE-NOTE-$RAND\",\"name\":\"Notify smoke\",\"price_minor\":50000,\"stock\":5}"
PRODUCT="$(jq -er .id "$BODY")"

# --- the notification API needs a login --------------------------------------------------------
request GET /api/notifications
expect_status "notifications require a token" 401
request GET /api/notifications "$CUSTOMER"
expect_status "a new customer can list notifications" 200
expect_equal "and has none yet" "$(jq -r .total "$BODY")" 0

# --- an order produces notifications -------------------------------------------------------------
request POST /api/orders "$CUSTOMER" "{\"items\":[{\"product_id\":$PRODUCT,\"quantity\":1}],\"payment_method\":\"tok_success\"}" "notify-$RAND"
expect_status "order is accepted" 201
ORDER_ID="$(jq -er .id "$BODY")"

notification_count_is() { # EXPECTED
  request GET /api/notifications "$CUSTOMER"
  [[ "$STATUS" == "200" && "$(jq -r .total "$BODY")" == "$1" ]]
}
wait_for "payment confirmation notification arrives" 30 notification_count_is 1
expect_equal "it is the confirmation" "$(jq -r '.items[0].type' "$BODY")" order.confirmed
expect_equal "it refers to the order" "$(jq -r '.items[0].order_id' "$BODY")" "$ORDER_ID"
expect_equal "it is unread" "$(jq -r '.unread' "$BODY")" 1

request POST "/api/orders/$ORDER_ID/ship" "$ADMIN_TOKEN"
expect_status "admin ships the order" 200
wait_for "shipping notification arrives" 15 notification_count_is 2

# --- reading ---------------------------------------------------------------------------------------
NOTIFICATION_ID="$(jq -er '.items[0].id' "$BODY")"
request POST "/api/notifications/$NOTIFICATION_ID/read" "$CUSTOMER"
expect_status "mark one notification read" 200
request POST /api/notifications/read-all "$CUSTOMER"
expect_status "mark all read" 200
request GET "/api/notifications?unread=true" "$CUSTOMER"
expect_equal "nothing is unread any more" "$(jq -r .total "$BODY")" 0

# --- someone else cannot read or touch them -----------------------------------------------------
request POST "/api/notifications/$NOTIFICATION_ID/read" "$ADMIN_TOKEN"
expect_status "another user cannot mark my notification" 404

# --- email landed in Mailpit (skipped when the inbox is not reachable) ----------------------------
if curl -fsS -o /dev/null "$MAILPIT_URL/api/v1/info" 2>/dev/null; then
  email_arrived() {
    curl -fsS "$MAILPIT_URL/api/v1/search?query=to:$EMAIL" | jq -e '.messages_count >= 2' >/dev/null
  }
  wait_for "two emails reached the Mailpit inbox for $EMAIL" 20 email_arrived
else
  echo "SKIP  Mailpit not reachable at $MAILPIT_URL"
fi

# --- /metrics is internal only -------------------------------------------------------------------
for path in /metrics /api/users/metrics /api/orders/metrics /api/notifications/metrics; do
  request GET "$path"
  if [[ "$STATUS" == "200" ]] && grep -q "^# HELP" "$BODY"; then fail "$path leaks Prometheus metrics through the gateway"; fi
done
echo "PASS  the gateway does not expose /metrics"

# --- Prometheus sees every service -------------------------------------------------------------------
if curl -fsS -o /dev/null "$PROMETHEUS_URL/-/ready" 2>/dev/null; then
  targets_up() {
    curl -fsS "$PROMETHEUS_URL/api/v1/query" --data-urlencode \
      'query=count(up{job=~"user-service|product-service|order-service|payment-service|notification-service"} == 1)' \
      | jq -e '.data.result[0].value[1] == "5"' >/dev/null
  }
  wait_for "Prometheus scrapes all 5 services" 45 targets_up
else
  echo "SKIP  Prometheus not reachable at $PROMETHEUS_URL"
fi

echo
echo "All notification and observability checks passed."
