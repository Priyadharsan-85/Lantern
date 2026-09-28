#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env.production}"
if [ ! -f "$ENV_FILE" ]; then
  echo "Production environment file not found: $ENV_FILE" >&2
  exit 1
fi

while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
    echo "Malformed environment entry in $ENV_FILE." >&2
    exit 1
  fi
  key="${BASH_REMATCH[1]}"
  value="${BASH_REMATCH[2]}"
  if [[ "$value" == \"*\" && "$value" == *\" ]] ||
     [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf -v "$key" '%s' "$value"
  export "$key"
done < "$ENV_FILE"

required_vars=(
  APP_DOMAIN
  DASHBOARD_DOMAIN
  TLS_EMAIL
  PGHOST
  PGUSER
  PGPASSWORD
  PGDATABASE
  REDIS_HOST
  REDIS_PORT
  COLLECTOR_API_KEY
  CORS_ORIGIN
  DASHBOARD_ORIGIN
  DASHBOARD_AUTH_USER
  DASHBOARD_AUTH_PASSWORD
  SESSION_SECRET
  SPANS_RATE_LIMIT_MAX
  SPANS_RATE_LIMIT_WINDOW_MS
  PAYMENT_FAILURE_RATE
  PAYMENT_PROVIDER
  VITE_COLLECTOR_URL
  GRAFANA_ADMIN_USER
  GRAFANA_ADMIN_PASSWORD
  ALERT_EMAIL
  SMTP_USERNAME
  SMTP_PASSWORD
)

for var in "${required_vars[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "Missing required production variable: $var" >&2
    exit 1
  fi
done

if [ "$PAYMENT_PROVIDER" != "disabled" ]; then
  echo "PAYMENT_PROVIDER must be disabled in production; only local Stripe sandbox payments are supported." >&2
  exit 1
fi

if [ "${#SESSION_SECRET}" -lt 32 ]; then
  echo "SESSION_SECRET must be at least 32 characters." >&2
  exit 1
fi

if [ "${#DASHBOARD_AUTH_PASSWORD}" -lt 12 ]; then
  echo "DASHBOARD_AUTH_PASSWORD must be at least 12 characters." >&2
  exit 1
fi

echo "Production environment appears valid."
