import type { Placement, Vec2 } from './types';

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

/**
 * KiCad rotation on the y-down page: positive angles turn counter-clockwise as
 * seen on screen, which in y-down maths is x' = x·cos + y·sin, y' = −x·sin + y·cos.
 *
 * Derived from the renderer this repo already vendors rather than from memory:
 * its `Matrix3.rotation` lays its elements out as
 * [cos, −sin, 0, sin, cos, 0, 0, 0, 1], `Matrix3.transform` reads them as
 * x = px·e0 + py·e3 and y = px·e1 + py·e4, and `Angle.deg_to_rad` applies no sign
 * flip. This is the ONE place the sign lives — never flip it anywhere else.
 */
export function rotate(p: Vec2, deg: number): Vec2 {
  if (deg === 0) return { x: p.x, y: p.y };
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return { x: p.x * c + p.y * s, y: -p.x * s + p.y * c };
}

/**
 * Footprint-local → board: rotate by the footprint's angle, translate to its
 * position — the composition the vendored renderer's FootprintPainter applies
 * as `Matrix3.translation(at).rotate_self(rot)`, and nothing more.
 *
 * NO mirror for the back side. KiCad saves a flipped footprint's children in
 * coordinates that are ALREADY mirrored (the file un-rotates them but never
 * un-flips them), so mirroring again reflects every asymmetric back-side part
 * across its own x axis — StickHub's U2 put its pads beside its traces. The
 * `side` still decides which layers a part's copper, mask and body sit on.
 */
export function place(p: Vec2, pl: Placement): Vec2 {
  return add(rotate(p, pl.rotDeg), pl.at);
}

/**
 * Shoelace area. y-down means a loop that reads clockwise on screen has POSITIVE
 * area here, so callers take |area| for size and orient explicitly for winding
 * (outline.ts fixes outer < 0, holes > 0).
 */
export function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}

export function bbox(pts: Vec2[]): { min: Vec2; max: Vec2 } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}
