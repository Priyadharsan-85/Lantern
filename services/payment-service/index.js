require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const express = require('express');
const crypto  = require('crypto');
const pino    = require('pino');
const helmet  = require('helmet');
const compression = require('compression');
const { Pool } = require('pg');
const { Tracer, middleware } = require('sdk');
const { createCheckoutSession, verifyWebhookSignature } = require('./stripe');

const isProd = process.env.NODE_ENV === 'production';
if (isProd && !process.env.COLLECTOR_API_KEY) {
  throw new Error('[payment-service] COLLECTOR_API_KEY is required in production');
}
const paymentProvider = process.env.PAYMENT_PROVIDER || (isProd ? 'disabled' : 'simulated');
if (!['disabled', 'simulated', 'stripe'].includes(paymentProvider)) {
  throw new Error('[payment-service] PAYMENT_PROVIDER must be "disabled", "stripe", or "simulated"');
}
if (isProd && paymentProvider !== 'disabled') {
  throw new Error('[payment-service] production payments remain disabled until live Stripe configuration, webhook routing, and security controls are explicitly enabled');
}
if (paymentProvider === 'stripe' && !/^sk_test_/.test(process.env.STRIPE_SECRET_KEY || '')) {
  throw new Error('[payment-service] only Stripe sandbox keys are supported until server-side product pricing and user identity are implemented');
}

const logger = pino(
  isProd
    ? { level: 'info' }
    : { level: 'debug', transport: { target: 'pino-pretty', options: { colorize: true } } }
);

// ── Database pool ──────────────────────────────────────────────────────────────
const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'lantern',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD,
  max: 10,
  idleTimeoutMillis:      30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => logger.error({ err }, '[payment-service] DB pool error'));

// ── Configurable failure rate for chaos testing ────────────────────────────────
// Set PAYMENT_FAILURE_RATE=0 in production. Use 0.1 for 10% failure in staging.
const FAILURE_RATE = Math.min(1, Math.max(0, Number(process.env.PAYMENT_FAILURE_RATE) || 0));

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());
app.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (paymentProvider === 'disabled') {
    return res.status(404).json({ error: 'Payments are disabled' });
  }
  const signature = req.headers['stripe-signature'];
  if (!verifyWebhookSignature(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: 'Invalid Stripe webhook signature' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }
  if (!event.id || !event.type || !event.data?.object) {
    return res.status(400).json({ error: 'Invalid Stripe event' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO stripe_webhook_events (event_id, event_type)
       VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [event.id, event.type]
    );
    if (inserted.rowCount === 0) {
      await client.query('COMMIT');
      return res.json({ received: true, duplicate: true });
    }

    const session = event.data.object;
    const userId = session.client_reference_id || session.metadata?.user_id;
    const idempotencyKey = session.metadata?.idempotency_key;
    let paymentStatus;
    let orderStatus;
    if (event.type === 'checkout.session.completed' && session.payment_status === 'paid') {
      paymentStatus = 'paid';
      orderStatus = 'confirmed';
    } else if (event.type === 'checkout.session.async_payment_succeeded') {
      paymentStatus = 'paid';
      orderStatus = 'confirmed';
    } else if (event.type === 'checkout.session.async_payment_failed' ||
               event.type === 'checkout.session.expired') {
      paymentStatus = 'failed';
      orderStatus = 'failed';
    }

    if (paymentStatus && userId && idempotencyKey) {
      const updated = await client.query(
        `UPDATE payments
         SET status = $1, provider_reference = $2
         WHERE user_id = $3 AND idempotency_key = $4
            AND amount = $5 AND currency = $6
            AND (status <> 'paid' OR $1 = 'paid')
         RETURNING order_id`,
         [paymentStatus, session.id, userId, idempotencyKey,
           Number(session.amount_total) / 100, session.currency?.toLowerCase()]
      );
      if (updated.rowCount === 0) {
        throw new Error('No payment record matches the Stripe Checkout Session');
      }
      await client.query(
        `UPDATE orders SET status = $1
         WHERE user_id = $2 AND idempotency_key = $3`,
        [orderStatus, userId, idempotencyKey]
      );
    }

    await client.query('COMMIT');
    res.json({ received: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, '[payment-service] Failed to process Stripe webhook');
    res.status(500).json({ error: 'Webhook processing failed' });
  } finally {
    client.release();
  }
});
app.use(express.json({ limit: '1mb' }));

const tracer = new Tracer({
  serviceName:  'payment-service',
  collectorUrl: process.env.COLLECTOR_URL || 'http://localhost:4000',
  onLog: (level, msg) => logger[level]?.(msg) ?? logger.info(msg),
});

app.use(middleware(tracer));

app.post('/charge', async (req, res) => {
  if (paymentProvider === 'disabled') {
    return res.status(503).json({ error: 'Payments are disabled' });
  }
  const { span } = req;
  const idempotencyKey = req.headers['idempotency-key'];
  const { amount: suppliedAmount, amountMinor: suppliedAmountMinor, userId, lineItems } = req.body || {};
  const amountMinor = Number.isSafeInteger(suppliedAmountMinor)
    ? suppliedAmountMinor
    : Number.isFinite(suppliedAmount)
      ? Math.round(suppliedAmount * 100)
      : NaN;
  const amount = amountMinor / 100;

  // ── Input validation ───────────────────────────────────────────────────────
  if (!userId) {
    span.setTag('validation.error', 'missing userId');
    return res.status(400).json({ error: 'userId is required' });
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) {
    span.setTag('validation.error', 'invalid amount');
    return res.status(400).json({ error: 'amountMinor must be a positive safe integer' });
  }
  if (paymentProvider === 'stripe' && lineItems !== undefined &&
      (!Array.isArray(lineItems) || lineItems.length < 1 || lineItems.length > 20 ||
       lineItems.some((item) =>
         !item || typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 250 ||
         !Number.isSafeInteger(item.unitAmountMinor) || item.unitAmountMinor < 1 ||
         !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) ||
       lineItems.reduce((total, item) =>
         total + BigInt(item.unitAmountMinor) * BigInt(item.quantity), 0n) !== BigInt(amountMinor))) {
    return res.status(400).json({ error: 'Stripe line items must match the requested total' });
  }
  if (isProd && (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 255)) {
    return res.status(400).json({ error: 'Idempotency-Key header must be 16-255 characters' });
  }

  span.setTag('payment.amount', amount);
  span.setTag('payment.userId', userId);
  span.log('Initiating charge');

  let chargeId;
  try {
    chargeId = `pay_${crypto.randomUUID()}`;
    const currency = (process.env.PAYMENT_CURRENCY || 'usd').toLowerCase();
    const reservation = await pool.query(
      `INSERT INTO payments (charge_id, trace_id, user_id, amount, status, gateway, idempotency_key, currency)
       VALUES ($1, $2, $3, $4, 'pending', $6, $5, $7)
       ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING charge_id`,
      [chargeId, span.traceId, userId, amount, idempotencyKey || null, paymentProvider, currency]
    );
    if (reservation.rowCount === 0) {
      const existing = await pool.query(
        `SELECT charge_id, amount, status, checkout_url FROM payments
         WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, idempotencyKey]
      );
      if (!existing.rows[0]) {
        return res.status(409).json({ error: 'Payment reservation is changing; retry with the same Idempotency-Key' });
      }
      chargeId = existing.rows[0].charge_id;
      if (Number(existing.rows[0].amount) !== amount) {
        return res.status(409).json({ error: 'Idempotency-Key was already used with a different amount' });
      }
      if (existing.rows[0].status === 'paid') {
        return res.json({ chargeId: existing.rows[0].charge_id, amount: existing.rows[0].amount, status: 'paid', idempotentReplay: true });
      }
      if (existing.rows[0].status === 'failed' || existing.rows[0].status === 'declined') {
        return res.status(409).json({ error: 'This payment attempt failed; submit a new request with a new Idempotency-Key' });
      }
      if (existing.rows[0].checkout_url) {
        return res.json({
          paymentId: chargeId,
          status: 'pending',
          checkoutUrl: existing.rows[0].checkout_url,
          idempotentReplay: true,
        });
      }
    }

    // ── Payment provider call ──────────────────────────────────────────────────
    await tracer.trace('gateway.charge', async (gatewaySpan) => {
      gatewaySpan.setTag('gateway', paymentProvider);
      gatewaySpan.setTag('payment.amount', amount);
      gatewaySpan.setTag('payment.charge_id', chargeId);

      if (paymentProvider === 'simulated') {
        if (FAILURE_RATE > 0 && Math.random() < FAILURE_RATE) {
          throw new Error('Card declined by issuer');
        }
        await sleep(45);
        await pool.query(`UPDATE payments SET status = 'paid' WHERE charge_id = $1`, [chargeId]);
      } else {
        const session = await createCheckoutSession({
          secretKey: process.env.STRIPE_SECRET_KEY,
          amount,
          amountMinor,
          currency,
          productName: process.env.PAYMENT_PRODUCT_NAME || 'Lantern order',
          lineItems: lineItems?.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            unitAmountMinor: item.unitAmountMinor,
          })),
          userId,
          idempotencyKey,
          successUrl: process.env.STRIPE_SUCCESS_URL ||
            `${process.env.DASHBOARD_ORIGIN}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: process.env.STRIPE_CANCEL_URL ||
            `${process.env.DASHBOARD_ORIGIN}/?checkout=cancelled`,
        });
        await pool.query(
          `UPDATE payments
           SET provider_reference = $1, checkout_url = $2, currency = $3
           WHERE charge_id = $4`,
          [session.id, session.url, currency, chargeId]
        );
        gatewaySpan.setTag('payment.checkout_session', session.id);
        gatewaySpan.log('Checkout Session created');
        return;
      }
      gatewaySpan.log('Charge authorized');
    });

    if (paymentProvider === 'stripe') {
      const checkoutSession = await pool.query(
        'SELECT provider_reference, checkout_url FROM payments WHERE charge_id = $1',
        [chargeId]
      );
      return res.status(201).json({
        paymentId: chargeId,
        checkoutSessionId: checkoutSession.rows[0].provider_reference,
        checkoutUrl: checkoutSession.rows[0].checkout_url,
        amount,
        currency,
        status: 'pending',
      });
    }

    // ── Persist payment record ──────────────────────────────────────────────────
    span.log('Recording payment in database');
    await tracer.trace('db.insertPayment', async (dbSpan) => {
      dbSpan.setTag('db.table', 'payments');
      dbSpan.setTag('db.operation', 'insert');

      await pool.query(
        `UPDATE payments SET status = 'paid' WHERE charge_id = $1`,
        [chargeId]
      );
      dbSpan.log('Payment persisted');
    });

    span.log('Payment completed');
    res.json({ chargeId, amount, status: 'paid' });

  } catch (err) {
    span.setError(err);

    if (paymentProvider === 'stripe') {
      logger.error({ err }, '[payment-service] Stripe Checkout creation failed');
      return res.status(502).json({ error: 'Unable to start checkout; retry with the same Idempotency-Key' });
    }
    try {
      await pool.query(`UPDATE payments SET status = 'failed' WHERE charge_id = $1`, [chargeId]);
    } catch (dbErr) {
      logger.error({ err: dbErr }, '[payment-service] Failed to record failed payment');
    }
    res.status(402).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'payment-service' }));

if (require.main === module) {
  app.listen(4002, () => logger.info('[payment-service] listening on :4002'));

  const shutdown = async () => {
    logger.info('[payment-service] shutting down...');
    await tracer.shutdown();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
}

module.exports = app;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }