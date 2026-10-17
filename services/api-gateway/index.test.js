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
const mockRedis = {
  on: jest.fn(),
  set: jest.fn().mockResolvedValue('OK'),
  exists: jest.fn().mockResolvedValue(1),
  del: jest.fn().mockResolvedValue(1),
  sadd: jest.fn().mockResolvedValue(1),
  srem: jest.fn().mockResolvedValue(1),
  smembers: jest.fn().mockResolvedValue([]),
  expire: jest.fn().mockResolvedValue(1),
  eval: jest.fn().mockResolvedValue(1),
  quit: jest.fn().mockResolvedValue('OK'),
};
jest.mock('ioredis', () => jest.fn(() => mockRedis));
const app     = require('./index');

async function customerCookie(email = 'buyer@example.com') {
  axios.post.mockResolvedValueOnce({
    data: { customer: { id: 'cus_test_123', email } },
  });
  const response = await request(app)
    .post('/auth/customer/login')
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
    it('registers a customer and requires email verification before creating a session', async () => {
      axios.post.mockResolvedValueOnce({
        status: 201,
        data: { verificationRequired: true, emailSent: true },
      });

      const registration = await request(app)
        .post('/auth/customer/register')
        .send({ email: 'buyer@example.com', password: 'long-password-123' });

      expect(registration.status).toBe(201);
      expect(registration.body).toEqual({
        verificationRequired: true,
        emailSent: true,
      });
      expect(registration.headers['set-cookie']).toBeUndefined();
      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:4001/accounts/register',
        { email: 'buyer@example.com', password: 'long-password-123' },
        { timeout: 30_000 }
      );
    });

    it('forwards email verification and account recovery actions to the order service', async () => {
      axios.post
        .mockResolvedValueOnce({ status: 200, data: { verified: true } })
        .mockResolvedValueOnce({ status: 202, data: { message: 'If the account needs verification, an email will be sent shortly.' } })
        .mockResolvedValueOnce({ status: 202, data: { message: 'If an account exists for that email, password reset instructions will be sent.' } })
        .mockResolvedValueOnce({ status: 200, data: { passwordReset: true, customerId: 'cus_test_123' } });
      mockRedis.smembers.mockResolvedValueOnce(['existing-session']);

      const verified = await request(app).post('/auth/customer/verify-email').send({ token: 'verify-token' });
      const resent = await request(app).post('/auth/customer/request-verification')
        .send({ email: 'buyer@example.com', password: 'long-password-123' });
      const requested = await request(app).post('/auth/customer/request-password-reset')
        .send({ email: 'buyer@example.com' });
      const reset = await request(app).post('/auth/customer/reset-password')
        .send({ token: 'reset-token', password: 'another-long-password-123' });

      expect(verified.status).toBe(200);
      expect(resent.status).toBe(202);
      expect(requested.status).toBe(202);
      expect(reset.status).toBe(200);
      expect(reset.body).toEqual({ passwordReset: true });
      expect(mockRedis.del).toHaveBeenCalledWith('session:existing-session');
      expect(mockRedis.del).toHaveBeenCalledWith('customer-sessions:cus_test_123');
      expect(axios.post).toHaveBeenNthCalledWith(
        1,
        'http://localhost:4001/accounts/verify-email',
        { token: 'verify-token' },
        { timeout: 10_000 }
      );
      expect(axios.post).toHaveBeenNthCalledWith(
        2,
        'http://localhost:4001/accounts/request-verification',
        { email: 'buyer@example.com', password: 'long-password-123' },
        { timeout: 30_000 }
      );
      expect(axios.post).toHaveBeenNthCalledWith(
        4,
        'http://localhost:4001/accounts/reset-password',
        { token: 'reset-token', password: 'another-long-password-123' },
        { timeout: 10_000 }
      );
    });

    it('does not create a customer session when sign-in is rejected for an unverified email', async () => {
      const error = new Error('Verify your email address before signing in');
      error.response = {
        status: 403,
        data: { error: error.message, code: 'EMAIL_NOT_VERIFIED' },
      };
      axios.post.mockRejectedValueOnce(error);
      const response = await request(app)
        .post('/auth/customer/login')
        .send({ email: 'buyer@example.com', password: 'long-password-123' });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('EMAIL_NOT_VERIFIED');
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('revokes a customer session at logout', async () => {
      const cookie = await customerCookie();
      mockRedis.exists.mockResolvedValueOnce(0);
      const logoutResponse = await request(app)
        .post('/auth/customer/logout')
        .set('Cookie', cookie);

      expect(logoutResponse.status).toBe(200);
      expect(mockRedis.del).toHaveBeenCalledWith(expect.stringMatching(/^session:/));
      const session = await request(app)
        .get('/auth/customer/me')
        .set('Cookie', cookie);
      expect(session.status).toBe(401);
    });

    it('limits repeated customer registration requests through Redis', async () => {
      mockRedis.eval.mockResolvedValueOnce(6);

      const response = await request(app)
        .post('/auth/customer/register')
        .send({ email: 'buyer@example.com', password: 'long-password-123' });

      expect(response.status).toBe(429);
      expect(response.headers['retry-after']).toBe('900');
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('fails closed when Redis cannot enforce registration limits', async () => {
      mockRedis.eval.mockRejectedValueOnce(new Error('Redis unavailable'));

      const response = await request(app)
        .post('/auth/customer/register')
        .send({ email: 'buyer@example.com', password: 'long-password-123' });

      expect(response.status).toBe(503);
      expect(axios.post).not.toHaveBeenCalled();
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

  describe('project management and scoped trace access', () => {
    it('lists account-owned projects through the signed internal API', async () => {
      const cookie = await customerCookie();
      axios.get.mockResolvedValueOnce({ data: { projects: [{ id: 'prj_owned', name: 'Owned' }] } });
      const response = await request(app).get('/projects').set('Cookie', cookie);
      expect(response.status).toBe(200);
      expect(response.body.projects[0].id).toBe('prj_owned');
      expect(axios.get).toHaveBeenCalledWith(
        'http://localhost:4001/projects',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-customer-id': 'cus_test_123',
            'x-customer-signature': expect.stringMatching(/^[a-f\d]{64}$/),
          }),
        })
      );
    });

    it('creates projects using the customer session, never exposing the server collector key', async () => {
      const cookie = await customerCookie();
      const projectResponse = {
        data: { project: { id: 'prj_new', name: 'New' }, ingestKey: 'lntr_one-time-secret' },
      };
      axios.post.mockResolvedValueOnce(projectResponse);
      const response = await request(app)
        .post('/projects')
        .set('Cookie', cookie)
        .send({ name: 'New' });

      expect(response.status).toBe(201);
      expect(response.body).toEqual(projectResponse.data);
      expect(response.body.ingestKey).toBe('lntr_one-time-secret');
      expect(response.body).not.toHaveProperty('COLLECTOR_API_KEY');
    });

    it('forwards public SDK ingestion using only the supplied project key', async () => {
      axios.post.mockResolvedValueOnce({ status: 200, data: { received: 1 } });
      const response = await request(app)
        .post('/spans')
        .set('x-api-key', 'lntr_project-secret')
        .send({ spans: [{ spanId: 's1' }] });
      expect(response.status).toBe(200);
      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:4000/spans',
        { spans: [{ spanId: 's1' }] },
        { headers: { 'x-api-key': 'lntr_project-secret' }, timeout: 10_000 }
      );
    });

    it('rejects public SDK ingestion without a project key', async () => {
      const response = await request(app).post('/spans').send({ spans: [{ spanId: 's1' }] });
      expect(response.status).toBe(401);
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('requires project selection for trace reads', async () => {
      const cookie = await customerCookie();
      const response = await request(app).get('/traces').set('Cookie', cookie);
      expect(response.status).toBe(400);
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('rejects trace reads without an authenticated customer session', async () => {
      const response = await request(app).get('/traces?projectId=prj_owned');
      expect(response.status).toBe(401);
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('verifies project ownership before forwarding a project-scoped trace query', async () => {
      const cookie = await customerCookie();
      axios.get
        .mockResolvedValueOnce({ data: { project: { id: 'prj_owned' } } })
        .mockResolvedValueOnce({ data: [{ trace_id: 'trace_1' }] });
      const response = await request(app)
        .get('/traces?projectId=prj_owned&limit=50')
        .set('Cookie', cookie);

      expect(response.status).toBe(200);
      expect(axios.get).toHaveBeenNthCalledWith(
        1,
        'http://localhost:4001/projects/prj_owned/access',
        expect.objectContaining({ headers: expect.objectContaining({ 'x-customer-id': 'cus_test_123' }) })
      );
      expect(axios.get).toHaveBeenNthCalledWith(
        2,
        'http://localhost:4000/traces?projectId=prj_owned&limit=50',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': process.env.COLLECTOR_API_KEY,
            'x-project-id': 'prj_owned',
          }),
        })
      );
    });

    it('rejects cross-account trace access without querying the collector', async () => {
      const cookie = await customerCookie();
      const notOwned = new Error('Project not found');
      notOwned.response = { status: 404, data: { error: 'Project not found' } };
      axios.get.mockRejectedValueOnce(notOwned);
      const response = await request(app)
        .get('/traces/secret-trace?projectId=prj_victim')
        .set('Cookie', cookie);
      expect(response.status).toBe(404);
      expect(axios.get).toHaveBeenCalledTimes(1);
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
          headers: expect.objectContaining({
            'x-customer-id': 'cus_test_123',
            'x-customer-timestamp': expect.stringMatching(/^\d{10}$/),
            'x-customer-signature': expect.stringMatching(/^[a-f\d]{64}$/),
          }),
          timeout: 15_000,
        })
      );
    });
  });

  describe('production origin protection', () => {
    const originalEnv = {
      NODE_ENV: process.env.NODE_ENV,
      COLLECTOR_API_KEY: process.env.COLLECTOR_API_KEY,
      DASHBOARD_AUTH_USER: process.env.DASHBOARD_AUTH_USER,
      DASHBOARD_AUTH_PASSWORD: process.env.DASHBOARD_AUTH_PASSWORD,
      SESSION_SECRET: process.env.SESSION_SECRET,
      CUSTOMER_IDENTITY_SECRET: process.env.CUSTOMER_IDENTITY_SECRET,
      DASHBOARD_ORIGIN: process.env.DASHBOARD_ORIGIN,
    };

    afterAll(() => {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('rejects cross-origin and origin-less production mutations', async () => {
      Object.assign(process.env, {
        NODE_ENV: 'production',
        COLLECTOR_API_KEY: 'test-collector-key',
        DASHBOARD_AUTH_USER: 'admin',
        DASHBOARD_AUTH_PASSWORD: 'test-dashboard-password',
        SESSION_SECRET: 'test-session-secret-that-is-long-enough',
        CUSTOMER_IDENTITY_SECRET: 'test-customer-identity-secret-32-bytes',
        DASHBOARD_ORIGIN: 'https://shop.example.test',
      });
      let productionApp;
      jest.isolateModules(() => {
        productionApp = require('./index');
      });

      const noOrigin = await request(productionApp)
        .post('/auth/customer/register')
        .send({ email: 'buyer@example.com', password: 'long-password-123' });
      const foreignOrigin = await request(productionApp)
        .post('/auth/customer/register')
        .set('Origin', 'https://attacker.example')
        .send({ email: 'buyer@example.com', password: 'long-password-123' });
      axios.post.mockResolvedValueOnce({ status: 200, data: { received: 1 } });
      const sdkIngest = await request(productionApp)
        .post('/spans')
        .set('x-api-key', 'lntr_project-key')
        .send({ spans: [{ spanId: 's1' }] });

      expect(noOrigin.status).toBe(403);
      expect(foreignOrigin.status).toBe(403);
      expect(sdkIngest.status).toBe(200);
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
