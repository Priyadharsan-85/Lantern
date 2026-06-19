require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'lantern',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
});

pool.on('error', (err) => {
  console.error('[DB] unexpected error:', err.message);
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function insertSpan(span) {
  const sql = `
    INSERT INTO spans
      (span_id, trace_id, parent_span_id, name, service_name,
       status, duration, start_time, end_time, tags, logs)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (span_id) DO NOTHING
  `;
  await query(sql, [
    span.spanId,
    span.traceId,
    span.parentSpanId || null,
    span.name,
    span.serviceName,
    span.status,
    span.duration,
    span.startTime,
    span.endTime,
    JSON.stringify(span.tags || {}),
    JSON.stringify(span.logs || []),
  ]);
}

async function getTraces(limit = 50) {
  const sql = `
    SELECT
      trace_id,
      MIN(start_time)                          AS start_time,
      SUM(duration)                            AS total_duration,
      COUNT(*)                                 AS span_count,
      array_agg(DISTINCT service_name)         AS services,
      bool_or(status = 'error')                AS has_error,
      (array_agg(name ORDER BY start_time))[1] AS root_span
    FROM spans
    GROUP BY trace_id
    ORDER BY start_time DESC
    LIMIT $1
  `;
  const result = await query(sql, [limit]);
  return result.rows;
}

async function getTraceById(traceId) {
  const sql = `
    SELECT * FROM spans
    WHERE trace_id = $1
    ORDER BY start_time ASC
  `;
  const result = await query(sql, [traceId]);
  return result.rows;
}

module.exports = { insertSpan, getTraces, getTraceById, query };