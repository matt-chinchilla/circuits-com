// Pure formatting for the sponsor Billing panel. Every number here came from
// the server (GET /api/admin/sponsors/{id}/billing) — nothing in this file
// computes a PRICE; it only turns cents, dates and Stripe statuses into the
// sentence a rep reads.
//
// Dates render in UTC, like the Expenses list: a Stripe timestamp is an
// instant, and the day a rep sees must be the same day the sweep counts from.

/** The sweep's grace period (settings.BILLING_GRACE_DAYS). Only a fallback —
 *  the billing payload carries `cancels_on`, computed by the server. */
export const GRACE_DAYS = 14;

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Integer cents -> `$2,100.00`. A missing amount is a dash, never `$NaN`. */
export function cents(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return USD.format(value / 100);
}

/** Accepts an ISO string or Stripe's unix SECONDS. */
function toDate(value: string | number | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `Sep 1` (or `Sep 1, 2026` with `{ year: true }`), read in UTC. */
export function formatDay(
  value: string | number | null | undefined,
  opts: { year?: boolean } = {},
): string {
  const d = toDate(value);
  if (!d) return '—';
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(opts.year ? { year: 'numeric' } : {}),
  });
}

/** The instant the dunning sweep cancels: first failure + grace days. */
export function cancelsOn(
  failingSince: string | null | undefined,
  graceDays: number = GRACE_DAYS,
): string | null {
  const d = toDate(failingSince ?? null);
  if (!d) return null;
  return new Date(d.getTime() + graceDays * 86_400_000).toISOString();
}

/** The subset of the billing payload the status strip reads. */
export interface BillingStatusInput {
  status: string | null;
  failing_since?: string | null;
  cancels_on?: string | null;
  cancel_scheduled?: boolean;
  cancel_at?: string | null;
  period_end?: string | null;
}

function humanize(status: string): string {
  const words = status.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown';
}

/** One sentence for the status strip. The failing branch wins over every
 *  other: it is the one a rep has to act on (spec §10, "Payment failing since
 *  {date} · cancels {date + 14 days}"). */
export function billingStatusLabel(b: BillingStatusInput): string {
  if (b.failing_since) {
    const end = b.cancels_on ?? cancelsOn(b.failing_since);
    return `Payment failing since ${formatDay(b.failing_since)} · cancels ${formatDay(end)}`;
  }
  const status = (b.status ?? '').trim();
  if (!status) return 'No subscription';
  if (status === 'canceled') return 'Cancelled';
  if (b.cancel_scheduled) {
    return `Cancels ${formatDay(b.cancel_at ?? b.period_end)} · no further charges`;
  }
  switch (status) {
    case 'active':
    case 'trialing':
      return b.period_end ? `Active · renews ${formatDay(b.period_end)}` : 'Active';
    case 'past_due':
      return 'Payment past due';
    case 'unpaid':
      return 'Unpaid';
    case 'incomplete':
      return 'Waiting for the first payment';
    case 'incomplete_expired':
      return 'First payment never arrived';
    case 'paused':
      return 'Paused in Stripe';
    default:
      return humanize(status);
  }
}

export type BillingTone = 'ok' | 'warn' | 'danger' | 'muted';

/** The colour of the status dot. */
export function billingTone(b: BillingStatusInput): BillingTone {
  const status = b.status ?? '';
  if (status === 'canceled' || status === 'incomplete_expired' || !status) return 'muted';
  if (b.failing_since || status === 'past_due' || status === 'unpaid') return 'danger';
  if (b.cancel_scheduled || status === 'incomplete' || status === 'paused') return 'warn';
  return 'ok';
}

export interface InvoiceMoney {
  status: string;
  amount_paid_cents: number;
  amount_refunded_cents: number;
}

/** What happened to the money on one invoice. */
export function invoiceStatusLabel(inv: InvoiceMoney): string {
  if (inv.status === 'paid') {
    if (inv.amount_refunded_cents > 0 && inv.amount_refunded_cents >= inv.amount_paid_cents) {
      return 'Refunded';
    }
    if (inv.amount_refunded_cents > 0) return 'Partly refunded';
    return 'Paid';
  }
  return humanize(inv.status || 'unknown');
}

/** Cents still refundable on an invoice (never negative). */
export function refundableCents(inv: Pick<InvoiceMoney, 'amount_paid_cents' | 'amount_refunded_cents'>): number {
  return Math.max(0, (inv.amount_paid_cents || 0) - (inv.amount_refunded_cents || 0));
}

/** A typed dollar amount ("50", "1,250.5", "$20.00") -> integer cents, or
 *  null when it is not a positive amount. The refund dialog's partial field. */
export function parseDollarsToCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const value = Math.round(Number(cleaned) * 100);
  return value > 0 ? value : null;
}
