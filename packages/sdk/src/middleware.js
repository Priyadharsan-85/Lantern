function tracingMiddleware(tracer) {
  return function (req, res, next) {
    // create a span linked to any upstream trace via request headers
    const span = tracer.startSpanFromRequest(`${req.method} ${req.path}`, req.headers, {
      'http.method': req.method,
      'http.url':    req.originalUrl,
      'http.host':   req.hostname,
    });
 
    // attach span to req so route handlers can add tags/logs
    req.span = span;
 
    // make it the active context for all async work in this request
    tracer.withSpan(span, () => {
 
      // intercept response finish to record status + duration
      const originalEnd = res.end.bind(res);
      res.end = function (...args) {
        span.setTag('http.status_code', res.statusCode);
 
        if (res.statusCode >= 500) {
          span.setError(new Error(`HTTP ${res.statusCode}`));
        } else if (res.statusCode >= 400) {
          span.setTag('http.client_error', true);
        }
 
        span.finish();
        tracer._enqueue(span);
 
        return originalEnd(...args);
      };
 
      next();
    });
  };
}
 
module.exports = tracingMiddleware;
