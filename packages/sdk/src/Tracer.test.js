// Mock uuid to avoid ESM-in-CJS issues with uuid@v10+ under Jest
jest.mock('uuid', () => {
  let counter = 0;
  return { v4: jest.fn(() => `test-uuid-${++counter}`) };
});

jest.mock('axios');

const axios  = require('axios');
const Tracer = require('./Tracer');

describe('Tracer', () => {

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.SDK_MAX_QUEUE_SIZE;
    delete process.env.COLLECTOR_API_KEY;
  });

  // ── Constructor validation ────────────────────────────────────────────────
  describe('constructor', () => {
    it('throws if serviceName is missing', () => {
      expect(() => new Tracer({ collectorUrl: 'http://collector' }))
        .toThrow('Tracer requires a serviceName');
    });

    it('throws if collectorUrl is missing', () => {
      expect(() => new Tracer({ serviceName: 'test-svc' }))
        .toThrow('Tracer requires a collectorUrl');
    });

    it('initialises successfully with valid args', () => {
      const t = new Tracer({ serviceName: 'svc', collectorUrl: 'http://c' });
      expect(t.serviceName).toBe('svc');
      expect(t.collectorUrl).toBe('http://c');
      t.shutdown();
    });
  });

  // ── startSpan ────────────────────────────────────────────────────────────
  describe('startSpan', () => {
    it('creates a span with the correct serviceName', () => {
      const t = new Tracer({ serviceName: 'my-service', collectorUrl: 'http://c' });
      const span = t.startSpan('db.query');
      expect(span.serviceName).toBe('my-service');
      expect(span.name).toBe('db.query');
      expect(span.traceId).toBeTruthy();
      t.shutdown();
    });

    it('assigns a new traceId when there is no parent context', () => {
      const t = new Tracer({ serviceName: 'svc', collectorUrl: 'http://c' });
      const s1 = t.startSpan('op1');
      const s2 = t.startSpan('op2');
      expect(s1.traceId).not.toBe(s2.traceId);
      t.shutdown();
    });
  });

  // ── trace() convenience wrapper ──────────────────────────────────────────
  describe('trace()', () => {
    it('finishes the span and enqueues it after the fn resolves', async () => {
      const t = new Tracer({ serviceName: 'svc', collectorUrl: 'http://c' });
      const enqueueSpy = jest.spyOn(t, '_enqueue');

      await t.trace('my-operation', async () => 'result');

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      const span = enqueueSpy.mock.calls[0][0];
      expect(span.name).toBe('my-operation');
      expect(span.endTime).not.toBeNull();
      t.shutdown();
    });

    it('marks span as error and still enqueues on exception', async () => {
      const t = new Tracer({ serviceName: 'svc', collectorUrl: 'http://c' });
      const enqueueSpy = jest.spyOn(t, '_enqueue');

      await expect(
        t.trace('failing-op', async () => { throw new Error('boom'); })
      ).rejects.toThrow('boom');

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      const span = enqueueSpy.mock.calls[0][0];
      expect(span.status).toBe('error');
      t.shutdown();
    });
  });

  // ── Queue size bounding ──────────────────────────────────────────────────
  describe('Queue size bounding', () => {
    it('respects maxQueueSize — drops oldest span when full', () => {
      const warnMessages = [];
      const t = new Tracer({
        serviceName:  'svc',
        collectorUrl: 'http://c',
        maxQueueSize: 3,
        onLog: (level, msg) => { if (level === 'warn') warnMessages.push(msg); },
      });

      // Fill queue to capacity
      for (let i = 0; i < 3; i++) {
        const s = t.startSpan(`op-${i}`); s.finish(); t._enqueue(s);
      }
      expect(t._queue).toHaveLength(3);

      // Adding one more should drop the oldest
      const s4 = t.startSpan('op-overflow'); s4.finish(); t._enqueue(s4);
      expect(t._queue).toHaveLength(3);
      expect(t._droppedSpans).toBe(1);
      expect(warnMessages[0]).toMatch(/queue full/i);

      t.shutdown();
    });

    it('reads maxQueueSize from SDK_MAX_QUEUE_SIZE env var', () => {
      process.env.SDK_MAX_QUEUE_SIZE = '10';
      const t = new Tracer({ serviceName: 'svc', collectorUrl: 'http://c' });
      expect(t.maxQueueSize).toBe(10);
      t.shutdown();
    });
  });

  // ── injectContext ────────────────────────────────────────────────────────
  describe('injectContext', () => {
    it('adds trace propagation headers', () => {
      const t = new Tracer({ serviceName: 'svc', collectorUrl: 'http://c' });
      const span = t.startSpan('test');
      const headers = t.injectContext(span);
      expect(headers['x-trace-id']).toBe(span.traceId);
      expect(headers['x-parent-span-id']).toBe(span.spanId);
      t.shutdown();
    });

    it('includes x-api-key when COLLECTOR_API_KEY is set', () => {
      process.env.COLLECTOR_API_KEY = 'my-secret';
      const t = new Tracer({ serviceName: 'svc', collectorUrl: 'http://c' });
      const span = t.startSpan('test');
      const headers = t.injectContext(span);
      expect(headers['x-api-key']).toBe('my-secret');
      t.shutdown();
    });

    it('does not add x-api-key when COLLECTOR_API_KEY is not set', () => {
      const t = new Tracer({ serviceName: 'svc', collectorUrl: 'http://c' });
      const span = t.startSpan('test');
      const headers = t.injectContext(span);
      expect(headers['x-api-key']).toBeUndefined();
      t.shutdown();
    });
  });

  // ── flush() ──────────────────────────────────────────────────────────────
  describe('flush()', () => {
    it('POSTs queued spans to collectorUrl/spans', async () => {
      axios.post.mockResolvedValue({ data: { received: 1 } });
      const t = new Tracer({ serviceName: 'svc', collectorUrl: 'http://collector' });
      const s = t.startSpan('test'); s.finish(); t._enqueue(s);

      await t.flush();

      expect(axios.post).toHaveBeenCalledWith(
        'http://collector/spans',
        { spans: expect.arrayContaining([expect.objectContaining({ name: 'test' })]) },
        expect.any(Object)
      );
      expect(t._queue).toHaveLength(0);
      t.shutdown();
    });

    it('re-queues spans on transient flush failure', async () => {
      axios.post.mockRejectedValue(new Error('Network error'));
      const t = new Tracer({ serviceName: 'svc', collectorUrl: 'http://collector' });
      const s = t.startSpan('test'); s.finish(); t._enqueue(s);

      await t.flush();

      // Spans should be put back
      expect(t._queue).toHaveLength(1);
      t.shutdown();
    });

    it('does nothing when queue is empty', async () => {
      const t = new Tracer({ serviceName: 'svc', collectorUrl: 'http://c' });
      await t.flush();
      expect(axios.post).not.toHaveBeenCalled();
      t.shutdown();
    });
  });
});
