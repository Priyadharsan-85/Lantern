const Redis = require('ioredis');
const crypto = require('crypto');
const os = require('os');

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = Number(process.env.REDIS_PORT) || 6379;

const redis    = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
const consumer = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

const STREAM_KEY  = 'lantern:spans';
const GROUP_NAME  = 'span-processors';
const CONSUMER_ID = `${os.hostname()}-${process.pid}-${crypto.randomUUID()}`;
const MAX_STREAM_LENGTH = Number(process.env.SPAN_STREAM_MAX_LENGTH) || 100_000;
const PENDING_IDLE_MS = Number(process.env.SPAN_PENDING_IDLE_MS) || 30_000;
let reclaimCursor = '0-0';
if (!Number.isSafeInteger(MAX_STREAM_LENGTH) || MAX_STREAM_LENGTH < 1 ||
    !Number.isSafeInteger(PENDING_IDLE_MS) || PENDING_IDLE_MS < 1) {
  throw new Error('[Queue] SPAN_STREAM_MAX_LENGTH and SPAN_PENDING_IDLE_MS must be positive integers');
}

const PUSH_SPANS_SCRIPT = `
  local length = redis.call('XLEN', KEYS[1])
  local count = #ARGV - 1
  if length + count > tonumber(ARGV[1]) then return -1 end
  for i = 2, #ARGV do
    redis.call('XADD', KEYS[1], '*', 'data', ARGV[i])
  end
  return count
`;

const ACK_AND_DELETE_SCRIPT = `
  local removed = 0
  for i = 2, #ARGV do
    local acknowledged = redis.call('XACK', KEYS[1], ARGV[1], ARGV[i])
    if acknowledged > 0 then removed = removed + redis.call('XDEL', KEYS[1], ARGV[i]) end
  end
  return removed
`;

class StreamCapacityError extends Error {
  constructor() { super('Span queue is full'); this.name = 'StreamCapacityError'; }
}

// create consumer group once on startup
async function setupStream() {
  try {
    await redis.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '0', 'MKSTREAM');
    console.log('[Queue] consumer group created');
  } catch (err) {
    if (!err.message.includes('BUSYGROUP')) throw err;
  }
}

// push a batch of spans onto the stream
async function pushSpans(spans) {
  const result = await redis.eval(PUSH_SPANS_SCRIPT, 1, STREAM_KEY,
    String(MAX_STREAM_LENGTH), ...spans.map((span) => JSON.stringify(span)));
  if (Number(result) < 0) throw new StreamCapacityError();
}

// read up to `count` unprocessed spans from the stream
async function readSpans(count = 100) {
  const claimed = await consumer.xautoclaim(STREAM_KEY, GROUP_NAME, CONSUMER_ID,
    PENDING_IDLE_MS, reclaimCursor, 'COUNT', count);
  reclaimCursor = claimed[0] === '0-0' ? '0-0' : claimed[0];
  const recovered = parseMessages(claimed[1] || []);
  if (recovered.length > 0) return recovered;

  const results = await consumer.xreadgroup(
    'GROUP', GROUP_NAME, CONSUMER_ID,
    'COUNT', count,
    'BLOCK', 1000,
    'STREAMS', STREAM_KEY, '>'
  );
  if (!results) return [];
  return parseMessages(results[0][1]);
}

// acknowledge processed spans so Redis removes them
async function ackSpans(ids) {
  if (ids.length === 0) return;
  await consumer.eval(ACK_AND_DELETE_SCRIPT, 1, STREAM_KEY, GROUP_NAME, ...ids);
}

function parseMessages(messages) {
  return messages.map(([id, fields]) => {
    const dataIndex = fields.indexOf('data');
    if (dataIndex < 0 || !fields[dataIndex + 1]) throw new Error(`Redis stream entry ${id} does not contain span data`);
    return { streamId: id, span: JSON.parse(fields[dataIndex + 1]) };
  });
}

module.exports = { setupStream, pushSpans, readSpans, ackSpans, StreamCapacityError };