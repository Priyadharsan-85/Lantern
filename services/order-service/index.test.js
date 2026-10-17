const request = require('supertest');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const testPasswordHash = async (password) => {
  const salt = Buffer.alloc(16, 1);
  const hash = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
};

const mockPool = {
  on: jest.fn(),
  query: jest.fn(),
  connect: jest.fn(),
  end: jest.fn(),
};
const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

jest.mock('pg', () => ({ Pool: jest.fn(() => mockPool) }));
jest.mock('axios');
jest.mock('./email', () => ({
  sendAccountEmail: jest.fn().mockResolvedValue(),
  validateProductionEmailConfig: jest.fn(),
}));
const axios = require('axios');
const { sendAccountEmail } = require('./email');
jest.mock('sdk', () => ({
  Tracer: jest.fn(() => ({
    shutdown: jest.fn(),
    trace: jest.fn((name, callback) => callback({ setTag: jest.fn(), log: jest.fn() })),
    injectContext: jest.fn((span, headers) => headers),
  })),
  middleware: jest.fn(() => (req, res, next) => {
    req.span = {
      traceId: 'trace-test',
      setTag: jest.fn(),
      log: jest.fn(),
      setError: jest.fn(),
    };
    next();
  }),
}));

process.env.NODE_ENV = 'test';
process.env.CUSTOMER_IDENTITY_SECRET = 'test-customer-identity-secret-32-bytes';
const app = require('./index');

function signedIdentity(customerId, timestamp = String(Math.floor(Date.now() / 1000))) {
  const signature = require('crypto')
    .createHmac('sha256', process.env.CUSTOMER_IDENTITY_SECRET)
    .update(`${customerId}.${timestamp}`)
    .digest('hex');
  return {
    'x-customer-id': customerId,
    'x-customer-timestamp': timestamp,
    'x-customer-signature': signature,
  };
}

describe('customer accounts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPool.connect.mockResolvedValue(mockClient);
    mockClient.query.mockResolvedValue({ rowCount: 1, rows: [] });
  });

  it('stores a salted password hash and starts email verification', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const response = await request(app)
      .post('/accounts/register')
      .send({ email: 'Buyer@Example.com', password: 'long-password-123' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ verificationRequired: true, emailSent: true });
    expect(mockPool.query).toHaveBeenCalledWith(
      'INSERT INTO customers (customer_id, email, password_hash) VALUES ($1, $2, $3)',
      [
        expect.stringMatching(/^cus_/),
        'buyer@example.com',
        expect.stringMatching(/^scrypt\$16384\$8\$1\$/),
      ]
    );
    expect(mockPool.query.mock.calls[0][1][2]).not.toContain('long-password-123');
    expect(sendAccountEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'buyer@example.com',
      subject: expect.stringMatching(/verify/i),
    }));
    const token = new URL(sendAccountEmail.mock.calls[0][0].text.match(/https?:\S+/)[0])
      .searchParams.get('verifyEmail');
    expect(mockClient.query.mock.calls[2][1][0]).toBe(
      crypto.createHash('sha256').update(token).digest('hex')
    );
    expect(mockClient.query.mock.calls[2][1][0]).not.toBe(token);
  });

  it('rejects weak passwords without database access', async () => {
    const response = await request(app)
      .post('/accounts/register')
      .send({ email: 'buyer@example.com', password: 'short' });

    expect(response.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('authenticates with the stored password hash', async () => {
    mockPool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        customer_id: 'cus_verified',
        email: 'buyer@example.com',
        password_hash: await testPasswordHash('long-password-123'),
        email_verified_at: '2026-10-17T00:00:00Z',
      }],
    });

    const response = await request(app)
      .post('/accounts/login')
      .send({ email: 'BUYER@example.com', password: 'long-password-123' });

    expect(response.status).toBe(200);
    expect(response.body.customer).toEqual({ id: 'cus_verified', email: 'buyer@example.com' });
  });

  it('blocks sign-in until the email address is verified', async () => {
    mockPool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        customer_id: 'cus_pending',
        email: 'buyer@example.com',
        password_hash: await testPasswordHash('long-password-123'),
        email_verified_at: null,
      }],
    });
    const response = await request(app)
      .post('/accounts/login')
      .send({ email: 'buyer@example.com', password: 'long-password-123' });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('verifies email with a one-time, hashed token', async () => {
    const token = crypto.randomBytes(32).toString('base64url');
    mockClient.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ customer_id: 'cus_pending' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'cus_pending', email: 'buyer@example.com' }] });
    const response = await request(app).post('/accounts/verify-email').send({ token });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ verified: true });
    expect(mockClient.query.mock.calls[1][1][0]).toBe(
      crypto.createHash('sha256').update(token).digest('hex')
    );
    expect(mockClient.query.mock.calls[2][1]).toEqual(['cus_pending']);
    expect(mockClient.query.mock.calls[2][0]).toContain('COALESCE(email_verified_at, NOW())');
  });

  it('rejects expired or reused verification tokens', async () => {
    const token = crypto.randomBytes(32).toString('base64url');
    mockClient.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const response = await request(app).post('/accounts/verify-email').send({ token });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/invalid or expired/i);
    expect(mockClient.query).toHaveBeenCalledTimes(3);
    expect(mockClient.query.mock.calls[2][0]).toBe('COMMIT');
  });

  it('sends reset requests with an enumeration-safe response', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const response = await request(app)
      .post('/accounts/request-password-reset')
      .send({ email: 'unknown@example.com' });
    expect(response.status).toBe(202);
    expect(response.body.message).toMatch(/if an account exists/i);
    expect(sendAccountEmail).not.toHaveBeenCalled();
  });

  it('updates the password and consumes all outstanding reset tokens', async () => {
    const token = crypto.randomBytes(32).toString('base64url');
    mockClient.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ customer_id: 'cus_verified' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const response = await request(app)
      .post('/accounts/reset-password')
      .send({ token, password: 'a-new-long-password-123' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ passwordReset: true, customerId: 'cus_verified' });
    expect(mockClient.query.mock.calls[1][1][0]).toBe(
      crypto.createHash('sha256').update(token).digest('hex')
    );
    expect(mockClient.query.mock.calls[2][1][1]).toBe('cus_verified');
    expect(mockClient.query.mock.calls[2][1][0]).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(mockClient.query.mock.calls[3][1]).toEqual(['cus_verified']);
  });

  it('defines expiring one-time account tokens and email verification state in migration 007', () => {
    const migration = fs.readFileSync(
      path.resolve(__dirname, '../../infra/migrations/007_customer_email_security.sql'),
      'utf8'
    );
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ/i);
    expect(migration).toMatch(/purpose IN \('email_verification', 'password_reset'\)/i);
    expect(migration).toMatch(/expires_at TIMESTAMPTZ NOT NULL/i);
    expect(migration).toMatch(/consumed_at TIMESTAMPTZ/i);
  });
});

describe('product catalog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPool.connect.mockResolvedValue(mockClient);
  });

  it('returns only active server-managed products with INR minor-unit prices', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'prod_demo',
        name: 'Example product',
        description: 'Catalog fixture',
        priceMinor: '129900',
        currency: 'inr',
      }],
    });

    const response = await request(app).get('/catalog');

    expect(response.status).toBe(200);
    expect(response.body.products[0]).toMatchObject({
      id: 'prod_demo',
      priceMinor: '129900',
      currency: 'inr',
    });
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE active = TRUE'));
  });
});

describe('customer project ownership and ingest keys', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPool.connect.mockResolvedValue(mockClient);
  });

  it('rejects project listing without a signed account identity', async () => {
    const response = await request(app).get('/projects');
    expect(response.status).toBe(401);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('lists only projects owned by the signed-in customer', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'prj_owned', name: 'Owned', createdAt: '2026-10-17T00:00:00Z' }],
    });
    const response = await request(app)
      .get('/projects')
      .set(signedIdentity('cus_owner'));
    expect(response.status).toBe(200);
    expect(response.body.projects).toHaveLength(1);
    expect(mockPool.query.mock.calls[0][0]).toContain('WHERE customer_id = $1 AND active = TRUE');
    expect(mockPool.query.mock.calls[0][1]).toEqual(['cus_owner']);
  });

  it('returns not found when another customer requests project access', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const response = await request(app)
      .get('/projects/prj_victim/access')
      .set(signedIdentity('cus_attacker'));
    expect(response.status).toBe(404);
    expect(mockPool.query.mock.calls[0][1]).toEqual(['prj_victim', 'cus_attacker']);
  });

  it('creates projects with a one-time plaintext key and stores only its hash', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'prj_new', name: 'New project', createdAt: '2026-10-17T00:00:00Z' }],
    });
    const response = await request(app)
      .post('/projects')
      .set(signedIdentity('cus_owner'))
      .send({ name: ' New project ' });

    expect(response.status).toBe(201);
    expect(response.body.project.id).toBe('prj_new');
    expect(response.body.ingestKey).toMatch(/^lntr_[A-Za-z0-9_-]{43}$/);
    const storedHash = mockPool.query.mock.calls[0][1][3];
    expect(storedHash).toBe(require('crypto').createHash('sha256')
      .update(response.body.ingestKey).digest('hex'));
    expect(storedHash).not.toBe(response.body.ingestKey);
  });

  it('rotates a project key only for its owner and stores the replacement hash', async () => {
    mockPool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'prj_owned', name: 'Owned', createdAt: '2026-10-17T00:00:00Z' }],
    });
    const response = await request(app)
      .post('/projects/prj_owned/rotate-key')
      .set(signedIdentity('cus_owner'));

    expect(response.status).toBe(200);
    expect(response.body.ingestKey).toMatch(/^lntr_[A-Za-z0-9_-]{43}$/);
    expect(mockPool.query.mock.calls[0][0]).toContain('WHERE project_id = $2 AND customer_id = $3 AND active = TRUE');
    expect(mockPool.query.mock.calls[0][1]).toEqual([
      require('crypto').createHash('sha256').update(response.body.ingestKey).digest('hex'),
      'prj_owned',
      'cus_owner',
    ]);
  });
});

describe('server-priced orders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPool.connect.mockResolvedValue(mockClient);
    mockClient.query.mockResolvedValue({ rowCount: 1, rows: [{ status: 'pending' }] });
  });

  it('rejects unauthenticated internal order calls', async () => {
    const response = await request(app)
      .post('/process')
      .send({ userId: 'forged-customer', amount: 0.01, items: [] });

    expect(response.status).toBe(401);
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it.each([
    ['forged signature', (headers) => ({ ...headers, 'x-customer-signature': '0'.repeat(64) })],
    ['stale timestamp', (headers) => {
      const stale = signedIdentity('cus_verified_1', String(Math.floor(Date.now() / 1000) - 120));
      return { ...headers, ...stale };
    }],
  ])('rejects a %s identity claim', async (_description, tamper) => {
    const headers = tamper(signedIdentity('cus_verified_1'));
    const response = await request(app)
      .post('/process')
      .set(headers)
      .send({ items: [{ productId: 'prod_1', quantity: 1 }] });

    expect(response.status).toBe(401);
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('computes INR total from active catalog prices and authenticated customer identity', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          product_id: 'prod_1',
          name: 'Secure product',
          price_minor: '1299',
          currency: 'inr',
        }],
      });
    axios.post.mockResolvedValueOnce({
      data: { paymentId: 'pay_1', status: 'pending', checkoutUrl: 'https://checkout.test/session' },
    });

    const response = await request(app)
      .post('/process')
      .set(signedIdentity('cus_verified_1'))
      .set('Idempotency-Key', 'order-request-key-1234')
      .send({
        userId: 'forged-customer',
        amount: 0.01,
        items: [{ productId: 'prod_1', quantity: 2 }],
      });

    expect(response.status).toBe(200);
    expect(axios.post).toHaveBeenCalledWith(
      'http://localhost:4002/charge',
      {
        amountMinor: 2598,
        currency: 'inr',
        userId: 'cus_verified_1',
        lineItems: [{ name: 'Secure product', quantity: 2, unitAmountMinor: 1299 }],
      },
      expect.objectContaining({ timeout: 15_000 })
    );
    const insertCall = mockClient.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO orders'));
    expect(insertCall[1]).toEqual(expect.arrayContaining([
      'cus_verified_1',
      JSON.stringify([{
        productId: 'prod_1',
        name: 'Secure product',
        quantity: 2,
        unitPriceMinor: 1299,
        lineTotalMinor: 2598,
      }]),
      25.98,
    ]));
    expect(response.body.checkoutUrl).toBe('https://checkout.test/session');
  });

  it('does not charge for unavailable catalog products', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const response = await request(app)
      .post('/process')
      .set(signedIdentity('cus_verified_1'))
      .send({ items: [{ productId: 'inactive_product', quantity: 1 }] });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/unavailable/i);
    expect(axios.post).not.toHaveBeenCalled();
  });
});
