CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ingest_key_hash TEXT UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_customer_created
  ON projects (customer_id, created_at, project_id);

INSERT INTO customers (customer_id, email, password_hash)
VALUES (
  'cus_lantern_internal',
  'internal-services@lantern.invalid',
  'disabled$internal-service-account'
)
ON CONFLICT (customer_id) DO NOTHING;

INSERT INTO projects (project_id, customer_id, name, ingest_key_hash)
VALUES ('prj_internal', 'cus_lantern_internal', 'Lantern internal services', NULL)
ON CONFLICT (project_id) DO NOTHING;

ALTER TABLE spans ADD COLUMN IF NOT EXISTS project_id TEXT;

UPDATE spans
SET project_id = 'prj_internal'
WHERE project_id IS NULL;

ALTER TABLE spans ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE spans ALTER COLUMN project_id SET DEFAULT 'prj_internal';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'spans_project_id_fkey'
      AND conrelid = 'spans'::regclass
  ) THEN
    ALTER TABLE spans
      ADD CONSTRAINT spans_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES projects(project_id);
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'spans_pkey'
      AND conrelid = 'spans'::regclass
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (span_id)'
  ) THEN
    ALTER TABLE spans DROP CONSTRAINT spans_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'spans_pkey'
      AND conrelid = 'spans'::regclass
  ) THEN
    ALTER TABLE spans ADD CONSTRAINT spans_pkey PRIMARY KEY (project_id, span_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_spans_project_trace_start
  ON spans (project_id, trace_id, start_time);
