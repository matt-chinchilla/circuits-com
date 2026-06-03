// Canonical category-URL builder, shared across public + admin scopes.
//
// Categories form a two-level tree. Top-level categories live at
// `/category/{slug}`; subcategories live NESTED under their parent at
// `/category/{parentSlug}/{slug}` (the 2026-06-03 routing fix — before it,
// subcategory pages were only reachable as flat `/category/{slug}` filters and
// effectively unreachable as first-class pages).
//
// Pass the parent slug wherever you have it (parent-page chips, sibling chips,
// breadcrumbs, home cards, part breadcrumb, admin tree) so links point straight
// at the canonical nested URL. Omit it at call sites that only know the child
// slug (e.g. search results, which carry no parent reference) — the flat URL
// still resolves, and CategoryPage redirects it to the nested canonical.

/**
 * Build the public URL path for a category.
 *
 * @param slug        the category's own slug
 * @param parentSlug  the parent category's slug, when known (null/undefined for
 *                    top-level categories or when the caller lacks it)
 */
export function categoryPath(slug: string, parentSlug?: string | null): string {
  return parentSlug ? `/category/${parentSlug}/${slug}` : `/category/${slug}`;
}
