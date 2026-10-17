require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const express       = require('express');
const crypto        = require('crypto');
const rateLimit     = require('express-rate-limit');
const promClient    = require('prom-client');
const helmet        = require('helmet');
const cors          = require('cors');
const compression   = require('compression');
const { setupStream, pushSpans, getStreamLength, StreamCapacityError } = require('./queue');
const { startProcessor }         = require('./processor');
const {
  getProjectIdForIngestKey,
  reserveProjectSpanQuota,
  releaseProjectSpanQuota,
  deleteExpiredSpans,
  getTraces,
  getTraceById,
} = require('./db');
const logger                     = require('./logger');

// ── Startup validation ─────────────────────────────────────────────────────────
const isProd = process.env.NODE_ENV === 'production';

function positiveIntegerSetting(name, fallback) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`[Collector] ${name} must be a positive integer`);
  }
  return value;
}

const PROJECT_MONTHLY_SPAN_LIMIT = positiveIntegerSetting('PROJECT_MONTHLY_SPAN_LIMIT', 100_000);
const SPAN_RETENTION_DAYS = positiveIntegerSetting('SPAN_RETENTION_DAYS', 7);
const RETENTION_CLEANUP_INTERVAL_MS = positiveIntegerSetting('RETENTION_CLEANUP_INTERVAL_MS', 3_600_000);
const RETENTION_CLEANUP_BATCH_SIZE = positiveIntegerSetting('RETENTION_CLEANUP_BATCH_SIZE', 5_000);
const RETENTION_CLEANUP_MAX_BATCHES = positiveIntegerSetting('RETENTION_CLEANUP_MAX_BATCHES', 10);

if (isProd) {
  if (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === '*') {
    throw new Error('[Collector] CORS_ORIGIN must be set to a specific origin in production');
  }
  if (!process.env.COLLECTOR_API_KEY) {
    throw new Error('[Collector] COLLECTOR_API_KEY is required in production');
  }
}

// ── Express app ────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigin = process.env.CORS_ORIGIN || (isProd ? 'https://lantern.yourdomain.com' : true);
app.use(cors({
  origin: isProd ? allowedOrigin : true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'x-project-id'],
}));

function matchesSecret(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function ingestProjectAuth(req, res, next) {
  const provided = req.get('x-api-key');
  try {
    if (matchesSecret(provided, process.env.COLLECTOR_API_KEY)) {
      req.projectId = 'prj_internal';
      return next();
    }
    if (typeof provided !== 'string' || !provided) {
      return res.status(401).json({ error: 'Invalid or missing ingest key' });
    }
    const keyHash = crypto.createHash('sha256').update(provided).digest('hex');
    const projectId = await getProjectIdForIngestKey(keyHash);
    if (!projectId || projectId === 'prj_internal') {
      return res.status(401).json({ error: 'Invalid or missing ingest key' });
    }
    req.projectId = projectId;
    next();
  } catch (err) {
    logger.error({ err }, '[Collector] Failed to authenticate ingest key');
    res.status(503).json({ error: 'Ingestion authentication is temporarily unavailable' });
  }
}

function internalProjectAuth(req, res, next) {
  if (!matchesSecret(req.get('x-api-key'), process.env.COLLECTOR_API_KEY) ||
      typeof req.get('x-project-id') !== 'string' ||
      !req.get('x-project-id')) {
    return res.status(401).json({ error: 'Authenticated project access required' });
  }
  req.projectId = req.get('x-project-id');
  next();
}

// ── Rate limiter for span ingestion ───────────────────────────────────────────
const spansLimiter = rateLimit({
  windowMs: Number(process.env.SPANS_RATE_LIMIT_WINDOW_MS) || 60_000,
  max:      Number(process.env.SPANS_RATE_LIMIT_MAX)        || 200,
  keyGenerator: (req) => {
    const key = req.get('x-api-key');
    return key ? crypto.createHash('sha256').update(key).digest('hex') : 'missing-ingest-key';
  },
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many span batches from this IP, slow down.' },
});

function secondsUntilNextUtcMonth() {
  const now = new Date();
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.ceil((nextMonth - now.getTime()) / 1000);
}

// ── Prometheus metrics ────────────────────────────────────────────────────────
const spansIngested = new promClient.Counter({
  name: 'lantern_spans_ingested_total',
  help: 'Total spans received',
  labelNames: ['status'],
});

const queueDepth = new promClient.Gauge({
  name: 'lantern_queue_depth',
  help: 'Current Redis stream depth (XLEN)',
});

const processorLatency = new promClient.Histogram({
  name: 'lantern_processor_latency_ms',
  help: 'Span processing latency in milliseconds',
  buckets: [10, 50, 100, 500, 1000],
});

// Export metrics for use in processor
module.exports._metrics = { spansIngested, queueDepth, processorLatency };

// ── Refresh queue depth from Redis every 5 s ──────────────────────────────────
async function refreshQueueDepth() {
  try {
    const depth = await getStreamLength();
    queueDepth.set(depth);
  } catch (_) { /* non-fatal */ }
}

app.get('/metrics', async (req, res) => {
  await refreshQueueDepth();
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

// ── Receive spans from SDK ─────────────────────────────────────────────────────
app.post('/spans', spansLimiter, ingestProjectAuth, async (req, res) => {
  const { spans } = req.body;
  if (!Array.isArray(spans) || spans.length === 0) {
    return res.status(400).json({ error: 'expected a non-empty spans array' });
  }
  if (spans.length > 1000) {
    return res.status(400).json({ error: 'batch too large — max 1000 spans per request' });
  }

  let quotaReserved = false;
  if (req.projectId !== 'prj_internal') {
    try {
      const reservation = await reserveProjectSpanQuota(
        req.projectId,
        spans.length,
        PROJECT_MONTHLY_SPAN_LIMIT
      );
      if (!reservation.allowed) {
        if (reservation.reason === 'project_inactive') {
          return res.status(401).json({ error: 'Invalid or missing ingest key' });
        }
        res.set('Retry-After', String(secondsUntilNextUtcMonth()));
        return res.status(429).json({
          error: 'Monthly project span limit reached',
          code: 'MONTHLY_SPAN_LIMIT_EXCEEDED',
          limit: PROJECT_MONTHLY_SPAN_LIMIT,
        });
      }
      quotaReserved = true;
    } catch (err) {
      logger.error({ err, projectId: req.projectId }, '[Collector] Failed to reserve project span quota');
      return res.status(503).json({ error: 'Ingestion quota is temporarily unavailable' });
    }
  }

  spansIngested.inc({ status: 'received' }, spans.length);
  const projectSpans = spans.map((span) => ({ ...span, projectId: req.projectId }));

  try {
    await pushSpans(projectSpans);
    printWaterfall(projectSpans);
    spansIngested.inc({ status: 'queued' }, projectSpans.length);
    res.json({ received: spans.length });
  } catch (err) {
    logger.error({ err }, '[Collector] Failed to queue spans');
    spansIngested.inc({ status: 'failed' }, projectSpans.length);
    if (quotaReserved) {
      try {
        await releaseProjectSpanQuota(req.projectId, spans.length);
      } catch (releaseError) {
        logger.error(
          { err: releaseError, projectId: req.projectId },
          '[Collector] Failed to release project span quota after queue failure'
        );
      }
    }
    if (err instanceof StreamCapacityError) {
      res.set('Retry-After', '5');
      return res.status(503).json({ error: 'Span queue is at capacity; retry later' });
    }
    res.status(500).json({ error: 'Failed to queue spans' });
  }
});

// ── Query endpoints for dashboard ─────────────────────────────────────────────
app.get('/traces', internalProjectAuth, async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit)  || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0,  0);
    const traces = await getTraces(req.projectId, limit, offset);
    res.json(traces);
  } catch (err) {
    logger.error({ err }, '[Collector] Failed to fetch traces');
    res.status(500).json({ error: err.message });
  }
});

app.get('/traces/:traceId', internalProjectAuth, async (req, res) => {
  try {
    const spans = await getTraceById(req.projectId, req.params.traceId);
    if (!spans.length) return res.status(404).json({ error: 'trace not found' });
    res.json(spans);
  } catch (err) {
    logger.error({ err }, '[Collector] Failed to fetch trace detail');
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    service:   'collector',
    version:   '0.3',
    timestamp: new Date().toISOString(),
  });
});

// ── Console waterfall (dev-friendly) ──────────────────────────────────────────
function printWaterfall(spans) {
  if (!spans.length || isProd) return;   // skip waterfall output in production
  const traceId    = spans[0].traceId;
  const sorted     = [...spans].sort((a, b) => a.startTime - b.startTime);
  const traceStart = sorted[0].startTime;
  const totalDur   = Math.max(...spans.map(s => s.duration || 1));

  console.log('\n' + '─'.repeat(60));
  console.log(`TRACE  ${traceId}`);
  console.log(`Spans: ${spans.length}`);
  console.log('─'.repeat(60));
  for (const span of sorted) {
    const indent = span.parentSpanId ? '  └─ ' : '';
    const bar    = renderBar(span, traceStart, totalDur);
    const status = span.status === 'error' ? ' ❌' : ' ✅';
    console.log(`${indent}${span.serviceName}.${span.name}${status}`);
    console.log(`   ${bar} ${span.duration}ms`);
  }
  console.log('─'.repeat(60) + '\n');
}

function renderBar(span, traceStart, totalDur) {
  const BAR_WIDTH = 30;
  if (!totalDur) return ' '.repeat(BAR_WIDTH);
  const offset = Math.max(0, Math.floor(((span.startTime - traceStart) / totalDur) * BAR_WIDTH));
  const width  = Math.max(1, Math.floor(((span.duration || 1) / totalDur) * BAR_WIDTH));
  const fill   = Math.max(0, Math.min(width, BAR_WIDTH - offset));
  return ' '.repeat(offset) + '█'.repeat(fill);
}

let retentionCleanupRunning = false;

async function runRetentionCleanup() {
  if (retentionCleanupRunning) return;
  retentionCleanupRunning = true;
  try {
    const cutoff = new Date(Date.now() - SPAN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    let deleted = 0;
    for (let batch = 0; batch < RETENTION_CLEANUP_MAX_BATCHES; batch += 1) {
      const count = await deleteExpiredSpans(cutoff, RETENTION_CLEANUP_BATCH_SIZE);
      deleted += count;
      if (count < RETENTION_CLEANUP_BATCH_SIZE) break;
    }
    if (deleted > 0) {
      logger.info({ deleted, retentionDays: SPAN_RETENTION_DAYS }, '[Collector] Expired spans removed');
    }
  } catch (err) {
    logger.error({ err }, '[Collector] Retention cleanup failed');
  } finally {
    retentionCleanupRunning = false;
  }
}

function startRetentionCleanup() {
  void runRetentionCleanup();
  const timer = setInterval(runRetentionCleanup, RETENTION_CLEANUP_INTERVAL_MS);
  timer.unref();
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  try {
    await setupStream();
    startProcessor();
    startRetentionCleanup();

    app.listen(4000, () => {
      logger.info('╔══════════════════════════════════════╗');
      logger.info('║   Lantern — Collector v0.3           ║');
      logger.info('║   Listening on :4000                 ║');
      logger.info('║   Storage: PostgreSQL + Redis        ║');
      logger.info('║   Metrics: :4000/metrics             ║');
      logger.info(`║   Auth:    ${process.env.COLLECTOR_API_KEY ? 'API key required     ' : 'disabled (dev mode)  '}║`);
      logger.info('╚══════════════════════════════════════╝');
    });
  } catch (err) {
    logger.error({ err }, '[Collector] Failed to start');
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  logger.info('[Collector] Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('[Collector] Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

// Only boot when run directly — not during tests
if (require.main === module) {
  start();
}

module.exports = app;