import type { Category } from "@public/types/category";

/**
 * Total parts across the catalog from the categories payload. A top-level
 * category's `parts_count` is OWN-count only (parts attach to subcategories),
 * so the real total is own + sum(children) — the same client-side rollup the
 * homepage CategoryCard does per card.
 */
export function catalogPartsRollup(categories: Category[]): number {
  return categories.reduce(
    (total, cat) =>
      total +
      (cat.parts_count ?? 0) +
      cat.children.reduce((sum, sub) => sum + (sub.parts_count ?? 0), 0),
    0,
  );
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
