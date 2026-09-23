import axios from 'axios';

/**
 * Backend `detail` values that are MACHINE CODES, not prose. A form that renders
 * `apiErrorDetail(err)` inline would otherwise print a bare code like
 * "feed_not_configured" at the user; map them to the sentence a person can read. Anything absent from
 * this map is already human-written copy (e.g. the single-slot sponsor 409) and
 * passes through untouched.
 */
const CODE_MESSAGES: Record<string, string> = {
  // routes/feed_credentials.py 422. The server deliberately does NOT quote the
  // rejected key back (a validation message is a classic place for a secret to
  // escape), so the sentence has to describe the rule instead of the value.
  invalid_api_key: 'That key doesn’t look usable — 8 to 128 plain-text characters.',
  // routes/suppliers.py 409 — the nightly auto-import was switched ON for a
  // supplier with no feed provider, or no key for the one it has. Names the fix
  // rather than the code, and matches the greyed switch's own hint.
  feed_not_configured: 'Add this supplier’s API key in Settings to enable nightly imports.',
  // auth_service.READ_ONLY_DETAIL — a `viewer` account on any write.
  read_only: 'This account is view-only — changes are disabled.',

  // ── Gold/Platinum sales + the billing console (spec §9, 2026-09-23) ──────
  // require_billing_reader — a viewer asking for billing, codes or quotes.
  no_billing_access: 'Billing and sales codes are hidden from view-only accounts.',
  // R15 — delete/expire refused while a Stripe subscription still charges.
  billing_active:
    'This sponsorship is still billed in Stripe — cancel it under Billing first, then expire or delete it.',
  // Retry/refund was asked of a hold that is not an unresolved conflict.
  not_a_conflict: 'That checkout is not waiting on a refund — refresh the list.',
  // The subscription sits on retired price objects; the rule cannot re-price it.
  legacy_price:
    'This subscription is on an older price, so its discount cannot be changed here — ask the owner.',
  // R13 — more than one live subscription names this sponsor.
  ambiguous_subscription:
    'Several Stripe subscriptions name this sponsorship — the owner needs to resolve which one is real.',
  // /v1/invoice_payments answered with something other than a card payment.
  unsupported_payment:
    'This invoice was not paid by card, so it cannot be refunded from here — ask the owner.',
  // R7 — the bound company already holds this placement.
  already_sponsor:
    'This company already sponsors that placement — upgrades on the same category go through the desk.',
  // A money action sent without its confirm dialog's key.
  idempotency_key_required: 'That action was sent without its safety key — reload the page and try again.',
  // /join anti-squatting, surfaced here when staff drive a checkout.
  hold_limit: 'There is already a checkout open for this buyer — wait for it to finish or lapse.',
};

/**
 * Pull a human-readable `detail` string off an axios error's response body —
 * FastAPI returns `{ detail: "..." }` for 4xx (e.g. the single-slot sponsor 409
 * "This category already has an active Platinum sponsor…").
 *
 * Returns `undefined` (so the caller falls back to its own generic message) when:
 *  - it's not an axios error, or there is no HTTP response (network failure), or
 *  - `detail` is not a string. A 422 detail is an ARRAY of error objects that
 *    would crash if rendered as a React child, so only a plain string is surfaced.
 */
/** The RAW string `detail` (the machine code itself, unmapped) and the HTTP
 *  status — for callers that branch on a code rather than print it. */
export function apiErrorCode(err: unknown): { status: number | undefined; code: string | undefined } {
  if (!axios.isAxiosError(err)) return { status: undefined, code: undefined };
  const detail = (err.response?.data as { detail?: unknown } | undefined)?.detail;
  return {
    status: err.response?.status,
    code: typeof detail === 'string' && detail.trim() ? detail : undefined,
  };
}

/** R6 — billing, codes and quote reads refuse a view-only account. */
export const NO_BILLING_ACCESS_DETAIL = 'no_billing_access';

export function isNoBillingAccess(err: unknown): boolean {
  const { status, code } = apiErrorCode(err);
  return status === 403 && code === NO_BILLING_ACCESS_DETAIL;
}

export function apiErrorDetail(err: unknown): string | undefined {
  if (!axios.isAxiosError(err)) return undefined;
  const detail = (err.response?.data as { detail?: unknown } | undefined)?.detail;
  if (typeof detail !== 'string' || !detail.trim()) return undefined;
  return CODE_MESSAGES[detail] ?? detail;
}
