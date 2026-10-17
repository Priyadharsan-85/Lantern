import { Component, useCallback, useEffect, useState } from 'react';
import PulseLine from './components/PulseLine';
import TraceRow from './components/TraceRow';
import Waterfall from './components/Waterfall';
import Shop from './Shop';
import {
  checkCustomerSession,
  createProject,
  fetchTraces,
  fetchTraceDetail,
  listProjects,
  loginCustomer,
  logoutCustomer,
  requestCustomerVerification,
  requestPasswordReset,
  registerCustomer,
  resetCustomerPassword,
  rotateProjectKey,
  verifyCustomerEmail,
} from './api';
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
  const searchParams = new URLSearchParams(window.location.search);
  const verificationToken = searchParams.get('verifyEmail') || '';
  const resetToken = searchParams.get('resetPassword') || '';
  const [mode, setMode] = useState(verificationToken ? 'verify' : resetToken ? 'reset' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!verificationToken) return;
    let active = true;
    verifyCustomerEmail(verificationToken)
      .then(() => {
        if (active) {
          setMode('login');
          setNotice('Email verified. You can now sign in.');
          window.history.replaceState({}, '', window.location.pathname);
        }
      })
      .catch((err) => {
        if (active) {
          setMode('login');
          setError(err.message);
          window.history.replaceState({}, '', window.location.pathname);
        }
      });
    return () => { active = false; };
  }, [verificationToken]);

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'register') {
        const result = await registerCustomer(email, password);
        setMode('login');
        setNotice(result.emailSent
          ? 'Account created. Check your email for a verification link before signing in.'
          : 'Account created, but the verification email could not be sent. Configure email delivery, then request a new link.');
      } else if (mode === 'resend') {
        const result = await requestCustomerVerification(email, password);
        setMode('login');
        setNotice(result.message);
      } else if (mode === 'forgot') {
        const result = await requestPasswordReset(email);
        setMode('login');
        setNotice(result.message);
      } else if (mode === 'reset') {
        await resetCustomerPassword(resetToken, password);
        setMode('login');
        setNotice('Password updated. Sign in with your new password.');
        window.history.replaceState({}, '', window.location.pathname);
      } else {
        await loginCustomer(email, password);
        onLogin();
      }
    } catch (err) {
      if (err.code === 'EMAIL_NOT_VERIFIED') setMode('resend');
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="brand-mark" />
        <h1>
          {mode === 'register' ? 'Create your Lantern account'
            : mode === 'forgot' ? 'Reset your password'
              : mode === 'reset' ? 'Choose a new password'
                : mode === 'resend' ? 'Verify your email'
                  : mode === 'verify' ? 'Verifying your email…'
                    : 'Sign in to Lantern'}
        </h1>
        {mode !== 'reset' && mode !== 'verify' && (
          <label>
            Email
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" maxLength={254} required />
          </label>
        )}
        {['register', 'login', 'resend', 'reset'].includes(mode) && (
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'register' || mode === 'reset' ? 12 : undefined} maxLength={128} required />
          </label>
        )}
        {notice && <p className="login-notice" role="status">{notice}</p>}
        {error && <p className="login-error" role="alert">{error}</p>}
        {mode !== 'verify' && (
          <button className="login-submit" type="submit" disabled={loading}>
            {loading ? 'Please wait…'
              : mode === 'register' ? 'Create account'
                : mode === 'forgot' ? 'Send reset link'
                  : mode === 'reset' ? 'Update password'
                    : mode === 'resend' ? 'Send verification link'
                      : 'Sign in'}
          </button>
        )}
        {mode === 'login' && (
          <button className="login-mode-toggle" type="button" onClick={() => { setMode('forgot'); setError(null); setNotice(null); }}>
            Forgot your password?
          </button>
        )}
        {['login', 'register'].includes(mode) && (
          <button
            className="login-mode-toggle"
            type="button"
            onClick={() => {
              setMode(mode === 'register' ? 'login' : 'register');
              setError(null);
              setNotice(null);
            }}
          >
            {mode === 'register' ? 'Already have an account? Sign in' : 'New to Lantern? Create an account'}
          </button>
        )}
        {['forgot', 'resend'].includes(mode) && (
          <button className="login-mode-toggle" type="button" onClick={() => { setMode('login'); setError(null); setNotice(null); }}>
            Back to sign in
          </button>
        )}
      </form>
    </main>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
function AppContent() {
  const [authenticated, setAuthenticated] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.has('verifyEmail') || params.has('resetPassword') ? false : null;
  });
  const [traces, setTraces]             = useState([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState(null);
  const [query, setQuery]               = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedSpans, setSelectedSpans] = useState(null);
  const [lastSync, setLastSync]         = useState(null);
  const [detailError, setDetailError]   = useState(null);
  const [projects, setProjects]         = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [projectName, setProjectName]   = useState('');
  const [projectError, setProjectError] = useState(null);
  const [issuedKey, setIssuedKey]       = useState('');
  const [copyStatus, setCopyStatus]     = useState('');

  const fetchTracesData = useCallback(async () => {
    if (!selectedProjectId) {
      setTraces([]);
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const data = await fetchTraces({ projectId: selectedProjectId, limit: 50 });
      setTraces(data);
      setLastSync(new Date());
    } catch (err) {
      if (/authentication required/i.test(err.message)) {
        setAuthenticated(false);
        setProjects([]);
        setSelectedProjectId('');
        setSelectedSpans(null);
        setIssuedKey('');
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('verifyEmail') || params.has('resetPassword')) return undefined;
    checkCustomerSession()
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    if (!authenticated) return undefined;
    let active = true;
    listProjects()
      .then(({ projects: result = [] }) => {
        if (!active) return;
        setProjects(result);
        setSelectedProjectId((current) =>
          result.some((project) => project.id === current) ? current : result[0]?.id || ''
        );
      })
      .catch((err) => {
        if (active) setProjectError(err.message);
      });
    return () => { active = false; };
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) return undefined;
    if (!selectedProjectId) return undefined;
    const initialFetch = setTimeout(fetchTracesData, 0);
    const interval = setInterval(fetchTracesData, 5000);

    return () => {
      clearTimeout(initialFetch);
      clearInterval(interval);
    };
  }, [authenticated, selectedProjectId, fetchTracesData]);

  if (authenticated === null) return <LoadingSkeleton />;
  if (!authenticated) return <LoginScreen onLogin={() => setAuthenticated(true)} />;

  async function handleSelect(traceId) {
    setDetailError(null);
    try {
      const spans = await fetchTraceDetail(traceId, selectedProjectId);
      setSelectedSpans(spans);
    } catch (err) {
      setDetailError(err.message);
    }
  }

  async function handleCreateProject(event) {
    event.preventDefault();
    setProjectError(null);
    try {
      const result = await createProject(projectName);
      setProjects((current) => [...current, result.project]);
      setSelectedProjectId(result.project.id);
      setIssuedKey(result.ingestKey);
      setProjectName('');
      setCopyStatus('');
    } catch (err) {
      setProjectError(err.message);
    }
  }

  async function handleRotateKey() {
    if (!window.confirm('This immediately invalidates the existing ingest key. Continue?')) return;
    setProjectError(null);
    try {
      const result = await rotateProjectKey(selectedProjectId);
      setIssuedKey(result.ingestKey);
      setCopyStatus('');
    } catch (err) {
      setProjectError(err.message);
    }
  }

  async function handleCopyKey() {
    try {
      await navigator.clipboard.writeText(issuedKey);
      setCopyStatus('Copied to clipboard');
    } catch {
      setCopyStatus('Copy unavailable; select and copy the key above.');
    }
  }

  async function handleLogout() {
    try {
      await logoutCustomer();
      setAuthenticated(false);
      setProjects([]);
      setSelectedProjectId('');
      setTraces([]);
      setIssuedKey('');
      setProjectError(null);
      setCopyStatus('');
    } catch (err) {
      setProjectError(err.message);
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
          <a className="refresh-btn" href="/shop">Storefront</a>
          <Stat label="traces" value={traces.length} />
          <Stat label="errors" value={errorCount} tone={errorCount > 0 ? 'error' : 'default'} />
          <Stat label="avg" value={`${avgDuration}ms`} />
        </div>
      </header>

      <main className="content">
        <section className="project-panel" aria-label="Project settings">
          <label className="project-select">
            Active project
            <select
              value={selectedProjectId}
              onChange={(event) => {
                setSelectedProjectId(event.target.value);
                setTraces([]);
                setSelectedSpans(null);
                setLoading(Boolean(event.target.value));
                setIssuedKey('');
              }}
            >
              <option value="">Select a project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          <form className="project-create" onSubmit={handleCreateProject}>
            <input
              aria-label="New project name"
              placeholder="New project name"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              maxLength={80}
              required
            />
            <button className="refresh-btn" type="submit">Create project</button>
          </form>
          {selectedProjectId && (
            <button className="refresh-btn" type="button" onClick={handleRotateKey}>
              Regenerate ingest key
            </button>
          )}
          {projectError && <p className="project-error" role="alert">{projectError}</p>}
          {issuedKey && (
            <div className="project-key" role="status">
              <label>
                New ingest key — copy it now; it will not be shown again
                <input readOnly value={issuedKey} onFocus={(event) => event.target.select()} />
              </label>
              <button className="refresh-btn" type="button" onClick={handleCopyKey}>Copy key</button>
              {copyStatus && <span>{copyStatus}</span>}
            </div>
          )}
        </section>
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
          <button className="refresh-btn" onClick={handleLogout}>
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

        {!selectedProjectId ? (
          <div className="empty-state">
            <ActivityIcon />
            <p className="empty-state__title">Create a project to get started</p>
            <p className="empty-state__sub">Each project has an isolated trace view and its own ingest key.</p>
          </div>
        ) : loading ? (
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
  const isStorefront = window.location.pathname.replace(/\/+$/, '') === '/shop';
  return (
    <ErrorBoundary>
      {isStorefront ? <Shop /> : <AppContent />}
    </ErrorBoundary>
  );
}