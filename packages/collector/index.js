// Milestone 1 collector: in-memory, logs a waterfall view to console
// In Milestone 2 we replace this with ClickHouse storage

const express = require('express');
const app = express();
app.use(express.json());

// store spans grouped by traceId
const traces = new Map();   // traceId → Span[]

// ── receive spans from SDK ────────────────────────────────────────────────
app.post('/spans', (req, res) => {
  const { spans } = req.body;
  if (!Array.isArray(spans)) return res.status(400).json({ error: 'expected spans array' });

  for (const span of spans) {
    if (!traces.has(span.traceId)) traces.set(span.traceId, []);
    traces.get(span.traceId).push(span);

    // print waterfall as spans arrive
    printSpan(span);
  }

  // once a trace has multiple spans, render the full waterfall
  const traceSpans = traces.get(spans[0]?.traceId) || [];
  if (traceSpans.length > 1) printWaterfall(traceSpans[0].traceId);

  res.json({ received: spans.length });
});

// ── get all traces (for dashboard later) ─────────────────────────────────
app.get('/traces', (req, res) => {
  const result = [];
  for (const [traceId, spans] of traces) {
    const root = spans.find(s => !s.parentSpanId) || spans[0];
    result.push({
      traceId,
      rootSpan:   root?.name,
      service:    root?.serviceName,
      duration:   root?.duration,
      spanCount:  spans.length,
      hasError:   spans.some(s => s.status === 'error'),
      startTime:  root?.startTime,
    });
  }
  res.json(result.sort((a, b) => b.startTime - a.startTime));
});

// ── get single trace detail ───────────────────────────────────────────────
app.get('/traces/:traceId', (req, res) => {
  const spans = traces.get(req.params.traceId);
  if (!spans) return res.status(404).json({ error: 'trace not found' });
  res.json(buildTree(spans));
});

// ── console waterfall renderer ────────────────────────────────────────────
function printSpan(span) {
  const status = span.status === 'error' ? '❌' : '✅';
  const dur    = span.duration != null ? `${span.duration}ms` : 'in progress';
  console.log(`${status} [${span.serviceName}] ${span.name} — ${dur}`);
}

function printWaterfall(traceId) {
  const spans = traces.get(traceId);
  if (!spans || spans.length < 2) return;

  const root      = spans.find(s => !s.parentSpanId) || spans[0];
  const traceStart = root?.startTime || spans[0].startTime;
  const traceEnd   = Math.max(...spans.map(s => s.endTime || Date.now()));
  const totalDur   = traceEnd - traceStart;

  console.log('\n' + '─'.repeat(70));
  console.log(`TRACE  ${traceId}`);
  console.log(`Total  ${totalDur}ms   Spans: ${spans.length}`);
  console.log('─'.repeat(70));

  // sort by start time, render indent based on depth
  const sorted = [...spans].sort((a, b) => a.startTime - b.startTime);
  for (const span of sorted) {
    const indent = span.parentSpanId ? '  └─ ' : '';
    const bar    = renderBar(span, traceStart, totalDur);
    const status = span.status === 'error' ? ' ❌' : '';
    const dur    = span.duration != null ? `${span.duration}ms` : '?ms';
    console.log(`${indent}${span.serviceName}.${span.name}${status}`);
    console.log(`   ${bar} ${dur}`);
  }
  console.log('─'.repeat(70) + '\n');
}

function renderBar(span, traceStart, totalDur) {
  const BAR_WIDTH = 30;
  if (!totalDur) return ' '.repeat(BAR_WIDTH);
  const offset = Math.max(0, Math.floor(((span.startTime - traceStart) / totalDur) * BAR_WIDTH));
  const width  = Math.max(1, Math.floor(((span.duration || 1) / totalDur) * BAR_WIDTH));
  const fill   = Math.max(0, Math.min(width, BAR_WIDTH - offset));
  return ' '.repeat(offset) + '█'.repeat(fill);
}

// build parent-child tree structure
function buildTree(spans) {
  const byId = Object.fromEntries(spans.map(s => [s.spanId, { ...s, children: [] }]));
  const roots = [];
  for (const span of Object.values(byId)) {
    if (span.parentSpanId && byId[span.parentSpanId]) {
      byId[span.parentSpanId].children.push(span);
    } else {
      roots.push(span);
    }
  }
  return roots;
}

app.listen(4000, () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Lantern — Collector v0.1  ║');
  console.log('║   Listening on :4000                 ║');
  console.log('╚══════════════════════════════════════╝\n');
});