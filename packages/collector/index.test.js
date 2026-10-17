// Mock Redis and DB before requiring the app
jest.mock('./queue', () => ({
  StreamCapacityError: class StreamCapacityError extends Error {},
  setupStream:   jest.fn().mockResolvedValue(),
  pushSpans:     jest.fn().mockResolvedValue(),
  getStreamLength: jest.fn().mockResolvedValue(0),
  readSpans:     jest.fn().mockResolvedValue([]),
  ackSpans:      jest.fn().mockResolvedValue(),
}));

jest.mock('./db', () => ({
  getProjectIdForIngestKey: jest.fn().mockResolvedValue(null),
  getTraces:    jest.fn().mockResolvedValue([
    {
      trace_id:       'abc123',
      start_time:     Date.now(),
      total_duration: 150,
      span_count:     3,
      services:       ['api-gateway', 'order-service'],
      has_error:      false,
      root_span:      'POST /order',
    },
  ]),
  getTraceById: jest.fn().mockResolvedValue([
    { span_id: 's1', trace_id: 'abc123', name: 'POST /order', service_name: 'api-gateway' },
  ]),
  insertSpan:   jest.fn().mockResolvedValue(),
}));

jest.mock('./processor', () => ({ startProcessor: jest.fn() }));

const request = require('supertest');
const app     = require('./index');

describe('Collector', () => {
  beforeEach(() => {
    process.env.COLLECTOR_API_KEY = 'secret-key';
    jest.clearAllMocks();
  });

  const internalHeaders = { 'x-api-key': 'secret-key' };
  const userHeaders = { 'x-api-key': 'lntr_project-key' };

  // ── Health ────────────────────────────────────────────────────────────────
  describe('GET /health', () => {
    it('returns status ok with version and timestamp', async () => {
      const res = await request(app).get('/health');
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok', service: 'collector' });
      expect(res.body.version).toBeDefined();
      expect(res.body.timestamp).toBeDefined();
    });
  });

  // ── POST /spans ───────────────────────────────────────────────────────────
  describe('POST /spans', () => {
    it('accepts a valid spans array and returns count', async () => {
      const { pushSpans } = require('./queue');
      const res = await request(app)
        .post('/spans')
        .set(internalHeaders)
        .send({ spans: [{ spanId: 's1', traceId: 't1', name: 'test', serviceName: 'svc' }] });
      expect(res.statusCode).toBe(200);
      expect(res.body.received).toBe(1);
      expect(pushSpans).toHaveBeenCalledWith([
        expect.objectContaining({ projectId: 'prj_internal' }),
      ]);
    });

    it('returns 400 when body is not a spans array', async () => {
      const res = await request(app)
        .post('/spans')
        .set(internalHeaders)
        .send({ notSpans: true });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/spans/i);
    });

    it('returns 400 for an empty spans array', async () => {
      const res = await request(app)
        .post('/spans')
        .set(internalHeaders)
        .send({ spans: [] });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when batch exceeds 1000 spans', async () => {
      const bigBatch = Array.from({ length: 1001 }, (_, i) => ({ spanId: `s${i}` }));
      const res = await request(app).post('/spans').set(internalHeaders).send({ spans: bigBatch });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/batch too large/i);
    });

    it('returns retryable 503 when the stream is at capacity', async () => {
      const { pushSpans, StreamCapacityError } = require('./queue');
      pushSpans.mockRejectedValueOnce(new StreamCapacityError());

      const res = await request(app)
        .post('/spans')
        .set(internalHeaders)
        .send({ spans: [{ spanId: 's1', traceId: 't1', name: 'test', serviceName: 'svc' }] });

      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body.error).toMatch(/queue is at capacity/i);
    });

    it('returns 401 when API key is required but missing', async () => {
      process.env.COLLECTOR_API_KEY = 'secret-key';
      const res = await request(app)
        .post('/spans')
        .send({ spans: [{ spanId: 's1' }] });
      expect(res.statusCode).toBe(401);
    });

    it('accepts valid request when correct API key is provided', async () => {
      process.env.COLLECTOR_API_KEY = 'secret-key';
      const res = await request(app)
        .post('/spans')
        .set('x-api-key', 'secret-key')
        .send({ spans: [{ spanId: 's1', traceId: 't1', name: 'test', serviceName: 'svc' }] });
      expect(res.statusCode).toBe(200);
    });

    it('rejects invalid project keys and does not queue spans', async () => {
      const { pushSpans } = require('./queue');
      const res = await request(app)
        .post('/spans')
        .set('x-api-key', 'invalid-key')
        .send({ spans: [{ spanId: 's1' }] });
      expect(res.statusCode).toBe(401);
      expect(pushSpans).not.toHaveBeenCalled();
    });

    it('assigns an authenticated project key scope rather than trusting the payload', async () => {
      const crypto = require('crypto');
      const { getProjectIdForIngestKey } = require('./db');
      const { pushSpans } = require('./queue');
      const key = 'lntr_project-key';
      getProjectIdForIngestKey.mockResolvedValueOnce('prj_customer_a');
      const res = await request(app)
        .post('/spans')
        .set(userHeaders)
        .send({ spans: [{ spanId: 's1', traceId: 't1', projectId: 'prj_customer_b' }] });
      expect(res.statusCode).toBe(200);
      expect(getProjectIdForIngestKey).toHaveBeenCalledWith(
        crypto.createHash('sha256').update(key).digest('hex')
      );
      expect(pushSpans).toHaveBeenCalledWith([
        expect.objectContaining({ projectId: 'prj_customer_a' }),
      ]);
    });
  });

  // ── GET /traces ────────────────────────────────────────────────────────────
  describe('GET /traces', () => {
    it('returns an array of traces', async () => {
      const res = await request(app).get('/traces').set({ ...internalHeaders, 'x-project-id': 'prj_a' });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toHaveProperty('trace_id');
    });

    it('respects limit and offset query params', async () => {
      const { getTraces } = require('./db');
      await request(app).get('/traces?limit=10&offset=20')
        .set({ ...internalHeaders, 'x-project-id': 'prj_a' });
      expect(getTraces).toHaveBeenCalledWith('prj_a', 10, 20);
    });

    it('caps limit at 200', async () => {
      const { getTraces } = require('./db');
      await request(app).get('/traces?limit=999')
        .set({ ...internalHeaders, 'x-project-id': 'prj_a' });
      expect(getTraces).toHaveBeenCalledWith('prj_a', 200, 0);
    });

    it('rejects unauthenticated or unscoped trace reads', async () => {
      const { getTraces } = require('./db');
      const response = await request(app).get('/traces');
      expect(response.status).toBe(401);
      expect(getTraces).not.toHaveBeenCalled();
    });
  });

  // ── GET /traces/:traceId ──────────────────────────────────────────────────
  describe('GET /traces/:traceId', () => {
    it('returns spans for a known trace', async () => {
      const res = await request(app).get('/traces/abc123')
        .set({ ...internalHeaders, 'x-project-id': 'prj_a' });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toHaveProperty('span_id');
    });

    it('returns 404 for an unknown trace', async () => {
      const { getTraceById } = require('./db');
      getTraceById.mockResolvedValueOnce([]);
      const res = await request(app).get('/traces/nonexistent')
        .set({ ...internalHeaders, 'x-project-id': 'prj_a' });
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });
  });
});
