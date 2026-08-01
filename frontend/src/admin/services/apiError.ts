import axios from 'axios';
import { DEMO_READ_ONLY_DETAIL, DEMO_READ_ONLY_MESSAGE } from '@admin/services/demoReadOnly';

/**
 * Backend `detail` values that are MACHINE CODES, not prose. A form that renders
 * `apiErrorDetail(err)` inline would otherwise print "demo_account_read_only" at
 * the user; map them to the sentence a person can read. Anything absent from
 * this map is already human-written copy (e.g. the single-slot sponsor 409) and
 * passes through untouched.
 */
const CODE_MESSAGES: Record<string, string> = {
  [DEMO_READ_ONLY_DETAIL]: DEMO_READ_ONLY_MESSAGE,
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
