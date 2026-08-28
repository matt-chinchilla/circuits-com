// Rebuilding the staff page's two-level tree from the flat account rows.
//
// GET /api/account/categories answers "where are my parts", so it sends only
// the categories holding some: mostly subcategories, each carrying its
// parent's id/name/slug/icon, and occasionally a top-level category with parts
// attached to it directly. The staff page draws the real taxonomy; this
// rebuilds the same two levels out of what the rows themselves carry, so a
// customer opens the SAME page rather than a second design.
//
// Pure functions in their own module — the grouping and the filter are the
// parts that break silently, and both are testable without mounting a page.

import type { AccountCategory } from '@admin/types/account';

/** One top-level block: the head the staff page draws, and its child tiles. */
export interface AccountCategoryNode {
  /** The parent's id — or the row's own id, when that row IS top-level. */
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  /** Parts sitting on this category itself rather than on a child. */
  own_count: number;
  /** The rows naming this node as their parent, in the order the server sent
   *  them (count DESC, then name). */
  children: AccountCategory[];
  /** `own_count` plus the children's counts — what the head pill shows. */
  parts_count: number;
}

/** A node as the search box leaves it: children may be narrowed to the ones
 *  that matched, in which case the block opens whatever the user expanded. */
export interface FilteredAccountCategoryNode extends AccountCategoryNode {
  forceOpen: boolean;
}

function total(node: Pick<AccountCategoryNode, 'own_count' | 'children'>): number {
  return node.children.reduce((n, c) => n + c.parts_count, node.own_count);
}

function byCountThenName(a: AccountCategoryNode, b: AccountCategoryNode): number {
  return b.parts_count - a.parts_count || a.name.localeCompare(b.name);
}

/**
 * Flat rows in, top-level blocks out.
 *
 * Two passes, and the order matters: a top-level category that came back as a
 * row in its own right supplies the real name/slug/icon before any child has
 * to fall back to the parent fields it carries. Both passes key on
 * `parent_id`, so a row is a child of exactly one node and a node appears once
 * however many of its children arrived.
 */
export function groupAccountCategories(rows: AccountCategory[]): AccountCategoryNode[] {
  const byId = new Map<string, AccountCategoryNode>();

  const nodeFor = (
    id: string,
    name: string,
    slug: string,
    icon: string | null,
  ): AccountCategoryNode => {
    const found = byId.get(id);
    if (found) return found;
    const made: AccountCategoryNode = {
      id,
      name,
      slug,
      icon,
      own_count: 0,
      children: [],
      parts_count: 0,
    };
    byId.set(id, made);
    return made;
  };

  for (const row of rows) {
    if (row.parent_id != null) continue;
    nodeFor(row.id, row.name, row.slug, row.icon).own_count += row.parts_count;
  }

  for (const row of rows) {
    if (row.parent_id == null) continue;
    // parent_name/slug are populated whenever parent_id is, but the contract
    // types them nullable and a hole here would render as a blank head.
    const name = row.parent_name ?? row.parent_slug ?? 'Uncategorized';
    nodeFor(row.parent_id, name, row.parent_slug ?? '', row.parent_icon).children.push(row);
  }

  const nodes = [...byId.values()];
  for (const node of nodes) node.parts_count = total(node);
  return nodes.sort(byCountThenName);
}

/**
 * The tree the search box leaves standing.
 *
 * Mirrors the staff filter exactly: a parent that matches keeps ALL its
 * children, a parent that does not keeps only the children that matched and
 * opens itself to show them, and a parent with neither drops out. Counts are
 * recomputed off the surviving children, so a filtered head never claims parts
 * it is no longer showing.
 */
export function filterAccountCategoryTree(
  nodes: AccountCategoryNode[],
  query: string,
): FilteredAccountCategoryNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes.map((node) => ({ ...node, forceOpen: false }));

  const hit = (text: string) => text.toLowerCase().includes(q);
  const out: FilteredAccountCategoryNode[] = [];

  for (const node of nodes) {
    if (hit(node.name) || hit(node.slug)) {
      out.push({ ...node, forceOpen: false });
      continue;
    }
    const children = node.children.filter((c) => hit(c.name) || hit(c.slug));
    if (children.length === 0) continue;
    out.push({ ...node, children, parts_count: total({ ...node, children }), forceOpen: true });
  }
  return out;
}
