import type { AdminCategory, AdminSponsor } from '@admin/types/admin';
import { categoryPath } from '@shared/utils/categoryPath';

// Resolve a sponsor row to the PUBLIC url its placement renders on, so the admin
// Sponsors list can link straight at the live surface an admin just sold.
//
// A sponsor's placement is an XOR: either a `category_id` (Platinum on a
// top-level category, Gold/Silver on a subcategory) or a `keyword`. Category
// rows only carry the category's id — never its slug, and never its parent's —
// so building a url needs the category tree. `buildCategoryIndex` flattens that
// tree once per fetch; `placementPath` is then a pure map lookup per row.
//
// Pure module by design: no fetch, no React. The list page owns the data.

/** A category's own slug plus its parent's, when it is a subcategory. */
export interface CategoryPathEntry {
  slug: string;
  parentSlug?: string;
}

/**
 * Flatten the admin category tree to `id -> { slug, parentSlug? }`.
 *
 * Mirrors the parent -> child walk behind `subcategoryOptions` in
 * `sponsors/form/index.tsx`: every top-level category maps to its own slug with
 * NO parentSlug (it is the root of its branch), and every child maps to its own
 * slug plus its parent's — which is exactly what `categoryPath` needs to emit
 * the canonical nested `/category/{parent}/{child}` url rather than the flat
 * `/category/{child}` that only survives via a redirect.
 *
 * `children` is treated as optional at runtime (`?? []`) the same way the form
 * does — the admin categories endpoint has shipped rows without it.
 */
export function buildCategoryIndex(
  categories: AdminCategory[],
): Map<string, CategoryPathEntry> {
  const index = new Map<string, CategoryPathEntry>();
  for (const c of categories) {
    index.set(c.id, { slug: c.slug });
    for (const child of c.children ?? []) {
      index.set(child.id, { slug: child.slug, parentSlug: c.slug });
    }
  }
  return index;
}

/**
 * The public path a sponsor's placement appears on, or `null` when it has none
 * we can link to.
 *
 * - category placement, resolvable in the index -> `categoryPath(slug, parentSlug)`
 * - keyword placement -> `/keyword/{encoded}` (matches the `/keyword/:keyword`
 *   route in App.tsx; the keyword is trimmed but NOT lowercased — the sponsor
 *   profile is keyed on the stored casing)
 * - anything else (a category_id the index doesn't know, e.g. a stale row from a
 *   category deleted since the tree was fetched — or neither field set) -> `null`
 */
export function placementPath(
  sponsor: AdminSponsor,
  index: Map<string, CategoryPathEntry>,
): string | null {
  if (sponsor.category_id) {
    const entry = index.get(sponsor.category_id);
    if (entry) return categoryPath(entry.slug, entry.parentSlug);
  }
  // XOR means a row with a category_id has no keyword, so an unresolvable
  // category falls through to `null` rather than borrowing a keyword url.
  const keyword = sponsor.keyword?.trim();
  if (keyword) return `/keyword/${encodeURIComponent(keyword)}`;
  return null;
}
