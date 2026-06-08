import type { Subcategory } from '@public/types/category';

/**
 * The stable "shell" of a top-level category: its identity + sibling list.
 * Identical across every subcategory of that parent, so caching it lets the
 * breadcrumb, page title, and subcategory chips render SYNCHRONOUSLY on a
 * sibling navigation — even to a not-yet-visited sibling — instead of
 * disappearing into a skeleton and re-animating on every CategoryPage remount
 * (the page is keyed by pathname via the ErrorBoundary, so it remounts on each
 * nav). Mirrors the partners-banner session memo.
 */
export interface CategoryShell {
  name: string;
  slug: string;
  icon: string;
  children: Subcategory[];
}

// Module-scoped session cache keyed by TOP-LEVEL slug. The category taxonomy
// (names, slugs, icons, children) is static within a session, so no
// invalidation is needed — it resets on a full page reload.
const memo = new Map<string, CategoryShell>();

export function getCategoryShell(topSlug: string): CategoryShell | undefined {
  return memo.get(topSlug);
}

export function setCategoryShell(shell: CategoryShell): void {
  memo.set(shell.slug, shell);
}
