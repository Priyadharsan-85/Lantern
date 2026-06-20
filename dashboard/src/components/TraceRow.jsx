import { ArrowUpRight } from 'lucide-react';

export default function TraceRow({ trace, maxDuration, onSelect }) {
  const duration = Number(trace.total_duration) || 0;
  const widthPct = Math.max(4, Math.min(100, (duration / maxDuration) * 100));
  const isError  = trace.has_error;
  const services = Array.isArray(trace.services) ? trace.services : [];

  const timeAgo = formatTimeAgo(Number(trace.start_time));

  return (
    <button className="trace-row" onClick={() => onSelect(trace.trace_id)}>
      <div className="trace-row__id">
        <span className="trace-row__mono">{trace.trace_id?.slice(0, 8)}</span>
        <span className="trace-row__time">{timeAgo}</span>
      </div>

      <div className="trace-row__name">
        {trace.root_span || 'unnamed operation'}
        <div className="trace-row__services">
          {services.slice(0, 4).map((s, i) => (
            <span key={i} className="svc-chip">{s}</span>
          ))}
        </div>
      </div>

      <div className="trace-row__bar-track">
        <div
          className={`trace-row__bar ${isError ? 'is-error' : ''}`}
          style={{ width: `${widthPct}%` }}
        />
      </div>

      <div className="trace-row__meta">
        <span className={`trace-row__duration ${isError ? 'is-error' : ''}`}>
          {duration}ms
        </span>
        <span className="trace-row__spans">{trace.span_count} spans</span>
      </div>

      <ArrowUpRight size={14} className="trace-row__arrow" strokeWidth={2} />
    </button>
  );
}

function formatTimeAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}