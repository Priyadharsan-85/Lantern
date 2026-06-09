const express  = require('express');
const { setupStream, pushSpans } = require('./queue');
const { startProcessor }         = require('./processor');
const { getTraces, getTraceById } = require('./db');

const app = express();
app.use(express.json());

// ── receive spans from SDK ────────────────────────────────────────────────
app.post('/spans', async (req, res) => {
  const { spans } = req.body;
  if (!Array.isArray(spans)) return res.status(400).json({ error: 'expected spans array' });

  // push to Redis Stream — processor writes to PostgreSQL
  await pushSpans(spans);

  // still print waterfall to console for dev visibility
  printWaterfall(spans);

  res.json({ received: spans.length });
});

// ── query endpoints for dashboard (Milestone 3) ───────────────────────────
app.get('/traces', async (req, res) => {
  try {
    const traces = await getTraces(50);
    res.json(traces);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/traces/:traceId', async (req, res) => {
  try {
    const spans = await getTraceById(req.params.traceId);
    if (!spans.length) return res.status(404).json({ error: 'trace not found' });
    res.json(spans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

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
  await setupStream();
  startProcessor();

  app.listen(4000, () => {
    console.log('╔══════════════════════════════════════╗');
    console.log('║   Lantern — Collector v0.2           ║');
    console.log('║   Listening on :4000                 ║');
    console.log('║   Storage: PostgreSQL + Redis        ║');
    console.log('╚══════════════════════════════════════╝\n');
  });
}

start();