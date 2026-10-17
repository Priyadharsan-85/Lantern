const Span = require('./Span');

// stores the "currently active span" per async execution chain
// AsyncLocalStorage is Node.js built-in — no extra deps needed
const { AsyncLocalStorage } = require('async_hooks');
const asyncStorage = new AsyncLocalStorage();

// Default max queue size: 5000 spans. Override with SDK_MAX_QUEUE_SIZE env var.
const DEFAULT_MAX_QUEUE = 5000;

class Tracer {
  /**
   * @param {object} opts
   * @param {string}   opts.serviceName   - Name of this service (required)
   * @param {string}   opts.collectorUrl  - Collector base URL (required)
   * @param {number}   [opts.maxQueueSize]- Max in-memory span queue (default 5000)
   * @param {Function} [opts.onLog]       - Optional log callback (level, msg) => void
   */
  constructor({ serviceName, collectorUrl, maxQueueSize, onLog }) {
    if (!serviceName)  throw new Error('Tracer requires a serviceName');
    if (!collectorUrl) throw new Error('Tracer requires a collectorUrl');

    this.serviceName    = serviceName;
    this.collectorUrl   = collectorUrl;
    this.maxQueueSize   = maxQueueSize
      || Number(process.env.SDK_MAX_QUEUE_SIZE)
      || DEFAULT_MAX_QUEUE;
    this._onLog         = onLog || (() => {});  // silent by default
    this._queue         = [];
    this._flushInterval = null;
    this._droppedSpans  = 0;

    // auto-flush every 2 seconds
    this._startAutoFlush();
    this._onLog('info', `[Tracer] initialized for service="${serviceName}"`);
  }

  // ── start a new span ──────────────────────────────────────────────────────
  startSpan(name, tags = {}) {
    const parent = asyncStorage.getStore();

    const span = new Span({
      name,
      traceId:      parent ? parent.traceId : null,
      parentSpanId: parent ? parent.spanId  : null,
      serviceName:  this.serviceName,
      tags,
    });

    return span;
  }

  // ── run a function with span as the active context ─────────────────────────
  withSpan(span, fn) {
    return asyncStorage.run(span, fn);
  }

  // ── convenience: wrap an async fn in a span automatically ─────────────────
  async trace(name, fn, tags = {}) {
    const span = this.startSpan(name, tags);
    try {
      const result = await asyncStorage.run(span, () => fn(span));
      span.finish();
      this._enqueue(span);
      return result;
    } catch (err) {
      span.setError(err).finish();
      this._enqueue(span);
      throw err;
    }
  }

  // ── extract trace context from incoming HTTP headers ───────────────────────
  extractContext(headers) {
    return {
      traceId:      headers['x-trace-id']       || null,
      parentSpanId: headers['x-parent-span-id'] || null,
    };
  }

  // ── inject trace context into outgoing HTTP headers ───────────────────────
  injectContext(span, headers = {}) {
    const extra = {};
    if (process.env.COLLECTOR_API_KEY) {
      extra['x-api-key'] = process.env.COLLECTOR_API_KEY;
    }
    return {
      ...headers,
      ...extra,
      'x-trace-id':       span.traceId,
      'x-parent-span-id': span.spanId,
    };
  }

  // ── start a span from incoming request headers ─────────────────────────────
  startSpanFromRequest(name, headers, tags = {}) {
    const { traceId, parentSpanId } = this.extractContext(headers);
    return new Span({
      name,
      traceId,
      parentSpanId,
      serviceName: this.serviceName,
      tags,
    });
  }

  // ── queue span for batched sending ────────────────────────────────────────
  _enqueue(span) {
    if (this._queue.length >= this.maxQueueSize) {
      // Drop oldest span to make room — prevents unbounded memory growth
      this._queue.shift();
      this._droppedSpans++;
      if (this._droppedSpans % 100 === 1) {
        this._onLog(
          'warn',
          `[Tracer] span queue full (max=${this.maxQueueSize}). ` +
          `${this._droppedSpans} spans dropped. Is the collector reachable?`
        );
      }
    }
    this._queue.push(span.toJSON());
  }

  // ── flush queue to collector ──────────────────────────────────────────────
  async flush() {
    if (this._queue.length === 0) return;

    const batch = this._queue.splice(0);  // drain queue atomically
    try {
      const axios = require('axios');
      const headers = { 'Content-Type': 'application/json' };
      if (process.env.COLLECTOR_API_KEY) {
        headers['x-api-key'] = process.env.COLLECTOR_API_KEY;
      }
      await axios.post(`${this.collectorUrl}/spans`, { spans: batch }, {
        timeout: 5000,
        headers,
      });
      this._onLog('debug', `[Tracer] flushed ${batch.length} spans`);
    } catch (err) {
      // Put spans back so we don't lose them on a transient failure.
      // If this would exceed the max, the oldest are dropped on next _enqueue.
      this._queue.unshift(...batch);
      this._onLog('warn', `[Tracer] flush failed: ${err.message}`);
    }
  }

  _startAutoFlush() {
    this._flushInterval = setInterval(() => this.flush(), 2000);
    // don't keep the process alive just for flushing
    if (this._flushInterval.unref) this._flushInterval.unref();
  }

  shutdown() {
    clearInterval(this._flushInterval);
    return this.flush();  // final flush on graceful shutdown
  }
}

module.exports = Tracer;