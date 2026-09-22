import { flattenThreePoint } from './arcs';
import { bbox, signedArea } from './geom';
import { circleRing } from './strokes';
import type { Ring, Shape, Vec2 } from './types';

export interface Chained { loops: Ring[]; unchained: number }

/** 1 µm snap: KiCad writes Edge.Cuts endpoints to 6 decimals, so exact equality misses. */

/**
 * Chain open polylines end-to-end into closed loops. Inputs that already close
 * (first == last within the snap) become loops directly. Anything that runs into
 * a dead end is counted in `unchained` — every polyline that went into the
 * non-closing chain, not just the last one.
 */
export function chainLoops(polylines: Vec2[][], snapMm = 0.001): Chained {
  const near = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) <= snapMm && Math.abs(a.y - b.y) <= snapMm;
  const loops: Ring[] = [];
  const open: Vec2[][] = [];
  for (const pl of polylines) {
    if (pl.length < 2) continue;
    const first = pl[0], last = pl[pl.length - 1];
    if (pl.length >= 3 && near(first, last)) loops.push({ pts: pl.slice(0, -1) });
    else open.push(pl);
  }
  // Endpoint index: grid cell → endpoint ids (2·polyline + end). Lookups scan
  // the 3×3 neighbourhood and confirm by DISTANCE: two endpoints 8 µm apart can
  // straddle a cell boundary at any cell size (Glasgow's J4 courtyard: 85.870 vs
  // 85.878 round to different 20 µm cells), so a same-cell test alone can never
  // close a gap the snap was meant to close.
  //
  // A consumed polyline's endpoints are SWAP-REMOVED from their cells, and a
  // lookup returns the first match rather than listing them all. Both matter
  // when endpoints pile up in one cell: scanning dead entries and building the
  // full match list on every step made a hostile file of 40k zero-length
  // Edge.Cuts lines cost 47 s (measured), quadratic in the pile.
  const used = new Array<boolean>(open.length).fill(false);
  const index = new Map<string, number[]>();
  const keyOf: string[] = new Array<string>(open.length * 2);
  const slotOf = new Int32Array(open.length * 2);
  const cellKey = (p: Vec2, dx = 0, dy = 0) => `${Math.round(p.x / snapMm) + dx}|${Math.round(p.y / snapMm) + dy}`;
  const endpoint = (id: number) => {
    const pl = open[id >> 1];
    return (id & 1) === 0 ? pl[0] : pl[pl.length - 1];
  };
  for (let id = 0; id < open.length * 2; id++) {
    const k = cellKey(endpoint(id));
    const arr = index.get(k);
    keyOf[id] = k;
    if (arr == null) {
      slotOf[id] = 0;
      index.set(k, [id]);
    } else {
      slotOf[id] = arr.length;
      arr.push(id);
    }
  }
  const drop = (id: number) => {
    const arr = index.get(keyOf[id])!;
    const last = arr.pop()!;
    if (last !== id) {
      arr[slotOf[id]] = last;
      slotOf[last] = slotOf[id];
    }
  };
  const consume = (i: number) => {
    used[i] = true;
    drop(2 * i);
    drop(2 * i + 1);
  };
  const firstCandidate = (p: Vec2): number => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of index.get(cellKey(p, dx, dy)) ?? []) if (near(p, endpoint(id))) return id;
      }
    }
    return -1;
  };
  let unchained = 0;
  for (let s = 0; s < open.length; s++) {
    if (used[s]) continue;
    consume(s);
    let consumed = 1;
    const chain: Vec2[] = [...open[s]];
    let closed = false;
    for (let guard = 0; guard < open.length; guard++) {
      const tail = chain[chain.length - 1];
      if (chain.length > 2 && near(tail, chain[0])) { closed = true; break; }
      const id = firstCandidate(tail);
      if (id < 0) break;
      const i = id >> 1;
      consume(i);
      consumed++;
      const next = (id & 1) === 0 ? open[i] : [...open[i]].reverse();
      chain.push(...next.slice(1));
    }
    if (closed) loops.push({ pts: chain.slice(0, -1) });
    else unchained += consumed;
  }
  return { loops, unchained };
}

/**
 * Every shape as ONE polyline in the shape's own coordinates. Closed shapes
 * (circle, rect, closed poly) repeat their first point so `chainLoops` takes
 * them as loops immediately; open ones (line, arc) are left for the chainer.
 * `degenerateArcs` counts the arcs whose three points were collinear and came
 * out as their chord. One home for this conversion: the board outline and a
 * footprint's courtyard are the same job on different shapes.
 */
export function shapePolylines(shapes: Shape[], tolMm: number): { polylines: Vec2[][]; degenerateArcs: number } {
  const polylines: Vec2[][] = [];
  let degenerateArcs = 0;
  for (const s of shapes) {
    if (s.kind === 'line') polylines.push([s.a, s.b]);
    else if (s.kind === 'arc') {
      const r = flattenThreePoint(s.a, s.mid, s.b, tolMm);
      if (r.degenerate) degenerateArcs++;
      polylines.push(r.pts);
    } else if (s.kind === 'circle') {
      const pts = circleRing(s.c, s.r, tolMm).pts;
      polylines.push([...pts, pts[0]]);
    } else if (s.kind === 'rect') {
      polylines.push([s.a, { x: s.b.x, y: s.a.y }, s.b, { x: s.a.x, y: s.b.y }, s.a]);
    } else if (s.kind === 'poly' && s.pts.length >= 3) {
      polylines.push([...s.pts, s.pts[0]]);
    }
  }
  return { polylines, degenerateArcs };
}

/** How far past the copper the fallback slab reaches, when there is no outline. */
const CONTENT_MARGIN_MM = 1;

/**
 * Edge.Cuts → the board outline plus its cutouts. Circles, rects and closed polys
 * are loops already; lines and arcs (flattened at `tolMm`) get chained. The
 * largest |area| loop is the board. If anything fails to chain, the caller gets
 * the axis-aligned bounding box and `open: true` — never a partial outline.
 *
 * With NO edge items at all (a layout that has no outline yet), the box is the
 * board's own content — `contentPts`, the copper's points, plus a millimetre —
 * rather than an invented square at the page origin, which put the slab and the
 * orbit centre ~100 mm from everything the board actually draws.
 */
export function boardOutline(edgeItems: Shape[], tolMm: number, contentPts: Vec2[] = []): {
  outer: Ring; cutouts: Ring[]; open: boolean; unchained: number; degenerateArcs: number;
} {
  const { polylines, degenerateArcs } = shapePolylines(edgeItems, tolMm);
  const chained = chainLoops(polylines);
  const all = polylines.flat();
  if (chained.loops.length === 0 || chained.unchained > 0) {
    const b = all.length > 0
      ? bbox(all)
      : contentPts.length > 0
        ? grow(bbox(contentPts), CONTENT_MARGIN_MM)
        : bbox([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    const outer: Ring = {
      pts: orient([
        { x: b.min.x, y: b.min.y }, { x: b.max.x, y: b.min.y },
        { x: b.max.x, y: b.max.y }, { x: b.min.x, y: b.max.y },
      ], 'outer'),
    };
    return { outer, cutouts: [], open: true, unchained: chained.unchained || polylines.length, degenerateArcs };
  }
  const sorted = [...chained.loops].sort((p, q) => Math.abs(signedArea(q.pts)) - Math.abs(signedArea(p.pts)));
  const outer: Ring = { pts: orient(sorted[0].pts, 'outer') };
  const cutouts = sorted.slice(1).map((l) => ({ pts: orient(l.pts, 'hole') }));
  return { outer, cutouts, open: false, unchained: 0, degenerateArcs };
}

const grow = (b: { min: Vec2; max: Vec2 }, m: number) => ({
  min: { x: b.min.x - m, y: b.min.y - m }, max: { x: b.max.x + m, y: b.max.y + m },
});

/** Outer loops carry signedArea < 0, holes > 0 (y-down convention used by tessellate.ts). */
export function orient(pts: Vec2[], as: 'outer' | 'hole'): Vec2[] {
  const a = signedArea(pts);
  const want = as === 'outer' ? a < 0 : a > 0;
  return want ? pts : [...pts].reverse();
}
