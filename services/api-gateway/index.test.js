// Mock the SDK before requiring the app so Tracer doesn't try to flush to a real collector
jest.mock('sdk', () => {
  const mockSpan = {
    log:    jest.fn().mockReturnThis(),
    setTag: jest.fn().mockReturnThis(),
    setError: jest.fn().mockReturnThis(),
    finish: jest.fn().mockReturnThis(),
    traceId: 'test-trace-id',
    spanId:  'test-span-id',
  };
  const mockTracer = {
    startSpanFromRequest: jest.fn().mockReturnValue(mockSpan),
    withSpan:    (span, fn) => fn(),
    _enqueue:    jest.fn(),
    injectContext: jest.fn().mockReturnValue({}),
    shutdown:    jest.fn().mockResolvedValue(),
  };
  return {
    Tracer:     jest.fn().mockImplementation(() => mockTracer),
    middleware:  jest.fn(() => (req, res, next) => {
      req.span = mockSpan;
      next();
    }),
  };
});

jest.mock('axios');
const axios   = require('axios');
const request = require('supertest');
const app     = require('./index');

describe('API Gateway', () => {

  // ── Health ────────────────────────────────────────────────────────────────
  describe('GET /health', () => {
    it('returns status ok', async () => {
      const res = await request(app).get('/health');
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok', service: 'api-gateway' });
    });
  });

  // ── POST /order — validation ──────────────────────────────────────────────
  describe('POST /order — input validation', () => {
    it('returns 400 when userId is missing', async () => {
      const res = await request(app)
        .post('/order')
        .send({ items: [{ id: 1 }], amount: 50 });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/userId/i);
    });

    it('returns 400 when items is empty', async () => {
      const res = await request(app)
        .post('/order')
        .send({ userId: 'u1', items: [], amount: 50 });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/items/i);
    });

    it('returns 400 when amount is invalid', async () => {
      const res = await request(app)
        .post('/order')
        .send({ userId: 'u1', items: [{ id: 1 }], amount: -10 });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/amount/i);
    });
  });

  // ── POST /order — happy path ──────────────────────────────────────────────
  describe('POST /order — happy path', () => {
    it('proxies to order-service and returns order data', async () => {
      axios.post.mockResolvedValueOnce({
        data: { orderId: 'ord_123', status: 'confirmed' },
      });

      const res = await request(app)
        .post('/order')
        .send({ userId: 'u1', items: [{ id: 'item_1', qty: 2 }], amount: 99.99 });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.order).toMatchObject({ orderId: 'ord_123' });
    });
  });

  // ── POST /order — upstream error ─────────────────────────────────────────
  describe('POST /order — upstream failure', () => {
    it('forwards the upstream error status and message', async () => {
      const upstreamError = new Error('Payment declined');
      upstreamError.response = { status: 402, data: { error: 'Card declined' } };
      axios.post.mockRejectedValueOnce(upstreamError);

      const res = await request(app)
        .post('/order')
        .send({ userId: 'u1', items: [{ id: 'item_1' }], amount: 100 });

      expect(res.statusCode).toBe(402);
      expect(res.body.error).toBe('Card declined');
    });

    it('returns 500 when order-service is unreachable', async () => {
      axios.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const res = await request(app)
        .post('/order')
        .send({ userId: 'u1', items: [{ id: 'item_1' }], amount: 100 });

      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBeTruthy();
    });
  });
});
