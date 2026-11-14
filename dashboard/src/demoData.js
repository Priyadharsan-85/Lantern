const now = Date.now();

const traceDefinitions = [
  {
    traceId: 'demo-trace-payment-timeout',
    ageMs: 42_000,
    duration: 742,
    hasError: true,
    rootSpan: 'POST /api/checkout',
    services: ['storefront-api', 'inventory-service', 'payment-service'],
    spans: [
      { id: 'demo-payment-root', name: 'POST /api/checkout', service: 'storefront-api', offset: 0, duration: 742, parent: null, status: 'error', tags: { 'http.method': 'POST', 'http.route': '/api/checkout', 'http.status_code': 502 } },
      { id: 'demo-payment-validate', name: 'validate cart', service: 'storefront-api', offset: 8, duration: 18, parent: 'demo-payment-root', status: 'ok', tags: { 'cart.item_count': 2 } },
      { id: 'demo-payment-stock', name: 'check inventory', service: 'inventory-service', offset: 39, duration: 74, parent: 'demo-payment-root', status: 'ok', tags: { 'inventory.available': true } },
      { id: 'demo-payment-authorize', name: 'authorize payment', service: 'payment-service', offset: 132, duration: 602, parent: 'demo-payment-root', status: 'error', tags: { 'error.type': 'GatewayTimeout', 'retry.count': 1 } },
    ],
  },
  {
    traceId: 'demo-trace-checkout-success',
    ageMs: 178_000,
    duration: 184,
    hasError: false,
    rootSpan: 'POST /api/checkout',
    services: ['storefront-api', 'inventory-service', 'payment-service'],
    spans: [
      { id: 'demo-checkout-root', name: 'POST /api/checkout', service: 'storefront-api', offset: 0, duration: 184, parent: null, status: 'ok', tags: { 'http.method': 'POST', 'http.route': '/api/checkout', 'http.status_code': 201 } },
      { id: 'demo-checkout-stock', name: 'reserve inventory', service: 'inventory-service', offset: 17, duration: 42, parent: 'demo-checkout-root', status: 'ok', tags: { 'inventory.reserved': true } },
      { id: 'demo-checkout-payment', name: 'authorize payment', service: 'payment-service', offset: 73, duration: 91, parent: 'demo-checkout-root', status: 'ok', tags: { 'payment.provider': 'demo-gateway' } },
    ],
  },
  {
    traceId: 'demo-trace-catalog',
    ageMs: 392_000,
    duration: 68,
    hasError: false,
    rootSpan: 'GET /api/products',
    services: ['storefront-api', 'catalog-service'],
    spans: [
      { id: 'demo-catalog-root', name: 'GET /api/products', service: 'storefront-api', offset: 0, duration: 68, parent: null, status: 'ok', tags: { 'http.method': 'GET', 'http.route': '/api/products', 'http.status_code': 200 } },
      { id: 'demo-catalog-query', name: 'query product catalog', service: 'catalog-service', offset: 9, duration: 45, parent: 'demo-catalog-root', status: 'ok', tags: { 'db.system': 'sqlite', 'db.operation': 'select' } },
    ],
  },
  {
    traceId: 'demo-trace-order-read',
    ageMs: 611_000,
    duration: 112,
    hasError: false,
    rootSpan: 'GET /api/orders/:orderId',
    services: ['storefront-api', 'order-service'],
    spans: [
      { id: 'demo-order-root', name: 'GET /api/orders/:orderId', service: 'storefront-api', offset: 0, duration: 112, parent: null, status: 'ok', tags: { 'http.method': 'GET', 'http.route': '/api/orders/:orderId', 'http.status_code': 200 } },
      { id: 'demo-order-fetch', name: 'fetch order', service: 'order-service', offset: 12, duration: 76, parent: 'demo-order-root', status: 'ok', tags: { 'db.system': 'postgresql', 'db.operation': 'select' } },
    ],
  },
];

export const DEMO_TRACES = traceDefinitions.map((trace) => ({
  trace_id: trace.traceId,
  start_time: now - trace.ageMs,
  total_duration: trace.duration,
  span_count: trace.spans.length,
  has_error: trace.hasError,
  root_span: trace.rootSpan,
  services: trace.services,
}));

export const DEMO_SPANS = Object.fromEntries(
  traceDefinitions.map((trace) => {
    const traceStart = now - trace.ageMs;
    return [
      trace.traceId,
      trace.spans.map((span) => ({
        span_id: span.id,
        trace_id: trace.traceId,
        parent_span_id: span.parent,
        name: span.name,
        service_name: span.service,
        status: span.status,
        start_time: traceStart + span.offset,
        duration: span.duration,
        end_time: traceStart + span.offset + span.duration,
        tags: span.tags,
        logs: [],
      })),
    ];
  })
);
