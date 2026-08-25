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
export function apiErrorDetail(err: unknown): string | undefined {
  if (!axios.isAxiosError(err)) return undefined;
  const detail = (err.response?.data as { detail?: unknown } | undefined)?.detail;
  if (typeof detail !== 'string' || !detail.trim()) return undefined;
  return CODE_MESSAGES[detail] ?? detail;
}
