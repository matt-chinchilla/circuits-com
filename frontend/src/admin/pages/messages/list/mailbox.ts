/**
 * The "Open mailbox" affordance's address.
 *
 * The company's mail lives on one host and the mailbox local-parts ARE the
 * staff usernames, lower-cased (`Anthony` owns `anthony@`). That derivation is
 * only true for STAFF: the console renders from one component tree at two
 * mounts (D16), and a customer's username IS their email address, so the old
 * inline `${user.username}@circuitcenter.ai` produced `buyer@acme.com@
 * circuitcenter.ai` for them — a malformed address pointing at a staff webmail
 * they have no account on.
 *
 * So the address is derived HERE, behind the staff check, and the page renders
 * the link only when this returns one.
 */
import { isStaff } from '@admin/services/permissions';
import type { UserInfo } from '@admin/types/admin';

/** Where the company's mail lives. Kept beside the address so both move
 *  together if the mail host ever changes. */
export const WEBMAIL_URL = 'https://mail.circuitcenter.ai';
export const MAIL_DOMAIN = 'circuitcenter.ai';

/**
 * This account's staff mailbox address, or null when there isn't one.
 *
 * Null for a customer, for a signed-out/still-loading render, and for a
 * username that cannot be a local-part. That last check is belt and braces
 * behind the role check rather than instead of it: a local-part may not
 * contain '@' or whitespace, and printing a broken address is worse than
 * printing nothing.
 */
export function staffMailboxAddress(
  user: Pick<UserInfo, 'role' | 'username'> | null | undefined,
): string | null {
  if (!isStaff(user) || !user) return null;
  const local = user.username.trim().toLowerCase();
  if (!local || /[@\s]/.test(local)) return null;
  return `${local}@${MAIL_DOMAIN}`;
}
