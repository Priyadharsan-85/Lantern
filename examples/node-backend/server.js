const http = require('node:http');
const { URL } = require('node:url');
const { Tracer } = require('sdk');

const port = Number(process.env.PORT || 5050);
const collectorUrl = process.env.LANTERN_COLLECTOR_URL || 'http://localhost:3000';
const ingestKey = process.env.COLLECTOR_API_KEY;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
if (!ingestKey) {
  throw new Error('COLLECTOR_API_KEY must contain this Lantern project’s ingest key');
}

const tracer = new Tracer({
  serviceName: 'example-node-backend',
  collectorUrl,
  onLog: (level, message) => console[level === 'warn' ? 'warn' : 'log'](`[${level}] ${message}`),
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'example-node-backend' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/hello') {
    const name = (url.searchParams.get('name') || 'Lantern').slice(0, 80);
    try {
      const result = await tracer.trace('GET /api/hello', async (requestSpan) => {
        requestSpan.setTag('http.method', 'GET');
        requestSpan.setTag('http.route', '/api/hello');

        const message = await tracer.trace('greeting.compose', async (operationSpan) => {
          operationSpan.setTag('greeting.name', name);
          return `Hello, ${name}!`;
        });

        return { message, service: 'example-node-backend' };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('Request failed:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request failed' }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Example backend listening on http://127.0.0.1:${port}`);
  console.log(`Sending project traces to ${collectorUrl}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; flushing pending traces`);
  server.close(async () => {
    try {
      await tracer.shutdown();
      process.exitCode = 0;
    } catch (error) {
      console.error('Could not flush pending traces:', error.message);
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
