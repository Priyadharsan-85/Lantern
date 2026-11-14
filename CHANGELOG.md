# Changelog

All notable changes to Lantern are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-07

Initial public release.

### Added

- Node.js tracing SDK with context propagation, batching, retry-safe flushing,
  and queue limits.
- Docker-based collector with Redis Streams ingestion, PostgreSQL persistence,
  project-scoped quotas, span validation, retention cleanup, and Prometheus
  metrics.
- Multi-tenant API gateway with customer sessions, project ingest keys, order
  and catalog services, and optional Stripe checkout that stays disabled in
  production.
- React dashboard with trace filtering, span waterfall, project management,
  one-time ingest key display, and key rotation.
- Cloudflare Workers + D1 tracing MVP with a single provisioned admin, secure
  sessions, idempotent ingestion, per-project and global quotas, scheduled
  retention, and project-isolated trace queries.
- Production Docker Compose stack with Caddy TLS, PostgreSQL, Redis,
  Prometheus, Alertmanager, and Grafana.
- Backup and restore scripts, including encrypted off-site backups and a restore
  rehearsal procedure.
- CI for all package tests, Cloudflare D1 integration tests, dashboard lint and
  build, Worker bundle validation, CodeQL, dependency review, image scanning,
  production Compose validation, alert-rule validation, and the production
  tracing smoke test.
- Hosted smoke test for the deployed Cloudflare Worker covering sign-in,
  project creation, key rotation, span ingestion, trace detail, and trace list.

### Verified

- Hosted Cloudflare sign-in and trace-ingestion smoke test passed on
  2026-11-07 against the then-current `workers.dev` deployment.
- Docker production tracing smoke test runs in CI against the Compose stack.

### Security

- Updated `body-parser` to 2.4.0 and `follow-redirects` to 1.16.2 to resolve
  high-severity production dependency advisories.
- Excluded the Cloudflare Worker's development dependencies from the production
  application image so the image vulnerability scan stays clean.

[1.0.0]: https://github.com/Priyadharsan-85/Lantern/releases/tag/v1.0.0
