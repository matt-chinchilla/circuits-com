import { describe, expect, it } from 'vitest';
import type { AccountCategory } from '@admin/types/account';
import {
  filterAccountCategoryTree,
  groupAccountCategories,
  type AccountCategoryNode,
} from './accountCategoryTree';

function row(overrides: Partial<AccountCategory> & { name: string }): AccountCategory {
  return {
    id: overrides.id ?? overrides.name.toLowerCase().replace(/\s+/g, '-'),
    name: overrides.name,
    slug: overrides.slug ?? overrides.name.toLowerCase().replace(/\s+/g, '-'),
    icon: overrides.icon ?? 'cpu',
    parent_id: overrides.parent_id ?? null,
    parent_name: overrides.parent_name ?? null,
    parent_slug: overrides.parent_slug ?? null,
    parent_icon: overrides.parent_icon ?? null,
    parts_count: overrides.parts_count ?? 1,
  };
}

/** A subcategory row under "Integrated Circuits", the shape the server sends. */
function child(name: string, parts: number): AccountCategory {
  return row({
    name,
    parts_count: parts,
    parent_id: 'ics',
    parent_name: 'Integrated Circuits',
    parent_slug: 'integrated-circuits',
    parent_icon: 'circuitry',
  });
}

describe('groupAccountCategories', () => {
  it('hangs subcategory rows under one node built from their parent fields', () => {
    const nodes = groupAccountCategories([child('Clock and Timing', 3), child('Amplifiers', 2)]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('ics');
    expect(nodes[0].name).toBe('Integrated Circuits');
    expect(nodes[0].slug).toBe('integrated-circuits');
    expect(nodes[0].icon).toBe('circuitry');
    expect(nodes[0].children.map((c) => c.name)).toEqual(['Clock and Timing', 'Amplifiers']);
  });

  it("sums the children into the parent's count", () => {
    const nodes = groupAccountCategories([child('Clock and Timing', 3), child('Amplifiers', 2)]);
    expect(nodes[0].parts_count).toBe(5);
    expect(nodes[0].own_count).toBe(0);
  });

  it('treats a row with no parent as a top-level node of its own', () => {
    const nodes = groupAccountCategories([row({ name: 'Connectors', parts_count: 4 })]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].children).toEqual([]);
    expect(nodes[0].own_count).toBe(4);
    expect(nodes[0].parts_count).toBe(4);
  });

  it('adds parts sitting on the parent itself to the parts under its children', () => {
    // seed.py attaches parts to TOP-LEVEL categories, so a category can come
    // back both in its own right and as somebody's parent.
    const nodes = groupAccountCategories([
      row({ id: 'ics', name: 'Integrated Circuits', slug: 'integrated-circuits', parts_count: 7 }),
      child('Clock and Timing', 3),
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].own_count).toBe(7);
    expect(nodes[0].parts_count).toBe(10);
  });

  it("prefers the top-level row's own name, slug and icon over a child's copy", () => {
    const nodes = groupAccountCategories([
      child('Clock and Timing', 3),
      row({
        id: 'ics',
        name: 'Integrated Circuits',
        slug: 'integrated-circuits',
        icon: 'cpu',
        parts_count: 1,
      }),
    ]);
    expect(nodes[0].icon).toBe('cpu');
  });

  it('orders the blocks by count, then name — the ordering the server uses', () => {
    const nodes = groupAccountCategories([
      row({ name: 'Bravo', parts_count: 2 }),
      row({ name: 'Alpha', parts_count: 2 }),
      row({ name: 'Charlie', parts_count: 9 }),
    ]);
    expect(nodes.map((n) => n.name)).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('names a parent by its slug, then a placeholder, when the name is missing', () => {
    const orphan = row({ name: 'Widgets', parent_id: 'p1', parent_slug: 'passives' });
    const nameless = row({ name: 'Gadgets', parent_id: 'p2' });
    const nodes = groupAccountCategories([orphan, nameless]);
    expect(nodes.map((n) => n.name).sort()).toEqual(['Uncategorized', 'passives']);
  });

  it('returns nothing for no rows', () => {
    expect(groupAccountCategories([])).toEqual([]);
  });
});

describe('filterAccountCategoryTree', () => {
  const tree: AccountCategoryNode[] = groupAccountCategories([
    row({ id: 'ics', name: 'Integrated Circuits', slug: 'integrated-circuits', parts_count: 1 }),
    child('Clock and Timing', 3),
    child('Amplifiers', 2),
    row({ name: 'Connectors', slug: 'connectors', parts_count: 4 }),
  ]);

  it('leaves the tree alone for an empty query', () => {
    const out = filterAccountCategoryTree(tree, '   ');
    expect(out.map((n) => n.name)).toEqual(tree.map((n) => n.name));
    expect(out.every((n) => !n.forceOpen)).toBe(true);
  });

  it('keeps every child of a parent that matches', () => {
    const out = filterAccountCategoryTree(tree, 'integrated');
    expect(out).toHaveLength(1);
    expect(out[0].children).toHaveLength(2);
    expect(out[0].forceOpen).toBe(false);
  });

  it('keeps only the matching children of a parent that does not match, and opens it', () => {
    const out = filterAccountCategoryTree(tree, 'amplifi');
    expect(out).toHaveLength(1);
    expect(out[0].children.map((c) => c.name)).toEqual(['Amplifiers']);
    expect(out[0].forceOpen).toBe(true);
  });

  it('recounts a narrowed parent so the head cannot claim parts it is hiding', () => {
    const out = filterAccountCategoryTree(tree, 'amplifi');
    // 1 on the parent itself + 2 on Amplifiers; Clock and Timing's 3 are gone.
    expect(out[0].parts_count).toBe(3);
  });

  it('drops a block that matches on neither side', () => {
    expect(filterAccountCategoryTree(tree, 'zzz')).toEqual([]);
  });

  it('matches on slug as well as name, and ignores case', () => {
    expect(filterAccountCategoryTree(tree, 'CONNECT').map((n) => n.name)).toEqual(['Connectors']);
  });

  it('does not mutate the tree it filtered', () => {
    filterAccountCategoryTree(tree, 'amplifi');
    const ics = tree.find((n) => n.id === 'ics');
    expect(ics?.children).toHaveLength(2);
    expect(ics?.parts_count).toBe(6);
  });
});
