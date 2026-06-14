import type { SponsorTier } from '@admin/types/admin';

// Sponsor `tier` is a free-form string column (no DB enum): admin-created rows
// are TitleCase, but legacy/seed rows can be lowercase ('platinum'/'gold'). So
// EVERY client-side tier comparison must normalize casing first — see CLAUDE.md
// "Sponsor tier casing". One normalizer, shared by every read site (the Suppliers
// sponsorship badge AND the Sponsors list count/filter/badge), so a third
// hand-rolled, drift-prone casing check never appears.

export const SPONSOR_TIER_RANK: Record<SponsorTier, number> = {
  Platinum: 3,
  Gold: 2,
  Silver: 1,
};

// Canonical TitleCase tier, or null for anything outside the live set
// (empty/nullish input, or a dropped tier like the pre-013 'Featured').
export function normalizeSponsorTier(
  tier: string | null | undefined,
): SponsorTier | null {
  if (!tier) return null;
  const key = (tier.charAt(0).toUpperCase() +
    tier.slice(1).toLowerCase()) as SponsorTier;
  return key in SPONSOR_TIER_RANK ? key : null;
}
