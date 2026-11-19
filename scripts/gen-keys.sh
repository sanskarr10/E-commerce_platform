#!/usr/bin/env bash
# Generate the RS256 key pair used to sign (user-service) and verify (all services) JWTs.
# DEV ONLY. In Kubernetes the private key lives in a Secret and only user-service mounts it.
set -euo pipefail

cd "$(dirname "$0")/.."
KEY_DIR="deploy/keys"
PRIVATE="$KEY_DIR/jwt_private.pem"
PUBLIC="$KEY_DIR/jwt_public.pem"

if [[ -f "$PRIVATE" && "${1:-}" != "--force" ]]; then
  echo "Keys already exist in $KEY_DIR (use --force to regenerate)."
  exit 0
fi

mkdir -p "$KEY_DIR"
openssl genrsa -out "$PRIVATE" 2048 2>/dev/null
openssl rsa -in "$PRIVATE" -pubout -out "$PUBLIC" 2>/dev/null
# World-readable so the non-root container user can read the bind mount. Dev only.
chmod 644 "$PRIVATE" "$PUBLIC"
echo "Generated $PRIVATE and $PUBLIC"
