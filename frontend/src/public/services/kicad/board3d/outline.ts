import { flattenThreePoint } from './arcs';
import { bbox, signedArea } from './geom';
import { circleRing } from './strokes';
import type { Ring, Shape, Vec2 } from './types';

export interface Chained { loops: Ring[]; unchained: number }

/** 1 µm snap: KiCad writes Edge.Cuts endpoints to 6 decimals, so exact equality misses. */
const key = (p: Vec2, snap: number) => `${Math.round(p.x / snap)}|${Math.round(p.y / snap)}`;

/**
 * Chain open polylines end-to-end into closed loops. Inputs that already close
 * (first == last within the snap) become loops directly. Anything that runs into
 * a dead end is counted in `unchained` — every polyline that went into the
 * non-closing chain, not just the last one.
 */
export function chainLoops(polylines: Vec2[][], snapMm = 0.001): Chained {
  const loops: Ring[] = [];
  const open: Vec2[][] = [];
  for (const pl of polylines) {
    if (pl.length < 2) continue;
    const first = pl[0], last = pl[pl.length - 1];
    if (pl.length >= 3 && key(first, snapMm) === key(last, snapMm)) loops.push({ pts: pl.slice(0, -1) });
    else open.push(pl);
  }
  // endpoint index: key → list of [polylineIndex, end(0|1)]
  const used = new Array<boolean>(open.length).fill(false);
  const index = new Map<string, [number, 0 | 1][]>();
  open.forEach((pl, i) => {
    for (const e of [0, 1] as const) {
      const k = key(e === 0 ? pl[0] : pl[pl.length - 1], snapMm);
      const arr = index.get(k) ?? []; arr.push([i, e]); index.set(k, arr);
    }
  });
  let unchained = 0;
  for (let s = 0; s < open.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    let consumed = 1;
    const chain: Vec2[] = [...open[s]];
    const startKey = key(chain[0], snapMm);
    let closed = false;
    for (let guard = 0; guard < open.length; guard++) {
      const tail = chain[chain.length - 1];
      if (key(tail, snapMm) === startKey && chain.length > 2) { closed = true; break; }
      const cands = (index.get(key(tail, snapMm)) ?? []).filter(([i]) => !used[i]);
      if (cands.length === 0) break;
      const [i, e] = cands[0];
      used[i] = true; consumed++;
      const next = e === 0 ? open[i] : [...open[i]].reverse();
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

/**
 * Edge.Cuts → the board outline plus its cutouts. Circles, rects and closed polys
 * are loops already; lines and arcs (flattened at `tolMm`) get chained. The
 * largest |area| loop is the board. If anything fails to chain, the caller gets
 * the axis-aligned bounding box and `open: true` — never a partial outline.
 */
export function boardOutline(edgeItems: Shape[], tolMm: number): {
  outer: Ring; cutouts: Ring[]; open: boolean; unchained: number; degenerateArcs: number;
} {
  const { polylines, degenerateArcs } = shapePolylines(edgeItems, tolMm);
  const chained = chainLoops(polylines);
  const all = polylines.flat();
  if (chained.loops.length === 0 || chained.unchained > 0) {
    const b = bbox(all.length ? all : [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
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

/** Outer loops carry signedArea < 0, holes > 0 (y-down convention used by tessellate.ts). */
export function orient(pts: Vec2[], as: 'outer' | 'hole'): Vec2[] {
  const a = signedArea(pts);
  const want = as === 'outer' ? a < 0 : a > 0;
  return want ? pts : [...pts].reverse();
}
