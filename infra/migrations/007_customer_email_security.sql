ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS customer_auth_tokens (
  token_hash TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_auth_tokens_customer_purpose
  ON customer_auth_tokens (customer_id, purpose, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_auth_tokens_expiry
  ON customer_auth_tokens (expires_at)
  WHERE consumed_at IS NULL;
