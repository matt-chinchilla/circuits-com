import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_CATEGORY_QUERY,
  DEFAULT_CATEGORY_QUERY,
  PAGE_SIZE,
  SORT_KEYS,
  categoryQuerySignature,
  categoryRequestQuery,
  isUnknownSortError,
  parseCategoryQuery,
  writeCategoryQuery,
} from './categoryQuery';

const parse = (search: string) => parseCategoryQuery(new URLSearchParams(search));
const write = (search: string, patch: Parameters<typeof writeCategoryQuery>[1]) =>
  writeCategoryQuery(new URLSearchParams(search), patch).toString();

describe('parseCategoryQuery', () => {
  it('a bare URL is the default query', () => {
    expect(parse('')).toEqual(DEFAULT_CATEGORY_QUERY);
  });

  it('reads every param the page owns', () => {
    expect(parse('?p=3&sort=qty100&dir=desc&q=stm32&mfg=TI&mfg=Nordic&sub=bluetooth')).toEqual({
      page: 3,
      sort: 'qty100',
      dir: 'desc',
      q: 'stm32',
      mfg: ['Nordic', 'TI'],
      sub: ['bluetooth'],
    });
  });

  it('sorts and dedupes filter values so the same selection has ONE identity', () => {
    // The lists key the rows memo. Two URLs that ask for the same rows must
    // produce the same signature or a revisit silently re-fetches.
    const a = parse('?mfg=Nordic&mfg=TI');
    const b = parse('?mfg=TI&mfg=Nordic&mfg=TI');
    expect(a).toEqual(b);
    expect(categoryQuerySignature(a)).toBe(categoryQuerySignature(b));
  });

  it('drops blank filter values rather than sending an empty name', () => {
    expect(parse('?mfg=&mfg=TI&sub=').mfg).toEqual(['TI']);
    expect(parse('?mfg=&sub=').sub).toEqual([]);
  });

  it('an unknown sort is NOT sent to the server — it reads as the default', () => {
    expect(parse('?sort=stock').sort).toBeNull();
    expect(parse('?sort=').sort).toBeNull();
  });

  it('garbage pagination lands on page 1', () => {
    expect(parse('?p=0').page).toBe(1);
    expect(parse('?p=-4').page).toBe(1);
    expect(parse('?p=banana').page).toBe(1);
  });

  it('null sort is a real state, distinct from sku asc', () => {
    // The parent default is popular-desc server-side; claiming sku-asc in the
    // header would be the UI lying about the order it is showing.
    expect(parse('').sort).toBeNull();
    expect(parse('?sort=sku').sort).toBe('sku');
    expect(categoryQuerySignature(parse(''))).not.toBe(
      categoryQuerySignature(parse('?sort=sku')),
    );
  });
});

describe('writeCategoryQuery', () => {
  it('resets to page 1 whenever WHAT is listed changes', () => {
    expect(write('?p=7', { sort: 'qty1', dir: 'asc' })).toBe('sort=qty1');
    expect(write('?p=7', { q: 'lm358' })).toBe('q=lm358');
    expect(write('?p=7', { mfg: ['TI'] })).toBe('mfg=TI');
    expect(write('?p=7', { sub: ['bluetooth'] })).toBe('sub=bluetooth');
  });

  it('a page change alone keeps the sort and filters', () => {
    expect(write('?sort=qty1&dir=desc&mfg=TI', { page: 4 })).toBe(
      'sort=qty1&dir=desc&mfg=TI&p=4',
    );
  });

  it('writes defaults as ABSENT params, so the default view is the bare URL', () => {
    expect(write('?p=3&sort=sku&dir=desc&q=x&mfg=TI', { sort: null })).toBe('q=x&mfg=TI');
    expect(write('?sort=sku&dir=desc', { sort: 'sku', dir: 'asc' })).toBe('sort=sku');
    expect(write('?q=x', { q: '   ' })).toBe('');
    expect(write('?mfg=TI&mfg=Nordic', { mfg: [] })).toBe('');
    expect(write('?p=2', { page: 1 })).toBe('');
  });

  it('preserves params this page does not own', () => {
    // ?welcome=silver is the Stripe success_url; ?sponsor=1 opens the Silver
    // checkout ticket. A filter click must not eat either.
    expect(write('?welcome=silver&sponsor=1', { q: 'lm358' })).toBe(
      'welcome=silver&sponsor=1&q=lm358',
    );
  });

  it('replaces a filter list wholesale instead of appending to it', () => {
    expect(write('?mfg=TI&mfg=Nordic', { mfg: ['Vishay'] })).toBe('mfg=Vishay');
  });

  it('never writes a dir without a sort to hang it on', () => {
    expect(write('', { dir: 'desc' })).toBe('');
    expect(write('?sort=sku', { dir: 'desc' })).toBe('sort=sku&dir=desc');
  });
});

describe('categoryRequestQuery', () => {
  it('the default is the canonical first page — 25 rows, no sort, no filters', () => {
    expect(CANONICAL_CATEGORY_QUERY).toBe(
      'popular_page=1&popular_per_page=1&parts_page=1&parts_per_page=25',
    );
    expect(PAGE_SIZE).toBe(25);
  });

  it("index.html's hand-built LCP preload URL still matches it", () => {
    // The preload can't import: it runs at HTML parse time, before any module.
    // If these drift, the preloaded response is never reused and the page pays
    // a second round trip on every direct category load.
    const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
    expect(html).toContain(CANONICAL_CATEGORY_QUERY);
  });

  it('sends dir only alongside sort, and omits absent filters entirely', () => {
    expect(categoryRequestQuery({ ...DEFAULT_CATEGORY_QUERY, sort: 'qty10', dir: 'desc' })).toBe(
      'popular_page=1&popular_per_page=1&parts_page=1&parts_per_page=25&sort=qty10&dir=desc',
    );
    expect(categoryRequestQuery({ ...DEFAULT_CATEGORY_QUERY, dir: 'desc' })).toBe(
      CANONICAL_CATEGORY_QUERY,
    );
  });

  it('repeats mfg/sub rather than joining them — FastAPI reads repeated params', () => {
    const qs = categoryRequestQuery({
      ...DEFAULT_CATEGORY_QUERY,
      mfg: ['Texas Instruments', 'Nordic'],
      sub: ['bluetooth', 'rf-transceivers'],
    });
    expect(qs).toContain('mfg=Texas+Instruments&mfg=Nordic');
    expect(qs).toContain('sub=bluetooth&sub=rf-transceivers');
  });

  it('paginates server-side — page 5 asks for page 5, not a 500-row slab', () => {
    expect(categoryRequestQuery({ ...DEFAULT_CATEGORY_QUERY, page: 5 })).toContain(
      'parts_page=5&parts_per_page=25',
    );
    expect(CANONICAL_CATEGORY_QUERY).not.toContain('500');
  });

  it('every sort key the UI can emit is one the contract names', () => {
    expect([...SORT_KEYS]).toEqual([
      'sku',
      'desc',
      'mfg',
      'sub',
      'qty1',
      'qty10',
      'qty100',
      'qty1k',
      'popular',
    ]);
  });
});

describe('categoryQuerySignature', () => {
  it('separates page 5 from page 1 — the rows memo must never cross them', () => {
    const one = categoryQuerySignature(parse(''));
    const five = categoryQuerySignature(parse('?p=5&sort=qty100'));
    expect(one).not.toBe(five);
  });

  it('cannot be collided by punctuation in the search text', () => {
    const a = categoryQuerySignature(parse('?q=a%26m%3D1'));
    const b = categoryQuerySignature(parse('?q=a&m=1'));
    expect(a).not.toBe(b);
  });

  it('is order-independent for filter values', () => {
    expect(categoryQuerySignature(parse('?mfg=b&mfg=a'))).toBe(
      categoryQuerySignature(parse('?mfg=a&mfg=b')),
    );
  });
});

describe('isUnknownSortError', () => {
  it('recognises the contract 422 so the page can heal the URL', () => {
    expect(isUnknownSortError({ response: { status: 422, data: { detail: 'unknown_sort' } } }))
      .toBe(true);
  });

  it('leaves every other failure alone', () => {
    expect(isUnknownSortError({ response: { status: 500, data: { detail: 'unknown_sort' } } }))
      .toBe(false);
    expect(isUnknownSortError({ response: { status: 422, data: { detail: [{ msg: 'x' }] } } }))
      .toBe(false);
    expect(isUnknownSortError(new Error('Network Error'))).toBe(false);
    expect(isUnknownSortError(null)).toBe(false);
    expect(isUnknownSortError(undefined)).toBe(false);
  });
});
