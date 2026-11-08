# Lantern

Lantern is a distributed tracing project: a Node.js SDK sends request spans to a
collector, and a React dashboard helps inspect traces, service calls, timing,
and errors. The repository includes the original Docker Compose application and
a separate Cloudflare Workers + D1 tracing MVP.

> **Deployment status:** the private Cloudflare version is deployed at
> [lantern-tracing.gpriyadharsan789.workers.dev](https://lantern-tracing.gpriyadharsan789.workers.dev).
> The dashboard and health endpoint have been checked over HTTPS, and the
> hosted sign-in and trace-ingestion smoke test passed on 2026-11-07. The
> original Docker Compose deployment and database are untouched and remain the
> fallback.

## What it demonstrates

- Distributed trace/span context with the Lantern Node SDK.
- Project-scoped ingest keys, one-time key display, and key rotation.
- Durable span storage and project-isolated trace search/detail.
- A React dashboard with trace filtering and a span waterfall.
- A private single-admin Worker using secure sessions and D1.
- Batch ingestion, idempotent span writes, per-project monthly quotas, a global
  daily free-plan limit, input-size validation, and trace retention.
- Unit/integration tests, CI checks, and Docker-based local development.

The original multi-service application also contains a storefront and order and
payment flows. Those are deliberately excluded from the private Cloudflare
tracing MVP; they remain in the Docker application.

## Architecture

```text
Instrumented Node.js service
        │  HTTPS POST /spans + project ingest key
        ▼
Cloudflare Worker ─────── React/Vite static dashboard
        │
        ├── D1: customers, sessions, projects, spans, trace summaries, quotas
        └── Daily scheduled cleanup for expired traces
```

Ingestion keys are stored as SHA-256 hashes. Dashboard sessions use secure,
HttpOnly, SameSite cookies; only a password-keyed HMAC digest of the random
session token is stored in D1. The admin password is a Worker secret and is
never stored in the database; the configured admin email is copied to the
single customer record after sign-in. The MVP has one provisioned admin, with
no public account registration or email recovery.

| Area | Technology |
| --- | --- |
| SDK / example backend | Node.js, AsyncLocalStorage, Axios |
| Dashboard | React, Vite |
| Serverless API | Cloudflare Workers |
| Persistence | Cloudflare D1 (SQLite) |
| Local/production containers | Docker Compose, PostgreSQL, Redis |
| Validation | Node test runner, Jest, Wrangler, GitHub Actions |

## Try the Cloudflare tracing MVP locally

Requirements: Node.js 22+, npm, and PowerShell on Windows.

1. Install the Cloudflare workspace dependencies:

   ```powershell
   npm ci --prefix cloudflare
   ```

2. Copy `cloudflare\.dev.vars.example` to `cloudflare\.dev.vars` and edit it
   with your own local-only admin email and a unique password of at least 20
   UTF-8 bytes. `.dev.vars` is git-ignored; never commit or share it.

3. Build the dashboard in private-MVP mode:

   ```powershell
   $env:VITE_PRIVATE_MVP = "true"
   npm ci --prefix dashboard
   npm run build --prefix dashboard
   ```

4. Apply the D1 schema locally and start the Worker:

   ```powershell
   npm run db:migrate:local --prefix cloudflare
   npm run dev --prefix cloudflare
   ```

   Open the local URL Wrangler prints. The local database lives under
   `cloudflare\.wrangler\`; it is disposable and is not your Docker/PostgreSQL
   data.

5. Sign in, create a project, copy its ingest key once, and run the sample
   backend in a second PowerShell window:

   ```powershell
   $env:LANTERN_COLLECTOR_URL = "http://127.0.0.1:8787"
   $env:SDK_MAX_BATCH_SIZE = "100"
   .\examples\node-backend\run.ps1
   ```

   Use the URL printed by Wrangler if its port differs. The sample asks for the
   ingest key through a secure PowerShell prompt. Call the example API:

   ```powershell
   Invoke-RestMethod 'http://127.0.0.1:5050/api/hello?name=Lantern'
   ```

   Return to the dashboard and refresh traces.

## Run the hosted Cloudflare smoke test

Use the Worker URL and the provisioned admin credentials (never commit or share
them):

```powershell
$env:LANTERN_BASE_URL = "https://lantern-tracing.gpriyadharsan789.workers.dev"
$env:LANTERN_ADMIN_EMAIL = "you@example.com"
$env:LANTERN_ADMIN_PASSWORD = "<worker admin password>"
node .\scripts\smoke-test-cloudflare.mjs
```

The script signs in, reuses or creates a `hosted-smoke-test` project, rotates
only that project's ingest key, posts one span, and reads the trace back through
both the trace detail and trace list APIs. It never prints the password or
ingest key. To use a different project name, set `LANTERN_SMOKE_PROJECT`.

## Run the full Docker stack in GitHub Codespaces (free)

GitHub Codespaces includes a free monthly allowance and does not require a
payment card. The repository ships a dev container with Docker-in-Docker and a
start script:

1. On GitHub, open the repository, choose **Code → Codespaces → Create codespace
   on main**, and wait for the container to finish building.
2. In the Codespaces terminal, run:

   ```bash
   bash scripts/codespaces-start.sh
   ```

   The script creates `.env.codespaces` with random secrets, builds and starts
   PostgreSQL, Redis, the collector, gateway, order/payment services, and the
   dashboard. It also creates a verified demo customer and prints its email and
   password in the terminal.
3. Open the **Ports** tab, set port **8080** to **Public**, then open its
   forwarded URL. The dashboard and `/api` share that origin.

Codespaces is on-demand: the forwarded URL stops working when the codespace
stops (for example after the idle timeout). It is a free way to demo the full
stack, not an always-on production host.

## Tests and checks

```powershell
npm test --prefix cloudflare
npm test --prefix packages/sdk
$env:VITE_PRIVATE_MVP = "true"
npm run lint --prefix dashboard
npm run build --prefix dashboard
npm run deploy --prefix cloudflare -- --dry-run
```

The Cloudflare tests exercise the Worker against local D1, including login and
session revocation, project/key rotation, trace summaries and details,
idempotent ingestion, quotas, retention, validation, and login throttling.

## Cloudflare deployment

The private tracing MVP is deployed at
https://lantern-tracing.gpriyadharsan789.workers.dev. The free plan has quotas
and no production uptime guarantee; account signup or verification requirements
can vary. Check current Cloudflare requirements before relying on the app for
real users or data.

To reproduce the deployment in another Cloudflare account, create a D1 database
and configure the account-specific ID in `cloudflare\wrangler.jsonc`. From
PowerShell:

1. Create the D1 database with `npm run db:create --prefix cloudflare`, then put
   the returned ID into `cloudflare\wrangler.jsonc`.
2. From the `cloudflare` directory, set the admin credentials as Wrangler
   secrets. Do not put them in source files or paste them into chat:

   ```powershell
   Set-Location cloudflare
   npx wrangler secret put ADMIN_EMAIL
   npx wrangler secret put ADMIN_PASSWORD
   ```

3. Apply the schema remotely with
   `npm run db:migrate:remote --prefix cloudflare`.
4. Build in private mode, validate the Worker bundle, then deploy:

   ```powershell
   $env:VITE_PRIVATE_MVP = "true"
   npm run build --prefix dashboard
   npm run deploy --prefix cloudflare -- --dry-run
   npm run deploy --prefix cloudflare
   ```

5. Sign in using the admin secret and create a project. Keep each project ingest
   key in the instrumented server's secret environment, never in browser code.
   Preview URLs are disabled; only the production workers.dev URL is intended
   to be publicly available.

Cloudflare data starts empty; the local PostgreSQL accounts, projects, and spans
are not migrated. Storefront/orders/payments, self-service accounts, and email
verification/password recovery are not part of this deployment.

## Free-plan constraints

The current Worker config caps ingestion at 2,000 spans/day globally and 100,000
per project/month, limits each batch to 100 spans, limits trace detail to 100
spans, and retains traces for seven days. It also caps the private admin at ten
projects. Cloudflare plan quotas may be lower than application limits, and
reaching a provider quota can cause requests to fail until it resets.

There is no multi-admin/user onboarding, email delivery, public signup,
payments, storage export, or migration from the Docker database in this MVP. Do
not use it for public customer onboarding or production customer data without
addressing those gaps and reviewing the hosting limits.

## Repository map

| Path | Purpose |
| --- | --- |
| `cloudflare/` | Worker, D1 migration, Wrangler config, local setup, tests |
| `dashboard/` | React trace dashboard and storefront UI |
| `packages/sdk/` | Node tracing SDK and tests |
| `packages/collector/` | Original queued collector and PostgreSQL persistence |
| `services/` | Original API gateway, account/order, and payment services |
| `examples/node-backend/` | Small instrumented Node backend for demos |
| `docs/` | Production operations, tenancy, and deployment guides |
| `.github/workflows/` | CI, CodeQL, and dependency review |
| `CHANGELOG.md` | Release history |
| `SECURITY.md` | Vulnerability reporting policy |

## Resume / portfolio wording

Use only claims that match the version you have actually demonstrated. Before
publicly claiming a live deployment, complete and document the Cloudflare
deployment.

- Built a distributed tracing dashboard with a Node.js SDK, context propagation,
  batched span ingestion, project-scoped API keys, and a React trace waterfall.
- Designed a Cloudflare Workers + D1 tracing MVP with secure single-admin
  sessions, idempotent ingestion, per-project quotas, and scheduled retention.
- Added automated Worker/D1 integration tests and CI checks for dashboard lint,
  production assets, and Worker bundle validation.

## License

Lantern is released under the [MIT License](LICENSE). See [CHANGELOG.md](CHANGELOG.md)
for release history and [SECURITY.md](SECURITY.md) for vulnerability reporting.
