ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS monthly_span_count BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usage_month DATE NOT NULL
    DEFAULT (date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date);

CREATE INDEX IF NOT EXISTS idx_spans_created_at_retention
  ON spans (created_at);
