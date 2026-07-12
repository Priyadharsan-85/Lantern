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

      // write all spans to PostgreSQL via circuit breaker
      await Promise.all(messages.map(({ span }) => dbBreaker.execute(() => insertSpan(span))));

      // acknowledge so Redis clears them from the stream
      const ids = messages.map(({ streamId }) => streamId);
      await ackSpans(ids);

      console.log(`[Processor] wrote ${messages.length} spans to PostgreSQL`);
    } catch (err) {
      console.error('[Processor] error:', err.message);
      await sleep(1000);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { startProcessor };