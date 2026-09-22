import { place, rotate } from './geom';
import { arcPoints, arcStep, circleRing } from './strokes';
import type { PadModel, PadShape, Placement, Ring, Vec2 } from './types';

/** KiCad's own default when a roundrect omits its ratio. */
const DEFAULT_RRATIO = 0.25;

/**
 * Segments across a half circle, forced EVEN so the arc's midpoint is emitted.
 * That midpoint is the shape's extreme point — an odd count leaves a stadium
 * short of its true length by r(1 − cos(step/2)), which a bounding box notices.
 */
function halfCircleSegments(r: number, tolMm: number): number {
  const k = Math.max(1, Math.ceil(Math.PI / arcStep(r, tolMm)));
  return k % 2 === 0 ? k : k + 1;
}

/** Rectangle centred on the origin, corner order (−,−) (+,−) (+,+) (−,+). */
function rectPts(hx: number, hy: number): Vec2[] {
  return [{ x: -hx, y: -hy }, { x: hx, y: -hy }, { x: hx, y: hy }, { x: -hx, y: hy }];
}

/** Rectangle with quarter-circle corners of radius `r`, centred on the origin. */
function roundRectPts(hx: number, hy: number, r: number, tolMm: number): Vec2[] {
  const q = Math.max(1, Math.ceil((Math.PI / 2) / arcStep(r, tolMm)));
  const ix = hx - r, iy = hy - r;
  // corner centres in the same order as rectPts, each sweeping a quarter turn
  const corners: { c: Vec2; a0: number }[] = [
    { c: { x: -ix, y: -iy }, a0: Math.PI },
    { c: { x: ix, y: -iy }, a0: (3 * Math.PI) / 2 },
    { c: { x: ix, y: iy }, a0: 0 },
    { c: { x: -ix, y: iy }, a0: Math.PI / 2 },
  ];
  const pts: Vec2[] = [];
  for (const { c, a0 } of corners) pts.push(...arcPoints(c, r, a0, Math.PI / 2, q));
  return pts;
}

/** Stadium: a rectangle capped by half circles on its two short ends. */
function stadiumPts(w: number, h: number, tolMm: number): Vec2[] {
  const r = Math.min(w, h) / 2;
  const half = halfCircleSegments(r, tolMm);
  if (w >= h) {
    const ix = w / 2 - r;                              // horizontal: caps on ±x
    return [
      ...arcPoints({ x: ix, y: 0 }, r, -Math.PI / 2, Math.PI, half),
      ...arcPoints({ x: -ix, y: 0 }, r, Math.PI / 2, Math.PI, half),
    ];
  }
  const iy = h / 2 - r;                                // vertical: caps on ±y
  return [
    ...arcPoints({ x: 0, y: iy }, r, 0, Math.PI, half),
    ...arcPoints({ x: 0, y: -iy }, r, Math.PI, Math.PI, half),
  ];
}

/**
 * Pad shape → ring in PAD-LOCAL coordinates (centre at the origin), UNROTATED.
 * `trapezoid` and `custom` fall back to the anchor rectangle of `size`: the
 * trapezoid's delta and a custom pad's extra primitives are not read, so the
 * anchor is the honest approximation rather than a guess at the real outline.
 */
export function padRing(shape: PadShape, size: Vec2, rratio: number | null, tolMm: number): Ring {
  const hx = size.x / 2, hy = size.y / 2;
  switch (shape) {
    case 'circle':
      return circleRing({ x: 0, y: 0 }, hx, tolMm);    // KiCad states a circular pad as (size d d)
    case 'oval':
      return { pts: stadiumPts(size.x, size.y, tolMm) };
    case 'roundrect': {
      const r = Math.min((rratio ?? DEFAULT_RRATIO) * Math.min(size.x, size.y), hx, hy);
      return r > 0 ? { pts: roundRectPts(hx, hy, r, tolMm) } : { pts: rectPts(hx, hy) };
    }
    default:
      return { pts: rectPts(hx, hy) };
  }
}

/**
 * The pad's absolute ring. KiCad 6+ stores a pad's `(at x y rot)` rotation
 * ABSOLUTE — it already includes the footprint's — so the ring turns by
 * `pad.rotDeg` alone while its centre goes through `place(pad.at, fp)`. (The
 * vendored 2D renderer spells the same thing as R(fp)·T(at)·R(−fp)·R(pad), in
 * which the footprint's two rotations cancel on the shape.)
 */
export function placedPadRing(pad: PadModel, fp: Placement, tolMm: number): Ring {
  const centre = place(pad.at, fp);
  const local = padRing(pad.shape, pad.size, pad.rratio, tolMm).pts;
  return { pts: local.map((q) => placeRingPoint(q, pad.rotDeg, centre)) };
}

/** Drill → ring at the pad centre: round → a circle, slot → a stadium turned with the pad. */
export function drillRing(pad: PadModel, fp: Placement, tolMm: number): Ring | null {
  const d = pad.drill;
  if (d == null) return null;
  const centre = place(pad.at, fp);
  if (d.slotW != null && d.slotH != null && d.slotW > 0 && d.slotH > 0) {
    const local = stadiumPts(d.slotW, d.slotH, tolMm);
    return { pts: local.map((q) => placeRingPoint(q, pad.rotDeg, centre)) };
  }
  if (!(d.d > 0)) return null;
  return circleRing(centre, d.d / 2, tolMm);
}

/** Shared tail of both placements: turn, then translate. No back-side mirror,
 *  for the reason `place` gives — the file's coordinates are already flipped. */
function placeRingPoint(q: Vec2, rotDeg: number, centre: Vec2): Vec2 {
  const r = rotate(q, rotDeg);
  return { x: r.x + centre.x, y: r.y + centre.y };
}
