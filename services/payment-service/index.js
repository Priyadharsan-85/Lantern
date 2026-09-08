require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const express = require('express');
const pino    = require('pino');
const helmet  = require('helmet');
const compression = require('compression');
const { Pool } = require('pg');
const { Tracer, middleware } = require('sdk');

const isProd = process.env.NODE_ENV === 'production';
if (isProd && !process.env.COLLECTOR_API_KEY) {
  throw new Error('[payment-service] COLLECTOR_API_KEY is required in production');
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
app.use(express.json({ limit: '1mb' }));

const tracer = new Tracer({
  serviceName:  'payment-service',
  collectorUrl: process.env.COLLECTOR_URL || 'http://localhost:4000',
  onLog: (level, msg) => logger[level]?.(msg) ?? logger.info(msg),
});

app.use(middleware(tracer));

app.post('/charge', async (req, res) => {
  const { span } = req;
  const idempotencyKey = req.headers['idempotency-key'];
  const { amount, userId } = req.body || {};

  // ── Input validation ───────────────────────────────────────────────────────
  if (!userId) {
    span.setTag('validation.error', 'missing userId');
    return res.status(400).json({ error: 'userId is required' });
  }
  if (typeof amount !== 'number' || amount <= 0) {
    span.setTag('validation.error', 'invalid amount');
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (isProd && (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 255)) {
    return res.status(400).json({ error: 'Idempotency-Key header must be 16-255 characters' });
  }

  span.setTag('payment.amount', amount);
  span.setTag('payment.userId', userId);
  span.log('Initiating charge');

  let chargeId;
  try {
    chargeId = `ch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const reservation = await pool.query(
      `INSERT INTO payments (charge_id, trace_id, user_id, amount, status, gateway, idempotency_key)
       VALUES ($1, $2, $3, $4, 'pending', 'stripe', $5)
       ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING charge_id`,
      [chargeId, span.traceId, userId, amount, idempotencyKey || null]
    );
    if (reservation.rowCount === 0) {
      const existing = await pool.query(
        `SELECT charge_id, amount, status FROM payments
         WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, idempotencyKey]
      );
      if (existing.rows[0].status === 'paid') {
        if (Number(existing.rows[0].amount) !== amount) {
          return res.status(409).json({ error: 'Idempotency-Key was already used with a different amount' });
        }
        return res.json({ chargeId: existing.rows[0].charge_id, amount: existing.rows[0].amount, status: 'paid', idempotentReplay: true });
      }
      return res.status(409).json({ error: 'Payment with this Idempotency-Key is already in progress' });
    }

    // ── Simulated gateway call (replace with real Stripe SDK when ready) ───────
    await tracer.trace('gateway.charge', async (gatewaySpan) => {
      gatewaySpan.setTag('gateway', 'stripe');
      gatewaySpan.setTag('payment.amount', amount);
      gatewaySpan.setTag('payment.charge_id', chargeId);

      // Configurable failure — controlled by PAYMENT_FAILURE_RATE env var (default 0)
      // To integrate real Stripe: replace this block with the Stripe SDK call
      // e.g. const charge = await stripe.charges.create({ amount, currency: 'usd', ... })
      if (FAILURE_RATE > 0 && Math.random() < FAILURE_RATE) {
        throw new Error('Card declined by issuer');
      }

      // Simulate gateway network latency
      await sleep(45);
      gatewaySpan.log('Charge authorized');
    });

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

    // Still attempt to record failed payment for audit trail
    try {
      await pool.query(
        `UPDATE payments SET status = 'declined' WHERE charge_id = $1`,
        [chargeId]
      );
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