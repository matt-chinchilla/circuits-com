import { describe, expect, it } from "vitest";
import type { Category } from "@public/types/category";
import { catalogPartsRollup, partsPillLabel } from "./drawerCounts";

const cat = (
  own: number | null | undefined,
  children: (number | null | undefined)[],
): Category => ({
  id: "id",
  name: "Cat",
  slug: "cat",
  icon: "cpu",
  parts_count: own,
  children: children.map((n, i) => ({
    id: `c${i}`,
    name: `Sub ${i}`,
    slug: `sub-${i}`,
    icon: "cpu",
    parts_count: n,
  })),
});

describe("catalogPartsRollup", () => {
  it("sums own + children across categories", () => {
    expect(catalogPartsRollup([cat(10, [20, 30]), cat(5, [])])).toBe(65);
  });

  it("treats null/undefined counts as 0 (the ?:-misses-null trap)", () => {
    expect(catalogPartsRollup([cat(null, [undefined, 40]), cat(undefined, [null])])).toBe(40);
  });

  it("returns 0 for an empty catalog", () => {
    expect(catalogPartsRollup([])).toBe(0);
  });
});

describe("partsPillLabel", () => {
  it("rounds DOWN to the nearest hundred with a trailing +", () => {
    expect(partsPillLabel(6270)).toBe("6,200+");
    expect(partsPillLabel(199)).toBe("100+");
  });

  it("keeps exact hundreds as-is", () => {
    expect(partsPillLabel(100)).toBe("100+");
    expect(partsPillLabel(2400)).toBe("2,400+");
  });

  it("comma-groups large totals", () => {
    expect(partsPillLabel(132456)).toBe("132,400+");
  });

  it("floors sub-hundred totals to 0+", () => {
    expect(partsPillLabel(42)).toBe("0+");
  });
});
