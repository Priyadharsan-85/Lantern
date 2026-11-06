const { validateSpan, MAX_SPAN_JSON_BYTES } = require('./validate');

function validSpan(overrides = {}) {
  return {
    spanId: 'span-1',
    traceId: 'trace-1',
    parentSpanId: null,
    name: 'GET /health',
    serviceName: 'example',
    status: 'ok',
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_000_003,
    duration: 3,
    tags: { 'http.status': 200 },
    logs: [],
    ...overrides,
  };
}

describe('collector span validation', () => {
  it('accepts SDK-shaped spans', () => {
    expect(validateSpan(validSpan())).toBe(true);
    expect(validateSpan(validSpan({ status: undefined }))).toBe(true);
    expect(validateSpan(validSpan({ parentSpanId: undefined }))).toBe(true);
    expect(validateSpan(validSpan({ tags: undefined, logs: undefined }))).toBe(true);
  });

  it('rejects non-object values and missing required fields', () => {
    for (const value of [null, undefined, 'span', 42, [], ['span']]) {
      expect(validateSpan(value)).toBe(false);
    }
    expect(validateSpan(validSpan({ spanId: undefined }))).toBe(false);
    expect(validateSpan(validSpan({ traceId: '' }))).toBe(false);
    expect(validateSpan(validSpan({ name: undefined }))).toBe(false);
    expect(validateSpan(validSpan({ serviceName: undefined }))).toBe(false);
  });

  it('rejects values that exceed field length limits', () => {
    expect(validateSpan(validSpan({ spanId: 'x'.repeat(129) }))).toBe(false);
    expect(validateSpan(validSpan({ traceId: 'x'.repeat(129) }))).toBe(false);
    expect(validateSpan(validSpan({ name: 'x'.repeat(257) }))).toBe(false);
    expect(validateSpan(validSpan({ serviceName: 'x'.repeat(129) }))).toBe(false);
    expect(validateSpan(validSpan({ parentSpanId: 'x'.repeat(129) }))).toBe(false);
  });

  it('rejects invalid status, timestamps, and durations', () => {
    expect(validateSpan(validSpan({ status: 'unknown' }))).toBe(false);
    expect(validateSpan(validSpan({ startTime: -1 }))).toBe(false);
    expect(validateSpan(validSpan({ startTime: 1.5 }))).toBe(false);
    expect(validateSpan(validSpan({ startTime: undefined }))).toBe(false);
    expect(validateSpan(validSpan({ duration: -1 }))).toBe(false);
    expect(validateSpan(validSpan({ duration: undefined }))).toBe(false);
    expect(validateSpan(validSpan({ duration: 24 * 60 * 60 * 1000 + 1 }))).toBe(false);
    expect(validateSpan(validSpan({ endTime: 0 }))).toBe(false);
    expect(validateSpan(validSpan({ endTime: 1.5 }))).toBe(false);
  });

  it('rejects malformed tags and logs', () => {
    expect(validateSpan(validSpan({ tags: [] }))).toBe(false);
    expect(validateSpan(validSpan({ tags: 'tag' }))).toBe(false);
    expect(validateSpan(validSpan({ logs: {} }))).toBe(false);
    expect(validateSpan(validSpan({ logs: 'log' }))).toBe(false);
  });

  it('rejects tags or logs above the JSON size limit', () => {
    const oversized = { blob: 'x'.repeat(MAX_SPAN_JSON_BYTES) };
    expect(validateSpan(validSpan({ tags: oversized }))).toBe(false);
    expect(validateSpan(validSpan({ logs: [oversized] }))).toBe(false);
  });
});
