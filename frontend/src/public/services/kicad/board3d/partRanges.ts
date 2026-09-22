// A pick's way back from a triangle to a footprint, and a highlight's way from a
// footprint to the slice of a mesh it owns. Pure index arithmetic over the
// `PartRange` tables `buildScene` records — no three.js, so the renderer's only
// job is to hand a face index in and a set of draw ranges out.
import type { PartRange } from './types';

/**
 * The footprint that owns triangle `faceIndex` of a group, or null when the
 * triangle is nobody's (a track, a pour, or a group with no table at all).
 * Ranges are contiguous and ascending by construction, so this is a binary
 * search on `start` over what is, on a real board, a few hundred entries.
 */
export function partAtFace(parts: readonly PartRange[] | undefined, faceIndex: number): string | null {
  if (parts == null || parts.length === 0 || faceIndex < 0) return null;
  const index = faceIndex * 3;
  let lo = 0, hi = parts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (parts[mid].start <= index) lo = mid;
    else hi = mid - 1;
  }
  const range = parts[lo];
  return range.start <= index && index < range.start + range.count ? range.ref : null;
}

/** One draw range of a group: `materialIndex` 0 is the group's own material, 1
 *  is the highlight. What `BufferGeometry.addGroup` takes, in order. */
export interface DrawSlice { start: number; count: number; materialIndex: 0 | 1 }

/**
 * How to draw a group so that `ref`'s triangles — and only those — take the
 * highlight material. With no selection, or a selection this group does not
 * draw, the whole group draws with its own material in one range, which is
 * exactly the un-highlighted state. Every emitted slice is non-empty and the
 * slices tile `[0, totalIndices)` in order.
 */
export function highlightSlices(
  parts: readonly PartRange[] | undefined, ref: string | null, totalIndices: number,
): DrawSlice[] {
  const out: DrawSlice[] = [];
  const push = (start: number, end: number, materialIndex: 0 | 1) => {
    if (end > start) out.push({ start, count: end - start, materialIndex });
  };
  let cursor = 0;
  if (ref != null && parts != null) {
    for (const range of parts) {
      if (range.ref !== ref) continue;
      push(cursor, range.start, 0);
      push(range.start, range.start + range.count, 1);
      cursor = range.start + range.count;
    }
  }
  push(cursor, totalIndices, 0);
  return out;
}
