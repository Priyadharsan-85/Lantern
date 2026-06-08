const { v4: uuidv4 } = require('uuid');
 
class Span {
  constructor({ name, traceId, parentSpanId = null, serviceName, tags = {} }) {
    this.spanId      = uuidv4();
    this.traceId     = traceId || uuidv4();  // new trace if no parent
    this.parentSpanId = parentSpanId;
    this.name        = name;
    this.serviceName = serviceName;
    this.tags        = tags;        // custom key-value metadata
    this.logs        = [];          // timestamped log lines attached to this span
    this.status      = 'ok';        // ok | error
    this.startTime   = Date.now();
    this.endTime     = null;
    this.duration    = null;
  }
 
  // attach arbitrary metadata: span.setTag('http.status', 200)
  setTag(key, value) {
    this.tags[key] = value;
    return this;
  }
 
  // attach a log line with a timestamp to this span
  log(message, level = 'info') {
    this.logs.push({ timestamp: Date.now(), message, level });
    return this;
  }
 
  // mark span as failed and record the error message
  setError(err) {
    this.status = 'error';
    this.setTag('error.message', err.message || String(err));
    this.setTag('error.stack', err.stack || '');
    return this;
  }
 
  // stop the clock
  finish() {
    this.endTime  = Date.now();
    this.duration = this.endTime - this.startTime;
    return this;
  }
 
  // serialize to plain object for sending to collector
  toJSON() {
    return {
      spanId:       this.spanId,
      traceId:      this.traceId,
      parentSpanId: this.parentSpanId,
      name:         this.name,
      serviceName:  this.serviceName,
      status:       this.status,
      tags:         this.tags,
      logs:         this.logs,
      startTime:    this.startTime,
      endTime:      this.endTime,
      duration:     this.duration,
    };
  }
}
 
module.exports = Span;