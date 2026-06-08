const Span = require('./Span');
 
// stores the "currently active span" per async execution chain
// AsyncLocalStorage is Node.js built-in — no extra deps needed
const { AsyncLocalStorage } = require('async_hooks');
const asyncStorage = new AsyncLocalStorage();
 
class Tracer {
  constructor({ serviceName, collectorUrl }) {
    if (!serviceName) throw new Error('Tracer requires a serviceName');
    if (!collectorUrl) throw new Error('Tracer requires a collectorUrl');
 
    this.serviceName  = serviceName;
    this.collectorUrl = collectorUrl;
    this._queue       = [];        // spans waiting to be flushed
    this._flushInterval = null;
 
    // auto-flush every 2 seconds so we don't hammer the collector
    this._startAutoFlush();
    console.log(`[Tracer] initialized for service="${serviceName}"`);
  }
 
  // ── start a new span ─────────────────────────────────────────────────────
  // if there's an active parent span in this async context, link to it
  startSpan(name, tags = {}) {
    const parent = asyncStorage.getStore();   // active span in this context
 
    const span = new Span({
      name,
      traceId:      parent ? parent.traceId : null,   // inherit trace ID
      parentSpanId: parent ? parent.spanId  : null,   // link to parent
      serviceName:  this.serviceName,
      tags,
    });
 
    return span;
  }
 
  // ── run a function with span as the active context ────────────────────────
  // usage: tracer.withSpan(span, () => { /* child spans link here */ })
  withSpan(span, fn) {
    return asyncStorage.run(span, fn);
  }
 
  // ── convenience: wrap an async fn in a span automatically ────────────────
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
 
  // ── extract trace context from incoming HTTP headers ─────────────────────
  // call this at the top of each request handler
  extractContext(headers) {
    return {
      traceId:      headers['x-trace-id']       || null,
      parentSpanId: headers['x-parent-span-id'] || null,
    };
  }
 
  // ── inject trace context into outgoing HTTP headers ──────────────────────
  // call this before making a fetch/axios call to another service
  injectContext(span, headers = {}) {
    return {
      ...headers,
      'x-trace-id':       span.traceId,
      'x-parent-span-id': span.spanId,
    };
  }
 
  // ── start a span from incoming request headers ───────────────────────────
  // the main entry point for Express middleware
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
 
  // ── queue span for batched sending ───────────────────────────────────────
  _enqueue(span) {
    this._queue.push(span.toJSON());
  }
 
  // ── flush queue to collector ──────────────────────────────────────────────
  async flush() {
    if (this._queue.length === 0) return;
 
    const batch = this._queue.splice(0);  // drain queue atomically
    try {
      const axios = require('axios');
      await axios.post(`${this.collectorUrl}/spans`, { spans: batch }, {
        timeout: 3000,
        headers: { 'Content-Type': 'application/json' },
      });
      console.log(`[Tracer] flushed ${batch.length} spans`);
    } catch (err) {
      // put spans back so we don't lose them on a transient failure
      this._queue.unshift(...batch);
      console.error(`[Tracer] flush failed: ${err.message}`);
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