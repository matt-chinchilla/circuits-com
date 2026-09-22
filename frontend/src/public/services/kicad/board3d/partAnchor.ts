// Where a part IS in the scene, for the label that names it (owner, 2026-09-22:
// "things just need to be clearly labeled"). The label anchors to the centre
// of the part's estimated body when one was drawn, at the body's outer face;
// on a board without bodies (the reduced tier, a part with no courtyard) it
// anchors to the centre of the part's pads on the outer copper instead — the
// pads are the part's true footprint, and they are always drawn. A part the
// scene does not draw at all has no anchor, and the label stays away.
//
// Pure index arithmetic over the range tables `buildScene` records; the
// renderer only projects the point it is given.
import { partAtFace } from './partRanges';
import type { BoardScene, MeshGroup, PartRange, Side } from './types';

export interface PartAnchor {
  /** Model space, as the scene's `positions` are. */
  x: number;
  y: number;
  z: number;
  /** Which face of the board the part sits on: the label is hidden while the
   *  camera looks at the other face. */
  side: Side;
  /** True when the anchor is a drawn BODY — an estimate — rather than the pads. */
  body: boolean;
}

/** The part's range in a group, or null. */
function rangeOf(group: MeshGroup, ref: string): PartRange | null {
  return group.parts?.find((p) => p.ref === ref) ?? null;
}

/** The centroid of every vertex the range's triangles touch (each vertex
 *  counted once), and the range's z extent. */
function centroid(group: MeshGroup, range: PartRange): { x: number; y: number; zMin: number; zMax: number } | null {
  const seen = new Set<number>();
  let sx = 0, sy = 0, n = 0, zMin = Infinity, zMax = -Infinity;
  const end = Math.min(group.indices.length, range.start + range.count);
  for (let i = range.start; i < end; i++) {
    const v = group.indices[i];
    if (seen.has(v)) continue;
    seen.add(v);
    sx += group.positions[v * 3];
    sy += group.positions[v * 3 + 1];
    const z = group.positions[v * 3 + 2];
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
    n++;
  }
  return n === 0 ? null : { x: sx / n, y: sy / n, zMin, zMax };
}

/** The board's own z extent — the substrate's — cached per scene, so a body's
 *  side is read as "above the board" or "below it". */
const boardZ = new WeakMap<BoardScene, { lo: number; hi: number }>();
function boardExtent(scene: BoardScene): { lo: number; hi: number } {
  const hit = boardZ.get(scene);
  if (hit != null) return hit;
  let lo = Infinity, hi = -Infinity;
  for (const g of scene.groups) {
    if (g.material !== 'substrate') continue;
    for (let i = 2; i < g.positions.length; i += 3) {
      const z = g.positions[i];
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
  }
  const extent = Number.isFinite(lo) ? { lo, hi } : { lo: 0, hi: 0 };
  boardZ.set(scene, extent);
  return extent;
}

/** The side a layer name says, or null for a group that names no face. */
function sideOfLayer(layerName: string | null): Side | null {
  return layerName?.startsWith('F.') ? 'F' : layerName?.startsWith('B.') ? 'B' : null;
}

export function partAnchor(scene: BoardScene, ref: string): PartAnchor | null {
  // The body first: its outer face is where a leader line lands on a part.
  for (const group of scene.groups) {
    if (group.material !== 'body') continue;
    const range = rangeOf(group, ref);
    if (range == null) continue;
    const c = centroid(group, range);
    if (c == null) continue;
    const board = boardExtent(scene);
    const mid = (board.lo + board.hi) / 2;
    const side: Side = (c.zMin + c.zMax) / 2 >= mid ? 'F' : 'B';
    return { x: c.x, y: c.y, z: side === 'F' ? c.zMax : c.zMin, side, body: true };
  }
  // Else the pads on the outer copper, front face first.
  for (const wanted of ['F', 'B'] as const) {
    for (const group of scene.groups) {
      if (group.material !== 'copper' || sideOfLayer(group.layerName) !== wanted) continue;
      const range = rangeOf(group, ref);
      if (range == null) continue;
      const c = centroid(group, range);
      if (c == null) continue;
      return { x: c.x, y: c.y, z: wanted === 'F' ? c.zMax : c.zMin, side: wanted, body: false };
    }
  }
  return null;
}

/** Does the scene draw an ESTIMATED body for `ref`? Every body the pipeline
 *  draws is one (spec D2), so this is "does it draw a body at all". */
export function hasEstimatedBody(scene: BoardScene, ref: string): boolean {
  return scene.groups.some((g) => g.material === 'body' && rangeOf(g, ref) != null);
}

/** The part a triangle of a group belongs to — re-exported so the renderer
 *  has one import for "from a hit to a part" and "from a part to a point". */
export { partAtFace };
