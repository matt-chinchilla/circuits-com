// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetQueryCache,
  clearPersistedQueries,
  invalidateQueries,
  isQueryFresh,
  MAX_PERSIST_BYTES,
  payloadEqual,
  peekQuery,
  runQuery,
  setVersionSource,
  VERSIONS_MAX_AGE,
  versionFor,
} from './queryCache';
import { TOKEN_KEY } from './sessionToken';

/** An unsigned token: the cache only reads `sub` as a namespace label. */
function fakeToken(sub: string): string {
  return `h.${btoa(JSON.stringify({ sub, role: 'owner' }))}.s`;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, fakeToken('person-1'));
  _resetQueryCache();
  setVersionSource(null);
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

describe('persistence', () => {
  it('survives a fresh document for the same person', async () => {
    await runQuery('dashboard:core', async () => ({ n: 1 }));
    _resetQueryCache(); // a full page load: module memory is gone…
    expect(peekQuery('dashboard:core')).toEqual({ n: 1 }); // …storage is not
    expect(isQueryFresh('dashboard:core')).toBe(true);
  });

  it('is per person — another sign-in never hydrates the last one’s numbers', async () => {
    await runQuery('k', async () => 'mine');
    localStorage.setItem(TOKEN_KEY, fakeToken('person-2'));
    expect(peekQuery('k')).toBeUndefined(); // memory cleared with the owner change
    _resetQueryCache();
    expect(peekQuery('k')).toBeUndefined(); // and storage is namespaced
    localStorage.setItem(TOKEN_KEY, fakeToken('person-1'));
    expect(peekQuery('k')).toBe('mine');
  });

  it('keeps an oversized payload in memory only', async () => {
    const big = { s: 'x'.repeat(MAX_PERSIST_BYTES) };
    await runQuery('big', async () => big);
    expect(peekQuery('big')).toBe(big);
    _resetQueryCache();
    expect(peekQuery('big')).toBeUndefined();
  });

  it('persists nothing when there is no session', async () => {
    localStorage.removeItem(TOKEN_KEY);
    await runQuery('k', async () => 1);
    expect(peekQuery('k')).toBe(1); // memory still serves the tab
    _resetQueryCache();
    expect(peekQuery('k')).toBeUndefined();
  });

  it('invalidateQueries drops the persisted copy as well as the memory one', async () => {
    await runQuery('dashboard:core', async () => 1);
    await runQuery('reports:core', async () => 2);
    invalidateQueries('dashboard:');
    _resetQueryCache();
    expect(peekQuery('dashboard:core')).toBeUndefined();
    expect(peekQuery('reports:core')).toBe(2);
  });

  it('clearPersistedQueries (sign-out) wipes every namespace and the memory', async () => {
    await runQuery('k', async () => 1);
    localStorage.setItem(TOKEN_KEY, fakeToken('person-2'));
    await runQuery('k', async () => 2);
    clearPersistedQueries();
    expect(peekQuery('k')).toBeUndefined();
    localStorage.setItem(TOKEN_KEY, fakeToken('person-1'));
    expect(peekQuery('k')).toBeUndefined();
    expect(localStorage.length).toBe(1); // only the token itself
  });

  it('ignores a persisted entry that does not parse', () => {
    localStorage.setItem('admin.qc.v1.person-1.k', '{not json');
    expect(peekQuery('k')).toBeUndefined();
  });
});

describe('the change check', () => {
  const stale = () => vi.advanceTimersByTime(Math.max(1001, VERSIONS_MAX_AGE + 1));

  it('serves a stale entry WITHOUT a refetch when its scopes did not move', async () => {
    const source = vi.fn(async () => ({ catalog: 'a', money: 'm' }));
    setVersionSource(source);
    const fetcher = vi.fn(async () => ({ n: 1 }));
    await runQuery('k', fetcher, { maxAge: 1000, scopes: ['catalog'] });
    stale();
    expect(isQueryFresh('k', 1000)).toBe(false);
    expect(await runQuery('k', fetcher, { maxAge: 1000, scopes: ['catalog'] })).toEqual({ n: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1); // the owner's ask, literally
    expect(source).toHaveBeenCalledTimes(2);
    expect(isQueryFresh('k', 1000)).toBe(true); // fresh again, no query ran
  });

  it('refetches when a scope version moved', async () => {
    const source = vi.fn().mockResolvedValueOnce({ catalog: 'a' }).mockResolvedValueOnce({ catalog: 'b' });
    setVersionSource(source);
    const fetcher = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await runQuery('k', fetcher, { maxAge: 1000, scopes: ['catalog'] });
    stale();
    expect(await runQuery('k', fetcher, { maxAge: 1000, scopes: ['catalog'] })).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('asks about the versions BEFORE fetching, so a concurrent write can never be masked', async () => {
    const order: string[] = [];
    setVersionSource(async () => {
      order.push('probe');
      return { catalog: 'a' };
    });
    await runQuery(
      'k',
      async () => {
        order.push('fetch');
        return 1;
      },
      { scopes: ['catalog'] },
    );
    expect(order).toEqual(['probe', 'fetch']);
  });

  it('shares one probe between entries that go stale together', async () => {
    const source = vi.fn(async () => ({ traffic: 't' }));
    setVersionSource(source);
    await runQuery('a', async () => 1, { maxAge: 1000, scopes: ['traffic'] });
    await runQuery('b', async () => 2, { maxAge: 1000, scopes: ['traffic'] });
    expect(source).toHaveBeenCalledTimes(1); // the miss pair shared it
    stale();
    await Promise.all([
      runQuery('a', async () => 1, { maxAge: 1000, scopes: ['traffic'] }),
      runQuery('b', async () => 2, { maxAge: 1000, scopes: ['traffic'] }),
    ]);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('treats a scope the server did not report as changed', async () => {
    setVersionSource(async () => ({}));
    const fetcher = vi.fn(async () => 1);
    await runQuery('k', fetcher, { maxAge: 1000, scopes: ['leads'] });
    stale();
    await runQuery('k', fetcher, { maxAge: 1000, scopes: ['leads'] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('falls back to a plain refetch when the probe fails', async () => {
    setVersionSource(async () => {
      throw new Error('down');
    });
    const fetcher = vi.fn(async () => 1);
    await runQuery('k', fetcher, { maxAge: 1000, scopes: ['catalog'] });
    stale();
    await runQuery('k', fetcher, { maxAge: 1000, scopes: ['catalog'] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refetches an entry that was cached without scopes, then versions it', async () => {
    setVersionSource(async () => ({ catalog: 'a' }));
    const fetcher = vi.fn(async () => 1);
    await runQuery('k', fetcher, { maxAge: 1000 });
    stale();
    await runQuery('k', fetcher, { maxAge: 1000, scopes: ['catalog'] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    stale();
    await runQuery('k', fetcher, { maxAge: 1000, scopes: ['catalog'] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('forgets the last probe answer on invalidation', async () => {
    const source = vi.fn(async () => ({ catalog: 'a' }));
    setVersionSource(source);
    await runQuery('k', async () => 1, { scopes: ['catalog'] });
    invalidateQueries();
    await runQuery('k', async () => 1, { scopes: ['catalog'] });
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('versionFor is the scopes in order, or undefined if any is missing', () => {
    expect(versionFor(['catalog', 'money'], { catalog: 'a', money: 'b' })).toBe('catalog=a,money=b');
    expect(versionFor(['catalog', 'money'], { catalog: 'a' })).toBeUndefined();
    expect(versionFor(['catalog'], { catalog: '' })).toBeUndefined();
  });
});
