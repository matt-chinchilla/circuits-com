import type { Category } from "@public/types/category";

/**
 * Own + children parts total for ONE category. A top-level category's
 * `parts_count` is OWN-count only (parts attach to subcategories), so every
 * rendered count is own + sum(children) — the homepage CategoryGrid card and
 * the drawer both consume this.
 */
export function categoryPartsRollup(cat: Category): number {
  return (
    (cat.parts_count ?? 0) +
    cat.children.reduce((sum, sub) => sum + (sub.parts_count ?? 0), 0)
  );
}

/** Total parts across the catalog from the categories payload. */
export function catalogPartsRollup(categories: Category[]): number {
  return categories.reduce((total, cat) => total + categoryPartsRollup(cat), 0);
}

/**
 * Rail-pill / footer label for the parts total: rounded DOWN to the nearest
 * hundred with a trailing "+" so the number is never an overclaim
 * (6,270 -> "6,200+").
 */
export function partsPillLabel(total: number): string {
  const floored = Math.floor(total / 100) * 100;
  return `${floored.toLocaleString("en-US")}+`;
}
