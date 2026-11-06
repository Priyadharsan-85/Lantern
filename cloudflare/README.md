# Lantern Cloudflare tracing MVP

This is a separate, private, single-admin tracing deployment. It leaves the
Docker Compose configuration and existing PostgreSQL data untouched. The MVP
includes the dashboard, one provisioned admin login, projects and ingest-key
rotation, span ingestion, trace search, and seven-day retention.
Storefront/orders/payments and self-service registration, verification, and
password recovery are deliberately disabled.

## Free-plan operating limits

- Workers Free: 100,000 requests/day and 10 ms CPU/request.
- D1 Free: 5 million rows read/day, 100,000 rows written/day, and 5 GB total
  storage.
- Ingestion is capped at 2,000 spans/day across all projects and 100,000 spans
  per project/month. The batch limit is 100 spans to keep Worker CPU use bounded.
- Trace detail is limited to 100 spans per trace; larger traces return an explicit
  error rather than an incomplete waterfall.
- At most 10 projects may be created. Exceeding platform limits can make requests
  fail until the quota resets; this plan has no uptime SLA.
- Daily retention cleanup processes up to 2,000 expired traces per scheduled run.
- The dashboard uses a 30-second refresh interval in this build to reduce D1
  reads. Users can refresh manually.
- Account email flows need an outbound email service and are not enabled in this
  free, private MVP. Do not use it for public customer signup.

## Local development

1. Create a D1 database and set its ID in `wrangler.jsonc`:

   ```powershell
   npm --prefix cloudflare run db:create
   ```

2. Apply the schema locally:

   ```powershell
   npm --prefix cloudflare run db:migrate:local
   ```

3. Copy `cloudflare\.dev.vars.example` to `cloudflare\.dev.vars` and replace
   the sample values with your private admin email and a unique, long password.
   `.dev.vars` is ignored by Git; never commit or share it.

4. From the repository root, build the private dashboard and start the Worker:

   ```powershell
   $env:VITE_PRIVATE_MVP = "true"
   npm --prefix dashboard run build
   npm --prefix cloudflare run dev
   ```

   The Worker and dashboard are served from the same local origin. D1 is local
   until you explicitly use Wrangler's `--remote` option.

   The configured admin email must be valid, and the unique admin password must
   contain at least 20 UTF-8 bytes. Set both through Wrangler secrets for a
   deployment; do not commit local credentials. Changing the admin password
   invalidates all existing sessions.

   Instrumented Node services should set `SDK_MAX_BATCH_SIZE=100` to keep
   requests within this Worker’s batch limit.

## Deployment (not performed by this change)

After creating a Cloudflare account and D1 database, set the real D1 database ID
in `wrangler.jsonc`, apply migrations remotely, and store `ADMIN_EMAIL` and
`ADMIN_PASSWORD` as Worker secrets. Build the dashboard with
`VITE_PRIVATE_MVP=true`, then deploy with Wrangler. Keep credentials out of the
repository and chat. Do not deploy until the dashboard bundle and local D1 flow
have been tested.

The current local PostgreSQL accounts, projects, and traces are not imported.
This Worker starts with a separate empty D1 database; the existing Docker
application remains unchanged and is the fallback.
