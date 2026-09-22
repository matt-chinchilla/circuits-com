import { cross, sub } from './geom';
import type { Vec2 } from './types';

export interface ArcParams { c: Vec2; r: number; a0: number; sweep: number }

const DEG = Math.PI / 180;

/**
 * KiCad 6+ states an arc as start / mid / end. Solve the circle through them.
 * Returns null when the three points are (near) collinear, i.e. when
 * |cross(mid−a, b−a)| < 1e-6 · |b−a|² — the caller draws the chord instead.
 */
export function threePointArc(a: Vec2, mid: Vec2, b: Vec2): ArcParams | null {
  const ab = sub(b, a), am = sub(mid, a);
  const chord2 = ab.x * ab.x + ab.y * ab.y;
  const cr = cross(am, ab);
  if (chord2 === 0 || Math.abs(cr) < 1e-6 * chord2) return null;
  // circumcentre via perpendicular bisectors, relative to a
  const bx = b.x - a.x, by = b.y - a.y, mx = mid.x - a.x, my = mid.y - a.y;
  const d = 2 * (mx * by - my * bx);
  if (Math.abs(d) < 1e-12) return null;
  const m2 = mx * mx + my * my, b2 = bx * bx + by * by;
  const ux = (by * m2 - my * b2) / d, uy = (mx * b2 - bx * m2) / d;
  const c = { x: a.x + ux, y: a.y + uy };
  const r = Math.hypot(ux, uy);
  const a0 = Math.atan2(a.y - c.y, a.x - c.x);
  const aM = Math.atan2(mid.y - c.y, mid.x - c.x);
  const a1 = Math.atan2(b.y - c.y, b.x - c.x);
  // Choose the direction that sweeps THROUGH mid: if mid is reached before b when
  // travelling counter-clockwise, the arc is the counter-clockwise one; otherwise
  // it is the complementary clockwise arc (which may exceed 180°).
  const ccw = (from: number, to: number) => { let s = to - from; while (s < 0) s += 2 * Math.PI; return s; };
  const sCcw = ccw(a0, a1), mCcw = ccw(a0, aM);
  const sweep = mCcw <= sCcw ? sCcw : -(2 * Math.PI - sCcw);
  return { c, r, a0, sweep };
}

/**
 * Polyline from the arc's start to its end (both inclusive), stepping by
 * clamp(acos(1 − tol/r), 2°, 15°) so the sagitta stays under `tolMm`. A radius at
 * or below the tolerance saturates the clamp at 15° rather than short-circuiting
 * to the chord: the extra points are invisible but they keep the curve's winding
 * intact for the chainer and the tessellator.
 */
export function flattenArc(arc: ArcParams, tolMm: number): Vec2[] {
  const { c, r, a0, sweep } = arc;
  const at = (t: number): Vec2 => ({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
  if (!(r > 0) || !Number.isFinite(sweep)) return [at(a0), at(a0)];
  const step = Math.min(15 * DEG, Math.max(2 * DEG, Math.acos(Math.max(-1, 1 - tolMm / r))));
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / step));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) pts.push(at(a0 + (sweep * i) / n));
  return pts;
}

export function flattenThreePoint(a: Vec2, mid: Vec2, b: Vec2, tolMm: number): { pts: Vec2[]; degenerate: boolean } {
  const arc = threePointArc(a, mid, b);
  if (arc == null) return { pts: [a, b], degenerate: true };
  const pts = flattenArc(arc, tolMm);
  pts[0] = a; pts[pts.length - 1] = b;   // exact endpoints, so chaining snaps
  return { pts, degenerate: false };
}
