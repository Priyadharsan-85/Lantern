require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const crypto  = require('crypto');
const express = require('express');
const axios   = require('axios');
const pino    = require('pino');
const helmet  = require('helmet');
const cors    = require('cors');
const compression = require('compression');
const { Tracer, middleware } = require('sdk');

const isProd = process.env.NODE_ENV === 'production';
if (isProd && !process.env.COLLECTOR_API_KEY) {
  throw new Error('[api-gateway] COLLECTOR_API_KEY is required in production');
}
if (isProd && (!process.env.DASHBOARD_AUTH_USER ||
  !process.env.DASHBOARD_AUTH_PASSWORD || !process.env.SESSION_SECRET)) {
  throw new Error('[api-gateway] DASHBOARD_AUTH_USER, DASHBOARD_AUTH_PASSWORD, and SESSION_SECRET are required in production');
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
app.use(cors({
  origin: isProd ? process.env.DASHBOARD_ORIGIN || /^https:\/\/.*/ : true,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
}));
app.use(express.json({ limit: '1mb' }));

const SESSION_COOKIE = 'lantern_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function signSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'development-only-secret')
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

function readCookies(header = '') {
  return Object.fromEntries(header.split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
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

function requireDashboardAuth(req, res, next) {
  if (!isProd) return next();
  const cookies = readCookies(req.headers.cookie);
  if (!verifySession(cookies[SESSION_COOKIE])) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

app.post('/auth/login', (req, res) => {
  if (!isProd) return res.json({ authenticated: true });
  const { username, password } = req.body || {};
  if (username !== process.env.DASHBOARD_AUTH_USER ||
      password !== process.env.DASHBOARD_AUTH_PASSWORD) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  setSessionCookie(res, signSession({ user: username, exp }));
  res.json({ authenticated: true, user: username });
});

app.post('/auth/logout', (req, res) => {
  setSessionCookie(res, '', 0);
  res.json({ authenticated: false });
});

app.get('/auth/me', (req, res) => {
  if (!isProd) return res.json({ authenticated: true });
  const cookies = readCookies(req.headers.cookie);
  const authenticated = verifySession(cookies[SESSION_COOKIE]);
  res.status(authenticated ? 200 : 401).json({ authenticated });
});

const tracer = new Tracer({
  serviceName:  'api-gateway',
  collectorUrl: process.env.COLLECTOR_URL || 'http://localhost:4000',
  onLog: (level, msg) => logger[level]?.(msg) ?? logger.info(msg),
});

app.use(middleware(tracer));

app.post('/order', requireDashboardAuth, async (req, res) => {
  const { span } = req;
  const idempotencyKey = req.headers['idempotency-key'];
  if (isProd && (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 255)) {
    return res.status(400).json({ error: 'Idempotency-Key header must be 16-255 characters' });
  }

  // ── Input validation ───────────────────────────────────────────────────────
  const { userId, items, amount } = req.body || {};
  if (!userId) {
    span.setTag('validation.error', 'missing userId');
    return res.status(400).json({ error: 'userId is required' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    span.setTag('validation.error', 'missing items');
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }
  if (typeof amount !== 'number' || amount <= 0) {
    span.setTag('validation.error', 'invalid amount');
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  try {
    span.log('Received order request');
    span.setTag('user.id', userId);
    span.setTag('order.items_count', items.length);

    const orderRes = await axios.post(
      (process.env.ORDER_SERVICE_URL || 'http://localhost:4001') + '/process',
      req.body,
      { headers: tracer.injectContext(span, { 'idempotency-key': idempotencyKey }) }
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

// Proxy trace endpoints to collector. Use app.use so both /traces and
// /traces/:traceId work with Express 5's route parser.
app.use('/traces', requireDashboardAuth, async (req, res) => {
  try {
    const collectorUrl = process.env.COLLECTOR_URL || 'http://localhost:4000';
    const url = `${collectorUrl}${req.originalUrl}`;
    const resp = await axios.get(url, {
      headers: {
        'x-api-key': process.env.COLLECTOR_API_KEY,
        // Forward any relevant headers from the incoming request
        ...(req.headers['user-agent'] && { 'user-agent': req.headers['user-agent'] }),
      },
      timeout: 5000
    });
    res.status(resp.status).json(resp.data);
  } catch (err) {
    if (err.response) {
      // Collector returned an error response
      res.status(err.response.status).json(err.response.data);
    } else {
      // Network error or timeout
      logger.error({ err }, '[api-gateway] Failed to proxy trace request to collector');
      res.status(500).json({ error: 'Failed to reach collector' });
    }
  }
});

if (require.main === module) {
  app.listen(3000, () => logger.info('[api-gateway] listening on :3000'));

  const shutdown = async () => {
    logger.info('[api-gateway] shutting down...');
    await tracer.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
}

module.exports = app;