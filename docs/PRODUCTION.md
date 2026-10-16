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
cp .env.production.example .env.production
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
- SPAN_STREAM_MAX_LENGTH
- SPAN_PENDING_IDLE_MS
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
- SMTP_SMARTHOST
- SMTP_FROM
- SMTP_PASSWORD
- PAYMENT_PROVIDER=disabled

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
stripe listen --events checkout.session.completed --forward-to http://localhost:4002/webhooks/stripe
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

Production payments are deliberately disabled: the payment service returns `503`
for charge requests and does not accept Stripe webhooks. Do not add Stripe keys
or enable payments in `.env.production`. Local sandbox checkout is for development
only. Customer accounts use salted scrypt password hashes and signed, HttpOnly
sessions; active products are served from the PostgreSQL catalog with prices stored
as integer minor units in INR. The order flow now uses the authenticated customer
session and computes totals from active catalog rows, but live Stripe enablement
still needs production webhook routing, live-mode configuration, and account
security/operational review.

To add a product, insert it through a controlled database/admin workflow. For
example, `price_minor` is in paise (129900 is ₹1,299.00); new products default to
inactive and must be explicitly activated after review. The customer API is
`POST /api/auth/customer/register`, `POST /api/auth/customer/login`,
`GET /api/auth/customer/me`, and `GET /api/products`. The product list is empty
until products are added. The customer storefront is available at `/shop`; the
trace dashboard remains at `/`.

For a local catalog smoke test, add a disposable product directly to the dev
database and remove it after testing:

```sql
INSERT INTO products (product_id, name, description, price_minor, currency, active)
VALUES ('local-example', 'Local example product', 'Sandbox-only fixture', 129900, 'inr', TRUE);
```

Stripe Checkout displays the server-snapshotted product names, quantities, and
prices. A temporary `Lantern Sandbox Sample (test only)` item priced at ₹100 has
been added to the current local database to exercise the storefront. It is not a
migration or production product; remove it when the sandbox test is complete:

```sql
DELETE FROM products WHERE product_id = 'lantern-sandbox-sample';
```

Do not use test fixtures as real production product data.

Authenticated customers submit orders to `POST /api/order` with an `items` array
of `{ "productId": "...", "quantity": 1 }` entries and an `Idempotency-Key`
header. The server resolves active products, snapshots their names/prices, and
computes the INR total; client-supplied user IDs and amounts are ignored. Order
creation will fail until at least one active catalog product has been configured.

## 4. Private networking

The production compose file keeps PostgreSQL, Redis, application services, and monitoring on the same Docker network while exposing only the TLS layer (`80` and `443`) to the internet.

## 5. Monitoring and alerts

Access the stack via:

- Prometheus: http://localhost:9090
- Alertmanager: http://localhost:9093
- Grafana: http://localhost:3000

Prometheus scrapes the collector metrics endpoint at `/metrics`.

Alertmanager sends email using the SMTP settings in `.env.production`:

- `SMTP_SMARTHOST`: SMTP server hostname and port, usually port `587` for STARTTLS.
- `SMTP_FROM`: sender address shown in alert emails.
- `ALERT_EMAIL`: alert recipient.
- `SMTP_USERNAME` and `SMTP_PASSWORD`: SMTP credentials. Some email providers require
  an app-specific password rather than the account password.

The Alertmanager image renders and validates the configuration at startup.
The SMTP password is written to a private temporary password file instead of
the rendered YAML, and is not printed in logs. CI validates the rendered
configuration using Alertmanager's version-matched `amtool`.

After entering real SMTP settings and starting the stack, send a deliberate test
alert to verify delivery (this sends an email to `ALERT_EMAIL`):

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec alertmanager \
  /bin/amtool alert add --alertmanager.url=http://localhost:9093 \
  alertname=SMTPDeliveryTest severity=warning \
  --start="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --end="$(date -u -d '+2 minutes' +%Y-%m-%dT%H:%M:%SZ)" \
  --annotation=summary="Configured SMTP delivery test"
```

Allow at least the configured `group_wait` interval (30 seconds), then check the
recipient inbox and spam folder. The test alert expires after two minutes. A
successful command confirms Alertmanager accepted the alert; it does not by
itself confirm SMTP delivery.

Redis Streams retain spans only while they are queued: after a successful
PostgreSQL write, the consumer acknowledges and deletes the stream entry
atomically. The queue rejects new batches with HTTP `503` and `Retry-After` when
it reaches `SPAN_STREAM_MAX_LENGTH` (default `100000`) rather than silently
trimming unprocessed spans. SDK clients retry failed flushes. The processor uses
unique consumer IDs and reclaims abandoned pending entries after
`SPAN_PENDING_IDLE_MS` (default `30000`); a database outage can therefore leave
spans queued temporarily, while queue capacity provides backpressure.

## 6. Backup strategy

Create a compressed PostgreSQL custom-format backup. The script validates the
archive, writes a SHA-256 checksum, and uses a temporary file so an interrupted
dump is not mistaken for a complete backup:

```bash
ENV_FILE=.env.production \
COMPOSE_FILE=docker-compose.prod.yml \
BACKUP_DIR=/mnt/lantern-encrypted-backups \
bash ./scripts/backup-postgres.sh
```

Schedule this command daily using the host's scheduler, with `BACKUP_DIR` set to
encrypted storage mounted outside the application directory. Copy backups to
off-host/object storage and enforce a retention policy there; the script does not
delete older backups.

Periodically test an archive by restoring it into a temporary database on a
staging PostgreSQL instance (the configured database user needs permission to
create databases). The script removes that temporary database only after a
successful restore and validation; failed restores leave it for investigation:

```bash
ENV_FILE=.env.staging \
COMPOSE_FILE=docker-compose.prod.yml \
bash ./scripts/test-postgres-restore.sh /mnt/lantern-encrypted-backups/lantern-<timestamp>.dump --confirm
```

Do not point the restore test at a production database instance; it creates a
temporary database and consumes database resources.

## 7. Production hardening checklist

Before public release, verify:

- `NODE_ENV=production`
- `CORS_ORIGIN` is a specific domain, not `*`
- `COLLECTOR_API_KEY` is strong and unique
- `PAYMENT_PROVIDER=disabled`; production charge requests are rejected
- Stripe keys and webhook secrets are not configured in production
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
