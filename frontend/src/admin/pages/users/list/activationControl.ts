/**
 * What the roster's action cell offers for one account.
 *
 * Activation is a ONE-WAY DOOR (owner decision, 2026-08-26): the server answers
 * 409 `activation_is_one_way` to any attempt to switch it back, so the console
 * must not present a toggle that implies otherwise. The way back is deletion,
 * and deletion is owner-only (`require_owner` on DELETE /api/admin/users/{id}),
 * so an admin who is not the owner gets no control at all — showing them a
 * Delete button that always 403s would be a lie the server has to correct.
 *
 * Kept as a pure function because the frontend harness is unit-logic only: the
 * three-way choice is the part worth pinning, and a rendered component is not
 * where it should be decided.
 */

export type ActivationControl =
  | { kind: 'activate' }
  | { kind: 'delete' }
  | { kind: 'activated-readonly' };

export function activationControl(args: {
  activatedAt: string | null | undefined;
  viewerIsOwner: boolean;
}): ActivationControl {
  // `?: T | null` catches only `undefined`; Python's None arrives as JSON null,
  // so both have to be tested.
  const activated = args.activatedAt != null;
  if (!activated) return { kind: 'activate' };
  return args.viewerIsOwner ? { kind: 'delete' } : { kind: 'activated-readonly' };
}
