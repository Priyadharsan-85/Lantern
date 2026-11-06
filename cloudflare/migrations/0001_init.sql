PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  attempt_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ingest_key_hash TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  monthly_span_count INTEGER NOT NULL DEFAULT 0,
  usage_month TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_customer_active
  ON projects(customer_id, active, created_at);

CREATE TABLE IF NOT EXISTS spans (
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  span_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  service_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  duration INTEGER NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  tags TEXT NOT NULL DEFAULT '{}',
  logs TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, span_id)
);

CREATE INDEX IF NOT EXISTS idx_spans_created_at ON spans(created_at);
CREATE INDEX IF NOT EXISTS idx_spans_project_trace_start
  ON spans(project_id, trace_id, start_time);

CREATE TABLE IF NOT EXISTS trace_summaries (
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  trace_id TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  total_duration INTEGER NOT NULL,
  span_count INTEGER NOT NULL,
  has_error INTEGER NOT NULL CHECK (has_error IN (0, 1)),
  root_span TEXT NOT NULL,
  services_json TEXT NOT NULL,
  last_ingested_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, trace_id)
);

CREATE INDEX IF NOT EXISTS idx_trace_summaries_project_recent
  ON trace_summaries(project_id, last_ingested_at DESC, trace_id);

CREATE TABLE IF NOT EXISTS daily_ingest_usage (
  usage_date TEXT PRIMARY KEY,
  span_count INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS spans_after_insert
AFTER INSERT ON spans
BEGIN
  INSERT INTO trace_summaries (
    project_id, trace_id, start_time, total_duration, span_count,
    has_error, root_span, services_json, last_ingested_at
  )
  VALUES (
    NEW.project_id, NEW.trace_id, NEW.start_time, NEW.duration, 1,
    CASE WHEN NEW.status = 'error' THEN 1 ELSE 0 END,
    NEW.name, json_array(NEW.service_name), NEW.created_at
  )
  ON CONFLICT (project_id, trace_id) DO UPDATE SET
    start_time = MIN(trace_summaries.start_time, excluded.start_time),
    total_duration = trace_summaries.total_duration + excluded.total_duration,
    span_count = trace_summaries.span_count + 1,
    has_error = MAX(trace_summaries.has_error, excluded.has_error),
    root_span = CASE
      WHEN excluded.start_time < trace_summaries.start_time THEN excluded.root_span
      ELSE trace_summaries.root_span
    END,
    services_json = CASE
      WHEN EXISTS (
        SELECT 1 FROM json_each(trace_summaries.services_json)
        WHERE value = NEW.service_name
      ) THEN trace_summaries.services_json
      ELSE json_insert(trace_summaries.services_json, '$[#]', NEW.service_name)
    END,
    last_ingested_at = MAX(trace_summaries.last_ingested_at, excluded.last_ingested_at);
END;
