# Lantern project showcase

## Short description

Lantern is a distributed tracing dashboard with a Node.js SDK, a span-ingestion
API, project-scoped keys, and a React trace explorer. The repository contains a
Docker-based multi-service application and a separately developed, private
Cloudflare Workers + D1 tracing MVP.

## Three-minute demo

1. Open the Cloudflare tracing dashboard and sign in with the locally provisioned
   admin credentials.
2. Create a project and show that the ingest key is revealed once.
3. Start `examples/node-backend` with the project key in its secure prompt and
   the Worker URL as `LANTERN_COLLECTOR_URL`.
4. Send a request to `/api/hello`; point out the parent request span and child
   operation span in the trace waterfall.
5. Rotate the key and show that the old key is rejected.
6. Show the test results and explain the free-plan limits and why user email
   signup/storefront/payments are intentionally not included in this MVP.

Do not show ingest keys, `.dev.vars`, Worker secrets, or private account data in
screenshots or recordings.

## Resume bullets

- Developed Lantern, a distributed tracing app with a Node.js SDK, batched span
  collection, project isolation, and an interactive React trace explorer.
- Implemented a Cloudflare Worker + D1 tracing MVP with HttpOnly session
  cookies, hashed project keys, idempotent span writes, quota enforcement, and
  scheduled data retention.
- Added D1-backed integration tests for authentication, ingestion, trace
  queries, rate limits, key rotation, and retention; integrated dashboard and
  Worker checks into GitHub Actions.

The Cloudflare MVP is deployed. Its dashboard and health endpoint have been
verified over HTTPS, and the hosted sign-in and trace-ingestion smoke test
passed on 2026-11-07.

## Interview topics to prepare

- Why the original Redis Streams/PostgreSQL collector cannot be deployed
  unchanged to Workers and D1.
- How project ownership is checked for trace queries and how ingest keys are
  stored and rotated.
- Why span ingestion is idempotent and how duplicate spans interact with usage
  limits.
- How free-plan limits influenced batch sizes, refresh intervals, retention,
  and deferred email/account features.
- What you would add before production use: multi-user accounts, email delivery,
  backups/export, monitoring/alerts, load testing, deployment verification, and
  a documented rollback/data migration plan.
