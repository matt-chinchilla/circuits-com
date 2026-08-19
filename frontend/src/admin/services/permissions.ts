/**
 * Role-derived UI permissions.
 *
 * NOTHING here protects any data. The API is the enforcement point — the two
 * message-delete routes depend on `auth_service.require_owner` and answer every
 * other account with `403 { detail: "owner_only" }`. This module exists so the
 * console never renders a control that is guaranteed to fail: a staff user
 * should not see a Delete button, not click one and read an error.
 *
 * Pure and role-shaped (never user-shaped beyond the role) so it unit-tests
 * with no React and no browser.
 */

import type { UserInfo } from '@admin/types/admin';

/**
 * The EXACT 403 detail the backend sends (`auth_service.OWNER_ONLY_DETAIL`).
 * Kept beside the check it mirrors so the two move together.
 */
export const OWNER_ONLY_DETAIL = 'owner_only';

/** What the user reads instead of the machine code. One sentence, no jargon. */
export const OWNER_ONLY_MESSAGE = 'Only the account owner can delete messages.';

/**
 * True when this axios error is the backend's owner-only 403 — the mirror of
 * `isDemoReadOnly`.
 *
 * The affordance is hidden from staff, so this should be unreachable in normal
 * use. It is not unreachable in practice: a second tab open across a role
 * change, or a stale bundle after a demotion, still holds a Delete button, and
 * without this the operator would read the raw string "owner_only" (the demo
 * gate has had a human sentence all along — review-caught).
 */
export function isOwnerOnly(status: unknown, detail: unknown): boolean {
  return status === 403 && detail === OWNER_ONLY_DETAIL;
}

/** True when this account holds the `owner` role. */
export function isOwner(user: Pick<UserInfo, 'role'> | null | undefined): boolean {
  return user?.role === 'owner';
}

/**
 * May this account delete messages?
 *
 * Owner ONLY (owner decision, 2026-08-19): deletion is irreversible and the
 * rows are real public correspondence. `admin` keeps everything else — reading,
 * filtering, status changes, archive.
 *
 * A null user (still loading, or signed out) is NOT granted the affordance:
 * the safe default while the answer is unknown is to withhold it, and the
 * screen re-renders the moment /auth/me resolves.
 */
export function canDeleteMessages(
  user: Pick<UserInfo, 'role'> | null | undefined,
): boolean {
  return isOwner(user);
}
