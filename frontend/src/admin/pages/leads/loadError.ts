/**
 * How the three Leads screens turn a failed request into something a person can
 * act on — and, just as importantly, what they REFUSE to put on the screen.
 *
 * THE BUG THIS EXISTS FOR: every leads page used to do
 * `setError(apiErrorDetail(err) ?? '…')`, and `apiErrorDetail` passes any string
 * `detail` through untouched. So when a 24h-old token expired mid-session the
 * owner was shown FastAPI's internal auth prose — a bare "Not authenticated"
 * printed inside the empty-row cell of a table that otherwise looked fine, under
 * a console that still looked signed in. The same branch could equally have
 * printed "Token expired" / "Invalid token" / "User not found".
 *
 * Two rules follow:
 *  1. A 401 is never described in the server's words. It is one named sentence,
 *     and the page RECOVERS (signs the dead session out so ProtectedRoute
 *     bounces to the sign-in screen) instead of dead-ending.
 *  2. A backend `detail` is only surfaced for the statuses where it is
 *     deliberately human-written copy (400/409/422). Anything else — 403
 *     `password_change_required`, a 500 traceback — gets the page's own
 *     sentence.
 */

import axios from 'axios';

import { apiErrorDetail } from '@admin/services/apiError';

/** The exact 403 detail `require_leads_access` sends for the demo account. */
export const DEMO_NO_LEADS_DETAIL = 'demo_account_no_leads';

/**
 * The ONE thing a retired session says. Deliberately not "401", not
 * "Not authenticated", and not a status code: the reader is a salesperson with
 * a call list open, and the only useful information is that they have to sign
 * in again.
 */
export const SESSION_EXPIRED_MESSAGE =
  'Your sign-in has expired. Sign in again to work the call list.';

/**
 * Statuses whose `detail` is written FOR a reader (the 409 slot messages, a
 * 400's named refusal). Every other status keeps its detail internal.
 */
const HUMAN_DETAIL_STATUSES = new Set([400, 409, 422]);

export type LeadsErrorKind =
  /** Demo account — the quiet closed-door panel, not an error. */
  | 'demo'
  /** The token is gone or refused. Recover by signing out; never explain in the server's words. */
  | 'session'
  /** Everything else — show the page's own sentence and offer a retry. */
  | 'failed';

export interface LeadsLoadError {
  kind: LeadsErrorKind;
  /** Safe to render. Empty for `demo`, which has its own panel copy. */
  message: string;
}

/**
 * Classify a rejected leads request.
 *
 * @param err      whatever the promise rejected with (axios error, or not)
 * @param fallback the calling page's own sentence for an unexplained failure
 */
export function classifyLeadsError(err: unknown, fallback: string): LeadsLoadError {
  const status = axios.isAxiosError(err) ? err.response?.status : undefined;
  const detail = apiErrorDetail(err);

  if (status === 403 && detail === DEMO_NO_LEADS_DETAIL) {
    return { kind: 'demo', message: '' };
  }
  if (status === 401) {
    return { kind: 'session', message: SESSION_EXPIRED_MESSAGE };
  }
  if (status !== undefined && HUMAN_DETAIL_STATUSES.has(status) && detail) {
    return { kind: 'failed', message: detail };
  }
  return { kind: 'failed', message: fallback };
}
