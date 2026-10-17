const fs = require('fs');
const path = require('path');

const mockClient = { query: jest.fn(), release: jest.fn() };
const mockPool = { connect: jest.fn(), on: jest.fn() };
jest.mock('pg', () => ({ Pool: jest.fn(() => mockPool) }));

const { insertSpan, getProjectIdForIngestKey, getTraces, getTraceById } = require('./db');

describe('tenant-scoped trace persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPool.connect.mockResolvedValue(mockClient);
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('stores an explicit project id and scopes duplicate ids to that project', async () => {
    await insertSpan({
      projectId: 'prj_alpha',
      spanId: 'span_1',
      traceId: 'trace_1',
      name: 'GET /',
      serviceName: 'api',
      status: 'ok',
      duration: 1,
      startTime: 10,
      endTime: 11,
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (project_id, span_id) DO NOTHING'),
      expect.arrayContaining(['prj_alpha', 'span_1'])
    );
  });

  it('assigns pre-migration queued spans only to the internal tenant', async () => {
    await insertSpan({ spanId: 'legacy', traceId: 'legacy-trace' });
    expect(mockClient.query.mock.calls[0][1][0]).toBe('prj_internal');
  });

  it('looks up only active projects by the hash supplied by the collector', async () => {
    await getProjectIdForIngestKey('a'.repeat(64));
    expect(mockClient.query).toHaveBeenCalledWith(
      'SELECT project_id FROM projects WHERE ingest_key_hash = $1 AND active = TRUE',
      ['a'.repeat(64)]
    );
  });

  it('scopes trace list and detail queries by project id', async () => {
    await getTraces('prj_alpha', 25, 10);
    expect(mockClient.query.mock.calls[0][0]).toContain('WHERE project_id = $1');
    expect(mockClient.query.mock.calls[0][1]).toEqual(['prj_alpha', 25, 10]);

    await getTraceById('prj_beta', 'shared-trace-id');
    expect(mockClient.query.mock.calls[1][0]).toContain('WHERE project_id = $1 AND trace_id = $2');
    expect(mockClient.query.mock.calls[1][1]).toEqual(['prj_beta', 'shared-trace-id']);
  });

  it('migrates existing spans to the private internal project and requires tenant scope', () => {
    const migration = fs.readFileSync(
      path.resolve(__dirname, '../../infra/migrations/005_project_multitenancy.sql'),
      'utf8'
    );
    expect(migration).toMatch(/UPDATE spans\s+SET project_id = 'prj_internal'\s+WHERE project_id IS NULL/i);
    expect(migration).toMatch(/ALTER TABLE spans ALTER COLUMN project_id SET NOT NULL/i);
    expect(migration).toMatch(/ALTER TABLE spans ALTER COLUMN project_id SET DEFAULT 'prj_internal'/i);
    expect(migration).toMatch(/PRIMARY KEY \(project_id, span_id\)/i);
    expect(migration).toMatch(/FOREIGN KEY \(project_id\) REFERENCES projects/i);
  });
});
