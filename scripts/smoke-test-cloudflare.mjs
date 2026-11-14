#!/usr/bin/env node
// End-to-end smoke test for a deployed Lantern Cloudflare Worker.
//
// Usage (PowerShell):
//   $env:LANTERN_BASE_URL = "https://lantern-tracing.lantern-observability.workers.dev"
//   $env:LANTERN_ADMIN_EMAIL = "you@example.com"
//   $env:LANTERN_ADMIN_PASSWORD = "<worker admin password>"
//   node ./scripts/smoke-test-cloudflare.mjs
//
// The script signs in, reuses or creates a dedicated smoke-test project,
// rotates that project's ingest key, posts one span, and reads the trace back
// through the authenticated API. Credentials and keys are never printed.

import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.LANTERN_BASE_URL || '').replace(/\/+$/, '');
const email = process.env.LANTERN_ADMIN_EMAIL;
const password = process.env.LANTERN_ADMIN_PASSWORD;
const projectName = process.env.LANTERN_SMOKE_PROJECT || 'hosted-smoke-test';

if (!baseUrl) {
  fail('LANTERN_BASE_URL is required, for example https://lantern-tracing.example.workers.dev');
}
if (!email || !password) {
  fail('LANTERN_ADMIN_EMAIL and LANTERN_ADMIN_PASSWORD are required');
}

let origin;
try {
  origin = new URL(baseUrl).origin;
} catch {
  fail(`LANTERN_BASE_URL is not a valid URL: ${baseUrl}`);
}

let sessionCookie = '';

function fail(message) {
  console.error(`Hosted smoke test failed: ${message}`);
  process.exit(1);
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });

  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const value of setCookies) {
    const pair = value.split(';')[0];
    if (pair.startsWith('lntr_session=')) sessionCookie = pair;
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const detail = typeof data === 'string' ? data : data?.error || `HTTP ${response.status}`;
    const error = new Error(`${method} ${path} returned ${response.status}: ${detail}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function findProject() {
  const data = await request('/projects');
  return (data?.projects || []).find((project) => project.name === projectName) || null;
}

async function main() {
  console.log(`Signing in to ${baseUrl}`);
  const login = await request('/auth/customer/login', {
    method: 'POST',
    body: { email, password },
  });
  if (!login?.authenticated) fail('sign-in did not return an authenticated session');
  console.log(`Signed in as ${login.customer?.email || email}`);

  let project = await findProject();
  let ingestKey;
  if (project) {
    const rotated = await request(`/projects/${encodeURIComponent(project.id)}/rotate-key`, {
      method: 'POST',
    });
    ingestKey = rotated?.ingestKey;
    console.log(`Rotated ingest key for existing project "${project.name}" (${project.id})`);
  } else {
    const created = await request('/projects', {
      method: 'POST',
      body: { name: projectName },
    });
    project = created?.project;
    ingestKey = created?.ingestKey;
    if (!project?.id || !ingestKey) fail('project creation did not return a project and ingest key');
    console.log(`Created project "${project.name}" (${project.id})`);
  }
  if (!ingestKey) fail('could not obtain an ingest key');

  const traceId = `smoke-${randomUUID()}`;
  const spanId = `smoke-span-${randomUUID()}`;
  const startTime = Date.now();
  const span = {
    spanId,
    traceId,
    parentSpanId: null,
    name: 'Hosted smoke test',
    serviceName: 'lantern-smoke-test',
    status: 'ok',
    startTime,
    endTime: startTime + 5,
    duration: 5,
    tags: { source: 'hosted-smoke-test' },
    logs: [],
  };

  const ingested = await request('/spans', {
    method: 'POST',
    headers: { 'X-Api-Key': ingestKey },
    body: { spans: [span] },
  });
  if (ingested?.received !== 1) fail(`ingest returned an unexpected response: ${JSON.stringify(ingested)}`);
  console.log(`Ingested span ${spanId} in trace ${traceId}`);

  const deadline = Date.now() + 20_000;
  let spans = null;
  while (Date.now() < deadline) {
    try {
      const result = await request(
        `/traces/${encodeURIComponent(traceId)}?projectId=${encodeURIComponent(project.id)}`
      );
      if (Array.isArray(result) && result.some((entry) => entry.span_id === spanId)) {
        spans = result;
        break;
      }
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!spans) fail('the span was accepted but did not appear in trace detail within 20 seconds');

  const summaries = await request(
    `/traces?projectId=${encodeURIComponent(project.id)}&limit=10`
  );
  if (!Array.isArray(summaries) || !summaries.some((trace) => trace.trace_id === traceId)) {
    fail('the trace did not appear in the project trace list');
  }

  console.log(`Read back ${spans.length} span(s) from trace detail and the trace list`);
  console.log('Hosted Cloudflare sign-in and trace-ingestion smoke test passed.');
}

main().catch((error) => fail(error.message));
