// Which triangles of one mesh draw in which material (spec 2026-09-22 §2.2).
//
// A copper group is ONE BufferGeometry whose draw groups say, range by range,
// which material each slice of the index buffer uses: one material per object
// class (tracks, pads, zones — so each can carry its own opacity), and the
// highlight material over whatever a part, layer or net selection lights. This
// module is that arithmetic and nothing else — no three.js — so the renderer's
// job is to hand ranges in and `addGroup` what comes out.
//
// Units: everything here is in INDICES, what `BufferGeometry.addGroup` counts —
// the same units as the pipeline's part, class and net ranges (an offset into a
// group's `indices`, a count that is a multiple of 3), so they pass straight in.

/** A slice of a group's index buffer: `start` and `count` in indices. */
export interface Span { start: number; count: number }
/** A slice and the material (an index into the mesh's material array) it draws in. */
export interface MaterialSpan extends Span { materialIndex: number }

/** Sorted, clamped to [0, total), overlapping and touching spans merged, empty ones dropped. */
export function normaliseSpans(spans: readonly Span[], total: number): Span[] {
  const clamped: Span[] = [];
  for (const s of spans) {
    const start = Math.max(0, s.start);
    const end = Math.min(total, s.start + s.count);
    if (end > start) clamped.push({ start, count: end - start });
  }
  clamped.sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of clamped) {
    const last = out[out.length - 1];
    if (last != null && s.start <= last.start + last.count) {
      last.count = Math.max(last.count, s.start + s.count - last.start);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

export interface DrawSliceOptions {
  /** The material for triangles no class claims (every triangle of a group
   *  that has no class table at all). */
  baseIndex: number;
  /** The highlight material. */
  litIndex: number;
  /** Class materials whose triangles are not drawn at all — lit or not. A
   *  class at opacity 0 is hidden, and a highlight must not bring it back. */
  hidden?: ReadonlySet<number>;
}

/**
 * The draw groups of one mesh. `classes` claim triangles for their own
 * material (anything unclaimed draws in `baseIndex`); `lit` spans take
 * `litIndex` over whatever class they fall in; a `hidden` class is left out.
 * The result is ascending, non-overlapping and never empty per slice, and
 * adjacent slices of one material are joined — each slice is a draw call.
 */
export function drawSlices(
  total: number, classes: readonly MaterialSpan[], lit: readonly Span[], options: DrawSliceOptions,
): MaterialSpan[] {
  const { baseIndex, litIndex, hidden } = options;
  const out: MaterialSpan[] = [];
  const push = (start: number, end: number, materialIndex: number) => {
    if (end <= start) return;
    const last = out[out.length - 1];
    if (last != null && last.materialIndex === materialIndex && last.start + last.count === start) last.count += end - start;
    else out.push({ start, count: end - start, materialIndex });
  };

  // The class tiling of [0, total): each class where it claims, base elsewhere.
  // A class overlapping one before it only claims what is left.
  const tiles: MaterialSpan[] = [];
  let cursor = 0;
  const sorted = [...classes].sort((a, b) => a.start - b.start);
  for (const c of sorted) {
    const start = Math.max(cursor, c.start, 0);
    const end = Math.min(total, c.start + c.count);
    if (end <= start) continue;
    if (start > cursor) tiles.push({ start: cursor, count: start - cursor, materialIndex: baseIndex });
    tiles.push({ start, count: end - start, materialIndex: c.materialIndex });
    cursor = end;
  }
  if (cursor < total) tiles.push({ start: cursor, count: total - cursor, materialIndex: baseIndex });

  const lights = normaliseSpans(lit, total);
  let j = 0;
  for (const tile of tiles) {
    const end = tile.start + tile.count;
    if (hidden?.has(tile.materialIndex)) continue;
    let p = tile.start;
    while (j < lights.length && lights[j].start + lights[j].count <= p) j++;
    while (p < end) {
      const light = lights[j];
      if (light != null && light.start <= p) {
        const lightEnd = Math.min(light.start + light.count, end);
        push(p, lightEnd, litIndex);
        p = lightEnd;
        if (light.start + light.count <= p) j++;
      } else {
        const next = light == null ? end : Math.min(light.start, end);
        push(p, next, tile.materialIndex);
        p = next;
      }
    }
  }
  return out;
}
