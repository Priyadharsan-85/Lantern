#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ] || [ "$2" != "--confirm" ]; then
  echo "Usage: $0 <backup.dump> --confirm" >&2
  echo "This creates and then removes a temporary database in the configured PostgreSQL instance." >&2
  exit 2
fi

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_PATH="$(cd -- "$(dirname -- "$1")" && pwd)/$(basename -- "$1")"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"

if [ ! -f "$BACKUP_PATH" ]; then
  echo "Backup file not found: $BACKUP_PATH" >&2
  exit 1
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "Environment file not found: $ENV_FILE" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to test a database restore." >&2
  exit 1
fi

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
if [ ! -f "$BACKUP_PATH.sha256" ]; then
  echo "Backup checksum not found: $BACKUP_PATH.sha256" >&2
  exit 1
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum is required to verify the backup checksum." >&2
  exit 1
fi
(cd "$(dirname "$BACKUP_PATH")" && sha256sum --check "$(basename "$BACKUP_PATH").sha256")

"${COMPOSE[@]}" exec -T postgres pg_restore --list < "$BACKUP_PATH" > /dev/null

RESTORE_DATABASE="lantern_restore_test_$(date -u +%Y%m%d%H%M%S)_${BASHPID}"
"${COMPOSE[@]}" exec -T postgres sh -ec \
  'createdb --template=template0 -U "$POSTGRES_USER" "$1"' sh "$RESTORE_DATABASE"

if ! "${COMPOSE[@]}" exec -T postgres sh -ec \
  'pg_restore --exit-on-error --no-owner --no-acl -U "$POSTGRES_USER" -d "$1"' \
  sh "$RESTORE_DATABASE" < "$BACKUP_PATH"; then
  echo "Restore failed; temporary database $RESTORE_DATABASE was left in place for investigation." >&2
  exit 1
fi

TABLE_COUNT="$("${COMPOSE[@]}" exec -T postgres sh -ec \
  'psql -U "$POSTGRES_USER" -d "$1" -Atc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '\''public'\''"' \
  sh "$RESTORE_DATABASE")"
if ! [[ "$TABLE_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  echo "Restore completed but no public tables were found; temporary database $RESTORE_DATABASE was left in place." >&2
  exit 1
fi

"${COMPOSE[@]}" exec -T postgres sh -ec 'dropdb -U "$POSTGRES_USER" "$1"' sh "$RESTORE_DATABASE"
echo "Restore test passed: restored $TABLE_COUNT public tables into a temporary database and removed it."
