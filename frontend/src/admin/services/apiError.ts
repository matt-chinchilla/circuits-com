import axios from 'axios';

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
  return typeof detail === 'string' && detail.trim() ? detail : undefined;
}
