// Wire types for the BOM tool. These mirror the row dict built by
// api/app/services/bom_match.py `build_row` — the ONE row shape both
// /bom/match and the resolve stream emit. Keep them in step with it.
//
// Every optional number is `number | null`, never `field?: number`: Python
// None serializes to null, and `?:` only catches undefined (house gotcha).

import type { ParsedBomLine } from './parseBom';
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
  /**
   * When this offer ENTERED THE CATALOG — never "when the price was read".
   *
   * The server sends `part_listings.last_updated`, which has a `default=` and
   * no `onupdate=`: it is stamped at INSERT and no writer bumps it. So it can
   * under-claim, and does — 1,352 Mouser listings still carry the 2026-06-03
   * seed date and 137 of those were demonstrably rewritten by a feed in
   * August. Under-claiming is the safe direction and we accept it; the fix
   * that looks obvious (stamp it on every confirming pass) is ~130k UPDATEs
   * on an 8-index table per sweep, which is the write churn commit 9e4abd0
   * removed. Word it as "added", never "updated" or "confirmed".
   *
   * Optional for the same reason `price_source` is: an old share replays
   * offers that never carried it.
   */
  price_as_of?: string | null;
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

/** Server-side match outcomes, spelled exactly as `LineMatch.status` emits
 *  them (api/app/services/bom_match.py): `resolve` is "no catalog hit but we
 *  built a query for it", `none` is "nothing identifiable on this line at
 *  all". `exact_live` is only ever produced by the resolve stream. */
export type BomRowStatus = 'exact' | 'approx' | 'resolve' | 'none' | 'exact_live';

/** A comparable-option stub for the Matches column's "Similar" picker —
 *  identity only; picking one re-matches the line by this SKU, which brings
 *  the full offer set (owner spec 2026-08-21). */
export interface SimilarPart {
  id: string;
  sku: string;
  manufacturer_name: string | null;
  description: string | null;
  package: string | null;
  lifecycle_status: string | null;
  lifecycle_verified: boolean;
}

export interface BomRow {
  index: number;
  status: BomRowStatus;
  approx_reason: string | null;
  package_warning: string | null;
  resolve_query: string | null;
  part: BomPartInfo | null;
  recommended_supplier_id: string | null;
  offers: BomOffer[];
  /** Ranked runner-ups for approx rows; always [] for exact/live/none. */
  similar: SimilarPart[];
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

// ─── Client row model ───────────────────────────────────────────────────────
// Not wire shapes: these are what the table renders. They exist here rather
// than in the table component so the page, the table and the coverage strip
// all read ONE definition.

/**
 * Where a row sits in the two-phase pipeline.
 *
 * `matched` means "phase 1 answered for this row" — the BADGE then reads the
 * server status, so a `resolve`/`none` row is still `matched` in this sense
 * and simply renders NO MATCH. The other four are phase-2 outcomes (Task 17).
 */
export type RowState = 'matched' | 'resolving' | 'resolved_live' | 'not_found' | 'unavailable';

/**
 * One table row: the parsed line (qty, designators and DNP — all of which
 * stay in the browser, D7) plus whatever the server was able to say about its
 * identity fields.
 *
 * `viewerHref` is the §7.6 seam for the schematic/PCB viewer projects. It is
 * ALWAYS null today and designator chips render as plain text; when a viewer
 * ships it becomes a route and the chips become links with no other change.
 */
export type TableRow = ParsedBomLine & {
  server: BomRow | null;
  state: RowState;
  viewerHref: string | null;
};
