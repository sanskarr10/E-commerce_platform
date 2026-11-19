#!/usr/bin/env bash
# Dump every service database from the running compose stack and prune old backups.
# Usage: scripts/db-backup.sh        (env: BACKUP_DIR=backups RETENTION_DAYS=7)
set -euo pipefail

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
STAMP="$(date +%Y%m%d-%H%M%S)"
COMPOSE=(docker compose --env-file .env -f deploy/docker-compose.yml)

mkdir -p "$BACKUP_DIR"

dump() {
  local label="$1" out="$BACKUP_DIR/$1-$STAMP.sql.gz"
  shift
  if "$@" | gzip >"$out"; then
    echo "wrote $out ($(du -h "$out" | cut -f1))"
  else
    rm -f "$out" # never leave a truncated dump that looks valid
    echo "backup of $label failed" >&2
    exit 1
  fi
}

for db in users_db orders_db payments_db; do
  dump "$db" "${COMPOSE[@]}" exec -T postgres sh -c "pg_dump -U \"\$POSTGRES_USER\" --no-owner $db"
done

# Single quotes are intentional: the variables must expand inside the container, not here.
# shellcheck disable=SC2016
dump "catalog" "${COMPOSE[@]}" exec -T mysql sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot --single-transaction --routines "$MYSQL_DATABASE"'

find "$BACKUP_DIR" -name '*.sql.gz' -mtime +"$RETENTION_DAYS" -print -delete | sed 's/^/pruned /'
