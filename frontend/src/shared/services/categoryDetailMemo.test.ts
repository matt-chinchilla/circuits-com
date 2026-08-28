import { beforeEach, describe, expect, it } from 'vitest';
import {
  categoryRowsKey,
  clearCategoryDetailMemo,
  getCategoryChromeMemo,
  getCategoryRowsMemo,
  setCategoryChromeMemo,
  setCategoryRowsMemo,
} from './categoryDetailMemo';

beforeEach(() => {
  clearCategoryDetailMemo();
});

describe('the chrome/rows split', () => {
  it('keeps the chrome across every query on the same slug', () => {
    // The header, chips and sponsor boards do not change when you sort — that
    // is exactly why they no longer share a cache key with the rows.
    setCategoryChromeMemo('connectors', { name: 'Connectors' });
    setCategoryRowsMemo(categoryRowsKey('connectors', 'p=1'), { total: 39353 });
    setCategoryRowsMemo(categoryRowsKey('connectors', 'p=5&s=qty100'), { total: 39353 });

    expect(getCategoryChromeMemo('connectors')).toEqual({ name: 'Connectors' });
  });

  it('never serves one query\'s rows to another', () => {
    // The regression this split exists to prevent: a ?p=5&sort=qty100 URL
    // painting page-1-sku-asc rows out of a slug-keyed memo.
    setCategoryRowsMemo(categoryRowsKey('connectors', 'p=1&s='), { page: 1 });
    expect(getCategoryRowsMemo(categoryRowsKey('connectors', 'p=5&s=qty100'))).toBeUndefined();
  });

  it('keeps rows for the same query on different categories apart', () => {
    setCategoryRowsMemo(categoryRowsKey('connectors', 'p=1'), { slug: 'connectors' });
    setCategoryRowsMemo(categoryRowsKey('sensors', 'p=1'), { slug: 'sensors' });
    expect(getCategoryRowsMemo(categoryRowsKey('connectors', 'p=1'))).toEqual({
      slug: 'connectors',
    });
  });

  it('reports a miss as undefined, so a cold read is distinguishable from a null payload', () => {
    expect(getCategoryChromeMemo('nope')).toBeUndefined();
    expect(getCategoryRowsMemo(categoryRowsKey('nope', 'p=1'))).toBeUndefined();
  });
});

describe('bounding', () => {
  it('evicts the least-recently-used chrome past 12 entries', () => {
    for (let i = 0; i < 12; i++) setCategoryChromeMemo(`c${i}`, i);
    getCategoryChromeMemo('c0'); // touch — c1 is now the oldest
    setCategoryChromeMemo('c12', 12);

    expect(getCategoryChromeMemo('c0')).toBe(0);
    expect(getCategoryChromeMemo('c1')).toBeUndefined();
    expect(getCategoryChromeMemo('c12')).toBe(12);
  });

  it('gives rows a bigger cap — one category can hold many pages', () => {
    // 24 keys of a SINGLE category must not evict each other; each is ~25 parts.
    for (let i = 0; i < 24; i++) setCategoryRowsMemo(categoryRowsKey('connectors', `p=${i}`), i);
    expect(getCategoryRowsMemo(categoryRowsKey('connectors', 'p=0'))).toBe(0);
    expect(getCategoryRowsMemo(categoryRowsKey('connectors', 'p=23'))).toBe(23);

    setCategoryRowsMemo(categoryRowsKey('connectors', 'p=24'), 24);
    // p=0 was just touched by the read above, so p=1 is the eviction victim.
    expect(getCategoryRowsMemo(categoryRowsKey('connectors', 'p=1'))).toBeUndefined();
    expect(getCategoryRowsMemo(categoryRowsKey('connectors', 'p=0'))).toBe(0);
  });
});

describe('clearCategoryDetailMemo', () => {
  it('drops BOTH maps — a half-cleared memo paints a stale half', () => {
    setCategoryChromeMemo('connectors', { name: 'Connectors' });
    setCategoryRowsMemo(categoryRowsKey('connectors', 'p=1'), { total: 1 });

    clearCategoryDetailMemo();

    expect(getCategoryChromeMemo('connectors')).toBeUndefined();
    expect(getCategoryRowsMemo(categoryRowsKey('connectors', 'p=1'))).toBeUndefined();
  });
});
