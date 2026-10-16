#!/bin/sh
set -eu

: "${ALERT_EMAIL:?ALERT_EMAIL is required}"
: "${SMTP_FROM:?SMTP_FROM is required}"
: "${SMTP_PASSWORD:?SMTP_PASSWORD is required}"
: "${SMTP_SMARTHOST:?SMTP_SMARTHOST is required}"
: "${SMTP_USERNAME:?SMTP_USERNAME is required}"

if ! printf '%s\n' "$SMTP_SMARTHOST" | grep -Eq '^[A-Za-z0-9.-]+:[0-9]{1,5}$'; then
  echo "SMTP_SMARTHOST must be a hostname and port, for example smtp.example.com:587." >&2
  exit 1
fi

for address in "$ALERT_EMAIL" "$SMTP_FROM"; do
  if ! printf '%s\n' "$address" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
    echo "ALERT_EMAIL and SMTP_FROM must be valid email addresses." >&2
    exit 1
  fi
done

if ! printf '%s\n' "$SMTP_USERNAME" | grep -Eq '^[A-Za-z0-9._%+-][A-Za-z0-9._%@+-]*$'; then
  echo "SMTP_USERNAME contains unsupported characters." >&2
  exit 1
fi

umask 077
password_file=/tmp/smtp_password
config_file=/tmp/alertmanager.yml
printf '%s' "$SMTP_PASSWORD" > "$password_file"
envsubst '${ALERT_EMAIL} ${SMTP_FROM} ${SMTP_SMARTHOST} ${SMTP_USERNAME}' \
  < /etc/alertmanager/alertmanager.yml.template > "$config_file"

if [ "$#" -eq 1 ] && [ "$1" = "--check-config" ]; then
  /bin/amtool check-config "$config_file"
  rm -f "$password_file"
  exit 0
fi

exec /bin/alertmanager --config.file="$config_file" --storage.path=/alertmanager "$@"
