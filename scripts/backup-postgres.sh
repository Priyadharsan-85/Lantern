#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_PATH="$BACKUP_DIR/lantern-$TIMESTAMP.dump"
CHECKSUM_PATH="$BACKUP_PATH.sha256"

if [ -e "$BACKUP_PATH" ] || [ -e "$CHECKSUM_PATH" ]; then
  echo "Backup already exists for this timestamp: $BACKUP_PATH" >&2
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
  echo "Docker is required to create a database backup." >&2
  exit 1
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum is required to verify the backup." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
umask 077
TEMP_BACKUP="$(mktemp "$BACKUP_DIR/.lantern-$TIMESTAMP.XXXXXX.dump")"
TEMP_CHECKSUM="$TEMP_BACKUP.sha256"
trap 'rm -f -- "$TEMP_BACKUP" "$TEMP_CHECKSUM"' EXIT

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  sh -ec 'exec pg_dump --format=custom --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "$TEMP_BACKUP"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_restore --list < "$TEMP_BACKUP" > /dev/null

CHECKSUM="$(sha256sum < "$TEMP_BACKUP" | awk '{print $1}')"
printf '%s  %s\n' "$CHECKSUM" "$(basename "$BACKUP_PATH")" > "$TEMP_CHECKSUM"
mv -- "$TEMP_BACKUP" "$BACKUP_PATH"
mv -- "$TEMP_CHECKSUM" "$CHECKSUM_PATH"
trap - EXIT

echo "Created and verified PostgreSQL backup: $BACKUP_PATH"
echo "Checksum: $CHECKSUM_PATH"
