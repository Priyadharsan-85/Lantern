const MAX_SPAN_JSON_BYTES = 32 * 1024;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

function boundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function withinJsonLimit(value, maxBytes) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (_) {
    return false;
  }
  return serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= maxBytes;
}

function validateSpan(span) {
  if (!span || typeof span !== 'object' || Array.isArray(span)) return false;
  if (!boundedString(span.spanId, 128) ||
      !boundedString(span.traceId, 128) ||
      !boundedString(span.name, 256) ||
      !boundedString(span.serviceName, 128) ||
      (span.parentSpanId != null && !boundedString(span.parentSpanId, 128)) ||
      !['ok', 'error'].includes(span.status || 'ok') ||
      !Number.isSafeInteger(span.startTime) || span.startTime < 0 ||
      !Number.isSafeInteger(span.duration) || span.duration < 0 ||
      span.duration > MAX_DURATION_MS ||
      (span.endTime != null &&
        (!Number.isSafeInteger(span.endTime) || span.endTime < span.startTime))) {
    return false;
  }

  const tags = span.tags ?? {};
  const logs = span.logs ?? [];
  if (!tags || typeof tags !== 'object' || Array.isArray(tags) || !Array.isArray(logs)) {
    return false;
  }
  return withinJsonLimit(tags, MAX_SPAN_JSON_BYTES) &&
    withinJsonLimit(logs, MAX_SPAN_JSON_BYTES);
}

module.exports = { validateSpan, MAX_SPAN_JSON_BYTES };
