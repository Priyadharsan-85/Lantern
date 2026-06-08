const express = require('express');
const { Tracer, middleware } = require('../../packages/sdk');

const app = express();
app.use(express.json());

const tracer = new Tracer({
  serviceName:  'payment-service',
  collectorUrl: 'http://localhost:4000',
});

app.use(middleware(tracer));

app.post('/charge', async (req, res) => {
  const { span } = req;
  const { amount, userId } = req.body;

  try {
    span.setTag('payment.amount', amount);
    span.setTag('payment.userId', userId);
    span.log('Initiating charge');

    await tracer.trace('gateway.stripe.charge', async (gatewaySpan) => {
      gatewaySpan.setTag('gateway', 'stripe');
      gatewaySpan.setTag('payment.amount', amount);
      await sleep(45);

      if (Math.random() < 0.1) {
        throw new Error('Card declined by issuer');
      }

      gatewaySpan.log('Charge authorized');
    });

    span.log('Payment recorded in DB');
    await sleep(8);

    res.json({
      chargeId: `ch_${Date.now()}`,
      amount,
      status:   'paid',
    });

  } catch (err) {
    span.setError(err);
    res.status(402).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'payment-service' }));

app.listen(4002, () => console.log('[payment-service] listening on :4002'));
process.on('SIGTERM', async () => { await tracer.shutdown(); process.exit(0); });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }