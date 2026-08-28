// Session cache for the category page's payload, in TWO parts, because the two
// halves have different identities.
//
// CategoryPage remounts on every (sub)category navigation — it's keyed by
// pathname via the ErrorBoundary — so without a memo the header, chips, counts
// and rows all re-fetch behind a loading skeleton each time (the white flash).
// Reading the memo SYNCHRONOUSLY in the page's useState initializers paints on
// the first frame of a warm navigation, while the page revalidates behind it.
// Mirrors partnersMemo / categoryShellMemo.
//
//   CHROME — identity, family tree, sponsor boards. Keyed by SLUG. This is the
//   half that makes a revisit paint instantly, and it is the same for every
//   sort/filter/page the visitor picks.
//
//   ROWS — one page of parts plus the facet counts that describe it. Keyed by
//   slug + a normalized query signature (see @public/services/categoryQuery),
//   because sorting, filtering and paging are SERVER-side now: a
//   ?p=5&sort=qty100 URL must never paint page-1-sku-asc rows. That was the
//   whole reason a single slug-keyed memo could not survive this rework.
//
// Generic (Map<string, unknown> + get<T>) so this @shared module never imports
// the @public CategoryDetail types — the shared ↛ public/admin boundary rule.
//
// Invalidation: clearCategoryDetailMemo() drops BOTH maps, and is called by
// bustSponsorCaches() (admin/services/swCache.ts) on any sponsor/supplier OR
// part mutation, alongside the SW caches — so an admin edit is reflected on the
// next navigation and neither map can serve stale parts or counts.
//
// Bounded (LRU): unbounded memos accumulate real heap across a long browsing
// session, notably on mobile. Chrome entries are small but few categories are
// visited; rows entries are ~25 parts each and MULTIPLY per category (every
// page, sort and filter combination is its own key), so they get their own,
// larger cap. Everything resets on a full reload.
const CHROME_MAX = 12;
const ROWS_MAX = 24;

const chromeCache = new Map<string, unknown>();
const rowsCache = new Map<string, unknown>();

function readLru<T>(cache: Map<string, unknown>, key: string): T | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value); // move to most-recently-used
  }
  return value as T | undefined;
}

function writeLru<T>(cache: Map<string, unknown>, key: string, data: T, max: number): void {
  cache.delete(key);
  cache.set(key, data);
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** The rows-cache key. Two arguments so no caller can invent its own spelling. */
export function categoryRowsKey(slug: string, signature: string): string {
  return `${slug}?${signature}`;
}

/** Synchronously read a cached category chrome (LRU-touch), or undefined. */
export function getCategoryChromeMemo<T>(slug: string): T | undefined {
  return readLru<T>(chromeCache, slug);
}

/** Cache a category's chrome, evicting the least-recently-used past the cap. */
export function setCategoryChromeMemo<T>(slug: string, data: T): void {
  writeLru(chromeCache, slug, data, CHROME_MAX);
}

/** Synchronously read a cached rows page by `categoryRowsKey`, or undefined. */
export function getCategoryRowsMemo<T>(key: string): T | undefined {
  return readLru<T>(rowsCache, key);
}

/** Cache one rows page, evicting the least-recently-used past the cap. */
export function setCategoryRowsMemo<T>(key: string, data: T): void {
  writeLru(rowsCache, key, data, ROWS_MAX);
}

/**
 * Drop BOTH maps. Called from bustSponsorCaches() on any public-data mutation —
 * clearing only one would leave the page painting a stale half.
 */
export function clearCategoryDetailMemo(): void {
  chromeCache.clear();
  rowsCache.clear();
}
