/**
 * The public catalog totals, straight from `GET /api/stats/`.
 *
 * Raw integers on purpose — the server counts, the client formats. Rounding
 * 314,253 into "314.3K" is a presentation decision that belongs beside the
 * component that shows it (`@public/pages/about/siteStats`), not baked into a
 * payload a second consumer might want at full precision.
 */
export interface SiteStats {
  /** Parts in the catalog. */
  parts: number;
  /** Suppliers holding at least one part listing — see the route's docstring
   *  for why a directory row with no listings is not a distributor. */
  distributors: number;
  /** Top-level categories. */
  categories: number;
  /** Child categories, across every parent. */
  subcategories: number;
}
