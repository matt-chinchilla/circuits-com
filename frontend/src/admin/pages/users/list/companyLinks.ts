/**
 * Linking a registered account to the company it belongs to.
 *
 * An account's TIER is derived from its linked supplier's highest active
 * sponsorship (services/account_tier.py) — there is no tier column to set. So
 * until staff link a company here, every account is `free` no matter what it
 * has bought, which is why the roster shipping with only an Activate toggle
 * meant no account could ever leave the free tier.
 *
 * Two links, not one choice between two: `supplier_id` says this account
 * DISTRIBUTES and `manufacturer_id` says it MAKES parts, and a company that
 * does both (Avnet) is first-class rather than an edge case. Both are staff-set
 * only — nothing a customer submits reaches either field.
 *
 * Pure and id-shaped so it unit-tests with no React and no browser.
 */
import type { AdminUser } from '@admin/types/users';

export interface CompanyLinks {
  supplier_id: string | null;
  manufacturer_id: string | null;
}

/** A PATCH body carrying only the links that changed. */
export type CompanyLinkPatch = Partial<CompanyLinks>;

/**
 * '' (the picker's "— none —" option), whitespace, undefined (key absent) and
 * null (Python None over JSON) all mean the same thing: no link.
 */
export function normalizeLink(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v === '' ? null : v;
}

/** The links a row currently holds, in the shape the draft is compared against. */
export function currentLinks(
  user: Pick<AdminUser, 'supplier_id' | 'manufacturer_id'>,
): CompanyLinks {
  return {
    supplier_id: normalizeLink(user.supplier_id),
    manufacturer_id: normalizeLink(user.manufacturer_id),
  };
}

/**
 * The PATCH body for one save: exactly the fields that changed.
 *
 * Both keys can appear together — that is the point, and it is what stops the
 * two controls from behaving like a radio group.
 *
 * A cleared link sends an explicit `null`, never an omitted key: the server
 * reads `model_dump(exclude_unset=True)`, so an absent key means "leave this
 * alone" and would silently keep the old company attached.
 */
export function buildLinkPatch(current: CompanyLinks, draft: CompanyLinks): CompanyLinkPatch {
  const patch: CompanyLinkPatch = {};
  if (normalizeLink(draft.supplier_id) !== current.supplier_id) {
    patch.supplier_id = normalizeLink(draft.supplier_id);
  }
  if (normalizeLink(draft.manufacturer_id) !== current.manufacturer_id) {
    patch.manufacturer_id = normalizeLink(draft.manufacturer_id);
  }
  return patch;
}

/** Is there anything to send? An unchanged save must not hit the API at all. */
export function hasLinkChanges(patch: CompanyLinkPatch): boolean {
  return Object.keys(patch).length > 0;
}

/**
 * The manufacturer ids on the roster that need a NAME resolved.
 *
 * GET /api/admin/users/ returns `manufacturer_id` but no manufacturer name (it
 * joins the supplier only), so the page looks the handful of linked ones up.
 * Distinct, so two accounts under one manufacturer cost one request.
 */
export function manufacturerIdsToResolve(
  rows: readonly Pick<AdminUser, 'manufacturer_id'>[],
): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    const id = normalizeLink(r.manufacturer_id);
    if (id) ids.add(id);
  }
  return [...ids];
}
