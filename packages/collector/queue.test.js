const mockRedis = {
  xgroup: jest.fn(),
  eval: jest.fn(),
  xlen: jest.fn(),
};
const mockConsumer = {
  eval: jest.fn(),
  xautoclaim: jest.fn(),
  xreadgroup: jest.fn(),
};

jest.mock('ioredis', () => jest.fn()
  .mockImplementationOnce(() => mockRedis)
  .mockImplementationOnce(() => mockConsumer));

const queue = require('./queue');

describe('Redis span queue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.xgroup.mockResolvedValue('OK');
    mockRedis.eval.mockResolvedValue(1);
    mockConsumer.eval.mockResolvedValue(2);
    mockConsumer.xautoclaim.mockResolvedValue(['0-0', []]);
    mockConsumer.xreadgroup.mockResolvedValue(null);
  });

  it('creates a consumer group and tolerates an existing group', async () => {
    await queue.setupStream();
    expect(mockRedis.xgroup).toHaveBeenCalledWith(
      'CREATE',
      'lantern:spans',
      'span-processors',
      '0',
      'MKSTREAM'
    );

    mockRedis.xgroup.mockRejectedValueOnce(new Error('BUSYGROUP Consumer Group name already exists'));
    await expect(queue.setupStream()).resolves.toBeUndefined();
  });

  it('throws unexpected consumer-group setup errors', async () => {
    mockRedis.xgroup.mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(queue.setupStream()).rejects.toThrow('Redis unavailable');
  });

  it('adds spans atomically only while queue capacity is available', async () => {
    await queue.pushSpans([{ spanId: 's1' }, { spanId: 's2' }]);
    const [script, keyCount, streamKey, maximum, ...serializedSpans] = mockRedis.eval.mock.calls[0];

    expect(script).toContain('XLEN');
    expect(script).toContain('XADD');
    expect(keyCount).toBe(1);
    expect(streamKey).toBe('lantern:spans');
    expect(Number(maximum)).toBeGreaterThan(1);
    expect(serializedSpans.map(JSON.parse)).toEqual([{ spanId: 's1' }, { spanId: 's2' }]);
  });

  it('reports full capacity without silently dropping spans', async () => {
    mockRedis.eval.mockResolvedValueOnce(-1);
    await expect(queue.pushSpans([{ spanId: 's1' }])).rejects.toBeInstanceOf(queue.StreamCapacityError);
  });

  it('recovers idle pending messages before reading new messages', async () => {
    mockConsumer.xautoclaim.mockResolvedValueOnce([
      '0-0',
      [['1-0', ['data', JSON.stringify({ spanId: 'recovered' })]]],
    ]);

    const messages = await queue.readSpans(10);

    expect(messages).toEqual([{ streamId: '1-0', span: { spanId: 'recovered' } }]);
    expect(mockConsumer.xautoclaim).toHaveBeenCalledWith(
      'lantern:spans',
      'span-processors',
      expect.stringMatching(/^\S+-\d+-[0-9a-f-]+$/),
      30000,
      '0-0',
      'COUNT',
      10
    );
    expect(mockConsumer.xreadgroup).not.toHaveBeenCalled();
  });

  it('reads new messages if no idle messages can be reclaimed', async () => {
    mockConsumer.xreadgroup.mockResolvedValueOnce([
      ['lantern:spans', [['2-0', ['data', JSON.stringify({ spanId: 'new' })]]]],
    ]);

    const messages = await queue.readSpans(10);

    expect(messages).toEqual([{ streamId: '2-0', span: { spanId: 'new' } }]);
    expect(mockConsumer.xreadgroup).toHaveBeenCalledWith(
      'GROUP',
      'span-processors',
      expect.stringMatching(/^\S+-\d+-[0-9a-f-]+$/),
      'COUNT',
      10,
      'BLOCK',
      1000,
      'STREAMS',
      'lantern:spans',
      '>'
    );
  });

  it('acknowledges and deletes only successfully persisted stream entries atomically', async () => {
    await queue.ackSpans(['1-0', '2-0']);
    const [script, keyCount, streamKey, groupName, ...ids] = mockConsumer.eval.mock.calls[0];

    expect(script).toContain('XACK');
    expect(script).toContain('XDEL');
    expect(keyCount).toBe(1);
    expect(streamKey).toBe('lantern:spans');
    expect(groupName).toBe('span-processors');
    expect(ids).toEqual(['1-0', '2-0']);
  });
});
