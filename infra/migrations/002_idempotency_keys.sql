ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_user_idempotency
  ON orders (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_user_idempotency
  ON payments (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
