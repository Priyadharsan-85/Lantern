const { readSpans, ackSpans }   = require('./queue');
const { insertSpan, releaseProjectSpanQuota } = require('./db');
const { CircuitBreaker }        = require('./error');
const logger                    = require('./logger');

// Lazy-require metrics to avoid circular dependency issues in tests
function getMetrics() {
  try { return require('./index')._metrics; } catch (_) { return null; }
}

const dbBreaker = new CircuitBreaker(5, 30_000); // open after 5 failures, retry after 30s

async function startProcessor() {
  logger.info('[Processor] started — reading from Redis Stream');

  while (true) {
    try {
      const messages = await readSpans(100);
      if (messages.length === 0) continue;
      await processMessages(messages);
    } catch (err) {
      logger.error({ err }, '[Processor] processing error');

      // Increment the failure metric so Prometheus/Grafana can alert on it
      const m = getMetrics();
      if (m) m.spansIngested.inc({ status: 'processor_error' }, 1);

      await sleep(1000);
    }
  }
}

async function processMessages(messages) {
  const startedAt = Date.now();
  let processed = 0;
  for (const { streamId, span } of messages) {
    try {
      const inserted = await dbBreaker.execute(() => insertSpan(span));
      if (!inserted && span.projectId && span.projectId !== 'prj_internal') {
        // The span already existed, so the quota reserved at ingest must be
        // returned. Leaving the message unacknowledged on failure retries it.
        await releaseProjectSpanQuota(span.projectId, 1);
      }
      await ackSpans([streamId]);
      processed += 1;
    } catch (err) {
      logger.error({ err, streamId }, '[Processor] span processing failed; leaving message pending for retry');
      const m = getMetrics();
      if (m) m.spansIngested.inc({ status: 'processor_error' }, 1);
    }
  }
  const m = getMetrics();
  if (m) {
    m.processorLatency.observe(Date.now() - startedAt);
    if (processed > 0) m.spansIngested.inc({ status: 'processed' }, processed);
  }
  if (processed > 0) {
    logger.info(`[Processor] wrote ${processed} spans to PostgreSQL`);
  }
  return processed;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { startProcessor, processMessages };