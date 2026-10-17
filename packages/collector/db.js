require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'lantern',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD,
  // Connection pool settings for production
  max:              20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error({ err }, '[DB] unexpected pool error');
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
      (project_id, span_id, trace_id, parent_span_id, name, service_name,
       status, duration, start_time, end_time, tags, logs)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (project_id, span_id) DO NOTHING
  `;
  await query(sql, [
    span.projectId || 'prj_internal',
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

async function getProjectIdForIngestKey(keyHash) {
  const result = await query(
    'SELECT project_id FROM projects WHERE ingest_key_hash = $1 AND active = TRUE',
    [keyHash]
  );
  return result.rows[0]?.project_id || null;
}

async function getTraces(projectId, limit = 50, offset = 0) {
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
    WHERE project_id = $1
    GROUP BY trace_id
    ORDER BY start_time DESC
    LIMIT $2 OFFSET $3
  `;
  const result = await query(sql, [projectId, limit, offset]);
  return result.rows;
}

async function getTraceById(projectId, traceId) {
  const sql = `
    SELECT * FROM spans
    WHERE project_id = $1 AND trace_id = $2
    ORDER BY start_time ASC
  `;
  const result = await query(sql, [projectId, traceId]);
  return result.rows;
}

module.exports = {
  insertSpan,
  getProjectIdForIngestKey,
  getTraces,
  getTraceById,
  query,
};