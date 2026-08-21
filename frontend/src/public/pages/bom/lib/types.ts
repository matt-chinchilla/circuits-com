// Wire types for the BOM tool. These mirror the row dict built by
// api/app/services/bom_match.py `build_row` — the ONE row shape both
// /bom/match and the resolve stream emit. Keep them in step with it.
//
// Every optional number is `number | null`, never `field?: number`: Python
// None serializes to null, and `?:` only catches undefined (house gotcha).

import type { Offer, OfferBreak } from './priceBreaks';

export type { OfferBreak };

/** One distributor's listing for a part. `Offer` (priceBreaks.ts) is the pure
 *  ranking subset of this — a BomOffer is assignable to it. */
export interface BomOffer extends Offer {
  supplier_name: string;
  supplier_website: string | null;
  /** Normalized lowercase tier, or null for an unsponsored supplier. */
  tier: string | null;
  currency: string;
}

export interface BomPartInfo {
  id: string;
  sku: string;
  slug: string | null;
  manufacturer_name: string | null;
  description: string | null;
  package: string | null;
  lifecycle_status: string | null;
  /** False means UNVERIFIED — it must never render as "Active" (spec §5). */
  lifecycle_verified: boolean;
  image_url: string | null;
  datasheet_url: string | null;
}

/** Server-side match outcomes. `exact_live` is a resolve-stream result. */
export type BomRowStatus = 'exact' | 'approx' | 'no_match' | 'exact_live';

export interface BomRow {
  index: number;
  status: BomRowStatus;
  approx_reason: string | null;
  package_warning: string | null;
  resolve_query: string | null;
  part: BomPartInfo | null;
  recommended_supplier_id: string | null;
  offers: BomOffer[];
}

/** Identity fields only — D7: quantities, designators and the file itself
 *  never leave the browser, and the server schema forbids extras. */
export interface MatchLineIn {
  index: number;
  mpn: string | null;
  value: string | null;
  footprint: string | null;
  description: string | null;
  manufacturer: string | null;
}

export interface MissIn {
  index: number;
  query: string;
  mpn: string | null;
}

export type ResolveEventKind = 'resolved' | 'not_found' | 'resolve_unavailable';

export interface ResolveEvent {
  kind: ResolveEventKind;
  index: number;
  detail: string | null;
  row: BomRow | null;
}

export interface ShareCreated {
  slug: string;
  expires_at: string;
}

export interface SharePayloadEnvelope {
  payload: unknown;
  created_at: string | null;
  expires_at: string;
}
