const express = require('express');
const axios   = require('axios');
const { Tracer, middleware } = require('../../packages/sdk');

const app = express();
app.use(express.json());

const tracer = new Tracer({
  serviceName:  'order-service',
  collectorUrl: 'http://localhost:4000',
});

app.use(middleware(tracer));

app.post('/process', async (req, res) => {
  const { span } = req;

  try {
    span.log('Validating order items');
    span.setTag('order.items', JSON.stringify(req.body.items || []));

    await tracer.trace('db.fetchInventory', async (dbSpan) => {
      dbSpan.setTag('db.table', 'inventory');
      await sleep(20);
      dbSpan.log('Inventory check passed');
    });

    const paymentRes = await axios.post(
      'http://localhost:4002/charge',
      { amount: req.body.amount || 100, userId: req.body.userId },
      { headers: tracer.injectContext(span) }
    );

    span.log('Order saved to database');
    await sleep(10);

    res.json({
      orderId:  `ord_${Date.now()}`,
      payment:  paymentRes.data,
      status:   'confirmed',
    });

  } catch (err) {
    span.setError(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'order-service' }));

app.listen(4001, () => console.log('[order-service] listening on :4001'));
process.on('SIGTERM', async () => { await tracer.shutdown(); process.exit(0); });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }