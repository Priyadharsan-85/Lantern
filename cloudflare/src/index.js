const CUSTOMER_ID = 'cus_private_admin';
const SESSION_COOKIE = 'lntr_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SPANS_PER_BATCH = 100;
const MAX_PROJECTS = 10;
const MAX_SPAN_JSON_BYTES = 32 * 1024;
const CLEANUP_BATCH_SIZE = 40;
const MAX_CLEANUP_BATCHES = 50;

const encoder = new TextEncoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      ...headers,
    },
  });
}

function error(message, status, code) {
  return json({ error: message, ...(code ? { code } : {}) }, status);
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function equalSecret(provided, expected) {
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function cookieValue(cookieHeader, name) {
  for (const entry of (cookieHeader || '').split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() === name) {
      return entry.slice(separator + 1).trim();
    }
  }
  return '';
}

function sessionCookie(token, maxAge = SESSION_TTL_SECONDS) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return origin === new URL(request.url).origin;
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function readJson(request) {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { response: error('Request body exceeds the 1 MB limit', 413) };
  }

  const reader = request.body?.getReader();
  if (!reader) return { response: error('A JSON request body is required', 400) };
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      await reader.cancel();
      return { response: error('Request body exceeds the 1 MB limit', 413) };
    }
    chunks.push(value);
  }

  try {
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { value: JSON.parse(new TextDecoder().decode(body)) };
  } catch {
    return { response: error('Request body must contain valid JSON', 400) };
  }
}

function validEmail(email) {
  return typeof email === 'string' &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validAdminConfig(env) {
  return validEmail(env.ADMIN_EMAIL) &&
    typeof env.ADMIN_PASSWORD === 'string' &&
    encoder.encode(env.ADMIN_PASSWORD).byteLength >= 20;
}

function numericSetting(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('A Cloudflare Worker limit setting is invalid');
  }
  return parsed;
}

async function sessionDigest(token, password) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function makeSession(db, email, password) {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO customers (customer_id, email, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(customer_id) DO UPDATE SET email = excluded.email`
  ).bind(CUSTOMER_ID, email, now).run();

  const token = randomToken();
  await db.prepare(
    `INSERT INTO sessions (token_hash, customer_id, expires_at, created_at)
     VALUES (?, ?, ?, ?)`
  ).bind(await sessionDigest(token, password), CUSTOMER_ID, now + SESSION_TTL_SECONDS * 1000, now).run();
  return token;
}

async function getSession(request, env) {
  const token = cookieValue(request.headers.get('Cookie'), SESSION_COOKIE);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !validAdminConfig(env)) return null;
  return env.DB.prepare(
    `SELECT c.customer_id AS id, c.email
     FROM sessions s
     JOIN customers c ON c.customer_id = s.customer_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(await sessionDigest(token, env.ADMIN_PASSWORD), Date.now()).first();
}

function projectResponse(row) {
  return {
    id: row.project_id,
    name: row.name,
    createdAt: row.created_at,
  };
}

function validateSpan(span) {
  if (!span || typeof span !== 'object' || Array.isArray(span)) return false;
  const boundedString = (value, max) =>
    typeof value === 'string' && value.length > 0 && value.length <= max;
  if (!boundedString(span.spanId, 128) ||
      !boundedString(span.traceId, 128) ||
      !boundedString(span.name, 256) ||
      !boundedString(span.serviceName, 128) ||
      (span.parentSpanId != null && !boundedString(span.parentSpanId, 128)) ||
      !['ok', 'error'].includes(span.status || 'ok') ||
      !Number.isSafeInteger(span.startTime) || span.startTime < 0 ||
      !Number.isSafeInteger(span.duration) || span.duration < 0 ||
      span.duration > 24 * 60 * 60 * 1000 ||
      (span.endTime != null &&
        (!Number.isSafeInteger(span.endTime) || span.endTime < span.startTime))) {
    return false;
  }

  const tags = span.tags ?? {};
  const logs = span.logs ?? [];
  if (!tags || typeof tags !== 'object' || Array.isArray(tags) ||
      !Array.isArray(logs)) return false;
  return encoder.encode(JSON.stringify(tags)).byteLength <= MAX_SPAN_JSON_BYTES &&
    encoder.encode(JSON.stringify(logs)).byteLength <= MAX_SPAN_JSON_BYTES;
}

function spanStatement(db, projectId, span, createdAt) {
  return db.prepare(
    `INSERT OR IGNORE INTO spans (
       project_id, span_id, trace_id, parent_span_id, name, service_name,
       status, duration, start_time, end_time, tags, logs, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    projectId,
    span.spanId,
    span.traceId,
    span.parentSpanId || null,
    span.name,
    span.serviceName,
    span.status || 'ok',
    span.duration,
    span.startTime,
    span.endTime ?? null,
    JSON.stringify(span.tags ?? {}),
    JSON.stringify(span.logs ?? []),
    createdAt
  );
}

async function requireProject(db, projectId, customerId = CUSTOMER_ID) {
  if (typeof projectId !== 'string' || projectId.length > 128) return null;
  return db.prepare(
    `SELECT project_id FROM projects
     WHERE project_id = ? AND customer_id = ? AND active = 1`
  ).bind(projectId, customerId).first();
}

async function reserveMonthlyUsage(db, projectId, count, monthlyLimit) {
  const reserved = await db.prepare(
    `UPDATE projects
     SET monthly_span_count = CASE
           WHEN usage_month = strftime('%Y-%m', 'now')
             THEN monthly_span_count + ?
           ELSE ?
         END,
         usage_month = strftime('%Y-%m', 'now')
     WHERE project_id = ? AND customer_id = ? AND active = 1
       AND ? <= ?
       AND (usage_month <> strftime('%Y-%m', 'now')
         OR monthly_span_count <= ? - ?)
     RETURNING monthly_span_count`
  ).bind(count, count, projectId, CUSTOMER_ID, count, monthlyLimit, monthlyLimit, count).first();
  if (reserved) return { allowed: true };

  const project = await requireProject(db, projectId);
  return project ? { allowed: false, reason: 'monthly_limit' } : { allowed: false, reason: 'project_inactive' };
}

async function releaseMonthlyUsage(db, projectId, count) {
  await db.prepare(
    `UPDATE projects SET monthly_span_count = MAX(0, monthly_span_count - ?)
     WHERE project_id = ? AND usage_month = strftime('%Y-%m', 'now')`
  ).bind(count, projectId).run();
}

async function reserveDailyUsage(db, count, dailyLimit) {
  if (count > dailyLimit) return null;
  return db.prepare(
    `INSERT INTO daily_ingest_usage (usage_date, span_count)
     VALUES (date('now'), ?)
     ON CONFLICT(usage_date) DO UPDATE
       SET span_count = daily_ingest_usage.span_count + excluded.span_count
       WHERE daily_ingest_usage.span_count <= ? - excluded.span_count
     RETURNING usage_date, span_count`
  ).bind(count, dailyLimit).first();
}

async function findExistingSpanIds(db, projectId, spans) {
  const placeholders = spans.map(() => '?').join(', ');
  const result = await db.prepare(
    `SELECT span_id FROM spans
     WHERE project_id = ? AND span_id IN (${placeholders})`
  ).bind(projectId, ...spans.map((span) => span.spanId)).all();
  return new Set(result.results.map((row) => row.span_id));
}

async function releaseDailyUsage(db, count, usageDate) {
  await db.prepare(
    `UPDATE daily_ingest_usage SET span_count = MAX(0, span_count - ?)
     WHERE usage_date = ?`
  ).bind(count, usageDate).run();
}

async function handleLogin(request, env) {
  if (!sameOrigin(request)) return error('Cross-origin requests are not allowed', 403);
  if (!validAdminConfig(env)) {
    return error('Private account credentials are not configured', 503);
  }

  const parsed = await readJson(request);
  if (parsed.response) return parsed.response;
  const { email, password } = parsed.value || {};
  if (!validEmail(email) || typeof password !== 'string' || password.length > 128) {
    return error('A valid email and password are required', 400);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const attemptKey = await sha256(ip);
  const now = Date.now();
  const attempts = await env.DB.prepare(
    `INSERT INTO login_attempts (attempt_key, window_started_at, attempt_count)
     VALUES (?, ?, 1)
     ON CONFLICT(attempt_key) DO UPDATE SET
       attempt_count = CASE
         WHEN login_attempts.window_started_at <= ? THEN 1
         ELSE login_attempts.attempt_count + 1
       END,
       window_started_at = CASE
         WHEN login_attempts.window_started_at <= ? THEN excluded.window_started_at
         ELSE login_attempts.window_started_at
       END
     RETURNING attempt_count`
  ).bind(attemptKey, now, now - LOGIN_WINDOW_MS, now - LOGIN_WINDOW_MS).first();
  if (attempts?.attempt_count > MAX_LOGIN_ATTEMPTS) {
    return json(
      { error: 'Too many sign-in attempts. Try again later.', code: 'LOGIN_RATE_LIMITED' },
      429,
      { 'retry-after': String(Math.ceil(LOGIN_WINDOW_MS / 1000)) }
    );
  }

  const emailMatches = email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
  const passwordMatches = await equalSecret(password, env.ADMIN_PASSWORD);
  if (!emailMatches || !passwordMatches) {
    return error('Invalid email or password', 401);
  }

  await env.DB.prepare('DELETE FROM login_attempts WHERE attempt_key = ?')
    .bind(attemptKey).run();
  const token = await makeSession(env.DB, env.ADMIN_EMAIL.toLowerCase(), env.ADMIN_PASSWORD);
  return json(
    { authenticated: true, customer: { id: CUSTOMER_ID, email: env.ADMIN_EMAIL.toLowerCase() } },
    200,
    { 'set-cookie': sessionCookie(token) }
  );
}

async function handleLogout(request, env) {
  if (!sameOrigin(request)) return error('Cross-origin requests are not allowed', 403);
  const token = cookieValue(request.headers.get('Cookie'), SESSION_COOKIE);
  if (/^[A-Za-z0-9_-]{43}$/.test(token) && typeof env.ADMIN_PASSWORD === 'string') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(await sessionDigest(token, env.ADMIN_PASSWORD)).run();
  }
  return json(
    { authenticated: false },
    200,
    { 'set-cookie': sessionCookie('', 0) }
  );
}

async function handleIngest(request, env) {
  const key = request.headers.get('X-Api-Key');
  if (!key || key.length > 512) return error('Invalid or missing ingest key', 401);

  const project = await env.DB.prepare(
    'SELECT project_id FROM projects WHERE ingest_key_hash = ? AND active = 1'
  ).bind(await sha256(key)).first();
  if (!project) return error('Invalid or missing ingest key', 401);

  const parsed = await readJson(request);
  if (parsed.response) return parsed.response;
  const spans = parsed.value?.spans;
  if (!Array.isArray(spans) || spans.length === 0) {
    return error('expected a non-empty spans array', 400);
  }
  if (spans.length > MAX_SPANS_PER_BATCH) {
    return error(`batch too large — max ${MAX_SPANS_PER_BATCH} spans per request`, 400);
  }
  if (!spans.every(validateSpan)) return error('one or more spans are invalid', 400);

  const existingSpanIds = await findExistingSpanIds(env.DB, project.project_id, spans);
  const newSpans = spans.filter((span) => !existingSpanIds.has(span.spanId));
  if (newSpans.length === 0) return json({ received: spans.length });

  const monthlyLimit = numericSetting(env.MAX_MONTHLY_SPANS_PER_PROJECT, 100_000, 1, 1_000_000);
  const dailyLimit = numericSetting(env.MAX_DAILY_SPANS, 2_000, 1, 100_000);
  const monthly = await reserveMonthlyUsage(env.DB, project.project_id, newSpans.length, monthlyLimit);
  if (!monthly.allowed) {
    if (monthly.reason === 'project_inactive') {
      return error('Invalid or missing ingest key', 401);
    }
    const now = new Date();
    const retryAfter = Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime()) / 1000);
    return json(
      { error: 'Monthly project span limit reached', code: 'MONTHLY_SPAN_LIMIT_EXCEEDED' },
      429,
      { 'retry-after': String(retryAfter) }
    );
  }

  const daily = await reserveDailyUsage(env.DB, newSpans.length, dailyLimit);
  if (!daily) {
    await releaseMonthlyUsage(env.DB, project.project_id, newSpans.length);
    const retryAfter = Math.ceil((Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate() + 1
    ) - Date.now()) / 1000);
    return json(
      { error: 'Daily free-plan span limit reached', code: 'DAILY_SPAN_LIMIT_EXCEEDED' },
      429,
      { 'retry-after': String(retryAfter) }
    );
  }

  try {
    const now = Date.now();
    const results = await env.DB.batch(
      newSpans.map((span) => spanStatement(env.DB, project.project_id, span, now))
    );
    const insertedCount = results.reduce((total, result) => total + result.meta.changes, 0);
    const duplicateCount = newSpans.length - insertedCount;
    if (duplicateCount > 0) {
      await Promise.all([
        releaseMonthlyUsage(env.DB, project.project_id, duplicateCount),
        releaseDailyUsage(env.DB, duplicateCount, daily.usage_date),
      ]);
    }
    return json({ received: spans.length });
  } catch (err) {
    console.error('Cloudflare trace ingest failed', err);
    await Promise.all([
      releaseMonthlyUsage(env.DB, project.project_id, newSpans.length),
      releaseDailyUsage(env.DB, newSpans.length, daily.usage_date),
    ]);
    return error('Unable to persist spans; retry later', 503);
  }
}

async function handleProjects(request, url, env, customer) {
  if (request.method === 'GET' && url.pathname === '/projects') {
    const result = await env.DB.prepare(
      `SELECT project_id, name, created_at FROM projects
       WHERE customer_id = ? AND active = 1 ORDER BY created_at, project_id`
    ).bind(customer.id).all();
    return json({ projects: result.results.map(projectResponse) });
  }

  if (request.method === 'POST' && url.pathname === '/projects') {
    if (!sameOrigin(request)) return error('Cross-origin requests are not allowed', 403);
    const parsed = await readJson(request);
    if (parsed.response) return parsed.response;
    const name = typeof parsed.value?.name === 'string' ? parsed.value.name.trim() : '';
    if (!name || name.length > 80) {
      return error('Project name must be between 1 and 80 characters', 400);
    }
    const projectId = `prj_${crypto.randomUUID()}`;
    const ingestKey = `lntr_${randomToken()}`;
    const result = await env.DB.prepare(
      `INSERT INTO projects (
         project_id, customer_id, name, ingest_key_hash, usage_month, created_at
       )
       SELECT ?, ?, ?, ?, strftime('%Y-%m', 'now'), ?
       WHERE (SELECT COUNT(*) FROM projects
         WHERE customer_id = ? AND active = 1) < ?
       RETURNING project_id, name, created_at`
    ).bind(
      projectId,
      customer.id,
      name,
      await sha256(ingestKey),
      Date.now(),
      customer.id,
      MAX_PROJECTS
    ).first();
    if (!result) {
      return error(`A maximum of ${MAX_PROJECTS} projects is allowed on this private free MVP`, 429);
    }
    return json({ project: projectResponse(result), ingestKey }, 201);
  }

  const rotate = url.pathname.match(/^\/projects\/([^/]+)\/rotate-key$/);
  if (request.method === 'POST' && rotate) {
    if (!sameOrigin(request)) return error('Cross-origin requests are not allowed', 403);
    const projectId = decodePathSegment(rotate[1]);
    if (!projectId || projectId.length > 128) return error('Project ID is invalid', 400);
    const ingestKey = `lntr_${randomToken()}`;
    const result = await env.DB.prepare(
      `UPDATE projects SET ingest_key_hash = ?
       WHERE project_id = ? AND customer_id = ? AND active = 1
       RETURNING project_id, name, created_at`
    ).bind(await sha256(ingestKey), projectId, customer.id).first();
    if (!result) return error('Project not found', 404);
    return json({ project: projectResponse(result), ingestKey });
  }

  return null;
}

async function handleTraces(request, url, env, customer) {
  if (request.method !== 'GET') return null;
  const projectId = url.searchParams.get('projectId');
  if (!projectId) return error('A projectId is required', 400);
  if (!await requireProject(env.DB, projectId, customer.id)) {
    return error('Project not found', 404);
  }

  const detail = url.pathname.match(/^\/traces\/([^/]+)$/);
  if (detail) {
    const traceId = decodePathSegment(detail[1]);
    if (!traceId || traceId.length > 128) return error('Trace ID is invalid', 400);
    const result = await env.DB.prepare(
      `SELECT span_id, trace_id, parent_span_id, name, service_name,
              status, duration, start_time, end_time, tags, logs
       FROM spans WHERE project_id = ? AND trace_id = ?
      ORDER BY start_time ASC, span_id ASC
      LIMIT 101`
    ).bind(projectId, traceId).all();
    if (!result.results.length) return error('trace not found', 404);
    if (result.results.length > 100) {
      return error('Trace detail exceeds the 100-span limit for the free Worker', 413);
    }
    return json(result.results.map((span) => ({
      ...span,
      tags: JSON.parse(span.tags),
      logs: JSON.parse(span.logs),
    })));
  }

  if (url.pathname !== '/traces') return null;
  const requestedLimit = Number(url.searchParams.get('limit') || 50);
  const requestedOffset = Number(url.searchParams.get('offset') || 0);
  if (!Number.isSafeInteger(requestedLimit) || !Number.isSafeInteger(requestedOffset) ||
      requestedLimit < 1 || requestedOffset < 0) {
    return error('limit must be positive and offset must be non-negative integers', 400);
  }
  const limit = Math.min(requestedLimit, 200);
  const result = await env.DB.prepare(
    `SELECT trace_id, start_time, total_duration, span_count,
            has_error, root_span, services_json
     FROM trace_summaries
     WHERE project_id = ? AND last_ingested_at >= ?
     ORDER BY last_ingested_at DESC, trace_id
     LIMIT ? OFFSET ?`
  ).bind(
    projectId,
    Date.now() - numericSetting(env.SPAN_RETENTION_DAYS, 7, 1, 90) * 24 * 60 * 60 * 1000,
    limit,
    requestedOffset
  ).all();
  return json(result.results.map((trace) => ({
    ...trace,
    has_error: Boolean(trace.has_error),
    services: JSON.parse(trace.services_json),
  })));
}

async function cleanupExpiredTraces(db, retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (let iteration = 0; iteration < MAX_CLEANUP_BATCHES; iteration += 1) {
    const expired = await db.prepare(
      `SELECT project_id, trace_id FROM spans
       WHERE created_at < ?
       GROUP BY project_id, trace_id
       ORDER BY MIN(created_at)
       LIMIT ?`
    ).bind(cutoff, CLEANUP_BATCH_SIZE).all();
    if (!expired.results.length) break;

    const conditions = expired.results
      .map(() => '(project_id = ? AND trace_id = ?)')
      .join(' OR ');
    const values = expired.results.flatMap(({ project_id, trace_id }) => [project_id, trace_id]);
    const deleteSpans = db.prepare(
      `DELETE FROM spans WHERE ${conditions}`
    ).bind(...values);
    const deleteSummaries = db.prepare(
      `DELETE FROM trace_summaries WHERE ${conditions}`
    ).bind(...values);
    await db.batch([deleteSpans, deleteSummaries]);
  }

  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Date.now()),
    db.prepare('DELETE FROM login_attempts WHERE window_started_at <= ?')
      .bind(Date.now() - LOGIN_WINDOW_MS),
    db.prepare(`DELETE FROM daily_ingest_usage WHERE usage_date < date('now', '-30 days')`),
  ]);
}

async function route(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') {
    return json({ status: 'ok', service: 'lantern-cloudflare' });
  }

  if (request.method === 'POST' && url.pathname === '/auth/customer/login') {
    return handleLogin(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/auth/customer/logout') {
    return handleLogout(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/auth/customer/me') {
    const customer = await getSession(request, env);
    return customer
      ? json({ authenticated: true, customer })
      : error('Not authenticated', 401);
  }
  if (request.method === 'POST' && /^\/auth\/customer\/(register|request-verification|verify-email|request-password-reset|reset-password)$/.test(url.pathname)) {
    return error('Self-service account management is disabled for the private free MVP', 403, 'PRIVATE_MVP');
  }

  if (url.pathname === '/spans' && request.method === 'POST') {
    return handleIngest(request, env);
  }

  if (url.pathname.startsWith('/projects')) {
    const customer = await getSession(request, env);
    if (!customer) return error('Authentication is required', 401);
    const response = await handleProjects(request, url, env, customer);
    if (response) return response;
  }

  if (url.pathname === '/traces' || url.pathname.startsWith('/traces/')) {
    const customer = await getSession(request, env);
    if (!customer) return error('Authentication is required', 401);
    const response = await handleTraces(request, url, env, customer);
    if (response) return response;
  }

  if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/projects') ||
      url.pathname === '/spans' || url.pathname.startsWith('/traces')) {
    return error('Not found', 404);
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.error('Cloudflare request failed', err);
      return error('The service is temporarily unavailable', 503);
    }
  },

  async scheduled(_controller, env, context) {
    context.waitUntil(cleanupExpiredTraces(
      env.DB,
      numericSetting(env.SPAN_RETENTION_DAYS, 7, 1, 90)
    ));
  },
};

export {
  cleanupExpiredTraces,
  equalSecret,
  handleIngest,
  route,
  validateSpan,
};
