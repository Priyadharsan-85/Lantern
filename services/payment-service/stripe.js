const crypto = require('crypto');

const STRIPE_API = 'https://api.stripe.com/v1';
const REQUEST_TIMEOUT_MS = 10_000;
const SIGNATURE_TOLERANCE_SECONDS = 300;
const TWO_DECIMAL_CURRENCIES = new Set([
  'aud', 'cad', 'chf', 'dkk', 'eur', 'gbp', 'hkd', 'nzd', 'sek', 'sgd', 'usd',
]);

async function createCheckoutSession({
  secretKey,
  amount,
  currency,
  productName,
  userId,
  idempotencyKey,
  successUrl,
  cancelUrl,
}) {
  const normalizedCurrency = currency.toLowerCase();
  if (!TWO_DECIMAL_CURRENCIES.has(normalizedCurrency)) {
    throw new Error('Unsupported currency; configure a supported two-decimal Stripe currency');
  }
  const scaledAmount = amount * 100;
  const amountInMinorUnits = Math.round(scaledAmount);
  if (!Number.isSafeInteger(amountInMinorUnits) || amountInMinorUnits < 1 ||
      Math.abs(scaledAmount - amountInMinorUnits) > 1e-7) {
    throw new Error('Amount must be a positive value representable in the selected currency');
  }

  const params = new URLSearchParams({
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: userId,
    'line_items[0][price_data][currency]': normalizedCurrency,
    'line_items[0][price_data][unit_amount]': String(amountInMinorUnits),
    'line_items[0][price_data][product_data][name]': productName,
    'line_items[0][quantity]': '1',
    'metadata[user_id]': userId,
    'metadata[idempotency_key]': idempotencyKey,
    'payment_intent_data[metadata][user_id]': userId,
    'payment_intent_data[metadata][idempotency_key]': idempotencyKey,
  });
  const stripeIdempotencyKey = crypto
    .createHash('sha256')
    .update(`${userId}:${idempotencyKey}`)
    .digest('hex');

  const response = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': stripeIdempotencyKey,
    },
    body: params,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(`Stripe Checkout request failed with status ${response.status}`);
  }
  if (!result.id || !result.url) {
    throw new Error('Stripe returned an incomplete Checkout Session');
  }
  return { id: result.id, url: result.url };
}

function verifyWebhookSignature(payload, signatureHeader, secret, now = Date.now()) {
  if (!Buffer.isBuffer(payload) || !signatureHeader || !secret) return false;
  const parts = signatureHeader.split(',').map((part) => part.split('='));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts
    .filter(([key]) => key === 'v1')
    .map(([, signature]) => signature);
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;

  const timestampSeconds = Number(timestamp);
  if (Math.abs(Math.floor(now / 1000) - timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(payload)
    .digest();
  return signatures.some((signature) => {
    if (!/^[a-f\d]{64}$/i.test(signature)) return false;
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), expected);
  });
}

module.exports = { createCheckoutSession, verifyWebhookSignature };
