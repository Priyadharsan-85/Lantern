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
CREATE INDEX IF NOT EXISTS idx_start_time ON spans(start_time DESC);

-- ── Orders ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  order_id    TEXT PRIMARY KEY,
  trace_id    TEXT,
  user_id     TEXT NOT NULL,
  items       JSONB NOT NULL DEFAULT '[]',
  amount      NUMERIC(12, 2) NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | failed
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_user_id  ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_trace_id ON orders(trace_id);
CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status);

-- ── Payments ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  charge_id   TEXT PRIMARY KEY,
  order_id    TEXT REFERENCES orders(order_id) ON DELETE SET NULL,
  trace_id    TEXT,
  user_id     TEXT NOT NULL,
  amount      NUMERIC(12, 2) NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- paid | declined | error
  gateway     TEXT NOT NULL DEFAULT 'stripe',
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_order_id  ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_trace_id  ON payments(trace_id);
CREATE INDEX IF NOT EXISTS idx_payments_user_id   ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status    ON payments(status);