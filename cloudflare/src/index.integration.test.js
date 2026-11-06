import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import worker, { cleanupExpiredTraces } from './index.js';

const BASE_URL = 'https://lantern.test';
const ADMIN_EMAIL = 'admin@example.invalid';
const ADMIN_PASSWORD = 'integration-test-only-password-with-enough-length';
const ORIGIN = { Origin: BASE_URL };
const migrationUrl = new URL('../migrations/0001_init.sql', import.meta.url);

let miniflare;
let db;
let sessionCookie;
let project;
let secondProject;
let thirdProject;
let ingestKey;
let secondIngestKey;
let thirdIngestKey;

function splitMigration(source) {
  const statements = [];
  const triggerPattern = /^\s*CREATE TRIGGER[\s\S]*?^\s*END;\s*$/m;
  const trigger = source.match(triggerPattern)?.[0];
  const remaining = source
    .replace(triggerPattern, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:--|PRAGMA\b)/i.test(line))
    .join('\n');

  for (const statement of remaining.split(/;\s*(?:\r?\n|$)/)) {
    if (statement.trim()) statements.push(statement.trim());
  }
  if (trigger) statements.push(trigger.trim());
  return statements;
}

async function request(path, init = {}) {
  return miniflare.dispatchFetch(`${BASE_URL}${path}`, init);
}

async function login() {
  return request('/auth/customer/login', {
    method: 'POST',
    headers: { ...ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
}

async function createProject(name) {
  const response = await request('/projects', {
    method: 'POST',
    headers: { ...ORIGIN, Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

function makeSpan(traceId, name, serviceName, options = {}) {
  const startTime = options.startTime ?? Date.now();
  return {
    spanId: options.spanId || crypto.randomUUID(),
    traceId,
    parentSpanId: options.parentSpanId || null,
    name,
    serviceName,
    status: options.status || 'ok',
    startTime,
    endTime: startTime + 10,
    duration: 10,
    tags: options.tags || {},
    logs: options.logs || [],
  };
}

async function ingest(key, spans) {
  return request('/spans', {
    method: 'POST',
    headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ spans }),
  });
}

describe('Cloudflare Worker and D1 integration', () => {
  before(async () => {
    miniflare = new Miniflare({
      name: 'lantern-cloudflare-integration',
      scriptPath: fileURLToPath(new URL('./index.js', import.meta.url)),
      modules: true,
      compatibilityDate: '2026-10-17',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'lantern-cloudflare-integration' },
      bindings: {
        ADMIN_EMAIL,
        ADMIN_PASSWORD,
        MAX_DAILY_SPANS: '5',
        MAX_MONTHLY_SPANS_PER_PROJECT: '3',
        SPAN_RETENTION_DAYS: '7',
      },
    });

    db = await miniflare.getD1Database('DB');
    const migration = await readFile(migrationUrl, 'utf8');
    for (const statement of splitMigration(migration)) {
      await db.prepare(statement).run();
    }
  });

  after(async () => {
    await miniflare?.dispose();
  });

  it('authenticates the provisioned admin and blocks cross-origin/self-service access', async () => {
    const health = await request('/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, 'lantern-cloudflare');

    const crossOrigin = await request('/auth/customer/login', {
      method: 'POST',
      headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    assert.equal(crossOrigin.status, 403);

    const invalidLogin = await request('/auth/customer/login', {
      method: 'POST',
      headers: { ...ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: 'wrong-password' }),
    });
    assert.equal(invalidLogin.status, 401);

    const response = await login();
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    sessionCookie = setCookie.split(';')[0];

    const session = await request('/auth/customer/me', {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).customer.email, ADMIN_EMAIL);

    const register = await request('/auth/customer/register', {
      method: 'POST',
      headers: { ...ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.invalid', password: 'not-allowed' }),
    });
    assert.equal(register.status, 403);
    assert.equal((await register.json()).code, 'PRIVATE_MVP');
  });

  it('creates projects with one-time keys and isolates dashboard access', async () => {
    const unauthorized = await request('/projects');
    assert.equal(unauthorized.status, 401);

    const created = await createProject('Integration project');
    project = created.project;
    ingestKey = created.ingestKey;
    assert.match(ingestKey, /^lntr_[A-Za-z0-9_-]{43}$/);
    assert.equal(created.project.name, 'Integration project');

    const second = await createProject('Second project');
    secondProject = second.project;
    secondIngestKey = second.ingestKey;
    const third = await createProject('Third project');
    thirdProject = third.project;
    thirdIngestKey = third.ingestKey;

    const listed = await request('/projects', {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).projects.map(({ id }) => id).sort(), [
      project.id,
      secondProject.id,
      thirdProject.id,
    ].sort());

    for (let index = 4; index <= 10; index += 1) {
      await createProject(`Project ${index}`);
    }
    const overLimit = await request('/projects', {
      method: 'POST',
      headers: { ...ORIGIN, Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Project eleven' }),
    });
    assert.equal(overLimit.status, 429);

    const missingProject = await request('/traces?projectId=prj_not_owned', {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(missingProject.status, 404);
  });

  it('ingests idempotently, enforces free quotas, and serves trace summaries/details', async () => {
    const traceId = `trace-${crypto.randomUUID()}`;
    const rootSpan = makeSpan(traceId, 'GET /checkout', 'checkout-api', {
      tags: { 'http.status': 200 },
    });
    const childSpan = makeSpan(traceId, 'db.query', 'postgres', {
      parentSpanId: rootSpan.spanId,
      startTime: rootSpan.startTime + 1,
      status: 'error',
      logs: [{ message: 'query failed', level: 'error' }],
    });

    const missingKey = await ingest('', [rootSpan]);
    assert.equal(missingKey.status, 401);
    const firstIngest = await ingest(ingestKey, [rootSpan, childSpan]);
    assert.equal(firstIngest.status, 200);
    assert.deepEqual(await firstIngest.json(), { received: 2 });

    const duplicateIngest = await ingest(ingestKey, [rootSpan, childSpan]);
    assert.equal(duplicateIngest.status, 200);

    const addedSpan = makeSpan(traceId, 'cache.lookup', 'cache');
    const monthlyLimit = await ingest(ingestKey, [addedSpan]);
    assert.equal(monthlyLimit.status, 200);

    const monthlyExceeded = await ingest(ingestKey, [makeSpan(traceId, 'fourth', 'checkout-api')]);
    assert.equal(monthlyExceeded.status, 429);
    assert.equal((await monthlyExceeded.json()).code, 'MONTHLY_SPAN_LIMIT_EXCEEDED');
    assert.ok(monthlyExceeded.headers.get('retry-after'));

    assert.equal((await ingest(secondIngestKey, [
      makeSpan('trace-second-a', 'one', 'service-a'),
      makeSpan('trace-second-b', 'two', 'service-b'),
    ])).status, 200);

    const dailyExceeded = await ingest(thirdIngestKey, [makeSpan('trace-third', 'one', 'service-c')]);
    assert.equal(dailyExceeded.status, 429);
    assert.equal((await dailyExceeded.json()).code, 'DAILY_SPAN_LIMIT_EXCEEDED');
    assert.ok(dailyExceeded.headers.get('retry-after'));

    const oversizedTraceId = 'trace-' + 'x'.repeat(129);
    const invalidSpan = await ingest(thirdIngestKey, [makeSpan(oversizedTraceId, 'bad', 'bad')]);
    assert.equal(invalidSpan.status, 400);

    const tooManySpans = await ingest(
      thirdIngestKey,
      Array.from({ length: 101 }, (_, index) =>
        makeSpan(`trace-batch-${index}`, 'batch', 'service'))
    );
    assert.equal(tooManySpans.status, 400);

    const summaryResponse = await request(`/traces?projectId=${encodeURIComponent(project.id)}`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(summaryResponse.status, 200);
    const summary = (await summaryResponse.json()).find((trace) => trace.trace_id === traceId);
    assert.ok(summary);
    assert.equal(summary.span_count, 3);
    assert.equal(summary.total_duration, 30);
    assert.equal(summary.root_span, 'GET /checkout');
    assert.equal(summary.has_error, true);
    assert.deepEqual(summary.services.sort(), ['cache', 'checkout-api', 'postgres']);

    const detailResponse = await request(
      `/traces/${encodeURIComponent(traceId)}?projectId=${encodeURIComponent(project.id)}`,
      { headers: { Cookie: sessionCookie } }
    );
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.length, 3);
    assert.deepEqual(detail[0].tags, { 'http.status': 200 });
    assert.deepEqual(detail[1].logs, [{ message: 'query failed', level: 'error' }]);

    const overLimitDetail = await request(
      `/traces/bad%ZZ?projectId=${encodeURIComponent(project.id)}`,
      { headers: { Cookie: sessionCookie } }
    );
    assert.equal(overLimitDetail.status, 400);
  });

  it('rotates keys, expires retained trace data, revokes sessions, and rate-limits login', async () => {
    const rotatedResponse = await request(`/projects/${project.id}/rotate-key`, {
      method: 'POST',
      headers: { ...ORIGIN, Cookie: sessionCookie },
    });
    assert.equal(rotatedResponse.status, 200);
    const rotated = await rotatedResponse.json();
    assert.notEqual(rotated.ingestKey, ingestKey);
    assert.equal((await ingest(ingestKey, [makeSpan('trace-rotated', 'old', 'api')])).status, 401);
    assert.equal((await ingest(rotated.ingestKey, [
      makeSpan('trace-rotated', 'new', 'api'),
    ])).status, 429);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await cleanupExpiredTraces(db, 0);
    const remaining = await db.prepare('SELECT COUNT(*) AS count FROM spans').first();
    assert.equal(remaining.count, 0);
    const remainingSummaries = await db.prepare('SELECT COUNT(*) AS count FROM trace_summaries').first();
    assert.equal(remainingSummaries.count, 0);

    const logout = await request('/auth/customer/logout', {
      method: 'POST',
      headers: { ...ORIGIN, Cookie: sessionCookie },
    });
    assert.equal(logout.status, 200);
    assert.equal((await request('/auth/customer/me', {
      headers: { Cookie: sessionCookie },
    })).status, 401);

    const badLogin = () => request('/auth/customer/login', {
      method: 'POST',
      headers: { ...ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: 'incorrect-password' }),
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.equal((await badLogin()).status, 401);
    }
    const rateLimited = await badLogin();
    assert.equal(rateLimited.status, 429);
    assert.equal((await rateLimited.json()).code, 'LOGIN_RATE_LIMITED');
    assert.ok(rateLimited.headers.get('retry-after'));
  });
});
