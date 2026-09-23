// Rows for the admin's price dropdowns (sales-code discount, billing "change
// discount", quote price). Dollars lead, the discount follows — "$8,000 | 5%"
// (owner, 2026-09-23). Every dollar figure here comes from the SERVER's quote
// ladder (`GET /api/admin/quote-ladder`); nothing in the browser computes a
// price (spec §4). A code's extra discount is a percent of LIST, so it is
// said as a percent, never as "points".

import type { QuoteLadderTier } from '@admin/types/admin';

export type PriceTier = 'gold' | 'platinum';

export interface PriceRowModel {
  /** code_points: 0 = the Founder's Deal, 1–15 = extra percent off list. */
  value: number;
  /** One price, or Gold + Platinum when a code can buy either tier. */
  prices: { tier: PriceTier | null; usd: number }[];
  /** The 30%-of-list floor set this price (so two percents can share it). */
  capped: boolean;
  /** The subscription is billed at this row today. */
  current: boolean;
}

export function money(usd: number): string {
  return `$${usd.toLocaleString('en-US')}`;
}

export function percentLabel(points: number): string {
  return points === 0 ? 'Founder’s Deal' : `${points}%`;
}

const TIER_NAME: Record<PriceTier, string> = { gold: 'Gold', platinum: 'Platinum' };

/** Plain text for screen readers, typeahead and tests: "$8,000 | 5%". */
export function priceRowText(row: PriceRowModel): string {
  const pct = percentLabel(row.value);
  if (row.prices.length === 0) return pct;
  const dollars = row.prices
    .map((p) => (p.tier && row.prices.length > 1 ? `${TIER_NAME[p.tier]} ${money(p.usd)}` : money(p.usd)))
    .join(' · ');
  return `${dollars} | ${pct}`;
}

export function priceRows(
  ladder: QuoteLadderTier,
  opts: { current?: number | null; includeFounder?: boolean } = {},
): PriceRowModel[] {
  const { current = null, includeFounder = true } = opts;
  return ladder.options
    .filter((o) => includeFounder || o.code_points > 0)
    .map((o) => ({
      value: o.code_points,
      prices: [{ tier: null, usd: o.price_usd }],
      capped: o.code_points > 0 && o.price_usd <= ladder.floor,
      current: current != null && o.code_points === current,
    }));
}

/** A code that fits either tier: both prices on one row, gold first. */
export function dualPriceRows(
  tiers: Partial<Record<PriceTier, QuoteLadderTier>>,
  points: number[],
): PriceRowModel[] {
  return points.map((p) => {
    const prices: PriceRowModel['prices'] = [];
    let capped = false;
    for (const tier of ['gold', 'platinum'] as const) {
      const ladder = tiers[tier];
      const option = ladder?.options.find((o) => o.code_points === p);
      if (!ladder || !option) continue;
      prices.push({ tier, usd: option.price_usd });
      capped = capped || (p > 0 && option.price_usd <= ladder.floor);
    }
    // Half a pair would read as the only price — show none until both load.
    return { value: p, prices: prices.length === 2 ? prices : [], capped, current: false };
  });
}

/**
 * Index of the option a typed buffer selects: an exact `keys` hit first (so
 * "5" means 5%, "12" means 12%), then a case-insensitive label prefix. -1 when
 * nothing matches.
 */
export function typeaheadMatch(
  buffer: string,
  options: { label: string; keys?: string[] }[],
): number {
  const q = buffer.trim().toLowerCase();
  if (!q) return -1;
  const exact = options.findIndex((o) => o.keys?.some((k) => k.toLowerCase() === q));
  if (exact >= 0) return exact;
  return options.findIndex((o) => o.label.toLowerCase().startsWith(q));
}
