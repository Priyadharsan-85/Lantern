const express = require('express');
const axios   = require('axios');
const { Tracer, middleware } = require('../../packages/sdk');

const app = express();
app.use(express.json());

const tracer = new Tracer({
  serviceName:  'api-gateway',
  collectorUrl: 'http://localhost:4000',
});

app.use(middleware(tracer));

app.post('/order', async (req, res) => {
  const { span } = req;

  try {
    span.log('Received order request');
    span.setTag('user.id', req.body.userId || 'anonymous');

    const orderRes = await axios.post(
      'http://localhost:4001/process',
      req.body,
      { headers: tracer.injectContext(span) }
    );

    span.log('Order processed successfully');
    res.json({ success: true, order: orderRes.data });

  } catch (err) {
    span.setError(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'api-gateway' }));

app.listen(3000, () => console.log('[api-gateway] listening on :3000'));
process.on('SIGTERM', async () => { await tracer.shutdown(); process.exit(0); });