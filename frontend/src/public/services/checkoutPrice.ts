// The Silver number a buyer is shown is the number they are CHARGED.
//
// Since the Founder's Deal (spec 2026-09-23 §7) the Silver probes carry two
// prices: `monthly_total` (the LIST, kept for bundles cached before the change)
// and `price_usd` (what Stripe charges). Render `price_usd`; fall back to
// `monthly_total` only for an old API that does not send it. No literal ever —
// null when the server gave us nothing usable.

export interface SilverPriceProbe {
  monthly_total: number;
  price_usd?: number | null;
}

export function chargedMonthly(probe: SilverPriceProbe | null | undefined): number | null {
  if (!probe) return null;
  if (typeof probe.price_usd === 'number') return probe.price_usd;
  return typeof probe.monthly_total === 'number' ? probe.monthly_total : null;
}
