import { describe, expect, it } from 'vitest';
import { flattenArc, flattenThreePoint, threePointArc } from './arcs';

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

describe('threePointArc', () => {
  it('solves a quarter circle (the Glasgow silk arc at 51.5,111 → 51,110.5)', () => {
    const arc = threePointArc({ x: 51.5, y: 111 }, { x: 51.146447, y: 110.853553 }, { x: 51, y: 110.5 })!;
    expect(close(arc.c.x, 51.5, 1e-4)).toBe(true);
    expect(close(arc.c.y, 110.5, 1e-4)).toBe(true);
    expect(close(arc.r, 0.5, 1e-4)).toBe(true);
    expect(close(Math.abs(arc.sweep), Math.PI / 2, 1e-3)).toBe(true);
  });
  it('returns null for collinear points', () => {
    expect(threePointArc({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 })).toBeNull();
    expect(threePointArc({ x: 0, y: 0 }, { x: 1, y: 1e-9 }, { x: 2, y: 0 })).toBeNull();
  });
  it('picks the sweep that passes THROUGH mid, not the complementary arc', () => {
    // 270° arc: a=(1,0), mid=(-1,0) via the bottom, b=(0,1)
    const arc = threePointArc({ x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 })!;
    expect(close(Math.abs(arc.sweep), (3 * Math.PI) / 2, 1e-6)).toBe(true);
  });
});

describe('flattenArc', () => {
  it('starts at a, ends at b, and every point is on the circle', () => {
    const a = { x: 1, y: 0 }, mid = { x: 0, y: 1 }, b = { x: -1, y: 0 };
    const { pts, degenerate } = flattenThreePoint(a, mid, b, 0.01);
    expect(degenerate).toBe(false);
    expect(pts[0]).toEqual(a);
    expect(pts[pts.length - 1]).toEqual(b);
    for (const p of pts) expect(close(Math.hypot(p.x, p.y), 1, 1e-9)).toBe(true);
    // step = clamp(acos(1 − 0.01/1), 2°, 15°) = 8.1° → 180/8.1 ≈ 22 segments (+1 point)
    expect(pts.length).toBeGreaterThan(20);
    expect(pts.length).toBeLessThan(26);
  });
  it('coarser tolerance means fewer points, never fewer than the 15° floor implies', () => {
    const arc = threePointArc({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 })!;
    expect(flattenArc(arc, 0.05).length).toBeLessThan(flattenArc(arc, 0.01).length);
    expect(flattenArc(arc, 10).length).toBe(13); // 180° / 15° = 12 segments
  });
  it('a degenerate arc flattens to its chord and says so', () => {
    const r = flattenThreePoint({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, 0.01);
    expect(r.degenerate).toBe(true);
    expect(r.pts).toEqual([{ x: 0, y: 0 }, { x: 2, y: 0 }]);
  });
});
