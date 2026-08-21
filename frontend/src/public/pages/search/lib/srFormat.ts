// Pure formatting/ranking helpers for the search results page. No React, no
// DOM — unit-tested in srFormat.test.ts.

/** `lead_time_days` → "Nw" (spec §2: ceil(days / 7) weeks). Unknown → em dash. */
export function formatLeadTime(days: number | null | undefined): string {
  if (days == null) return '\u2014';
  return `${Math.ceil(days / 7)}w`;
}

/** Tiered price precision, matching the category PartsTable. Unknown → em dash. */
export function formatPrice(price: number | null | undefined): string {
  if (price == null) return '\u2014';
  if (price >= 100) return `$${price.toFixed(0)}`;
  if (price >= 1) return `$${price.toFixed(2)}`;
  return `$${price.toFixed(3)}`;
}

/** Thousands-separated integer for stock/MOQ cells. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** Lettermark initials for logo pads — kit `srInitials` verbatim. */
export function srInitials(name: string): string {
  return name
    .split(/[\s/]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/**
 * Display-only website trim for the suptile meta line (scheme + www. + trailing
 * slashes dropped). Never becomes an href — distributor surfaces link to /join.
 */
export function displayWebsite(website: string | null | undefined): string | null {
  if (website == null) return null;
  const trimmed = website
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');
  return trimmed === '' ? null : trimmed;
}

/** Empty-state distributor ordering: platinum > gold > silver > untiered. */
const TIER_ORDER: Record<string, number> = { platinum: 0, gold: 1, silver: 2 };

export function tierRank(tier: string | null | undefined): number {
  if (tier == null) return 3;
  return TIER_ORDER[tier.trim().toLowerCase()] ?? 3;
}
