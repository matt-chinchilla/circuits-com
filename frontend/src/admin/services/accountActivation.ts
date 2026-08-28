/**
 * D17's client half: is this customer's account activated yet, and did they
 * just arrive from the email that says it is?
 *
 * Activation is the ONE authorization boundary in this project (D16 puts every
 * console page at /account unscoped; the compensating control is that staff
 * must activate an account first). The server enforces it in exactly one place
 * — `auth_service.require_account_user`, which answers
 * `403 { detail: "account_not_activated" }`. Until this module existed the
 * client knew nothing about it, so a verified-but-unactivated customer signed
 * in successfully and landed in the FULL console, where every panel fired a
 * request that 403'd. A dozen failures presented as a dozen bugs.
 *
 * Pure, and browser side effects are confined to the two one-shot helpers at
 * the bottom, so the decision logic unit-tests with no React and no DOM.
 */

import type { AccountTier } from '@admin/types/account';

/** The EXACT 403 detail the backend sends (`auth_service.NOT_ACTIVATED_DETAIL`). */
export const NOT_ACTIVATED_DETAIL = 'account_not_activated';

/**
 * GET /api/account/me — identity, activation, and CAPABILITY.
 *
 * This file only reads `activated`; the rest is here because the probe is the
 * one call that already fetches this body, and AuthContext keeps the whole
 * object rather than throwing away the answer to "what kind of company is
 * this?" and asking again.
 *
 * Every field past `email` is optional for the same reason `activated` is: the
 * probe must survive a body that predates a field, and `account` is nullable
 * anyway, so a consumer optional-chains either way (`account?.is_supplier`
 * is `boolean | undefined` whichever way this is typed).
 */
export interface AccountMe {
  id: string;
  full_name: string;
  email: string;
  /**
   * Always `true` on a 200 — the route is gated on `require_account_user`, so
   * an unactivated caller never receives a body at all. Read anyway rather
   * than assumed: if that gate is ever relaxed, the field is the answer and
   * this stays correct instead of quietly reporting everyone activated.
   */
  activated?: boolean;
  /**
   * D18 — capability is the LINKS the account holds, not a type. Both may be
   * set at once (Avnet distributes AND manufactures) and neither is the free
   * browsing account, so read them as two independent booleans. A consumer
   * that writes `is_supplier ? … : is_manufacturer ? …` has already lost the
   * largest customers.
   */
  is_supplier?: boolean;
  is_manufacturer?: boolean;
  /**
   * Derived from the highest ACTIVE sponsorship the linked supplier holds —
   * 'free' | 'silver' | 'gold' | 'platinum'. There is no tier column.
   */
  tier?: AccountTier;
}

/** True for the backend's not-activated 403, and for nothing else. */
export function isNotActivated(status: unknown, detail: unknown): boolean {
  return status === 403 && detail === NOT_ACTIVATED_DETAIL;
}

/**
 * What a settled probe of GET /api/account/me means.
 *
 * `false` is claimed ONLY on the explicit 403. Every other failure — offline,
 * a 500, a dropped connection — resolves to `true`, because the alternative is
 * telling a perfectly good customer their account is awaiting approval on the
 * strength of a flaky network. Fail OPEN to the console, where a real error
 * can show itself; the server refuses either way, so nothing is protected by
 * guessing pessimistically here.
 */
export function activationFromProbe(
  outcome: { ok: true; body: AccountMe | null } | { ok: false; status: unknown; detail: unknown },
): boolean {
  if (outcome.ok) return outcome.body?.activated !== false;
  return !isNotActivated(outcome.status, outcome.detail);
}

// ── The "You're in" notice ──────────────────────────────────────────────────
// The activation email links to `/account?activated=1` (routes/admin_users.py),
// and that parameter cannot survive the trip: a recipient who is signed out
// meets ProtectedRoute's `<Navigate to="/admin/login">`, which drops the query,
// and the post-sign-in hop lands on `/admin` before bouncing to `/account`.
// Three redirects, no query string, and the email was promising a banner that
// nothing rendered. So the flag is taken off the URL the moment it is seen and
// held in sessionStorage until the console can show it.

const NOTICE_KEY = 'cc.account.activated';

/** True when this location carries the activation email's marker. */
export function isActivationLink(search: string): boolean {
  return new URLSearchParams(search).get('activated') === '1';
}

/**
 * Remember that the visitor arrived from the activation email.
 *
 * sessionStorage, not a module variable: the sign-in hop is a REDIRECT and may
 * be a full document load. Every access is wrapped — a locked-down browser
 * (Safari private mode, site data blocked) throws on the accessor itself, and a
 * congratulations banner is not worth a white screen.
 */
export function rememberActivation(): void {
  try {
    window.sessionStorage.setItem(NOTICE_KEY, '1');
  } catch {
    /* no banner, everything else still works */
  }
}

/**
 * Read the notice and CLEAR it in the same breath — it is a one-shot. Without
 * the clear it would greet the user on every console page for the rest of the
 * session, and again in any tab they open from it.
 */
export function takeActivationNotice(): boolean {
  try {
    const found = window.sessionStorage.getItem(NOTICE_KEY) === '1';
    if (found) window.sessionStorage.removeItem(NOTICE_KEY);
    return found;
  } catch {
    return false;
  }
}
