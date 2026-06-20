import { X, AlertTriangle, Clock } from 'lucide-react';

export default function Waterfall({ spans, onClose }) {
  if (!spans || spans.length === 0) return null;

  const starts = spans.map(s => Number(s.start_time));
  const ends   = spans.map(s => Number(s.start_time) + (Number(s.duration) || 0));
  const traceStart = Math.min(...starts);
  const traceEnd   = Math.max(...ends);
  const totalDur   = Math.max(traceEnd - traceStart, 1);

  const sorted = [...spans].sort((a, b) => Number(a.start_time) - Number(b.start_time));
  const depthMap = computeDepth(sorted);

  return (
    <div className="waterfall-overlay" onClick={onClose}>
      <div className="waterfall-panel" onClick={(e) => e.stopPropagation()}>
        <header className="waterfall-header">
          <div>
            <div className="waterfall-header__label">TRACE</div>
            <div className="waterfall-header__id">{spans[0].trace_id}</div>
          </div>
          <div className="waterfall-header__stats">
            <span><Clock size={13} /> {totalDur}ms total</span>
            <span>{spans.length} spans</span>
          </div>
          <button className="waterfall-close" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="waterfall-ruler">
          {[0, 0.25, 0.5, 0.75, 1].map((p) => (
            <span key={p} className="waterfall-ruler__tick" style={{ left: `${p * 100}%` }}>
              {Math.round(totalDur * p)}ms
            </span>
          ))}
        </div>

        <div className="waterfall-body">
          {sorted.map((span) => {
            const offset = ((Number(span.start_time) - traceStart) / totalDur) * 100;
            const width  = Math.max(0.6, (Number(span.duration) / totalDur) * 100);
            const isError = span.status === 'error';
            const depth = depthMap.get(span.span_id) || 0;

            return (
              <div key={span.span_id} className="span-row">
                <div className="span-row__label" style={{ paddingLeft: `${depth * 16}px` }}>
                  <span className={`span-row__dot ${isError ? 'is-error' : ''}`} />
                  <span className="span-row__service">{span.service_name}</span>
                  <span className="span-row__name">{span.name}</span>
                  {isError && <AlertTriangle size={11} className="span-row__warn" />}
                </div>
                <div className="span-row__track">
                  <div
                    className={`span-row__bar ${isError ? 'is-error' : ''}`}
                    style={{ left: `${offset}%`, width: `${width}%` }}
                    title={`${span.duration}ms`}
                  />
                  <span
                    className="span-row__bar-label"
                    style={{ left: `calc(${offset}% + ${width}% + 8px)` }}
                  >
                    {span.duration}ms
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function computeDepth(spans) {
  const byId = new Map(spans.map(s => [s.span_id, s]));
  const depth = new Map();

  function getDepth(span) {
    if (depth.has(span.span_id)) return depth.get(span.span_id);
    if (!span.parent_span_id || !byId.has(span.parent_span_id)) {
      depth.set(span.span_id, 0);
      return 0;
    }
    const d = getDepth(byId.get(span.parent_span_id)) + 1;
    depth.set(span.span_id, d);
    return d;
  }

  spans.forEach(getDepth);
  return depth;
}