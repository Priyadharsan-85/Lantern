const request = require('supertest');

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
const axios = require('axios');
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
  });

  it('stores a salted password hash and returns only the customer profile', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const response = await request(app)
      .post('/accounts/register')
      .send({ email: 'Buyer@Example.com', password: 'long-password-123' });

    expect(response.status).toBe(201);
    expect(response.body.customer.email).toBe('buyer@example.com');
    expect(mockPool.query).toHaveBeenCalledWith(
      'INSERT INTO customers (customer_id, email, password_hash) VALUES ($1, $2, $3)',
      [
        expect.stringMatching(/^cus_/),
        'buyer@example.com',
        expect.stringMatching(/^scrypt\$16384\$8\$1\$/),
      ]
    );
    expect(mockPool.query.mock.calls[0][1][2]).not.toContain('long-password-123');
  });

  it('rejects weak passwords without database access', async () => {
    const response = await request(app)
      .post('/accounts/register')
      .send({ email: 'buyer@example.com', password: 'short' });

    expect(response.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('authenticates with the stored password hash', async () => {
    const registration = await request(app)
      .post('/accounts/register')
      .send({ email: 'buyer@example.com', password: 'long-password-123' });
    const storedHash = mockPool.query.mock.calls[0][1][2];
    mockPool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        customer_id: registration.body.customer.id,
        email: registration.body.customer.email,
        password_hash: storedHash,
      }],
    });

    const response = await request(app)
      .post('/accounts/login')
      .send({ email: 'BUYER@example.com', password: 'long-password-123' });

    expect(response.status).toBe(200);
    expect(response.body.customer).toEqual(registration.body.customer);
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
