import { decideAfterFailure, nextRetryDelayMs } from '../src/relay/backoff';
import { createContext, parseTraceparent, sanitizeRequestId } from '../src/tracing/context';
import { isValidIdempotencyKey, requestFingerprint } from '../src/idempotency/fingerprint';

const policy = { baseMs: 1000, maxMs: 60_000, maxAttempts: 5 };

describe('relay backoff', () => {
  it('grows exponentially and is capped', () => {
    const mid = () => 0.5; // jitter factor 1.0
    expect([1, 2, 3, 4].map((a) => nextRetryDelayMs(policy, a, mid))).toEqual([
      1000, 2000, 4000, 8000,
    ]);
    expect(nextRetryDelayMs(policy, 20, mid)).toBe(60_000);
  });

  it('applies ±20% jitter', () => {
    expect(nextRetryDelayMs(policy, 1, () => 0)).toBe(800);
    expect(nextRetryDelayMs(policy, 1, () => 1)).toBe(1200);
  });

  it('retries attempts 1–4 and marks the delivery dead after the 5th', () => {
    for (const attempt of [1, 2, 3, 4])
      expect(decideAfterFailure(policy, attempt).action).toBe('retry');
    expect(decideAfterFailure(policy, 5)).toEqual({ action: 'dead' });
  });
});

describe('trace context', () => {
  it('continues a valid incoming trace with a new span', () => {
    const context = createContext({
      requestId: 'abc-12345',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    expect(context.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(context.spanId).not.toBe('b7ad6b7169203331');
    expect(context.requestId).toBe('abc-12345');
  });

  it.each([
    '',
    'garbage',
    '00-00000000000000000000000000000000-b7ad6b7169203331-01',
    '01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331',
  ])('starts a new trace for invalid traceparent %p', (value) => {
    expect(parseTraceparent(value)).toBeUndefined();
    expect(createContext({ traceparent: value }).traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('replaces unsafe request ids', () => {
    expect(sanitizeRequestId('ok-request-id')).toBe('ok-request-id');
    expect(sanitizeRequestId('bad\nid<script>')).not.toContain('<');
    expect(sanitizeRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('idempotency fingerprint', () => {
  it('is independent of key order', () => {
    expect(requestFingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(
      requestFingerprint({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });
  it('changes when parameters change', () => {
    expect(requestFingerprint({ a: 1 })).not.toBe(requestFingerprint({ a: 2 }));
  });
  it('validates key format', () => {
    expect(isValidIdempotencyKey('vr-01a14e5d-0000')).toBe(true);
    expect(isValidIdempotencyKey('short')).toBe(false);
    expect(isValidIdempotencyKey('has space in it')).toBe(false);
  });
});
