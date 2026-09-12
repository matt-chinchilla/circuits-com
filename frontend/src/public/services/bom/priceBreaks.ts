// The client home of the +20% sponsor-preference rule.
//
// MIRROR NOTICE: this module is one of the rule's TWO HOMES — the other is
// api/app/services/bom_match.py (SPONSOR_BAND / price_at / recommend). The
// case names and inputs in priceBreaks.test.ts are shared byte-for-byte with
// api/tests/test_bom_recommend.py; editing the rule means editing BOTH homes
// and BOTH tables in the same change, exactly like the password policy.
//
// The server picks at the break ladder's base qty (1); the client re-runs the
// IDENTICAL rule at the real line qty as the user edits it.

import { SPONSOR_TIER_ORDER, normalizeTier } from '@shared/utils/sponsorTier';

/** MIRROR of api/app/services/bom_match.py SPONSOR_BAND. 1.20 == "within
 *  +20% of the best in-stock price". */
export const SPONSOR_BAND = 1.2;

export interface OfferBreak {
  min_quantity: number;
  unit_price: number;
}

export interface Offer {
  supplier_id: string;
  stock_quantity: number;
  unit_price: number;
  breaks: OfferBreak[];
  /**
   * Where the price came from, NOT how fresh it is. `live` means a
   * distributor API is registered for that supplier and we hold a key for it
   * today; `static` means the number is real but nothing re-reads it. It
   * replaced a staleness boolean that was really measuring row age — see
   * `_offers_for_part` in api/app/services/bom_match.py for the measurements.
   *
   * OPTIONAL, and that is the one place this type deliberately does NOT
   * mirror the Python `Offer` (which always knows, because it is built from a
   * live row). Here the value can be genuinely absent: a share link created
   * before this field existed replays its stored offers verbatim, and
   * `share.ts` does not — and should not — reject them for lacking it. So
   * every render site must branch THREE ways. Rendering absent as `static`
   * would tell a reader that a live distributor's price is unmaintained,
   * which is the exact libel this field was added to prevent.
   */
  price_source?: 'live' | 'static';
}

/** supplier_id -> [tier order (platinum 0 / gold 1 / silver 2), tiebreak]. */
export type TierRank = Record<string, [number, string]>;

/** Unit price at `qty`: the largest break whose min_quantity is at or below
 *  qty, else the base price. */
export function priceAt(offer: Offer, qty: number): number {
  let price = offer.unit_price;
  const ladder = [...offer.breaks].sort(
    (a, b) => a.min_quantity - b.min_quantity || a.unit_price - b.unit_price,
  );
  for (const step of ladder) {
    if (step.min_quantity <= qty) {
      price = step.unit_price;
    } else {
      break;
    }
  }
  return price;
}

/** The pick for one line at `lineQty`: the top-ranked sponsor when it prices
 *  within SPONSOR_BAND of the best in-stock price, otherwise the cheapest
 *  (sponsor first on a price tie, then deepest stock). Null when nothing is
 *  in stock. `price_source` is a display field — it never re-ranks. */
export function recommend(
  offers: Offer[],
  lineQty: number,
  tierRank: TierRank,
): string | null {
  const inStock = offers.filter((o) => o.stock_quantity > 0);
  if (inStock.length === 0) return null;
  const best = Math.min(...inStock.map((o) => priceAt(o, lineQty)));
  const sponsored = inStock
    .filter((o) => tierRank[o.supplier_id] != null)
    .sort((a, b) => {
      const ra = tierRank[a.supplier_id];
      const rb = tierRank[b.supplier_id];
      if (ra[0] !== rb[0]) return ra[0] - rb[0];
      if (ra[1] !== rb[1]) return ra[1] < rb[1] ? -1 : 1;
      return priceAt(a, lineQty) - priceAt(b, lineQty);
    });
  const top = sponsored[0];
  if (top != null && priceAt(top, lineQty) <= SPONSOR_BAND * best) {
    return top.supplier_id;
  }
  const ordered = [...inStock].sort((a, b) => {
    const byPrice = priceAt(a, lineQty) - priceAt(b, lineQty);
    if (byPrice !== 0) return byPrice;
    const sponsorA = tierRank[a.supplier_id] != null ? 0 : 1;
    const sponsorB = tierRank[b.supplier_id] != null ? 0 : 1;
    if (sponsorA !== sponsorB) return sponsorA - sponsorB;
    return b.stock_quantity - a.stock_quantity;
  });
  return ordered[0].supplier_id;
}

/** Build the rank map from the server-stamped `tier` strings. The server
 *  already folded the oldest-sponsorship ordering into WHICH supplier it
 *  stamps, so the supplier_id is the deterministic tiebreak here and
 *  equal-rank behavior stays consistent between the two homes. */
export function tierRankFromOffers(
  offers: { supplier_id: string; tier: string | null }[],
): TierRank {
  const rank: TierRank = {};
  for (const offer of offers) {
    const order = SPONSOR_TIER_ORDER[normalizeTier(offer.tier)];
    if (order == null) continue;
    const current = rank[offer.supplier_id];
    if (current == null || order < current[0]) {
      rank[offer.supplier_id] = [order, offer.supplier_id];
    }
  }
  return rank;
}
