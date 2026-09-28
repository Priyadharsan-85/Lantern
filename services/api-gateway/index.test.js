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

async function customerCookie(email = 'buyer@example.com') {
  axios.post.mockResolvedValueOnce({
    data: { customer: { id: 'cus_test_123', email } },
  });
  const response = await request(app)
    .post('/auth/customer/register')
    .send({ email, password: 'long-password-123' });
  return response.headers['set-cookie'][0];
}

describe('API Gateway', () => {
  beforeEach(() => jest.clearAllMocks());

  // ── Health ────────────────────────────────────────────────────────────────
  describe('GET /health', () => {
    it('returns status ok', async () => {
      const res = await request(app).get('/health');
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok', service: 'api-gateway' });
    });
  });

  describe('customer account and catalog APIs', () => {
    it('registers a customer through the order service and starts a customer session', async () => {
      axios.post.mockResolvedValueOnce({
        data: { customer: { id: 'cus_123', email: 'buyer@example.com' } },
      });

      const registration = await request(app)
        .post('/auth/customer/register')
        .send({ email: 'buyer@example.com', password: 'long-password-123' });

      expect(registration.status).toBe(201);
      expect(registration.body).toEqual({
        authenticated: true,
        customer: { id: 'cus_123', email: 'buyer@example.com' },
      });
      expect(registration.headers['set-cookie'][0]).toContain('lantern_customer_session=');
      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:4001/accounts/register',
        { email: 'buyer@example.com', password: 'long-password-123' },
        { timeout: 10_000 }
      );

      const session = await request(app)
        .get('/auth/customer/me')
        .set('Cookie', registration.headers['set-cookie'][0]);
      expect(session.status).toBe(200);
      expect(session.body.customer.id).toBe('cus_123');
    });

    it('forwards catalog requests to the server-owned catalog', async () => {
      axios.get.mockResolvedValueOnce({
        data: { products: [{ id: 'prod_1', priceMinor: '129900', currency: 'inr' }] },
      });

      const response = await request(app).get('/products');

      expect(response.status).toBe(200);
      expect(response.body.products[0].priceMinor).toBe('129900');
      expect(axios.get).toHaveBeenCalledWith('http://localhost:4001/catalog', { timeout: 5000 });
    });
  });

  // ── POST /order — validation ──────────────────────────────────────────────
  describe('POST /order — input validation', () => {
    it('requires an authenticated customer', async () => {
      const res = await request(app)
        .post('/order')
        .send({ items: [{ productId: 'item_1', quantity: 1 }] });
      expect(res.statusCode).toBe(401);
      expect(res.body.error).toMatch(/authentication/i);
    });

    it('returns 400 when items is empty', async () => {
      const cookie = await customerCookie();
      const res = await request(app)
        .post('/order')
        .set('Cookie', cookie)
        .send({ items: [] });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/items/i);
    });
  });

  // ── POST /order — happy path ──────────────────────────────────────────────
  describe('POST /order — happy path', () => {
    it('forwards only cart items and derives identity from the customer session', async () => {
      const cookie = await customerCookie();
      axios.post.mockResolvedValueOnce({
        data: { orderId: 'ord_123', status: 'confirmed' },
      });

      const res = await request(app)
        .post('/order')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'order-request-key-1234')
        .send({
          userId: 'attacker-user',
          amount: 0.01,
          items: [{ productId: 'prod_1', quantity: 2 }],
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.order).toMatchObject({ orderId: 'ord_123' });
      expect(axios.post).toHaveBeenLastCalledWith(
        'http://localhost:4001/process',
        { items: [{ productId: 'prod_1', quantity: 2 }] },
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-customer-id': 'cus_test_123' }),
          timeout: 15_000,
        })
      );
    });
  });

  // ── POST /order — upstream error ─────────────────────────────────────────
  describe('POST /order — upstream failure', () => {
    it('forwards the upstream error status and message', async () => {
      const cookie = await customerCookie();
      const upstreamError = new Error('Payment declined');
      upstreamError.response = { status: 402, data: { error: 'Card declined' } };
      axios.post.mockRejectedValueOnce(upstreamError);

      const res = await request(app)
        .post('/order')
        .set('Cookie', cookie)
        .send({ items: [{ productId: 'prod_1', quantity: 1 }] });

      expect(res.statusCode).toBe(402);
      expect(res.body.error).toBe('Card declined');
    });

    it('returns 500 when order-service is unreachable', async () => {
      const cookie = await customerCookie();
      axios.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const res = await request(app)
        .post('/order')
        .set('Cookie', cookie)
        .send({ items: [{ productId: 'prod_1', quantity: 1 }] });

      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBeTruthy();
    });
  });
});
