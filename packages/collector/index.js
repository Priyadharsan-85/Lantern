require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const express  = require('express');
const promClient = require('prom-client');
const { setupStream, pushSpans } = require('./queue');
const { startProcessor }         = require('./processor');
const { getTraces, getTraceById } = require('./db');

const app = express();
app.use(express.json());

// Enable CORS for dashboard
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ── Prometheus metrics ──────────────────────────────────────────────────
const spansIngested = new promClient.Counter({
  name: 'lantern_spans_ingested_total',
  help: 'Total spans received',
  labelNames: ['status']
});

const queueDepth = new promClient.Gauge({
  name: 'lantern_queue_depth',
  help: 'Current span queue size'
});

const processorLatency = new promClient.Histogram({
  name: 'lantern_processor_latency_ms',
  help: 'Span processing latency in milliseconds',
  buckets: [10, 50, 100, 500, 1000]
});

app.get('/metrics', (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(promClient.register.metrics());
});

// ── receive spans from SDK ────────────────────────────────────────────────
app.post('/spans', async (req, res) => {
  const { spans } = req.body;
  if (!Array.isArray(spans)) {
    return res.status(400).json({ error: 'expected spans array' });
  }

  spansIngested.inc({ status: 'received' }, spans.length);
  queueDepth.set(spans.length);

  try {
    await pushSpans(spans);
    printWaterfall(spans);
    spansIngested.inc({ status: 'queued' }, spans.length);
    res.json({ received: spans.length });
  } catch (err) {
    console.error('[Collector] Failed to queue spans:', err.message);
    spansIngested.inc({ status: 'failed' }, spans.length);
    res.status(500).json({ error: 'Failed to queue spans' });
  }
});

// ── query endpoints for dashboard (Milestone 3) ───────────────────────────
app.get('/traces', async (req, res) => {
  try {
    const traces = await getTraces(50);
    res.json(traces);
  } catch (err) {
    console.error('[Collector] Failed to fetch traces:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/traces/:traceId', async (req, res) => {
  try {
    const spans = await getTraceById(req.params.traceId);
    if (!spans.length) return res.status(404).json({ error: 'trace not found' });
    res.json(spans);
  } catch (err) {
    console.error('[Collector] Failed to fetch trace detail:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'collector',
    version: '0.2',
    timestamp: new Date().toISOString()
  });
});

// ── console waterfall (kept from Milestone 1) ─────────────────────────────
function printWaterfall(spans) {
  if (!spans.length) return;
  const traceId  = spans[0].traceId;
  const sorted   = [...spans].sort((a, b) => a.startTime - b.startTime);
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

// ── startup ───────────────────────────────────────────────────────────────
async function start() {
  try {
    await setupStream();
    startProcessor();

    app.listen(4000, () => {
      console.log('╔══════════════════════════════════════╗');
      console.log('║   Lantern — Collector v0.2           ║');
      console.log('║   Listening on :4000                 ║');
      console.log('║   Storage: PostgreSQL + Redis        ║');
      console.log('║   Metrics: :4000/metrics             ║');
      console.log('╚══════════════════════════════════════╝\n');
    });
  } catch (err) {
    console.error('[Collector] Failed to start:', err.message);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  console.log('[Collector] Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Collector] Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

start();