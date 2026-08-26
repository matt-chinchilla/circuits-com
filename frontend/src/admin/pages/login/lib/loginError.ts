/**
 * What a failed sign-in actually was.
 *
 * The sign-in screen used to have two arms — no response means the network,
 * everything else means bad credentials — and `POST /api/auth/login` has a
 * third answer it never read: a registrant who typed the RIGHT password on an
 * account whose address was never confirmed gets
 * `403 { detail: "email_not_verified" }` (routes/auth.py). Folded into the
 * catch-all, that told them their password was wrong, forever, and every other
 * door was shut: /signup answers `email_taken` and points back at this screen,
 * and forgot-password deliberately skips unverified accounts (D14) and sends
 * nothing. So the one screen that CAN reach them has to recognise it.
 *
 * A pure classifier rather than an if-ladder in the catch block: the three
 * outcomes are the whole contract, and they unit-test with no React and no DOM.
 */
import axios from 'axios';

/** The EXACT 403 detail /auth/login sends for an unconfirmed address. */
export const EMAIL_NOT_VERIFIED_DETAIL = 'email_not_verified';

export type LoginFailure =
  /** Correct password, address never confirmed — offer a fresh link. */
  | 'unverified'
  /** No response at all: do NOT tell them their password is wrong. */
  | 'unreachable'
  /** The single generic 401 — unknown account, wrong password, or locked out. */
  | 'credentials';

export function classifyLoginError(err: unknown): LoginFailure {
  // A non-axios throw is a bug on our side, not an answer from the server.
  // It keeps the pre-existing generic message rather than inventing a new one.
  if (!axios.isAxiosError(err)) return 'credentials';
  if (!err.response) return 'unreachable';
  const detail = (err.response.data as { detail?: unknown } | undefined)?.detail;
  // BOTH halves are checked. The detail alone would match a 403 from anywhere
  // else that ever reused the string, and the status alone would swallow
  // `password_change_required` — which is also a 403 and must keep flowing to
  // the passwordGate, not turn into a resend prompt.
  if (err.response.status === 403 && detail === EMAIL_NOT_VERIFIED_DETAIL) {
    return 'unverified';
  }
  return 'credentials';
}
