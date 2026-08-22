// Sponsor tier ranking shared across scopes (search empty-state ordering,
// BOM recommend, drawer badges).
//
// NOTE: distinct from @admin/services/sponsorTier on purpose — that home
// normalizes free-string tiers INTO TitleCase labels for admin UI; this one
// is the lowercase rank dict for ordering. Do not merge them.

/** Rank by tier, platinum first. Keys absent from the dict (untiered or
 *  unknown strings) get no rank — callers decide the fallback. */
export const SPONSOR_TIER_ORDER: Record<string, number> = {
  platinum: 0,
  gold: 1,
  silver: 2,
};

/** Normalize a stored tier string for SPONSOR_TIER_ORDER lookup. */
export function normalizeTier(tier: string | null | undefined): string {
  return (tier ?? '').trim().toLowerCase();
}
