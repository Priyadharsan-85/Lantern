#!/bin/sh
set -eu

psql_args="-v ON_ERROR_STOP=1 -h ${PGHOST} -p ${PGPORT} -U ${PGUSER} -d ${PGDATABASE}"

psql ${psql_args} -c "
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
"

for migration in /migrations/*.sql; do
  version=$(basename "$migration" .sql)
  applied=$(psql ${psql_args} -tAc "SELECT 1 FROM schema_migrations WHERE version = '${version}'")
  if [ "$applied" = "1" ]; then
    echo "Skipping applied migration: $version"
    continue
  fi

  echo "Applying migration: $version"
  psql ${psql_args} -f "$migration"
  psql ${psql_args} -c "INSERT INTO schema_migrations (version) VALUES ('${version}')"
done
