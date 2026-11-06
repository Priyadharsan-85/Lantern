import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker, { equalSecret, validateSpan } from './index.js';

describe('Cloudflare tracing Worker', () => {
  it('compares secrets without exposing a string comparison path', async () => {
    assert.equal(await equalSecret('the same secret', 'the same secret'), true);
    assert.equal(await equalSecret('different secret', 'the same secret'), false);
  });

  it('accepts valid SDK spans and rejects malformed or oversized data', () => {
    assert.equal(validateSpan({
      spanId: 'span-1',
      traceId: 'trace-1',
      parentSpanId: null,
      name: 'GET /health',
      serviceName: 'example',
      status: 'ok',
      startTime: Date.now(),
      endTime: Date.now() + 3,
      duration: 3,
      tags: { 'http.status': 200 },
      logs: [],
    }), true);

    assert.equal(validateSpan({ spanId: 'missing-fields' }), false);
    assert.equal(validateSpan({
      spanId: 'span-2',
      traceId: 'trace-1',
      name: 'operation',
      serviceName: 'example',
      status: 'failed',
      startTime: 1,
      duration: 1,
    }), false);
  });

  it('keeps public self-service account creation disabled', async () => {
    const response = await worker.fetch(
      new Request('https://lantern.example/auth/customer/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://lantern.example' },
        body: JSON.stringify({ email: 'anyone@example.com', password: 'not-a-real-password' }),
      }),
      { DB: {} }
    );

    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'PRIVATE_MVP');
  });

  it('requires a valid ingest key before accepting spans', async () => {
    const response = await worker.fetch(
      new Request('https://lantern.example/spans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spans: [] }),
      }),
      { DB: {} }
    );

    assert.equal(response.status, 401);
  });
});
