// The workspace's views: their order, their names, and which half of a project
// each one needs. ONE home, read by the workspace's tablist AND by the /viewer
// guide's "what each file adds" table, so the guide can never promise a tab
// the workspace does not offer.

export type ViewId = 'schematic' | 'board' | 'stackup' | 'board3d' | 'bom';

export const VIEW_LABEL: Record<ViewId, string> = {
  schematic: 'Schematic',
  board: 'Board',
  stackup: 'Stackup',
  board3d: '3D',
  bom: 'BOM',
};

/** Every view, in tab order. */
export const VIEW_ORDER: readonly ViewId[] = ['schematic', 'board', 'stackup', 'board3d', 'bom'];

/**
 * The views a project offers, in tab order.
 *
 * Stackup and 3D are offered for any project with a board, INCLUDING one whose
 * board this reader cannot parse — the panel then says why, which is a better
 * answer than a tab that quietly is not there. The BOM is read from the
 * schematic, so it needs one.
 */
export function viewsFor(hasSchematic: boolean, hasBoard: boolean): ViewId[] {
  return VIEW_ORDER.filter((id) => (id === 'schematic' || id === 'bom' ? hasSchematic : hasBoard));
}

/**
 * The one plain key that jumps straight to each view. Clear of the 3D view's
 * own keys (t/b/f/r, 1/2/3) and of the page's `/` and Esc; `p` is the board
 * because `b` is the 3D view's "bottom". Callers pass `e.key.toLowerCase()`.
 */
export const VIEW_KEY: Record<ViewId, string> = {
  schematic: 's',
  board: 'p',
  stackup: 'k',
  board3d: 'd',
  bom: 'm',
};

/** The view a key jumps to, or null when the key is not one of them. */
export function viewForKey(key: string): ViewId | null {
  return VIEW_ORDER.find((id) => VIEW_KEY[id] === key) ?? null;
}
