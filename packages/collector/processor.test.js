const mockReadSpans = jest.fn();
const mockAckSpans = jest.fn();
const mockInsertSpan = jest.fn();

jest.mock('./queue', () => ({
  readSpans: (...args) => mockReadSpans(...args),
  ackSpans: (...args) => mockAckSpans(...args),
}));
jest.mock('./db', () => ({
  insertSpan: (...args) => mockInsertSpan(...args),
}));

const { processMessages } = require('./processor');

describe('span processor delivery guarantees', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInsertSpan.mockResolvedValue();
    mockAckSpans.mockResolvedValue();
  });

  it('leaves failed database writes unacknowledged and processes other spans', async () => {
    mockInsertSpan.mockRejectedValueOnce(new Error('database unavailable'));

    const processed = await processMessages([
      { streamId: '1-0', span: { spanId: 'failed-span' } },
      { streamId: '2-0', span: { spanId: 'saved-span' } },
    ]);

    expect(processed).toBe(1);
    expect(mockAckSpans).toHaveBeenCalledTimes(1);
    expect(mockAckSpans).toHaveBeenCalledWith(['2-0']);
    expect(mockInsertSpan.mock.invocationCallOrder[1])
      .toBeLessThan(mockAckSpans.mock.invocationCallOrder[0]);
  });

  it('retries persistence when acknowledgement fails after the database write', async () => {
    mockAckSpans.mockRejectedValueOnce(new Error('redis unavailable'));
    const message = { streamId: '3-0', span: { spanId: 'retry-safe-span' } };

    expect(await processMessages([message])).toBe(0);
    expect(await processMessages([message])).toBe(1);

    expect(mockInsertSpan).toHaveBeenCalledTimes(2);
    expect(mockAckSpans).toHaveBeenNthCalledWith(1, ['3-0']);
    expect(mockAckSpans).toHaveBeenNthCalledWith(2, ['3-0']);
  });
});
