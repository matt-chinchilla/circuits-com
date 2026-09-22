// Do two closed rings actually overlap? (spec 2026-09-21 §4.)
//
// v1 has no polygon-clipping library, so `buildScene` approximates the union of
// two overlapping holes by keeping the larger and DROPPING the smaller — a
// simplification it counts into "N features simplified". That makes the overlap
// TEST the thing the count is only as honest as: a test that says yes too often
// deletes real holes and inflates the number the caption shows. The first cut
// compared bounding boxes (a ring covering >25% of a smaller neighbour's box was
// "the same hole"), which on a fine-pitch board calls every neighbouring pad
// opening a duplicate — 126 of them on Glasgow alone.
//
// So: two rings overlap iff an edge of one properly CROSSES an edge of the other,
// or one lies inside the other. Boundaries are deliberately exclusive — two pads
// that share an edge, or a drill tangent to its own pad's rim, touch without
// overlapping and both survive.
import { bbox, boxesOverlap, type Box } from './geom';
import type { Ring, Vec2 } from './types';

/** A picometre. Coordinates are KiCad millimetres, and KiCad itself rounds to
 *  the nanometre, so this separates "the same point" from "a real gap" by three
 *  orders without ever swallowing one. */
const EPS = 1e-9;

/** Twice the signed area of the triangle abc: > 0, < 0 or 0 for c left of, right
 *  of, or on the line ab. */
const orient = (a: Vec2, b: Vec2, c: Vec2): number =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/**
 * A PROPER crossing: each segment strictly separates the other's endpoints. All
 * four collinear/touching cases give a zero and answer false, which is what
 * keeps two rings that share an edge apart.
 */
function segmentsCross(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
  const d1 = orient(b1, b2, a1), d2 = orient(b1, b2, a2);
  const d3 = orient(a1, a2, b1), d4 = orient(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Does any edge of ring `a` properly cross any edge of ring `b`? */
function edgesCross(a: Vec2[], b: Vec2[]): boolean {
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    for (let k = 0, l = b.length - 1; k < b.length; l = k++) {
      if (segmentsCross(a[j], a[i], b[l], b[k])) return true;
    }
  }
  return false;
}

/** Is `p` within EPS of the segment ab? */
function onSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return apx * apx + apy * apy <= EPS * EPS;
  const cr = abx * apy - aby * apx;
  if (cr * cr > EPS * EPS * len2) return false;          // perpendicular distance > EPS
  const t = (apx * abx + apy * aby) / len2;
  return t >= -EPS && t <= 1 + EPS;
}

/**
 * Ray cast, with the boundary excluded: a point ON the ring answers false, so a
 * shared vertex or a shared edge never reads as containment. (The unguarded
 * cast is arbitrary for a point exactly on a vertical edge, which two abutting
 * pads produce on every row.)
 */
function pointInRing(p: Vec2, pts: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j], b = pts[i];
    if (onSegment(p, a, b)) return false;
    if ((b.y > p.y) !== (a.y > p.y)) {
      const x = ((a.x - b.x) * (p.y - b.y)) / (a.y - b.y) + b.x;
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

/** Vertex average. Inside any convex ring — every ring this pipeline builds for
 *  a pad, a drill or a via is convex — and the one probe that catches two
 *  IDENTICAL rings, which share every vertex and cross nowhere. */
function centroid(pts: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

/** Does any vertex of `pts` — or their centre — lie strictly inside `host`? */
function anyPointInside(pts: Vec2[], host: Vec2[]): boolean {
  for (const p of pts) if (pointInRing(p, host)) return true;
  return pointInRing(centroid(pts), host);
}

/**
 * Is `inner` wholly inside `host`? No proper crossing plus an interior point
 * inside settles it for the simple, convex rings this pipeline builds. It is
 * what separates a SUBSUMED ring — one whose union with `host` is exactly
 * `host`, so dropping it approximates nothing — from a partial overlap, which
 * really does lose area and has to be counted as a simplification.
 */
export function ringContains(host: Ring, inner: Ring): boolean {
  if (host.pts.length < 3 || inner.pts.length < 3) return false;
  if (edgesCross(inner.pts, host.pts)) return false;
  // The centre rather than a vertex: two IDENTICAL rings share every vertex,
  // and a vertex on the boundary is not inside.
  return pointInRing(centroid(inner.pts), host.pts);
}

/**
 * True when the two rings share interior area. Bounding boxes reject first —
 * most pairs on a board are nowhere near each other — and a box that merely
 * TOUCHES is a reject, same rule as the boundary above. A caller that already
 * holds the rings' boxes (`buildScene` caches them) hands them in.
 */
export function ringsOverlap(a: Ring, b: Ring, boxA: Box = bbox(a.pts), boxB: Box = bbox(b.pts)): boolean {
  if (a.pts.length < 3 || b.pts.length < 3) return false;
  if (!boxesOverlap(boxA, boxB)) return false;
  if (edgesCross(a.pts, b.pts)) return true;
  // No crossing: either disjoint, or one ring is wholly inside the other.
  return anyPointInside(a.pts, b.pts) || anyPointInside(b.pts, a.pts);
}
