#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_PATH="$BACKUP_DIR/lantern-$TIMESTAMP.dump"
ENCRYPTED_PATH="$BACKUP_PATH.age"
CHECKSUM_PATH="$ENCRYPTED_PATH.sha256"

: "${AGE_RECIPIENT:?Set AGE_RECIPIENT to the backup age public recipient}"
: "${RCLONE_REMOTE:?Set RCLONE_REMOTE to a dedicated rclone remote directory}"

if [[ ! "$RETENTION_DAYS" =~ ^[1-9][0-9]{0,3}$ ]] || (( RETENTION_DAYS < 7 )); then
  echo "RETENTION_DAYS must be an integer of at least 7." >&2
  exit 1
fi

REMOTE_NAME="${RCLONE_REMOTE%%:*}"
REMOTE_PATH="${RCLONE_REMOTE#*:}"
if [[ "$RCLONE_REMOTE" != *:* || ! "$REMOTE_NAME" =~ ^[A-Za-z0-9_-]+$ ||
      -z "$REMOTE_PATH" || "$REMOTE_PATH" == "." ||
      "$REMOTE_PATH" =~ ^/*$ ||
      "/$REMOTE_PATH/" == *"/../"* ]]; then
  echo "RCLONE_REMOTE must be a dedicated relative path such as drive:Lantern/backups." >&2
  exit 1
fi

if [ -e "$ENCRYPTED_PATH" ] || [ -e "$CHECKSUM_PATH" ]; then
  echo "Encrypted backup already exists for this timestamp: $ENCRYPTED_PATH" >&2
  exit 1
fi

for command_name in age rclone sha256sum find; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required for encrypted off-site backups." >&2
    exit 1
  fi
done

umask 077
mkdir -p "$BACKUP_DIR"
TEMP_ENCRYPTED="$(mktemp "$BACKUP_DIR/.lantern-$TIMESTAMP.XXXXXX.dump.age")"
TEMP_CHECKSUM="$TEMP_ENCRYPTED.sha256"
trap 'rm -f -- "$TEMP_ENCRYPTED" "$TEMP_CHECKSUM"' EXIT

BACKUP_TIMESTAMP="$TIMESTAMP" BACKUP_DIR="$BACKUP_DIR" \
  bash "$ROOT_DIR/scripts/backup-postgres.sh"

age --encrypt --recipient "$AGE_RECIPIENT" --output "$TEMP_ENCRYPTED" "$BACKUP_PATH"
ENCRYPTED_CHECKSUM="$(sha256sum < "$TEMP_ENCRYPTED" | awk '{print $1}')"
printf '%s  %s\n' "$ENCRYPTED_CHECKSUM" "$(basename "$ENCRYPTED_PATH")" > "$TEMP_CHECKSUM"
mv -- "$TEMP_ENCRYPTED" "$ENCRYPTED_PATH"
mv -- "$TEMP_CHECKSUM" "$CHECKSUM_PATH"

REMOTE_BACKUP="$RCLONE_REMOTE/$(basename "$ENCRYPTED_PATH")"
REMOTE_CHECKSUM="$REMOTE_BACKUP.sha256"
rclone copyto "$ENCRYPTED_PATH" "$REMOTE_BACKUP"
rclone copyto "$CHECKSUM_PATH" "$REMOTE_CHECKSUM"

(cd "$BACKUP_DIR" && sha256sum --check "$(basename "$CHECKSUM_PATH")")

# Retain only encrypted local copies after both off-site objects are uploaded.
rm -f -- "$BACKUP_PATH" "$BACKUP_PATH.sha256"
rclone delete "$RCLONE_REMOTE" \
  --min-age "${RETENTION_DAYS}d" \
  --include 'lantern-*.dump.age' \
  --include 'lantern-*.dump.age.sha256'
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'lantern-*.dump' -o -name 'lantern-*.dump.sha256' \
     -o -name 'lantern-*.dump.age' -o -name 'lantern-*.dump.age.sha256' \) \
  -mmin "+$((RETENTION_DAYS * 1440))" -delete

trap - EXIT
rm -f -- "$TEMP_ENCRYPTED" "$TEMP_CHECKSUM"
echo "Encrypted PostgreSQL backup uploaded: $REMOTE_BACKUP"
echo "Local encrypted checksum validated and saved off-site."
echo "Retention: $RETENTION_DAYS days (local and off-site)"
