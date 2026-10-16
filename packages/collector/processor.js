const { readSpans, ackSpans } = require('./queue');
const { insertSpan }          = require('./db');
const { CircuitBreaker }      = require('./error');

const dbBreaker = new CircuitBreaker(5, 30000); // open after 5 failures, retry after 30s


async function startProcessor() {
  console.log('[Processor] started — reading from Redis Stream');

  while (true) {
    try {
      const messages = await readSpans(100);
      if (messages.length === 0) continue;

      await processMessages(messages);
    } catch (err) {
      console.error('[Processor] error:', err.message);
      await sleep(1000);
    }
  }
}

async function processMessages(messages) {
  let processed = 0;
  for (const { streamId, span } of messages) {
    try {
      await dbBreaker.execute(() => insertSpan(span));
      await ackSpans([streamId]);
      processed += 1;
    } catch (err) {
      console.error('[Processor] span processing failed; leaving message pending for retry:', err.message);
    }
  }
  if (processed > 0) console.log(`[Processor] wrote ${processed} spans to PostgreSQL`);
  return processed;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { startProcessor, processMessages };