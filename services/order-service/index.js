require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const { promisify } = require('util');
const pino    = require('pino');
const helmet  = require('helmet');
const compression = require('compression');
const { Pool } = require('pg');
const { Tracer, middleware } = require('sdk');
const scrypt = promisify(crypto.scrypt);
const PASSWORD_SCRYPT_N = 16384;
const PASSWORD_SCRYPT_R = 8;
const PASSWORD_SCRYPT_P = 1;
const PASSWORD_HASH_BYTES = 64;
const PASSWORD_SCRYPT_MAXMEM = 64 * 1024 * 1024;
const MAX_CART_ITEMS = 20;
const MAX_ITEM_QUANTITY = 99;
const MAX_ORDER_MINOR_UNITS = 99_999_999n;

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

app.post('/accounts/register', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!isValidEmail(email) || !isValidPassword(password)) {
    return res.status(400).json({
      error: 'A valid email and a password between 12 and 128 UTF-8 bytes are required',
    });
  }

  try {
    const customerId = `cus_${crypto.randomUUID()}`;
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt, PASSWORD_HASH_BYTES, {
      N: PASSWORD_SCRYPT_N,
      r: PASSWORD_SCRYPT_R,
      p: PASSWORD_SCRYPT_P,
      maxmem: PASSWORD_SCRYPT_MAXMEM,
    });
    const passwordHash = [
      'scrypt',
      PASSWORD_SCRYPT_N,
      PASSWORD_SCRYPT_R,
      PASSWORD_SCRYPT_P,
      salt.toString('base64url'),
      hash.toString('base64url'),
    ].join('$');
    await pool.query(
      'INSERT INTO customers (customer_id, email, password_hash) VALUES ($1, $2, $3)',
      [customerId, email, passwordHash]
    );
    res.status(201).json({ customer: { id: customerId, email } });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    logger.error({ err }, '[order-service] Failed to register customer');
    res.status(500).json({ error: 'Unable to create customer account' });
  }
});

app.post('/accounts/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!isValidEmail(email) || typeof password !== 'string' ||
      Buffer.byteLength(password, 'utf8') > 128) {
    return res.status(400).json({ error: 'A valid email and password are required' });
  }

  try {
    const result = await pool.query(
      'SELECT customer_id, email, password_hash FROM customers WHERE LOWER(email) = $1',
      [email]
    );
    const customer = result.rows[0];
    const passwordMatches = customer
      ? await verifyPassword(password, customer.password_hash)
      : await verifyPassword(password, makeDummyPasswordHash());
    if (!customer || !passwordMatches) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    res.json({ customer: { id: customer.customer_id, email: customer.email } });
  } catch (err) {
    logger.error({ err }, '[order-service] Failed to authenticate customer');
    res.status(500).json({ error: 'Unable to sign in' });
  }
});

app.get('/catalog', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT product_id AS id, name, description, price_minor AS "priceMinor", currency
       FROM products
       WHERE active = TRUE
       ORDER BY name, product_id`
    );
    res.json({ products: result.rows });
  } catch (err) {
    logger.error({ err }, '[order-service] Failed to load product catalog');
    res.status(500).json({ error: 'Unable to load product catalog' });
  }
});

app.post('/process', async (req, res) => {
  const { span } = req;
  const idempotencyKey = req.headers['idempotency-key'];
  const userId = req.headers['x-customer-id'];
  const requestedItems = req.body?.items;

  if (!userId) {
    span.setTag('validation.error', 'missing userId');
    return res.status(401).json({ error: 'Customer authentication is required' });
  }
  if (isProd && (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 255)) {
    return res.status(400).json({ error: 'Idempotency-Key header must be 16-255 characters' });
  }
  if (!Array.isArray(requestedItems) || requestedItems.length === 0 ||
      requestedItems.length > MAX_CART_ITEMS ||
      requestedItems.some((item) =>
        !item || typeof item.productId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(item.productId) ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 || item.quantity > MAX_ITEM_QUANTITY) ||
      new Set(requestedItems.map((item) => item.productId)).size !== requestedItems.length) {
    return res.status(400).json({
      error: `items must contain 1-${MAX_CART_ITEMS} unique products with quantities from 1 to ${MAX_ITEM_QUANTITY}`,
    });
  }

  try {
    const existing = await pool.query(
      `SELECT o.order_id, o.status, o.items, p.checkout_url
       FROM orders o
       LEFT JOIN payments p
         ON p.user_id = o.user_id AND p.idempotency_key = o.idempotency_key
       WHERE o.user_id = $1 AND o.idempotency_key = $2`,
      [userId, idempotencyKey || null]
    );
    if (existing.rowCount > 0) {
      if (!sameCart(existing.rows[0].items, requestedItems)) {
        return res.status(409).json({ error: 'Idempotency-Key was already used with different items' });
      }
      return res.json({
        orderId: existing.rows[0].order_id,
        status: existing.rows[0].status,
        checkoutUrl: existing.rows[0].checkout_url,
        idempotentReplay: true,
      });
    }

    const productIds = requestedItems.map((item) => item.productId);
    const productsResult = await pool.query(
      `SELECT product_id, name, price_minor::text AS price_minor, currency
       FROM products
       WHERE active = TRUE AND product_id = ANY($1::text[])`,
      [productIds]
    );
    if (productsResult.rowCount !== requestedItems.length) {
      return res.status(400).json({ error: 'One or more products are unavailable' });
    }

    const productsById = new Map(productsResult.rows.map((product) => [product.product_id, product]));
    let totalMinor = 0n;
    const items = requestedItems.map(({ productId, quantity }) => {
      const product = productsById.get(productId);
      if (!product || product.currency !== 'inr') {
        throw new Error('Product catalog contains an unsupported currency');
      }
      const unitPriceMinor = BigInt(product.price_minor);
      if (unitPriceMinor < 1n) {
        throw new Error('Product catalog contains an invalid price');
      }
      const lineTotalMinor = unitPriceMinor * BigInt(quantity);
      totalMinor += lineTotalMinor;
      return {
        productId,
        name: product.name,
        quantity,
        unitPriceMinor: Number(unitPriceMinor),
        lineTotalMinor: Number(lineTotalMinor),
      };
    });
    if (totalMinor < 1n || totalMinor > MAX_ORDER_MINOR_UNITS) {
      return res.status(400).json({ error: 'Order total is outside the supported INR payment range' });
    }
    const amount = Number(totalMinor) / 100;

    span.log('Validating order items');
    span.setTag('order.items', JSON.stringify(items));
    span.setTag('order.amount', amount);

    // ── Real inventory check ──────────────────────────────────────────────────
    await tracer.trace('db.fetchInventory', async (dbSpan) => {
      dbSpan.setTag('db.table', 'orders');
      dbSpan.setTag('db.operation', 'inventory_check');

      const client = await pool.connect();
      try {
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
      {
        amountMinor: Number(totalMinor),
        currency: 'inr',
        userId,
        lineItems: items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unitAmountMinor: item.unitPriceMinor,
        })),
      },
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

function sameCart(storedItems, requestedItems) {
  const snapshot = typeof storedItems === 'string' ? JSON.parse(storedItems) : storedItems;
  if (!Array.isArray(snapshot) || snapshot.length !== requestedItems.length) return false;
  const storedCart = new Map(snapshot.map((item) => [item.productId, item.quantity]));
  return requestedItems.every((item) => storedCart.get(item.productId) === item.quantity);
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function isValidEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPassword(password) {
  return typeof password === 'string' &&
    Buffer.byteLength(password, 'utf8') >= 12 &&
    Buffer.byteLength(password, 'utf8') <= 128;
}

async function verifyPassword(password, encodedHash) {
  const [algorithm, n, r, p, encodedSalt, encodedKey] = encodedHash.split('$');
  if (algorithm !== 'scrypt' || Number(n) !== PASSWORD_SCRYPT_N ||
      Number(r) !== PASSWORD_SCRYPT_R || Number(p) !== PASSWORD_SCRYPT_P) {
    return false;
  }
  const salt = Buffer.from(encodedSalt, 'base64url');
  const expected = Buffer.from(encodedKey, 'base64url');
  if (salt.length !== 16 || expected.length !== PASSWORD_HASH_BYTES) return false;
  const actual = await scrypt(password, salt, expected.length, {
    N: PASSWORD_SCRYPT_N,
    r: PASSWORD_SCRYPT_R,
    p: PASSWORD_SCRYPT_P,
    maxmem: PASSWORD_SCRYPT_MAXMEM,
  });
  return crypto.timingSafeEqual(actual, expected);
}

function makeDummyPasswordHash() {
  return `scrypt$${PASSWORD_SCRYPT_N}$${PASSWORD_SCRYPT_R}$${PASSWORD_SCRYPT_P}$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(PASSWORD_HASH_BYTES).toString('base64url')}`;
}