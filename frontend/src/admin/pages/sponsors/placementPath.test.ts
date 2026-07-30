import { describe, it, expect } from 'vitest';
import type { AdminCategory, AdminSponsor } from '@admin/types/admin';
import { buildCategoryIndex, placementPath } from './placementPath';

// Minimal tree factory — the index only reads id/slug/children[].{id,slug}.
function cat(
  id: string,
  slug: string,
  children: Array<{ id: string; slug: string }> = [],
): AdminCategory {
  return { id, slug, children } as unknown as AdminCategory;
}

// Minimal sponsor-row factory — placementPath only reads category_id/keyword.
function sponsor(fields: Partial<AdminSponsor>): AdminSponsor {
  return { category_id: null, keyword: null, ...fields } as unknown as AdminSponsor;
}

// Two-level fixture: a top-level category with two subcategories, plus a
// second top-level with none (the `children: []` shape).
const CATEGORIES: AdminCategory[] = [
  cat('cat-semis', 'semiconductors', [
    { id: 'sub-mcu', slug: 'microcontrollers' },
    { id: 'sub-opamp', slug: 'op-amps' },
  ]),
  cat('cat-passives', 'passive-components'),
];

describe('buildCategoryIndex', () => {
  it('maps top-level categories to their own slug with NO parentSlug', () => {
    const index = buildCategoryIndex(CATEGORIES);
    expect(index.get('cat-semis')).toEqual({ slug: 'semiconductors' });
    expect(index.get('cat-passives')).toEqual({ slug: 'passive-components' });
  });

  it('maps nested children to their slug PLUS the parent slug', () => {
    const index = buildCategoryIndex(CATEGORIES);
    expect(index.get('sub-mcu')).toEqual({
      slug: 'microcontrollers',
      parentSlug: 'semiconductors',
    });
    expect(index.get('sub-opamp')).toEqual({
      slug: 'op-amps',
      parentSlug: 'semiconductors',
    });
  });

  it('indexes every parent and child exactly once', () => {
    expect(buildCategoryIndex(CATEGORIES).size).toBe(4);
  });

  it('returns an empty index for no categories', () => {
    expect(buildCategoryIndex([]).size).toBe(0);
  });

  it('tolerates a row with no children array (endpoint drift)', () => {
    const index = buildCategoryIndex([
      { id: 'cat-bare', slug: 'bare' } as unknown as AdminCategory,
    ]);
    expect(index.get('cat-bare')).toEqual({ slug: 'bare' });
    expect(index.size).toBe(1);
  });
});

describe('placementPath — category placements', () => {
  const index = buildCategoryIndex(CATEGORIES);

  it('links a Platinum top-level placement to the flat /category/<slug>', () => {
    const path = placementPath(
      sponsor({ tier: 'Platinum', category_id: 'cat-semis' }),
      index,
    );
    expect(path).toBe('/category/semiconductors');
  });

  it('links a Gold subcategory placement to the NESTED /category/<parent>/<child>', () => {
    const path = placementPath(
      sponsor({ tier: 'Gold', category_id: 'sub-mcu' }),
      index,
    );
    expect(path).toBe('/category/semiconductors/microcontrollers');
  });

  it('links a Silver subcategory placement to the same nested url', () => {
    const path = placementPath(
      sponsor({ tier: 'Silver', category_id: 'sub-opamp' }),
      index,
    );
    expect(path).toBe('/category/semiconductors/op-amps');
  });

  it('returns null for a category_id the index does not know', () => {
    expect(
      placementPath(sponsor({ category_id: 'cat-deleted' }), index),
    ).toBeNull();
  });
});

describe('placementPath — keyword placements', () => {
  const index = buildCategoryIndex(CATEGORIES);

  it('links a plain keyword to /keyword/<keyword>', () => {
    expect(placementPath(sponsor({ keyword: 'resistors' }), index)).toBe(
      '/keyword/resistors',
    );
  });

  it('percent-encodes a keyword containing a space', () => {
    expect(placementPath(sponsor({ keyword: 'power supply' }), index)).toBe(
      '/keyword/power%20supply',
    );
  });

  it('percent-encodes url-significant characters', () => {
    expect(placementPath(sponsor({ keyword: 'r&d / tools?' }), index)).toBe(
      '/keyword/r%26d%20%2F%20tools%3F',
    );
  });

  it('trims surrounding whitespace but preserves casing', () => {
    expect(placementPath(sponsor({ keyword: '  Power MOSFET  ' }), index)).toBe(
      '/keyword/Power%20MOSFET',
    );
  });

  it('returns null for a whitespace-only keyword', () => {
    expect(placementPath(sponsor({ keyword: '   ' }), index)).toBeNull();
  });
});

describe('placementPath — no placement', () => {
  it('returns null when neither category_id nor keyword is set', () => {
    const index = buildCategoryIndex(CATEGORIES);
    expect(placementPath(sponsor({}), index)).toBeNull();
  });

  it('returns null for every row when the index is empty', () => {
    const empty = new Map<string, { slug: string; parentSlug?: string }>();
    expect(placementPath(sponsor({ category_id: 'cat-semis' }), empty)).toBeNull();
  });
});
