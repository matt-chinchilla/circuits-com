/**
 * The customer sponsorships page's pure helpers.
 *
 * GET /api/account/sponsors already answers the two questions this page used
 * to have to work out for itself: `tier` arrives normalized and `is_active`
 * has already applied the NULL-status-reads-as-Active rule. So nothing here
 * re-derives either — it formats what arrived.
 */

import type { AccountSponsorship } from '@admin/types/account';

/** Em dash, written as an escape: a literal glyph in source gets mangled. */
const DASH = '\u2014';

/**
 * `sponsors.amount` is a Postgres NUMERIC. The account route rounds it to a
 * float before it leaves, but the column is the same one the admin list has
 * to coerce out of a JSON string, so the number is made a number here too —
 * a string that reached a comparison would sort and format by its characters.
 */
export function monthlyAmount(raw: AccountSponsorship['amount']): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Money, at the precision it is actually held: whole dollars for the tier
 * prices every real placement carries, cents only when there are cents to
 * show. A $2,500 placement printed as $2,500.00 reads like a calculation.
 */
export function formatMonthly(raw: AccountSponsorship['amount']): string {
  const n = monthlyAmount(raw);
  if (n == null) return DASH;
  const hasCents = Math.round(n * 100) % 100 !== 0;
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  });
}

/** An ISO date, or the dash for a window with no end. */
export function formatDate(iso: string | null): string {
  return iso ?? DASH;
}

/**
 * Which badge a row wears. `is_active` is the arbiter, not the status string:
 * a legacy row stores NULL and the server has already read that as Active, so
 * a client-side string comparison could only disagree with it.
 */
export type StatusTone = 'active' | 'paused' | 'expired' | 'unknown';

export function statusTone(sponsorship: AccountSponsorship): StatusTone {
  if (sponsorship.is_active) return 'active';
  const status = sponsorship.status.trim().toLowerCase();
  if (status === 'paused') return 'paused';
  if (status === 'expired') return 'expired';
  return 'unknown';
}

/** The placement in one string, for a title attribute or a screen reader. */
export function placementLabel(sponsorship: AccountSponsorship): string {
  if (sponsorship.placement == null) return DASH;
  return sponsorship.placement_type === 'keyword'
    ? `keyword: ${sponsorship.placement}`
    : sponsorship.placement;
}
