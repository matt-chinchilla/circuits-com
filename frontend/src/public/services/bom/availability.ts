// What the right rail claims about GETTING the part.
//
// Extracted from BomTable so it can be tested under the house vitest harness,
// which is unit-logic only. That constraint is the reason this returns a STATE
// TOKEN and not a CSS class: the classnames live in BomTable.module.scss, they
// belong to the component, and importing a `.module.scss` into `lib/` would
// destroy the very testability the extraction exists for. The component owns
// the `state -> styles.*` map; this owns the rule and the words.
//
// WHAT IS DELIBERATELY ABSENT: price staleness. The rail used to test a
// `price_stale` flag ABOVE both stock branches, so a "stale" row printed
// "price not refreshed in 30 days" and its stock figure vanished. That flag
// was really reading row age (`part_listings.last_updated` is stamped at
// INSERT and never bumped), and it was about to swallow the entire table:
// measured on the local catalog, 38,442 of 167,823 listings read stale on
// 2026-08-24, 97,580 on 2026-09-20, and all 167,823 on 2026-09-24 — after
// which no BOM row anywhere would have reported stock at all.
//
// Provenance is now its own, separate, non-blocking label (priceSource.ts).
// Availability answers ONE question and answers it always.

export type AvailabilityState = 'none' | 'partial' | 'full';

export interface Availability {
  state: AvailabilityState;
  /** The rail is a bare coloured strip, so this is its accessible name and
   *  its tooltip — the only form in which a screen reader or a hovering
   *  reader gets the number. */
  label: string;
}

/**
 * `stockQuantity` is nullable because a row can have no chosen offer at all
 * (nothing matched, or the reader pinned a supplier this BOM does not carry).
 * That is `none`, not a crash and not an optimistic blank: the rail has to say
 * red rather than show "only 0 of 40" in the partial colour.
 */
export function availability(stockQuantity: number | null, lineQty: number): Availability {
  if (stockQuantity == null || stockQuantity <= 0) {
    return { state: 'none', label: 'Availability: nothing in stock' };
  }
  if (stockQuantity >= lineQty) {
    return {
      state: 'full',
      label: `Availability: ${stockQuantity.toLocaleString('en-US')} in stock`,
    };
  }
  return {
    state: 'partial',
    label: `Availability: only ${stockQuantity.toLocaleString('en-US')} of ${lineQty} in stock`,
  };
}
