import { Component, useCallback, useEffect, useState } from 'react';
import PulseLine from './components/PulseLine';
import TraceRow from './components/TraceRow';
import Waterfall from './components/Waterfall';
import { checkSession, fetchTraces, fetchTraceDetail, login, logout } from './api';
import './App.css';

// ── Icons ─────────────────────────────────────────────────────────────────────
const SearchIcon  = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg>;
const RefreshIcon = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36"></path></svg>;
const ActivityIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>;
const AlertIcon   = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;

// ── Error Boundary ────────────────────────────────────────────────────────────
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[Lantern] Uncaught render error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="fatal-error">
          <AlertIcon />
          <h2>Something went wrong</h2>
          <p>{this.state.error?.message || 'An unexpected error occurred.'}</p>
          <button
            className="refresh-btn"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Loading skeleton ──────────────────────────────────────────────────────────
function LoadingSkeleton() {
  return (
    <div className="skeleton-list" aria-busy="true" aria-label="Loading traces">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="skeleton-row">
          <div className="skeleton-cell skeleton-cell--id" />
          <div className="skeleton-cell skeleton-cell--op" />
          <div className="skeleton-cell skeleton-cell--bar" />
          <div className="skeleton-cell skeleton-cell--dur" />
        </div>
      ))}
    </div>
  );
}

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(username, password);
      onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="brand-mark" />
        <h1>Sign in to Lantern</h1>
        <label>
          Username
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
        </label>
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="login-submit" type="submit" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
function AppContent() {
  const [authenticated, setAuthenticated] = useState(null);
  const [traces, setTraces]             = useState([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState(null);
  const [query, setQuery]               = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedSpans, setSelectedSpans] = useState(null);
  const [lastSync, setLastSync]         = useState(null);
  const [detailError, setDetailError]   = useState(null);

  const fetchTracesData = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchTraces({ limit: 50 });
      setTraces(data);
      setLastSync(new Date());
    } catch (err) {
      if (err.message === 'Authentication required') {
        setAuthenticated(false);
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkSession()
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    if (!authenticated) return undefined;
    const initialFetch = setTimeout(fetchTracesData, 0);
    const interval = setInterval(fetchTracesData, 5000);

    return () => {
      clearTimeout(initialFetch);
      clearInterval(interval);
    };
  }, [authenticated, fetchTracesData]);

  if (authenticated === null) return <LoadingSkeleton />;
  if (!authenticated) return <LoginScreen onLogin={() => setAuthenticated(true)} />;

  async function handleSelect(traceId) {
    setDetailError(null);
    try {
      const spans = await fetchTraceDetail(traceId);
      setSelectedSpans(spans);
    } catch (err) {
      setDetailError(err.message);
    }
  }

  const filtered = traces.filter((t) => {
     if (statusFilter === 'ok'    &&  t.has_error) return false;
     if (statusFilter === 'error' && !t.has_error) return false;
     if (query) {
       const q = query.toLowerCase();
       const inServices = (t.services || []).some(s => s.toLowerCase().includes(q));
       const inRoot = (t.root_span || '').toLowerCase().includes(q);
       const inId   = (t.trace_id  || '').toLowerCase().includes(q);
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

          <button className="refresh-btn" onClick={fetchTracesData} aria-label="Refresh traces">
            <RefreshIcon />
            {lastSync && <span>synced {lastSync.toLocaleTimeString()}</span>}
          </button>
          <button className="refresh-btn" onClick={async () => { await logout(); setAuthenticated(false); }}>
            Sign out
          </button>
        </div>

        {/* API-level error with retry */}
        {error && (
          <div className="banner banner--error" role="alert">
            <AlertIcon />
            <span>Could not reach the collector — {error}</span>
            <button className="banner__retry" onClick={fetchTracesData}>Retry</button>
          </div>
        )}

        {/* Trace detail error */}
        {detailError && (
          <div className="banner banner--error" role="alert">
            <AlertIcon />
            <span>Could not load trace detail — {detailError}</span>
            <button className="banner__retry" onClick={() => setDetailError(null)}>Dismiss</button>
          </div>
        )}

        {loading ? (
          <LoadingSkeleton />
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <ActivityIcon />
            <p className="empty-state__title">No traces match this view</p>
            <p className="empty-state__sub">
              {traces.length === 0
                ? 'Run node test-trace.js to send your first request through the pipeline.'
                : 'Try a different search term or clear the status filter.'}
            </p>
            {traces.length === 0 && (
              <button className="refresh-btn" onClick={fetchTracesData}>
                <RefreshIcon /> Check again
              </button>
            )}
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

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}