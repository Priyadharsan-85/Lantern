CREATE TABLE IF NOT EXISTS spans (
  span_id        TEXT PRIMARY KEY,
  trace_id       TEXT NOT NULL,
  parent_span_id TEXT,
  name           TEXT NOT NULL,
  service_name   TEXT NOT NULL,
  status         TEXT DEFAULT 'ok',
  duration       INTEGER,
  start_time     BIGINT,
  end_time       BIGINT,
  tags           JSONB DEFAULT '{}',
  logs           JSONB DEFAULT '[]',
  created_at     TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trace_id ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_service_name ON spans(service_name);
CREATE INDEX IF NOT EXISTS idx_status ON spans(status);
CREATE INDEX IF NOT EXISTS idx_start_time ON spans(start_time DESC);psql 