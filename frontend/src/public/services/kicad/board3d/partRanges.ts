// A pick's way back from a triangle to a footprint (or a net), and a highlight's
// way from a footprint, a net, a layer or a class to the slices of a mesh it
// owns. Pure index arithmetic over the range tables `buildScene` records —
// `PartRange`, `ClassRange`, `NetRange`, all in the same units (offsets into a
// group's `indices`) — no three.js, so the renderer's only job is to hand a face
// index in and a list of draw ranges out.
import type { ClassRange, NetRange, PartRange } from './types';

/** Any slice of a group's `indices`: `start` an offset, `count` a length. */
export interface IndexRange { start: number; count: number }

/** The range holding index `index`, by binary search on `start` (the tables are
 *  contiguous-or-gapped but always ascending and non-overlapping). */
function rangeAt<T extends IndexRange>(ranges: readonly T[] | undefined, index: number): T | null {
  if (ranges == null || ranges.length === 0 || index < 0) return null;
  let lo = 0, hi = ranges.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ranges[mid].start <= index) lo = mid;
    else hi = mid - 1;
  }
  const range = ranges[lo];
  return range.start <= index && index < range.start + range.count ? range : null;
}

/**
 * The footprint that owns triangle `faceIndex` of a group, or null when the
 * triangle is nobody's (a track, a pour, or a group with no table at all).
 * Ranges are contiguous and ascending by construction, so this is a binary
 * search on `start` over what is, on a real board, a few hundred entries.
 */
export function partAtFace(parts: readonly PartRange[] | undefined, faceIndex: number): string | null {
  return rangeAt(parts, faceIndex * 3)?.ref ?? null;
}

/** The net that drew triangle `faceIndex` of a copper group; 0 when none did. */
export function netAtFace(nets: readonly NetRange[] | undefined, faceIndex: number): number {
  return rangeAt(nets, faceIndex * 3)?.net ?? 0;
}

/** One draw range of a group: `materialIndex` 0 is the group's own material, 1
 *  is the highlight. What `BufferGeometry.addGroup` takes, in order. */
export interface DrawSlice { start: number; count: number; materialIndex: 0 | 1 }

/**
 * `ranges` clipped to `[0, total)`, sorted, and with overlapping or touching
 * ranges joined — the canonical form every tiling below walks. Defensive on
 * purpose: a caller may hand in ranges from several tables at once.
 */
function normalised(ranges: readonly IndexRange[], total: number): IndexRange[] {
  const sorted = ranges
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(total, r.start + r.count) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: IndexRange[] = [];
  for (const r of sorted) {
    const last = out.length > 0 ? out[out.length - 1] : null;
    if (last != null && r.start <= last.start + last.count) {
      last.count = Math.max(last.count, r.end - last.start);
    } else {
      out.push({ start: r.start, count: r.end - r.start });
    }
  }
  return out;
}

/**
 * How to draw a group so that `ranges` — and only those — take the highlight
 * material. With no ranges the whole group draws with its own material in one
 * slice, which is exactly the un-highlighted state. Every emitted slice is
 * non-empty and the slices tile `[0, totalIndices)` in order.
 *
 * The one function every highlight goes through: a part is its `PartRange`s
 * (`highlightSlices`), a net its `NetRange`s (`netRangesOf`), a whole layer
 * the single range `[{ start: 0, count: totalIndices }]`.
 */
export function rangeSlices(ranges: readonly IndexRange[], totalIndices: number): DrawSlice[] {
  const out: DrawSlice[] = [];
  const push = (start: number, end: number, materialIndex: 0 | 1) => {
    if (end > start) out.push({ start, count: end - start, materialIndex });
  };
  let cursor = 0;
  for (const range of normalised(ranges, totalIndices)) {
    push(cursor, range.start, 0);
    push(range.start, range.start + range.count, 1);
    cursor = range.start + range.count;
  }
  push(cursor, totalIndices, 0);
  return out;
}

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
  const lifted = ref == null || parts == null ? [] : parts.filter((range) => range.ref === ref);
  return rangeSlices(lifted, totalIndices);
}

/** The ranges of one net in a copper group; none for `null`, net 0 or an absent table. */
export function netRangesOf(nets: readonly NetRange[] | undefined, net: number | null): NetRange[] {
  if (net == null || net === 0 || nets == null) return [];
  return nets.filter((range) => range.net === net);
}

/**
 * One draw range of a copper group that carries per-class opacity: which class
 * drew it (null where the group has no class table, or a gap in it) and whether
 * it is highlighted. The renderer maps each `(kind, highlighted)` pair to a
 * material; the slices tile `[0, totalIndices)` in order, every one non-empty,
 * and two neighbours never share both fields (they would have been one slice).
 */
export interface ClassSlice { start: number; count: number; kind: ClassRange['kind'] | null; highlighted: boolean }

export function classSlices(
  classes: readonly ClassRange[] | undefined, highlight: readonly IndexRange[], totalIndices: number,
): ClassSlice[] {
  const lifted = normalised(highlight, totalIndices);
  const byClass = (classes ?? [])
    .map((c) => ({ kind: c.kind, start: Math.max(0, c.start), end: Math.min(totalIndices, c.start + c.count) }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);

  const cuts = new Set<number>([0, totalIndices]);
  for (const c of byClass) cuts.add(c.start).add(c.end);
  for (const h of lifted) cuts.add(h.start).add(h.start + h.count);
  const points = [...cuts].filter((p) => p >= 0 && p <= totalIndices).sort((a, b) => a - b);

  const out: ClassSlice[] = [];
  let ci = 0, hi = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i], end = points[i + 1];
    while (ci < byClass.length && byClass[ci].end <= start) ci++;
    while (hi < lifted.length && lifted[hi].start + lifted[hi].count <= start) hi++;
    const kind = ci < byClass.length && byClass[ci].start <= start ? byClass[ci].kind : null;
    const highlighted = hi < lifted.length && lifted[hi].start <= start;
    const last = out.length > 0 ? out[out.length - 1] : null;
    if (last != null && last.kind === kind && last.highlighted === highlighted && last.start + last.count === start) {
      last.count += end - start;
    } else {
      out.push({ start, count: end - start, kind, highlighted });
    }
  }
  return out;
}
