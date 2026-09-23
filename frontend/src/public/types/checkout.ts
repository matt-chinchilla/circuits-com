// Wire shapes of the public checkout API (api/app/routes/checkout.py, spec
// 2026-09-23 §7). Every price here is computed by the server's sales_pricing;
// the client only renders it.

export type ExclusiveTier = 'gold' | 'platinum';

/** One row of GET /api/checkout/exclusive/slots — taken slots are omitted server-side. */
export interface SlotRow {
  category_id: string;
  name: string;
  parent_name: string | null;
  path: string;
  /** `taken` = occupied (R16 — Paused still pays); listed, never selectable. */
  state: 'open' | 'held' | 'taken';
  held_until: string | null;
}

export interface SlotsResponse {
  tier: string;
  list_usd: number;
  founder_usd: number;
  slots: SlotRow[];
}

/** POST /api/checkout/quote — every number is the server's. */
export interface QuoteResult {
  tier: string;
  list_usd: number;
  founder_usd: number;
  price_usd: number;
  savings_usd: number;
  code: null | { accepted: boolean; points: number | null; message: string | null };
  slot_state: 'open' | 'held' | 'taken' | null;
}

export interface ExclusiveCheckoutResult {
  url: string;
  release_token: string;
  held_until: string;
}
