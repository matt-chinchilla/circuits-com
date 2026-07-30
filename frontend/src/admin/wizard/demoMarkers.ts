// ⚠ THE DATA-SAFETY MARKERS. Everything the wizard's cleanup deletes is
// deleted by id, and an id can only ever be as trustworthy as the bookkeeping
// that recorded it. These predicates are the LAST line of defence: cleanup
// re-fetches the entity and refuses to delete it unless the row still looks
// like tour data. A mis-tracked id (a stale localStorage key, a Back-button
// replay, a hand-edited value) therefore cannot destroy a customer's supplier
// or part — the worst case is a demo row that survives the tour.
//
// SINGLE home for the markers so the tour copy and the delete guard can never
// disagree: flows.tsx builds DEMO_SUPPLIER/DEMO_PART from these constants, and
// demoCleanup.ts gates every cascading DELETE on the matching predicate. This
// module is deliberately a LEAF (no imports) — demoCleanup can't import
// flows.tsx, which imports demoCleanup, without creating a cycle.

/** The company name the add-supplier tour suggests. */
export const DEMO_SUPPLIER_NAME = 'Demo Components Inc.';

// Every SKU any tour writes starts with this — the created Part's `sku`, the 3
// CSV rows, AND the attach tour's distributor order code (`PartListing.sku`,
// autofilled from flows.tsx's DEMO_LISTING_SKU). One prefix for all three so
// there is ONE predicate below and no way for a delete guard to disagree with
// the tour copy about what "ours" means.
export const DEMO_PART_SKU_PREFIX = 'DEMO-';

// Tolerant on purpose: the tour SUGGESTS the name but the user can type their
// own, and a tour-created "Demo Widgets" would otherwise be un-cleanable. Any
// other name reads as real data and is left strictly alone.
export function isDemoSupplierName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed === DEMO_SUPPLIER_NAME) return true;
  // 'Demo ' / 'Demo-' prefixed, case-insensitive. NOT a bare 'demo' substring:
  // a real supplier could legitimately be called "Demolition Supply Co".
  return /^demo[\s-]/i.test(trimmed);
}

// Gates BOTH `Part.sku` and `PartListing.sku` — see DEMO_PART_SKU_PREFIX. A
// missing/null sku is NOT ours: unprovable is hands-off, so an unmarked
// distributor listing is left attached rather than detached on a guess.
export function isDemoPartSku(sku: string | null | undefined): boolean {
  if (typeof sku !== 'string') return false;
  return sku.trim().toUpperCase().startsWith(DEMO_PART_SKU_PREFIX);
}
