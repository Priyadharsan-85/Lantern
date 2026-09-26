const crypto = require('crypto');
const { createCheckoutSession, verifyWebhookSignature } = require('./stripe');

describe('Stripe Checkout integration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a hosted session with a stable idempotency key', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'cs_test_123', url: 'https://checkout.stripe.test/session' }),
    });

    const session = await createCheckoutSession({
      secretKey: 'sk_test_example',
      amount: 12.34,
      currency: 'usd',
      productName: 'Lantern order',
      userId: 'user-1',
      idempotencyKey: 'order-request-key-1234',
      successUrl: 'https://app.example.test/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://app.example.test/?checkout=cancelled',
    });

    expect(session).toEqual({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.test/session',
    });
    const [, options] = fetchMock.mock.calls[0];
    const body = new URLSearchParams(options.body);
    expect(body.get('line_items[0][price_data][unit_amount]')).toBe('1234');
    expect(body.get('metadata[idempotency_key]')).toBe('order-request-key-1234');
    expect(options.headers.Authorization).toBe('Bearer sk_test_example');
    expect(options.headers['Idempotency-Key']).toHaveLength(64);
  });

  it('rejects invalid amounts without contacting Stripe', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    await expect(createCheckoutSession({
      secretKey: 'sk_test_example',
      amount: 0,
      currency: 'usd',
      productName: 'Lantern order',
      userId: 'user-1',
      idempotencyKey: 'order-request-key-1234',
      successUrl: 'https://app.example.test/success',
      cancelUrl: 'https://app.example.test/cancel',
    })).rejects.toThrow('Amount must be a positive value');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates signed webhook payloads and rejects stale signatures', () => {
    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    const payload = Buffer.from(JSON.stringify({ id: 'evt_123' }));
    const secret = 'whsec_test_example';
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.`)
      .update(payload)
      .digest('hex');

    expect(verifyWebhookSignature(payload, `t=${timestamp},v1=${signature}`, secret, now)).toBe(true);
    expect(verifyWebhookSignature(payload, `t=${timestamp},v1=${'0'.repeat(64)}`, secret, now)).toBe(false);
    expect(verifyWebhookSignature(payload, `t=${timestamp - 301},v1=${signature}`, secret, now)).toBe(false);
  });
});
