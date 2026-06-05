// Session-scoped memo for the Preferred Partners banner payload, keyed by the
// top-level category slug.
//
// Why: the banner lives inside CategoryPage, which remounts on every subcategory
// navigation. Without this, each remount re-fetches /partners and the banner
// pops in a beat later, shoving the parts table down (a ~0.08 layout shift on
// every nav). Reading the memo SYNCHRONOUSLY in the banner's useState
// initializer means the banner renders with data on its very first frame — no
// pop-in, no layout shift — while still browsing within a category.
//
// Invalidation: cleared by bustSponsorCaches() (admin/services/swCache.ts) on
// every sponsor-affecting mutation, alongside the SW caches — so the memo can
// never short-circuit a stale banner (preserves the single-source-of-truth
// invariant from the 2026-06-03 sponsor work). Module-scoped: lives for the SPA
// session, dies on full reload. Tiny (≤ one entry per top-level category).
const cache = new Map<string, unknown>();

/** Synchronously read a cached partners payload, or undefined on a miss. */
export function getPartnersMemo<T>(slug: string): T | undefined {
  return cache.get(slug) as T | undefined;
}

/** Cache a partners payload for a top-level slug. */
export function setPartnersMemo<T>(slug: string, data: T): void {
  cache.set(slug, data);
}

/** Drop the whole memo. Called from bustSponsorCaches() on any sponsor mutation. */
export function clearPartnersMemo(): void {
  cache.clear();
}
