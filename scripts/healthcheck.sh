#!/usr/bin/env bash
# Wait until the gateway and the services behind it answer.
# Usage: scripts/healthcheck.sh [base_url] [timeout_seconds]
set -euo pipefail

BASE_URL="${1:-http://localhost:8080}"
TIMEOUT="${2:-60}"

wait_for() {
  local name="$1" path="$2" deadline=$((SECONDS + TIMEOUT))
  until curl -fsS -o /dev/null "$BASE_URL$path"; do
    if ((SECONDS >= deadline)); then
      echo "FAIL  $name ($BASE_URL$path) not healthy after ${TIMEOUT}s" >&2
      return 1
    fi
    sleep 2
  done
  echo "OK    $name"
}

wait_for "gateway" "/health"
wait_for "user-service (via gateway)" "/api/users/openapi.json"
