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
