const { readSpans, ackSpans } = require('./queue');
const { insertSpan }          = require('./db');

async function startProcessor() {
  console.log('[Processor] started — reading from Redis Stream');

  while (true) {
    try {
      const messages = await readSpans(100);
      if (messages.length === 0) continue;

      // write all spans to PostgreSQL in parallel
      await Promise.all(messages.map(({ span }) => insertSpan(span)));

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