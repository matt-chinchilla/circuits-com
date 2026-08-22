// Pure formatting/ranking helpers for the search results page. No React, no
// DOM — unit-tested in srFormat.test.ts.

import { SPONSOR_TIER_ORDER, normalizeTier } from '@shared/utils/sponsorTier';

// Price + RoHS cells format identically to the category PartsTable — single
// home @public/services/format, re-exported for the table and the tests here.
export { formatPrice, formatRohs } from '@public/services/format';

/** `lead_time_days` → "Nw" (spec §2: ceil(days / 7) weeks). Unknown → em dash. */
export function formatLeadTime(days: number | null | undefined): string {
  if (days == null) return '—';
  return `${Math.ceil(days / 7)}w`;
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
 * slashes dropped, PATH KEPT — deliberately different from @shared/utils/url
 * displayHost, which is host-only; do not "deduplicate" them). Never becomes
 * an href — distributor surfaces link to /join.
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
export function tierRank(tier: string | null | undefined): number {
  return SPONSOR_TIER_ORDER[normalizeTier(tier)] ?? 3;
}
