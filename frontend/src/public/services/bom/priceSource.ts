// The provenance label — the honest replacement for the "stale price" chip.
//
// WHAT IT CLAIMS, EXACTLY. `live` means a distributor API is registered for
// that supplier and we hold a key for it today, so the row does get rewritten
// when its numbers change. That is the ONLY claim this page makes.
//
// WE BADGE THE LIVE ONES AND SAY NOTHING ABOUT THE REST (owner decision,
// 2026-08-24). A `static` chip would have been honest about the DATA and
// misleading about the COMPANY: `live` vs `static` maps today onto "the two
// distributors we have integrated" vs "the other 57", so the chip would have
// published our own integration backlog as a visible mark against 57
// distributors, on the one page whose pitch is neutral comparison. The ~37,095
// listings behind those suppliers are real — collected, not invented — and
// several of those companies are sponsor prospects. So the rule is: assert
// only what we can back, and make no claim at all about a row we cannot.
// It also makes the badge earnable — a distributor gets one by giving us a
// feed, which is a sales asset rather than a penalty.
//
// The server still sends `price_source: 'static'`. Suppressing it is a RENDER
// decision made in one place, so reinstating the chip later is a one-line
// change here and nothing else moves.
//
// WHAT IT MUST NEVER CLAIM. That anything was confirmed, verified, checked or
// updated. Nothing in the schema can support a recency claim:
// `part_listings.last_updated` has one reader and zero writers, `updated_at`
// moves only when a value actually changed (at most 6,477 of 130,728 Mouser
// rows, 5.0%), `supplier_feeds.last_synced_at` is stamped by a job that by
// construction refreshes nothing, and `lifecycle_verified_at` covers 1.8% of
// parts. The design abandons the recency claim outright rather than faking it
// with a proxy, and the wording is the part of that decision a reader sees.
// priceSource.test.ts pins the forbidden words.
//
// THE DATE RIDES INSIDE THE STRING, not in a sibling node and not in a
// tooltip, so no layout change can keep the claim and drop the evidence. And
// it is the date the offer was ADDED: `last_updated` is stamped at INSERT with
// no `onupdate`, so it under-claims — 1,352 Mouser listings still show the
// 2026-06-03 seed date although 137 of them were demonstrably rewritten by a
// feed in August. Under-claiming is the safe direction. The obvious "fix",
// stamping the column on every confirming pass, is ~130k UPDATEs on an
// 8-index table per sweep: the write churn commit 9e4abd0 removed.

import type { Offer } from './priceBreaks';

/** Just the two provenance fields, so a caller can pass a whole `BomOffer` or
 *  a literal. Both are optional here for the same reason they are optional on
 *  the wire type — see the absent case below. */
export interface PriceProvenanceFields {
  price_source?: Offer['price_source'];
  price_as_of?: string | null;
}

/** Which colour the chip takes, or `null` for "render nothing".
 *
 *  Exported alongside the note so a render site never hand-writes
 *  `offer.price_source === 'live'` for its class name. That comparison is
 *  false for `undefined`, so a two-armed version silently prints its `else`
 *  for a row whose provenance we simply do not know — which is exactly how an
 *  old share link ends up making a claim about a distributor nobody measured.
 *  One decision, made here, used by both call sites.
 *
 *  `static` and absent BOTH return null, deliberately: they render identically
 *  because we make no claim in either case. They stay distinguishable on the
 *  wire — this function is the render gate, not the data model. */
export function priceSourceTone(offer: PriceProvenanceFields): 'live' | null {
  return offer.price_source === 'live' ? 'live' : null;
}

function addedOn(iso: string | null | undefined): string | null {
  if (iso == null) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  // UTC explicitly: the server sends an instant, and a listing added at 23:30
  // UTC must not print as the previous day for a reader west of Greenwich. A
  // sourcing table where the same offer is dated differently on two desks is
  // worse than a date that is nobody's local midnight.
  return when.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * The chip's text for one offer, or `null` for "say nothing".
 *
 * `null` is the third arm the review made mandatory. `price_source` is
 * optional on the wire because a share link created before the field existed
 * replays its stored offers verbatim (there is one live share, created
 * 2026-08-21, expiring 2027-02-17), and `share.ts parseRow` validates an offer
 * only as far as supplier_id / supplier_name / breaks before casting. Absence
 * means we do not know, and "we do not know" renders as nothing.
 *
 * A KNOWN source with an unusable date still labels the source. Degrading to
 * the bare claim is right — it is the half we can still stand behind — while
 * printing "Invalid Date" into a buyer's sourcing table is not. In practice
 * this only happens on a legacy share: `part_listings.last_updated` is NOT
 * NULL, so a server-built offer always carries both halves.
 */
export function priceSourceNote(offer: PriceProvenanceFields): string | null {
  if (priceSourceTone(offer) == null) return null;
  const added = addedOn(offer.price_as_of);
  return added == null ? 'live feed' : `live feed · added ${added}`;
}
