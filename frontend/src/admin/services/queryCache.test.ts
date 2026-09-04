import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetQueryCache,
  invalidateQueries,
  isQueryFresh,
  payloadEqual,
  peekQuery,
  runQuery,
} from './queryCache';

beforeEach(() => {
  _resetQueryCache();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('runQuery', () => {
  it('fetches on a miss and serves a fresh hit with NO request', async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    expect(await runQuery('k', fetcher)).toEqual({ n: 1 });
    expect(await runQuery('k', fetcher)).toEqual({ n: 1 });
    // The owner's rule: a revisit inside the window is not a re-query.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(peekQuery('k')).toEqual({ n: 1 });
  });

  it('refetches once the entry is older than maxAge', async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    await runQuery('k', fetcher, 1000);
    vi.advanceTimersByTime(1001);
    expect(isQueryFresh('k', 1000)).toBe(false);
    await runQuery('k', fetcher, 1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('joins concurrent callers onto one request', async () => {
    let resolve: (v: number) => void = () => {};
    const fetcher = vi.fn(() => new Promise<number>((r) => { resolve = r; }));
    const a = runQuery('k', fetcher);
    const b = runQuery('k', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(7);
    expect(await a).toBe(7);
    expect(await b).toBe(7);
  });

  it('does not store a result that started before an invalidation', async () => {
    // A fetch in flight across a mutation could otherwise cache the
    // pre-mutation payload AFTER the mutation cleared the cache.
    let resolve: (v: string) => void = () => {};
    const fetcher = vi.fn(() => new Promise<string>((r) => { resolve = r; }));
    const p = runQuery('k', fetcher);
    invalidateQueries();
    resolve('stale');
    expect(await p).toBe('stale'); // the caller still gets its answer…
    expect(peekQuery('k')).toBeUndefined(); // …but nobody else does
  });

  it('stores nothing on a rejection and lets the next caller retry', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(2);
    await expect(runQuery('k', fetcher)).rejects.toThrow('x');
    expect(peekQuery('k')).toBeUndefined();
    expect(await runQuery('k', fetcher)).toBe(2);
  });
});

describe('invalidateQueries', () => {
  it('drops by prefix, or everything', async () => {
    await runQuery('dashboard:core', async () => 1);
    await runQuery('reports:x', async () => 2);
    invalidateQueries('dashboard:');
    expect(peekQuery('dashboard:core')).toBeUndefined();
    expect(peekQuery('reports:x')).toBe(2);
    invalidateQueries();
    expect(peekQuery('reports:x')).toBeUndefined();
  });
});

describe('payloadEqual', () => {
  it('is structural and key-order independent', () => {
    expect(payloadEqual({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 })).toBe(true);
    expect(payloadEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(payloadEqual([1, 2], [2, 1])).toBe(false);
    expect(payloadEqual({ a: 1 }, { a: '1' })).toBe(false);
    expect(payloadEqual(null, {})).toBe(false);
    expect(payloadEqual([], {})).toBe(false);
  });
});
