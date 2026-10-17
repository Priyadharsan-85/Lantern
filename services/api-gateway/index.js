require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const crypto  = require('crypto');
const express = require('express');
const axios   = require('axios');
const pino    = require('pino');
const helmet  = require('helmet');
const cors    = require('cors');
const compression = require('compression');
const Redis = require('ioredis');
const { Tracer, middleware } = require('sdk');

const isProd = process.env.NODE_ENV === 'production';
if (isProd && !process.env.COLLECTOR_API_KEY) {
  throw new Error('[api-gateway] COLLECTOR_API_KEY is required in production');
}
if (isProd && (!process.env.DASHBOARD_AUTH_USER ||
  !process.env.DASHBOARD_AUTH_PASSWORD || !process.env.SESSION_SECRET)) {
  throw new Error('[api-gateway] DASHBOARD_AUTH_USER, DASHBOARD_AUTH_PASSWORD, and SESSION_SECRET are required in production');
}
if (isProd && (!process.env.CUSTOMER_IDENTITY_SECRET ||
    Buffer.byteLength(process.env.CUSTOMER_IDENTITY_SECRET, 'utf8') < 32)) {
  throw new Error('[api-gateway] CUSTOMER_IDENTITY_SECRET must be at least 32 characters in production');
}

const logger = pino(
  isProd
    ? { level: 'info' }
    : { level: 'debug', transport: { target: 'pino-pretty', options: { colorize: true } } }
);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
redis.on('error', (err) => logger.error({ err }, '[api-gateway] Redis error'));
app.use(cors({
  origin: isProd ? process.env.DASHBOARD_ORIGIN : true,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Idempotency-Key'],
}));
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  if (isProd && req.path !== '/spans' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
      req.get('origin') !== process.env.DASHBOARD_ORIGIN) {
    return res.status(403).json({ error: 'Request origin is not allowed' });
  }
  next();
});

const SESSION_COOKIE = 'lantern_session';
const CUSTOMER_SESSION_COOKIE = 'lantern_customer_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function signSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'development-only-secret')
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

function readCookies(header = '') {
  return Object.fromEntries(header.split(';').filter(Boolean).flatMap((part) => {
    const index = part.indexOf('=');
    if (index < 0) return [];
    try {
      return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]];
    } catch {
      return [];
    }
  }));
}

function verifySession(value) {
  if (!value) return false;
  const [encoded, signature] = value.split('.');
  if (!encoded || !signature) return false;
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'development-only-secret')
    .update(encoded)
    .digest('base64url');
  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    return payload.exp > Math.floor(Date.now() / 1000) &&
      payload.user === process.env.DASHBOARD_AUTH_USER;
  } catch {
    return false;
  }
}

function readSignedSession(value) {
  if (!value) return null;
  const [encoded, signature] = value.split('.');
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'development-only-secret')
    .update(encoded)
    .digest('base64url');
  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    return payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch {
    return null;
  }
}

function setSessionCookie(res, value, maxAge = SESSION_TTL_SECONDS) {
  const flags = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAge}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isProd) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}

function setCustomerSessionCookie(res, value, maxAge = SESSION_TTL_SECONDS) {
  const flags = [
    `${CUSTOMER_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAge}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isProd) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}

async function issueSession(payload) {
  const sid = crypto.randomUUID();
  const session = { ...payload, sid };
  await redis.set(`session:${sid}`, '1', 'EX', SESSION_TTL_SECONDS);
  if (payload.role === 'customer') {
    await redis.sadd(`customer-sessions:${payload.customerId}`, sid);
    await redis.expire(`customer-sessions:${payload.customerId}`, SESSION_TTL_SECONDS);
  }
  return signSession(session);
}

async function revokeSession(value) {
  const session = readSignedSession(value);
  if (session?.sid) await redis.del(`session:${session.sid}`);
  if (session?.role === 'customer' && session.customerId && session.sid) {
    await redis.srem(`customer-sessions:${session.customerId}`, session.sid);
  }
}

async function revokeCustomerSessions(customerId) {
  const indexKey = `customer-sessions:${customerId}`;
  const sessionIds = await redis.smembers(indexKey);
  if (sessionIds.length > 0) {
    await redis.del(...sessionIds.map((sid) => `session:${sid}`));
  }
  await redis.del(indexKey);
}

async function isSessionActive(session) {
  return Boolean(session?.sid && await redis.exists(`session:${session.sid}`));
}

function rateLimit({ name, max, windowSeconds, key }) {
  return async (req, res, next) => {
    const clientKey = key ? key(req) : req.ip;
    const hashedKey = crypto.createHash('sha256').update(String(clientKey)).digest('hex');
    try {
      const count = await redis.eval(
        "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return count",
        1,
        `rate-limit:${name}:${hashedKey}`,
        String(windowSeconds)
      );
      res.setHeader('RateLimit-Limit', String(max));
      if (Number(count) > max) {
        res.setHeader('Retry-After', String(windowSeconds));
        return res.status(429).json({ error: 'Too many requests; try again later' });
      }
      next();
    } catch (err) {
      logger.error({ err, limit: name }, '[api-gateway] Rate limiter unavailable');
      res.status(503).json({ error: 'Authentication is temporarily unavailable' });
    }
  };
}

function requireDashboardAuth(req, res, next) {
  if (!isProd) return next();
  const cookies = readCookies(req.headers.cookie);
  const session = readSignedSession(cookies[SESSION_COOKIE]);
  if (!verifySession(cookies[SESSION_COOKIE]) || !session?.sid) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  isSessionActive(session)
    .then((active) => active ? next() : res.status(401).json({ error: 'Authentication required' }))
    .catch((err) => {
      logger.error({ err }, '[api-gateway] Could not validate dashboard session');
      res.status(503).json({ error: 'Authentication is temporarily unavailable' });
    });
}

async function requireCustomerAuth(req, res, next) {
  (async () => {
    const cookies = readCookies(req.headers.cookie);
    const session = readSignedSession(cookies[CUSTOMER_SESSION_COOKIE]);
    if (!session || session.role !== 'customer' || !session.customerId ||
        !await isSessionActive(session)) {
      return res.status(401).json({ error: 'Customer authentication required' });
    }
    req.customer = { id: session.customerId, email: session.email };
    next();
  })().catch((err) => {
    logger.error({ err }, '[api-gateway] Could not validate customer session');
    res.status(503).json({ error: 'Authentication is temporarily unavailable' });
  });
}

const dashboardLoginLimit = rateLimit({ name: 'dashboard-login', max: 10, windowSeconds: 900 });
const customerRegisterLimit = rateLimit({ name: 'customer-register', max: 5, windowSeconds: 900 });
const customerLoginLimit = rateLimit({ name: 'customer-login', max: 10, windowSeconds: 900 });
const customerVerifyLimit = rateLimit({ name: 'customer-verify', max: 10, windowSeconds: 900 });
const customerResendVerificationLimit = rateLimit({
  name: 'customer-resend-verification',
  max: 3,
  windowSeconds: 900,
  key: (req) => `${req.ip}:${String(req.body?.email || '').trim().toLowerCase()}`,
});
const customerPasswordResetRequestLimit = rateLimit({
  name: 'customer-password-reset-request',
  max: 3,
  windowSeconds: 900,
  key: (req) => `${req.ip}:${String(req.body?.email || '').trim().toLowerCase()}`,
});
const customerPasswordResetLimit = rateLimit({ name: 'customer-password-reset', max: 5, windowSeconds: 900 });
const customerOrderLimit = rateLimit({
  name: 'customer-order',
  max: 30,
  windowSeconds: 3600,
  key: (req) => readSignedSession(readCookies(req.headers.cookie)[CUSTOMER_SESSION_COOKIE])?.customerId || req.ip,
});
const spanIngestLimit = rateLimit({
  name: 'span-ingest',
  max: Number(process.env.GATEWAY_SPANS_RATE_LIMIT_MAX) || 500,
  windowSeconds: Number(process.env.GATEWAY_SPANS_RATE_LIMIT_WINDOW_SECONDS) || 60,
  key: (req) => req.get('x-api-key') || req.ip,
});

function customerIdentityHeaders(customerId) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac('sha256', process.env.CUSTOMER_IDENTITY_SECRET || 'local-development-customer-identity-secret')
    .update(`${customerId}.${timestamp}`)
    .digest('hex');
  return {
    'x-customer-id': customerId,
    'x-customer-timestamp': timestamp,
    'x-customer-signature': signature,
  };
}

function orderServiceUrl(path) {
  return `${process.env.ORDER_SERVICE_URL || 'http://localhost:4001'}${path}`;
}

function customerIdentityConfig(customerId) {
  return { headers: customerIdentityHeaders(customerId), timeout: 10_000 };
}

function forwardServiceError(err, res, message) {
  if (err.response) {
    return res.status(err.response.status || 500)
      .json({ error: err.response.data?.error || message });
  }
  logger.error({ err }, `[api-gateway] ${message}`);
  return res.status(503).json({ error: message });
}

app.post('/auth/login', dashboardLoginLimit, async (req, res) => {
  if (!isProd) return res.json({ authenticated: true });
  const { username, password } = req.body || {};
  if (username !== process.env.DASHBOARD_AUTH_USER ||
      password !== process.env.DASHBOARD_AUTH_PASSWORD) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  try {
    setSessionCookie(res, await issueSession({ user: username, exp }));
  } catch (err) {
    logger.error({ err }, '[api-gateway] Could not create dashboard session');
    return res.status(503).json({ error: 'Authentication is temporarily unavailable' });
  }
  res.json({ authenticated: true, user: username });
});

app.post('/auth/logout', async (req, res) => {
  try {
    await revokeSession(readCookies(req.headers.cookie)[SESSION_COOKIE]);
  } catch (err) {
    logger.error({ err }, '[api-gateway] Could not revoke dashboard session');
    return res.status(503).json({ error: 'Unable to sign out; try again' });
  }
  setSessionCookie(res, '', 0);
  res.json({ authenticated: false });
});

app.get('/auth/me', async (req, res) => {
  if (!isProd) return res.json({ authenticated: true });
  const cookies = readCookies(req.headers.cookie);
  const sessionValue = cookies[SESSION_COOKIE];
  try {
    const authenticated = verifySession(sessionValue) &&
      await isSessionActive(readSignedSession(sessionValue));
    res.status(authenticated ? 200 : 401).json({ authenticated });
  } catch (err) {
    logger.error({ err }, '[api-gateway] Could not validate dashboard session');
    res.status(503).json({ error: 'Authentication is temporarily unavailable' });
  }
});

app.post('/auth/customer/register', customerRegisterLimit, async (req, res) => {
  try {
    const response = await axios.post(
      `${process.env.ORDER_SERVICE_URL || 'http://localhost:4001'}/accounts/register`,
      { email: req.body?.email, password: req.body?.password },
      { timeout: 30_000 }
    );
    res.status(response.status || 201).json(response.data);
  } catch (err) {
    if (err.response) {
      const status = err.response.status || 500;
      return res.status(status).json({ error: err.response.data?.error || 'Unable to create customer account' });
    }
    logger.error({ err }, '[api-gateway] Could not create customer session');
    res.status(503).json({ error: 'Authentication is temporarily unavailable' });
  }
});

app.post('/auth/customer/request-verification', customerResendVerificationLimit, async (req, res) => {
  try {
    const response = await axios.post(
      orderServiceUrl('/accounts/request-verification'),
      { email: req.body?.email, password: req.body?.password },
      { timeout: 30_000 }
    );
    res.status(response.status || 202).json(response.data);
  } catch (err) {
    forwardServiceError(err, res, 'Unable to process verification request');
  }
});

app.post('/auth/customer/verify-email', customerVerifyLimit, async (req, res) => {
  try {
    const response = await axios.post(
      orderServiceUrl('/accounts/verify-email'),
      { token: req.body?.token },
      { timeout: 10_000 }
    );
    res.status(response.status || 200).json(response.data);
  } catch (err) {
    forwardServiceError(err, res, 'Unable to verify email address');
  }
});

app.post('/auth/customer/request-password-reset', customerPasswordResetRequestLimit, async (req, res) => {
  try {
    const response = await axios.post(
      orderServiceUrl('/accounts/request-password-reset'),
      { email: req.body?.email },
      { timeout: 10_000 }
    );
    res.status(response.status || 202).json(response.data);
  } catch (err) {
    forwardServiceError(err, res, 'Unable to process password reset request');
  }
});

app.post('/auth/customer/reset-password', customerPasswordResetLimit, async (req, res) => {
  try {
    const response = await axios.post(
      orderServiceUrl('/accounts/reset-password'),
      { token: req.body?.token, password: req.body?.password },
      { timeout: 10_000 }
    );
    if (response.data?.passwordReset && response.data.customerId) {
      await revokeCustomerSessions(response.data.customerId);
      setCustomerSessionCookie(res, '', 0);
    }
    res.status(response.status || 200).json({ passwordReset: response.data?.passwordReset === true });
  } catch (err) {
    forwardServiceError(err, res, 'Unable to reset password');
  }
});

app.post('/auth/customer/login', customerLoginLimit, async (req, res) => {
  try {
    const response = await axios.post(
      `${process.env.ORDER_SERVICE_URL || 'http://localhost:4001'}/accounts/login`,
      { email: req.body?.email, password: req.body?.password },
      { timeout: 10_000 }
    );
    const customer = response.data.customer;
    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    setCustomerSessionCookie(res, await issueSession({
      role: 'customer',
      customerId: customer.id,
      email: customer.email,
      exp,
    }));
    res.json({ authenticated: true, customer });
  } catch (err) {
    if (err.response) {
      const status = err.response.status || 500;
      return res.status(status).json({
        error: err.response.data?.error || 'Unable to sign in',
        ...(err.response.data?.code ? { code: err.response.data.code } : {}),
      });
    }
    logger.error({ err }, '[api-gateway] Could not create customer session');
    res.status(503).json({ error: 'Authentication is temporarily unavailable' });
  }
});

app.post('/auth/customer/logout', async (req, res) => {
  try {
    await revokeSession(readCookies(req.headers.cookie)[CUSTOMER_SESSION_COOKIE]);
  } catch (err) {
    logger.error({ err }, '[api-gateway] Could not revoke customer session');
    return res.status(503).json({ error: 'Unable to sign out; try again' });
  }
  setCustomerSessionCookie(res, '', 0);
  res.json({ authenticated: false });
});

app.get('/auth/customer/me', async (req, res) => {
  const cookies = readCookies(req.headers.cookie);
  const session = readSignedSession(cookies[CUSTOMER_SESSION_COOKIE]);
  if (!session || session.role !== 'customer' || !session.customerId) {
    return res.status(401).json({ authenticated: false });
  }
  try {
    if (!await isSessionActive(session)) return res.status(401).json({ authenticated: false });
  } catch (err) {
    logger.error({ err }, '[api-gateway] Could not validate customer session');
    return res.status(503).json({ error: 'Authentication is temporarily unavailable' });
  }
  res.json({
    authenticated: true,
    customer: { id: session.customerId, email: session.email },
  });
});

app.get('/projects', requireCustomerAuth, async (req, res) => {
  try {
    const response = await axios.get(
      orderServiceUrl('/projects'),
      customerIdentityConfig(req.customer.id)
    );
    res.json(response.data);
  } catch (err) {
    forwardServiceError(err, res, 'Unable to load projects');
  }
});

app.post('/projects', requireCustomerAuth, async (req, res) => {
  try {
    const response = await axios.post(
      orderServiceUrl('/projects'),
      { name: req.body?.name },
      customerIdentityConfig(req.customer.id)
    );
    res.status(response.status || 201).json(response.data);
  } catch (err) {
    forwardServiceError(err, res, 'Unable to create project');
  }
});

app.post('/projects/:projectId/rotate-key', requireCustomerAuth, async (req, res) => {
  try {
    const response = await axios.post(
      orderServiceUrl(`/projects/${encodeURIComponent(req.params.projectId)}/rotate-key`),
      {},
      customerIdentityConfig(req.customer.id)
    );
    res.json(response.data);
  } catch (err) {
    forwardServiceError(err, res, 'Unable to rotate project key');
  }
});

app.post('/spans', spanIngestLimit, async (req, res) => {
  const ingestKey = req.get('x-api-key');
  if (!ingestKey) return res.status(401).json({ error: 'An ingest key is required' });
  try {
    const response = await axios.post(
      `${process.env.COLLECTOR_URL || 'http://localhost:4000'}/spans`,
      req.body,
      { headers: { 'x-api-key': ingestKey }, timeout: 10_000 }
    );
    res.status(response.status || 200).json(response.data);
  } catch (err) {
    if (err.response) {
      return res.status(err.response.status || 500)
        .json({ error: err.response.data?.error || 'Unable to ingest spans' });
    }
    logger.error({ code: err.code }, '[api-gateway] Collector ingest proxy unavailable');
    res.status(503).json({ error: 'Unable to ingest spans' });
  }
});

const tracer = new Tracer({
  serviceName:  'api-gateway',
  collectorUrl: process.env.COLLECTOR_URL || 'http://localhost:4000',
  onLog: (level, msg) => logger[level]?.(msg) ?? logger.info(msg),
});

app.use(middleware(tracer));

app.get('/products', async (req, res) => {
  try {
    const response = await axios.get(
      `${process.env.ORDER_SERVICE_URL || 'http://localhost:4001'}/catalog`,
      { timeout: 5000 }
    );
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.response?.data?.error || 'Unable to load product catalog' });
  }
});

app.post('/order', requireCustomerAuth, customerOrderLimit, async (req, res) => {
  const { span } = req;
  const suppliedIdempotencyKey = req.headers['idempotency-key'];
  if (isProd && !suppliedIdempotencyKey) {
    return res.status(400).json({ error: 'Idempotency-Key header is required' });
  }
  if (suppliedIdempotencyKey &&
      (typeof suppliedIdempotencyKey !== 'string' ||
       suppliedIdempotencyKey.length < 16 || suppliedIdempotencyKey.length > 255)) {
    return res.status(400).json({ error: 'Idempotency-Key header must be 16-255 characters' });
  }
  const idempotencyKey = suppliedIdempotencyKey || crypto.randomUUID();

  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    span.setTag('validation.error', 'missing items');
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }

  try {
    span.log('Received order request');
    span.setTag('user.id', req.customer.id);
    span.setTag('order.items_count', items.length);
    const orderRes = await axios.post(
      (process.env.ORDER_SERVICE_URL || 'http://localhost:4001') + '/process',
      { items },
      {
        headers: {
          ...tracer.injectContext(span),
          'idempotency-key': idempotencyKey,
          ...customerIdentityHeaders(req.customer.id),
        },
        timeout: 15_000,
      }
    );

    span.log('Order processed successfully');
    res.json({ success: true, order: orderRes.data });

  } catch (err) {
    span.setError(err);
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.response?.data?.error || err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'api-gateway' }));

// The gateway verifies ownership before the collector receives a project scope.
app.use('/traces', requireCustomerAuth, async (req, res) => {
  const projectId = req.query.projectId;
  if (typeof projectId !== 'string' || !projectId) {
    return res.status(400).json({ error: 'A projectId is required' });
  }
  try {
    const collectorUrl = process.env.COLLECTOR_URL || 'http://localhost:4000';
    await axios.get(
      orderServiceUrl(`/projects/${encodeURIComponent(projectId)}/access`),
      customerIdentityConfig(req.customer.id)
    );
    const url = `${collectorUrl}${req.originalUrl}`;
    const resp = await axios.get(url, {
      headers: {
        'x-api-key': process.env.COLLECTOR_API_KEY,
        'x-project-id': projectId,
        // Forward any relevant headers from the incoming request
        ...(req.headers['user-agent'] && { 'user-agent': req.headers['user-agent'] }),
      },
      timeout: 5000
    });
    res.status(resp.status || 200).json(resp.data);
  } catch (err) {
    if (err.response) {
      res.status(err.response.status).json(err.response.data);
    } else {
      logger.error({ code: err.code }, '[api-gateway] Failed to proxy trace request to collector');
      res.status(503).json({ error: 'Unable to verify project access or reach collector' });
    }
  }
});

if (require.main === module) {
  app.listen(3000, () => logger.info('[api-gateway] listening on :3000'));

  const shutdown = async () => {
    logger.info('[api-gateway] shutting down...');
    await tracer.shutdown();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
}

module.exports = app;