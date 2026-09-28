const crypto = require('crypto');
const request = require('supertest');

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};
const mockPool = {
  on: jest.fn(),
  query: jest.fn(),
  connect: jest.fn(() => mockClient),
  end: jest.fn(),
};

jest.mock('pg', () => ({ Pool: jest.fn(() => mockPool) }));
jest.mock('sdk', () => ({
  Tracer: jest.fn(() => ({ shutdown: jest.fn() })),
  middleware: jest.fn(() => (req, res, next) => {
    req.span = { traceId: 'trace-test', setTag: jest.fn(), log: jest.fn(), setError: jest.fn() };
    next();
  }),
}));

process.env.NODE_ENV = 'test';
process.env.PAYMENT_PROVIDER = 'simulated';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_unit_test';

const app = require('./index');

function signedHeader(payload, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto
    .createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.`)
    .update(payload)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

describe('Stripe webhook endpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes('INSERT INTO stripe_webhook_events')) return { rowCount: 1, rows: [{}] };
      if (sql.includes('UPDATE payments')) return { rowCount: 1, rows: [{ order_id: 'order-1' }] };
      return { rowCount: 1, rows: [] };
    });
  });

  it('confirms payment only for a verified completed session', async () => {
    const event = {
      id: 'evt_123',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_123',
          client_reference_id: 'user-1',
          metadata: { idempotency_key: 'order-request-key-1234' },
          amount_total: 1234,
          currency: 'usd',
          payment_status: 'paid',
        },
      },
    };
    const payload = Buffer.from(JSON.stringify(event));

    const response = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signedHeader(payload))
      .send(payload.toString('utf8'));

    expect(response.status).toBe(200);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE payments'),
      ['paid', 'cs_test_123', 'user-1', 'order-request-key-1234', 12.34, 'usd']
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE orders SET status'),
      ['confirmed', 'user-1', 'order-request-key-1234']
    );
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('rejects a webhook with an invalid signature before database work', async () => {
    const response = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=1,v1=invalid')
      .send(Buffer.from('{}'));

    expect(response.status).toBe(400);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });
});

describe('production payment disablement', () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER,
    COLLECTOR_API_KEY: process.env.COLLECTOR_API_KEY,
  };

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_PROVIDER = 'disabled';
    process.env.COLLECTOR_API_KEY = 'test-collector-key';
    jest.clearAllMocks();
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('rejects charges and webhooks without touching the database', async () => {
    let productionApp;
    jest.isolateModules(() => {
      productionApp = require('./index');
    });

    const charge = await request(productionApp)
      .post('/charge')
      .send({ userId: 'user-1', amount: 10 });
    const webhook = await request(productionApp)
      .post('/webhooks/stripe')
      .send('{}');

    expect(charge.status).toBe(503);
    expect(charge.body.error).toBe('Payments are disabled');
    expect(webhook.status).toBe(404);
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('refuses to start in production if payments are enabled', () => {
    process.env.PAYMENT_PROVIDER = 'stripe';
    expect(() => {
      jest.isolateModules(() => require('./index'));
    }).toThrow('payments must remain disabled in production');
  });
});
