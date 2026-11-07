# Security Policy

## Supported versions

The latest release on `main` is supported. Older tags are not maintained unless
a security fix is explicitly backported.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting from the repository's **Security**
tab. If that option is unavailable, open a minimal public issue asking for a
private contact channel without including exploit details.

Include as much of the following as possible:

- affected version, commit, or deployment URL
- impact and attack scenario
- reproduction steps or a proof of concept
- any suggested fix or mitigation

We aim to acknowledge reports within five business days and will coordinate a
fix and disclosure timeline with you.

## Scope

Security issues in this repository include, but are not limited to:

- authentication, session handling, or authorization bypasses
- cross-project access to traces, projects, or usage data
- ingest key leakage, guessing, or privilege escalation
- injection, SSRF, or request-smuggling vulnerabilities
- rate-limit or quota bypass that affects other tenants
- secret exposure in source, logs, build output, or client bundles
- dependency vulnerabilities that are reachable through Lantern

## Out of scope

- denial of service caused by intentionally exhausting documented free-plan
  quotas
- issues that require a compromised admin password or stolen session cookie
- vulnerabilities only present in unsupported forks or modified deployments
- reports about third-party services without a demonstrated Lantern impact

## Deployment notes

Lantern stores ingest keys as hashes and keeps admin credentials in deployment
secrets. Never commit `.env`, `cloudflare/.dev.vars`, Worker secrets, database
dumps, or captured session cookies. Rotate an ingest key immediately if it is
exposed; rotating it invalidates the previous value.
