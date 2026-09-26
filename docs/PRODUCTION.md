# Production deployment guide

This project is now structured for a real production deployment with:

- TLS termination via Caddy
- reverse proxy routing for the app and dashboard
- separate production compose file
- internal networking for PostgreSQL and Redis
- monitoring via Prometheus, Alertmanager, and Grafana
- backup script for PostgreSQL
- versioned PostgreSQL migrations

## 1. Create a secure production environment

Copy the sample values and replace them with production-specific secrets:

```bash
cp .env.example .env.production
chmod 600 .env.production
```

Required production values include:

- APP_DOMAIN
- DASHBOARD_DOMAIN
- TLS_EMAIL
- PGUSER
- PGPASSWORD
- PGDATABASE
- REDIS_HOST
- REDIS_PORT
- COLLECTOR_API_KEY
- CORS_ORIGIN
- DASHBOARD_ORIGIN
- DASHBOARD_AUTH_USER
- DASHBOARD_AUTH_PASSWORD
- SESSION_SECRET
- GRAFANA_ADMIN_USER
- GRAFANA_ADMIN_PASSWORD
- ALERT_EMAIL
- SMTP_USERNAME
- SMTP_PASSWORD
- PAYMENT_PROVIDER
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- PAYMENT_CURRENCY
- PAYMENT_PRODUCT_NAME
- STRIPE_SUCCESS_URL
- STRIPE_CANCEL_URL

For real deployments, use a secret manager such as:

- AWS Secrets Manager
- Azure Key Vault
- GCP Secret Manager
- HashiCorp Vault

The repo is configured to consume a secure `.env.production` file, but production systems should source secrets from a managed secret store instead of committing them to version control.

## 2. Validate the environment

```bash
bash ./scripts/validate-prod-env.sh .env.production
```

## 3. Deploy with TLS and reverse proxy

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml config
docker compose --env-file .env.production -f docker-compose.prod.yml up --build -d
```

The `migrate` service runs pending files from `infra/migrations` before application
services start. It records completed migrations in the `schema_migrations` table.
Do not edit an already-applied migration; add a new numbered migration instead.

### Local Stripe sandbox testing (no custom domain)

Use the Stripe CLI to forward events to a localhost-only published payment webhook:

```powershell
npm install -g @stripe/cli
stripe login
stripe listen --forward-to localhost:4002/webhooks/stripe
```

Keep `stripe listen` running. Copy the `whsec_...` secret it prints into the
ignored `.env` file as `STRIPE_WEBHOOK_SECRET`, and add your sandbox `sk_test_...`
key as `STRIPE_SECRET_KEY`. In another terminal, start the local stack:

```powershell
docker compose -f docker-compose.yaml -f docker-compose.stripe-local.yaml up --build -d
```

The payment service webhook is bound to `127.0.0.1` only. Use the dashboard at
`http://localhost:8080`; do not configure the placeholder `.example.com` domain
as a Stripe endpoint. Stripe CLI forwarding is for local sandbox tests, not live
payments.

Caddy automatically obtains HTTPS certificates from Let’s Encrypt using the configured `TLS_EMAIL` and domains.

Stripe Checkout sends customers to Stripe-hosted payment pages. Configure a Stripe
webhook endpoint at `https://<APP_DOMAIN>/webhooks/stripe` for
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, and `checkout.session.expired`. Copy the
endpoint signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`. Keep both URLs
in `.env.production` quoted because they contain shell-significant characters.
Orders remain pending until a verified webhook confirms payment. Set
`STRIPE_SUCCESS_URL` to an HTTPS dashboard URL containing the literal
`{CHECKOUT_SESSION_ID}` placeholder; customers must not be treated as paid based
only on their browser redirect. This implementation deliberately accepts only
Stripe sandbox keys: live charging remains disabled until product prices and
customer identity are derived from trusted server-side data.

## 4. Private networking

The production compose file keeps PostgreSQL, Redis, application services, and monitoring on the same Docker network while exposing only the TLS layer (`80` and `443`) to the internet.

## 5. Monitoring and alerts

Access the stack via:

- Prometheus: http://localhost:9090
- Alertmanager: http://localhost:9093
- Grafana: http://localhost:3000

Prometheus scrapes the collector metrics endpoint at `/metrics`.

Alertmanager is set up as a template. Configure real notification endpoints in `monitoring/alertmanager.yml` before production use.

## 6. Backup strategy

Create a backup:

```bash
BACKUP_DIR=./backups ./scripts/backup-postgres.sh
```

Recommended production backup flow:

- run daily Postgres dumps
- store them off-host or in object storage
- keep at least 30 days of retention
- encrypt backups at rest
- test restores periodically

## 7. Production hardening checklist

Before public release, verify:

- `NODE_ENV=production`
- `CORS_ORIGIN` is a specific domain, not `*`
- `COLLECTOR_API_KEY` is strong and unique
- `PAYMENT_PROVIDER=stripe` and `STRIPE_SECRET_KEY` are configured before enabling production payments
- simulated payments are never enabled in production
- no DB/Redis ports are published to the internet
- TLS certificates are valid and renewed automatically
- monitoring and alerts are active
- backups are tested
- secrets are not stored in source control
- dashboard login works and unauthenticated trace requests return `401`

## 8. Recommended platform-specific next step

For a cloud deployment, use a managed service such as:

- Docker + DigitalOcean droplet + Caddy
- ECS / EKS / AKS / Cloud Run
- a managed PostgreSQL service with private networking
- a managed Redis service with private networking

This repo is production-oriented, but real Stripe payment processing still requires completing the provider call and webhook/reconciliation flow before accepting real payments.
