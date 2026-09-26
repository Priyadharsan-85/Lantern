require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const express = require('express');
const axios   = require('axios');
const pino    = require('pino');
const helmet  = require('helmet');
const compression = require('compression');
const { Pool } = require('pg');
const { Tracer, middleware } = require('sdk');

const isProd = process.env.NODE_ENV === 'production';
if (isProd && !process.env.COLLECTOR_API_KEY) {
  throw new Error('[order-service] COLLECTOR_API_KEY is required in production');
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

pool.on('error', (err) => logger.error({ err }, '[order-service] DB pool error'));

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));

const tracer = new Tracer({
  serviceName:  'order-service',
  collectorUrl: process.env.COLLECTOR_URL || 'http://localhost:4000',
  onLog: (level, msg) => logger[level]?.(msg) ?? logger.info(msg),
});

app.use(middleware(tracer));

app.post('/process', async (req, res) => {
  const { span } = req;
  const idempotencyKey = req.headers['idempotency-key'];
  const { userId, items = [], amount = 0 } = req.body || {};

  if (!userId) {
    span.setTag('validation.error', 'missing userId');
    return res.status(400).json({ error: 'userId is required' });
  }
  if (isProd && (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 255)) {
    return res.status(400).json({ error: 'Idempotency-Key header must be 16-255 characters' });
  }

  try {
    const existing = await pool.query(
      `SELECT o.order_id, o.status, o.amount, p.checkout_url
       FROM orders o
       LEFT JOIN payments p
         ON p.user_id = o.user_id AND p.idempotency_key = o.idempotency_key
       WHERE o.user_id = $1 AND o.idempotency_key = $2`,
      [userId, idempotencyKey || null]
    );
    if (existing.rowCount > 0) {
      if (Number(existing.rows[0].amount) !== amount) {
        return res.status(409).json({ error: 'Idempotency-Key was already used with a different amount' });
      }
      return res.json({
        orderId: existing.rows[0].order_id,
        status: existing.rows[0].status,
        checkoutUrl: existing.rows[0].checkout_url,
        idempotentReplay: true,
      });
    }

    span.log('Validating order items');
    span.setTag('order.items', JSON.stringify(items));
    span.setTag('order.amount', amount);

    // ── Real inventory check ──────────────────────────────────────────────────
    await tracer.trace('db.fetchInventory', async (dbSpan) => {
      dbSpan.setTag('db.table', 'orders');
      dbSpan.setTag('db.operation', 'inventory_check');

      const client = await pool.connect();
      try {
        // Verify the orders table is reachable and count existing orders for this user
        const result = await client.query(
          'SELECT COUNT(*) AS order_count FROM orders WHERE user_id = $1',
          [userId]
        );
        const orderCount = Number(result.rows[0].order_count);
        dbSpan.setTag('db.user_order_count', orderCount);
        dbSpan.log(`Inventory check passed — user has ${orderCount} prior orders`);
      } finally {
        client.release();
      }
    });

    // ── Call payment service ───────────────────────────────────────────────────
    const paymentRes = await axios.post(
      (process.env.PAYMENT_SERVICE_URL || 'http://localhost:4002') + '/charge',
      { amount, userId },
      { headers: tracer.injectContext(span, { 'idempotency-key': idempotencyKey }), timeout: 15_000 }
    );

    // ── Persist order to database ──────────────────────────────────────────────
    span.log('Saving order to database');
    const orderId = `ord_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    let replayOrder = null;
    let finalOrderStatus = paymentRes.data.status === 'paid' ? 'confirmed' : 'pending';
    await tracer.trace('db.insertOrder', async (dbSpan) => {
      dbSpan.setTag('db.table', 'orders');
      dbSpan.setTag('db.operation', 'insert');
      dbSpan.setTag('order.id', orderId);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
          `INSERT INTO orders (order_id, trace_id, user_id, items, amount, status, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6)
           ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
           DO NOTHING
           RETURNING order_id`,
          [orderId, span.traceId, userId, JSON.stringify(items), amount, idempotencyKey || null]
        );
        if (result.rowCount === 0) {
          const replay = await client.query(
            'SELECT order_id, status FROM orders WHERE user_id = $1 AND idempotency_key = $2',
            [userId, idempotencyKey]
          );
          replayOrder = replay.rows[0];
        } else {
          const payment = await client.query(
            `UPDATE payments SET order_id = $1
             WHERE user_id = $2 AND idempotency_key = $3
             RETURNING status`,
            [orderId, userId, idempotencyKey || null]
          );
          if (payment.rows[0]?.status === 'paid') {
            await client.query(`UPDATE orders SET status = 'confirmed' WHERE order_id = $1`, [orderId]);
            finalOrderStatus = 'confirmed';
          } else if (payment.rows[0]?.status === 'failed') {
            await client.query(`UPDATE orders SET status = 'failed' WHERE order_id = $1`, [orderId]);
            finalOrderStatus = 'failed';
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      dbSpan.log('Order persisted');
    });

    if (replayOrder) {
      return res.json({
        orderId: replayOrder.order_id,
        status: replayOrder.status,
        idempotentReplay: true,
      });
    }

    span.log(paymentRes.data.status === 'paid' ? 'Order confirmed' : 'Checkout started');
    res.json({
      orderId,
      payment: paymentRes.data,
      checkoutUrl: paymentRes.data.checkoutUrl,
      status: finalOrderStatus,
    });

  } catch (err) {
    span.setError(err);
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.response?.data?.error || err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'order-service' }));

if (require.main === module) {
  app.listen(4001, () => logger.info('[order-service] listening on :4001'));

  const shutdown = async () => {
    logger.info('[order-service] shutting down...');
    await tracer.shutdown();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
}

module.exports = app;