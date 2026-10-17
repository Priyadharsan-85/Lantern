# Projects and tenant-isolated traces

Lantern accounts use the existing customer email/password authentication. After
signing in at `/`, create a project and select it to view its traces. Projects
are owned by the authenticated account; the API checks ownership before each
trace list or detail request, and the collector query always includes that
project ID.

## Ingesting traces

Create a project to receive a one-time `lntr_...` ingest key. Copy it when shown:
Lantern stores only its SHA-256 hash and does not display the key again. Use
“Regenerate ingest key” to immediately invalidate the prior value. Treat the
key as a secret and configure it only in a trusted server-side application:

```text
COLLECTOR_URL=https://<Lantern API host>
COLLECTOR_API_KEY=<project ingest key>
```

The SDK sends batches to `POST /spans`; the public API gateway forwards only the
provided project key to the collector. The collector hashes the key, resolves
the active project, and overwrites any submitted project identifier before
adding spans to the Redis stream. The project ID travels with every queued span
and is persisted with it. An unknown or revoked key is rejected; there is no
anonymous or unscoped ingestion path.

Do not put an ingest key in browser code, a public repository, or a client-side
application: browser users can extract it. Lantern's production CORS policy is
intentionally limited to the configured dashboard origin. Use the SDK from a
server you control.

## Existing data and internal services

Migration `005_project_multitenancy.sql` creates an inaccessible internal
account/project and assigns all legacy database spans to `prj_internal`. It
also assigns previously queued messages without a project identifier to that
internal tenant when persisted. First-party services continue to use the
server-only `COLLECTOR_API_KEY`; that key maps their spans to `prj_internal`.
Those traces are not visible to customer accounts. Do not provide this global
server key to SDK users.

The span primary key is now `(project_id, span_id)`, permitting the same span ID
in independent projects. Both trace summaries and trace details filter by
project ID in SQL.

## Current limits

Account registration is public but currently has no email verification,
password reset, or MFA. Add those account protections before broad public
launch. Ingest keys are bearer credentials: rotate immediately if exposed.
Project key rotation is immediate and replaces the sole active key for that
project. The first release does not include team members, project sharing,
quotas, retention controls, or project deletion. Production payment behavior
is unchanged.
