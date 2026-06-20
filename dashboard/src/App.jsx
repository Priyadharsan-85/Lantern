import { useEffect, useState, useCallback } from 'react';
import PulseLine from './components/PulseLine';
import TraceRow from './components/TraceRow';
import Waterfall from './components/Waterfall';
import { fetchTraces, fetchTraceDetail } from './api';
import './app.css';

const SearchIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg>;
const RefreshIcon = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36"></path></svg>;
const ActivityIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>;

export default function App() {
  const [traces, setTraces]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [query, setQuery]         = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedSpans, setSelectedSpans] = useState(null);
  const [lastSync, setLastSync]   = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchTraces();
      setTraces(data);
      setLastSync(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  async function handleSelect(traceId) {
    try {
      const spans = await fetchTraceDetail(traceId);
      setSelectedSpans(spans);
    } catch (err) {
      setError(err.message);
    }
  }

  const filtered = traces.filter((t) => {
    if (statusFilter === 'ok' && t.has_error) return false;
    if (statusFilter === 'error' && !t.has_error) return false;
    if (query) {
      const q = query.toLowerCase();
      const inServices = (t.services || []).some(s => s.toLowerCase().includes(q));
      const inRoot = (t.root_span || '').toLowerCase().includes(q);
      const inId = (t.trace_id || '').toLowerCase().includes(q);
      if (!inServices && !inRoot && !inId) return false;
    }
    return true;
  });

  const maxDuration = Math.max(...traces.map(t => Number(t.total_duration) || 0), 1);
  const errorCount  = traces.filter(t => t.has_error).length;
  const avgDuration = traces.length
    ? Math.round(traces.reduce((sum, t) => sum + (Number(t.total_duration) || 0), 0) / traces.length)
    : 0;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar__brand">
          <div className="brand-mark" />
          <span className="brand-name">lantern</span>
          <span className="brand-tag">trace explorer</span>
        </div>

        <div className="topbar__pulse">
          <PulseLine traces={traces} />
        </div>

        <div className="topbar__stats">
          <Stat label="traces" value={traces.length} />
          <Stat label="errors" value={errorCount} tone={errorCount > 0 ? 'error' : 'default'} />
          <Stat label="avg" value={`${avgDuration}ms`} />
        </div>
      </header>

      <main className="content">
        <div className="toolbar">
          <div className="search-field">
            <SearchIcon />
            <input
              placeholder="search by service, operation, or trace id"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="filter-group">
            {['all', 'ok', 'error'].map((f) => (
              <button
                key={f}
                className={`filter-btn ${statusFilter === f ? 'is-active' : ''}`}
                onClick={() => setStatusFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>

          <button className="refresh-btn" onClick={load}>
            <RefreshIcon />
            {lastSync && <span>synced {lastSync.toLocaleTimeString()}</span>}
          </button>
        </div>

        {error && (
          <div className="banner banner--error">
            Could not reach the collector at localhost:4000 — {error}
          </div>
        )}

        {loading ? (
          <div className="empty-state">
            <ActivityIcon />
            <p>Reading the signal...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <p className="empty-state__title">No traces match this view</p>
            <p className="empty-state__sub">
              {traces.length === 0
                ? 'Run node test-trace.js to send your first request through the pipeline.'
                : 'Try a different search term or clear the status filter.'}
            </p>
          </div>
        ) : (
          <div className="trace-list">
            <div className="trace-list__header">
              <span>trace</span>
              <span>operation</span>
              <span>timeline</span>
              <span>duration</span>
              <span />
            </div>
            {filtered.map((t) => (
              <TraceRow
                key={t.trace_id}
                trace={t}
                maxDuration={maxDuration}
                onSelect={handleSelect}
              />
            ))}
          </div>
        )}
      </main>

      {selectedSpans && (
        <Waterfall spans={selectedSpans} onClose={() => setSelectedSpans(null)} />
      )}
    </div>
  );
}

function Stat({ label, value, tone = 'default' }) {
  return (
    <div className="stat">
      <span className={`stat__value ${tone === 'error' && value > 0 ? 'is-error' : ''}`}>{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}