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

Caddy automatically obtains HTTPS certificates from Let’s Encrypt using the configured `TLS_EMAIL` and domains.

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

This repo is production-ready from an application and deployment-configuration standpoint, but the final environment-specific deployment should still be run on a managed cloud host with proper network isolation and secrets management.
