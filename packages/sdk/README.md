# Lantern Node SDK

The SDK creates spans with trace IDs, parent-span relationships, timestamps,
status, tags, and logs. It maintains the active span across asynchronous Node.js
work with `AsyncLocalStorage`, then batches completed spans to the Lantern
collector.

```js
const { Tracer } = require('sdk');

const tracer = new Tracer({
  serviceName: 'orders-api',
  collectorUrl: process.env.LANTERN_COLLECTOR_URL,
});

await tracer.trace('GET /orders', async (requestSpan) => {
  requestSpan.setTag('http.method', 'GET');
  return tracer.trace('orders.lookup', async (operationSpan) => {
    operationSpan.setTag('db.system', 'postgres');
    return loadOrders();
  });
});

// Flush any spans still queued when shutting down.
await tracer.shutdown();
```

Set `COLLECTOR_API_KEY` in the server process to send a project ingest key in
the `x-api-key` header. The key must remain server-side. The SDK flushes
automatically every two seconds; `shutdown()` flushes any remaining spans.

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `COLLECTOR_API_KEY` | unset | Project ingest key used by `/spans` |
| `SDK_MAX_QUEUE_SIZE` | `5000` | In-memory completed-span queue bound |
| `SDK_MAX_BATCH_SIZE` | `1000` | Maximum spans sent in one HTTP request; capped at 1,000 |

For Lantern's Cloudflare Free tracing MVP, configure
`SDK_MAX_BATCH_SIZE=100`; larger batches are rejected. Set
`LANTERN_COLLECTOR_URL` to the Worker origin, not to the `/spans` path:

```powershell
$env:LANTERN_COLLECTOR_URL = "https://your-worker.workers.dev"
$env:SDK_MAX_BATCH_SIZE = "100"
```

Transient send failures are logged and the batch is re-queued in memory. The SDK
does not persist its queue across process restarts, so applications should treat
this as best-effort telemetry and avoid placing sensitive data in span tags or
logs.
