const Redis = require('ioredis');

const redis    = new Redis({ host: 'localhost', port: 6379 });
const consumer = new Redis({ host: 'localhost', port: 6379 });

const STREAM_KEY  = 'lantern:spans';
const GROUP_NAME  = 'span-processors';
const CONSUMER_ID = 'processor-1';

// create consumer group once on startup
async function setupStream() {
  try {
    await redis.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '0', 'MKSTREAM');
    console.log('[Queue] consumer group created');
  } catch (err) {
    if (!err.message.includes('BUSYGROUP')) {
      console.error('[Queue] setup error:', err.message);
    }
  }
}

// push a batch of spans onto the stream
async function pushSpans(spans) {
  const pipeline = redis.pipeline();
  for (const span of spans) {
    pipeline.xadd(STREAM_KEY, '*', 'data', JSON.stringify(span));
  }
  await pipeline.exec();
}

// read up to `count` unprocessed spans from the stream
async function readSpans(count = 100) {
  const results = await consumer.xreadgroup(
    'GROUP', GROUP_NAME, CONSUMER_ID,
    'COUNT', count,
    'BLOCK', 1000,
    'STREAMS', STREAM_KEY, '>'
  );
  if (!results) return [];

  const messages = results[0][1];
  return messages.map(([id, fields]) => ({
    streamId: id,
    span: JSON.parse(fields[1]),
  }));
}

// acknowledge processed spans so Redis removes them
async function ackSpans(ids) {
  if (ids.length === 0) return;
  await consumer.xack(STREAM_KEY, GROUP_NAME, ...ids);
}

module.exports = { setupStream, pushSpans, readSpans, ackSpans };