// MIRROR NOTICE: these case names and inputs are shared with
// api/tests/test_bom_recommend.py. Editing the +20% rule means editing BOTH
// tables in the same change — the password-policy discipline.

import { describe, expect, it } from 'vitest';
import {
  SPONSOR_BAND,
  priceAt,
  recommend,
  tierRankFromOffers,
  type Offer,
  type TierRank,
} from './priceBreaks';

function offer(
  supplierId: string,
  price: number,
  stock = 100,
  breaks: [number, number][] = [],
  stale = false,
): Offer {
  return {
    supplier_id: supplierId,
    stock_quantity: stock,
    unit_price: price,
    breaks: breaks.map(([min_quantity, unit_price]) => ({ min_quantity, unit_price })),
    price_stale: stale,
  };
}

const PLATINUM: TierRank = { 'sp-plat': [0, '2026-01-01'] };
const GOLD: TierRank = { 'sp-gold': [1, '2026-01-01'] };

describe('priceAt', () => {
  it('below_smallest_min_uses_base_price', () => {
    const o = offer('s1', 0.5, 100, [
      [10, 0.4],
      [100, 0.3],
    ]);
    expect(priceAt(o, 1)).toBe(0.5);
  });

  it('largest_min_at_or_below_qty_wins', () => {
    const o = offer('s1', 0.5, 100, [
      [10, 0.4],
      [100, 0.3],
    ]);
    expect(priceAt(o, 10)).toBe(0.4);
    expect(priceAt(o, 99)).toBe(0.4);
    expect(priceAt(o, 100)).toBe(0.3);
    expect(priceAt(o, 5000)).toBe(0.3);
  });
});

describe('recommend', () => {
  it('case_sponsor_within_band_wins', () => {
    const offers = [offer('cheap', 1.0), offer('sp-plat', 1.19)];
    expect(recommend(offers, 1, PLATINUM)).toBe('sp-plat');
  });

  it('case_sponsor_at_exact_band_edge_wins', () => {
    const offers = [offer('cheap', 1.0), offer('sp-plat', 1.2)];
    expect(recommend(offers, 1, PLATINUM)).toBe('sp-plat');
  });

  it('case_sponsor_outside_band_loses_to_cheapest', () => {
    const offers = [offer('cheap', 1.0), offer('sp-plat', 1.21)];
    expect(recommend(offers, 1, PLATINUM)).toBe('cheap');
  });

  it('case_highest_tier_sponsor_is_the_one_band_tested', () => {
    // Platinum outside the band does NOT fall through to gold-in-band:
    // the spec band-tests only the top sponsor, then falls to cheapest.
    const offers = [offer('cheap', 1.0), offer('sp-plat', 1.5), offer('sp-gold', 1.1)];
    const rank: TierRank = { ...PLATINUM, ...GOLD };
    expect(recommend(offers, 1, rank)).toBe('cheap');
  });

  it('case_tier_tie_goes_to_oldest_sponsorship', () => {
    const offers = [offer('sp-old', 1.1), offer('sp-new', 1.05)];
    const rank: TierRank = { 'sp-old': [1, '2025-01-01'], 'sp-new': [1, '2026-06-01'] };
    expect(recommend(offers, 1, rank)).toBe('sp-old');
  });

  it('case_no_sponsor_cheapest_wins', () => {
    const offers = [offer('a', 2.0), offer('b', 1.0)];
    expect(recommend(offers, 1, {})).toBe('b');
  });

  it('case_out_of_stock_is_never_recommended', () => {
    const offers = [offer('sp-plat', 1.0, 0), offer('b', 5.0)];
    expect(recommend(offers, 1, PLATINUM)).toBe('b');
  });

  it('case_all_out_of_stock_returns_none', () => {
    const offers = [offer('a', 1.0, 0)];
    expect(recommend(offers, 1, {})).toBeNull();
  });

  it('case_price_tie_prefers_sponsor_then_stock', () => {
    const offers = [offer('plain', 1.0, 50), offer('sp-gold', 1.0, 10)];
    expect(recommend(offers, 1, GOLD)).toBe('sp-gold');
    const noRank = [offer('small', 1.0, 10), offer('big', 1.0, 500)];
    expect(recommend(noRank, 1, {})).toBe('big');
  });

  it('case_band_compares_at_the_line_qty_break', () => {
    // At qty 100 the sponsor's break brings it inside the band even though
    // its base price is far outside.
    const offers = [
      offer('cheap', 1.0, 100, [[100, 1.0]]),
      offer('sp-plat', 2.0, 100, [[100, 1.15]]),
    ];
    expect(recommend(offers, 100, PLATINUM)).toBe('sp-plat');
    expect(recommend(offers, 1, PLATINUM)).toBe('cheap');
  });

  it('case_stale_price_still_recommendable', () => {
    // price_stale is a DISPLAY flag (hatched right rail); it does not
    // change the pick — honesty is rendered, not silently re-ranked.
    const offers = [offer('stale', 1.0, 100, [], true), offer('fresh', 1.5)];
    expect(recommend(offers, 1, {})).toBe('stale');
  });

  it('band_constant_is_the_documented_twenty_percent', () => {
    expect(SPONSOR_BAND).toBe(1.2);
  });
});

describe('tierRankFromOffers', () => {
  it('maps the server-stamped tier strings and drops unsponsored suppliers', () => {
    const rank = tierRankFromOffers([
      { supplier_id: 'a', tier: 'platinum' },
      { supplier_id: 'b', tier: 'Gold' },
      { supplier_id: 'c', tier: 'silver' },
      { supplier_id: 'd', tier: null },
    ]);
    expect(rank).toEqual({ a: [0, 'a'], b: [1, 'b'], c: [2, 'c'] });
    expect(rank.d).toBeUndefined();
  });

  it('keeps a supplier at its best (lowest) rank across repeated offers', () => {
    const rank = tierRankFromOffers([
      { supplier_id: 'a', tier: 'gold' },
      { supplier_id: 'a', tier: 'platinum' },
    ]);
    expect(rank.a).toEqual([0, 'a']);
  });

  it('feeds recommend so a stamped sponsor wins inside the band', () => {
    const offers = [offer('cheap', 1.0), offer('sp', 1.15)];
    const rank = tierRankFromOffers([
      { supplier_id: 'cheap', tier: null },
      { supplier_id: 'sp', tier: 'gold' },
    ]);
    expect(recommend(offers, 1, rank)).toBe('sp');
  });
});
