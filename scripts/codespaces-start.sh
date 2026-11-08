#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE=".env.codespaces"
COMPOSE=(docker compose --env-file "$ENV_FILE")

if [ ! -f "$ENV_FILE" ]; then
  umask 077
  {
    echo "PGPASSWORD=$(openssl rand -hex 32)"
    echo "COLLECTOR_API_KEY=$(openssl rand -hex 32)"
    echo "CORS_ORIGIN=http://localhost:8080"
    echo "DASHBOARD_ORIGIN=http://localhost:8080"
    echo "PUBLIC_APP_URL=http://localhost:8080"
    echo "SESSION_SECRET=$(openssl rand -hex 32)"
    echo "CUSTOMER_IDENTITY_SECRET=$(openssl rand -hex 32)"
    echo "VITE_COLLECTOR_URL=/api"
    echo "PAYMENT_FAILURE_RATE=0"
    echo "PAYMENT_PROVIDER=disabled"
  } > "$ENV_FILE"
fi

"${COMPOSE[@]}" up --build -d

echo "Waiting for the gateway on port 8080..."
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:8080/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

DEMO_EMAIL="demo-$(date +%s)@example.com"
DEMO_PASSWORD="$(openssl rand -hex 16)"
curl -fsS -X POST http://localhost:8080/api/auth/customer/register \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$DEMO_EMAIL\",\"password\":\"$DEMO_PASSWORD\"}" >/dev/null || true

"${COMPOSE[@]}" exec -T postgres psql -U postgres -d lantern \
  -c "UPDATE customers SET email_verified_at = now() WHERE LOWER(email) = LOWER('$DEMO_EMAIL');" >/dev/null

"${COMPOSE[@]}" ps
echo
echo "Lantern is running on forwarded port 8080."
echo "In the Ports tab, set port 8080 to Public, then open its URL."
echo "Demo login: $DEMO_EMAIL / $DEMO_PASSWORD"
