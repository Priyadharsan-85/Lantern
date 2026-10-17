const mockPushSpans = jest.fn();

jest.mock('./queue', () => ({
  setupStream: jest.fn(),
  pushSpans: (...args) => mockPushSpans(...args),
  StreamCapacityError: class StreamCapacityError extends Error {},
}));
jest.mock('./processor', () => ({ startProcessor: jest.fn() }));
jest.mock('./db', () => ({
  getTraces: jest.fn(),
  getTraceById: jest.fn(),
}));

const request = require('supertest');
process.env.COLLECTOR_API_KEY = 'capacity-test-key';
const app = require('./index');
const { StreamCapacityError } = require('./queue');

describe('span ingestion backpressure', () => {
  it('returns a retryable 503 when the Redis stream is full', async () => {
    mockPushSpans.mockRejectedValueOnce(new StreamCapacityError());

    const response = await request(app)
      .post('/spans')
      .set('x-api-key', 'capacity-test-key')
      .send({ spans: [{ spanId: 'span-1', traceId: 'trace-1' }] });

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.body.error).toMatch(/queue is at capacity/i);
  });
});
