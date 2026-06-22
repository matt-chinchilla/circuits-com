// Session cache for the per-category CategoryDetail payload (parts + popular
// parts + counts + banner data), keyed by the category slug that drives the API
// fetch. CategoryPage remounts on every (sub)category navigation — it's keyed by
// pathname via the ErrorBoundary — so without this the parts list AND the "number
// of parts" count re-fetch behind a loading skeleton each time (the white flash).
// Reading the memo SYNCHRONOUSLY in the page's useState initializer paints the
// parts + counts on the first frame of a warm navigation (no flash), while the
// page revalidates in the background. Mirrors partnersMemo / categoryShellMemo.
//
// Generic (Map<string, unknown> + get<T>) so this @shared module never imports the
// @public CategoryDetail type — the shared ↛ public/admin boundary rule.
//
// Invalidation: cleared by bustSponsorCaches() (admin/services/swCache.ts) on any
// sponsor/supplier OR part mutation, alongside the SW caches — so an admin edit is
// reflected on the next navigation and the memo can never serve stale parts/counts.
//
// Bounded (LRU, MAX entries): each entry can hold up to 500 parts, so an unbounded
// memo would accumulate real heap across a long browsing session (notably on
// mobile, where memory pressure already matters). The LRU keeps the most recently
// visited categories instant and evicts the rest; everything resets on full reload.
const MAX = 12;
const cache = new Map<string, unknown>();

/** Synchronously read a cached CategoryDetail (LRU-touch), or undefined on a miss. */
export function getCategoryDetailMemo<T>(slug: string): T | undefined {
  const value = cache.get(slug);
  if (value !== undefined) {
    cache.delete(slug);
    cache.set(slug, value); // move to most-recently-used
  }
  return value as T | undefined;
}

/** Cache a CategoryDetail for a slug, evicting the least-recently-used past MAX. */
export function setCategoryDetailMemo<T>(slug: string, data: T): void {
  cache.delete(slug);
  cache.set(slug, data);
  if (cache.size > MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Drop the whole memo. Called from bustSponsorCaches() on any public-data mutation. */
export function clearCategoryDetailMemo(): void {
  cache.clear();
}
