export interface Subcategory {
  id: string;
  name: string;
  slug: string;
  icon: string;
  // Server sends it on category detail children; optional because older
  // cached shells may predate it. `| null` per the ?:-misses-null gotcha.
  parts_count?: number | null;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  icon: string;
  description?: string | null;
  // OWN-count only — parts attach to subcategories, so a top-level card's
  // real total is this plus the children's counts (summed client-side).
  parts_count?: number | null;
  children: Subcategory[];
}

export interface PartsPage {
  items: import('./part').PublicPart[];
  total: number;
  page: number;
  pages: number;
  per_page: number;
}

export type PopularPartsPage = PartsPage;

/**
 * Faceted-search counts for the category page's filter UI.
 *
 * Each list is computed with every filter applied EXCEPT its own, so choosing
 * one manufacturer never collapses the manufacturer list to that single
 * option. `total_unfiltered` is the category's true size — the number the
 * "All" chip and the sub-sheet show — while `parts.total` is what the current
 * filters leave.
 */
export interface CategoryFacets {
  total_unfiltered: number;
  manufacturers: { name: string; count: number }[];
  /** SLUG-keyed. Empty on a leaf category (nothing to group by). */
  subs: { slug: string; name: string; count: number }[];
}

/**
 * Everything on a category page that does NOT change when you sort, filter,
 * search or paginate: identity, the family tree, and the sponsor boards.
 *
 * Split out from the rows so the two can be cached independently — the chrome
 * by slug (paints the header/chips on the first frame of a revisit), the rows
 * by slug + query signature (so a `?p=5&sort=qty100` URL can never paint
 * page-1 rows).
 */
export interface CategoryChrome extends Category {
  // Parent carries its own children (siblings of `this`) so subcategory pages
  // can render the SubcategoryChips strip without an extra fetch — see
  // 2026-05-16 fix for intra-category navigation on leaf pages.
  parent: {
    id: string;
    name: string;
    slug: string;
    icon: string;
    children: Subcategory[];
  } | null;
  // On a child category this is the single GOLD sponsor (newest visible); the
  // Gold-tier SponsorBlock consumes it. Null when unsold.
  sponsor: import('./sponsor').Sponsor | null;
  // The child category's SILVER sponsors (many) — feeds the SilverPartners
  // directory in the tier row. Empty on parent pages and when unsold.
  silver: import('./sponsor').PartnerSupplier[];
}

export interface CategoryDetail extends CategoryChrome {
  // ONE scope-aware block: a leaf's own parts, a parent's rollup over
  // self + children (each item still carries sub_slug + category names).
  // `total` is the FILTERED total — the header count, and the number the page
  // used to lie about while it truncated at 500 rows client-side.
  parts: PartsPage;
  // Legacy rollup block, unchanged and no longer read by this page: the page
  // asks for popular_per_page=1 and takes its parent ordering from `parts`
  // (sort=popular) instead. Kept because test_category_hierarchy pins it.
  popular_parts: PopularPartsPage;
  // Optional so a frontend deployed ahead of the API degrades (no counts, no
  // filter options) instead of white-screening. `?:` misses null, hence the
  // explicit `| null` — read it with `!= null`.
  facets?: CategoryFacets | null;
}

export interface CategoryPartners {
  // The resolved TOP-LEVEL category (a child slug resolves to its parent) and
  // its single PLATINUM Category Sponsor — fed to the always-present banner.
  // `platinum` is null when the slot is unsold (→ Open-Placement board).
  slug: string;
  name: string;
  platinum: import('./sponsor').PlatinumSponsor | null;
}
