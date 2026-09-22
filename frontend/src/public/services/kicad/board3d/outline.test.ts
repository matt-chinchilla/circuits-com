import { describe, expect, it } from 'vitest';
import { boardOutline, chainLoops } from './outline';
import { signedArea } from './geom';
import type { Shape } from './types';

const L = (x1: number, y1: number, x2: number, y2: number): Shape => ({ kind: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, width: 0.1 });

describe('chainLoops', () => {
  it('chains four unordered, mixed-direction segments into one square', () => {
    const r = chainLoops([
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [{ x: 10, y: 10 }, { x: 0, y: 10 }],
      [{ x: 10, y: 0 }, { x: 10, y: 10 }],
      [{ x: 0, y: 0 }, { x: 0, y: 10 }],   // reversed relative to the loop
    ]);
    expect(r.unchained).toBe(0);
    expect(r.loops).toHaveLength(1);
    expect(r.loops[0].pts).toHaveLength(4);
  });
  it('snaps endpoints within 1 µm and reports an unchained segment', () => {
    const r = chainLoops([
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [{ x: 10.0000004, y: 0 }, { x: 10, y: 10 }],
      [{ x: 10, y: 10 }, { x: 0, y: 10 }],
      [{ x: 0, y: 10 }, { x: 0, y: 0 }],
      [{ x: 50, y: 50 }, { x: 60, y: 60 }],
    ]);
    expect(r.loops).toHaveLength(1);
    expect(r.unchained).toBe(1);
  });
});

describe('boardOutline', () => {
  it('largest loop is the board, the rest are cutouts, orientations fixed', () => {
    const items: Shape[] = [
      L(0, 0, 100, 0), L(100, 0, 100, 50), L(100, 50, 0, 50), L(0, 50, 0, 0),
      { kind: 'circle', c: { x: 20, y: 20 }, r: 3, width: 0.1, filled: false },
      { kind: 'rect', a: { x: 60, y: 10 }, b: { x: 70, y: 20 }, width: 0.1, filled: false },
    ];
    const o = boardOutline(items, 0.01);
    expect(o.open).toBe(false);
    expect(Math.abs(signedArea(o.outer.pts))).toBeCloseTo(5000, 6);
    expect(o.cutouts).toHaveLength(2);
    expect(signedArea(o.outer.pts)).toBeLessThan(0);
    for (const c of o.cutouts) expect(signedArea(c.pts)).toBeGreaterThan(0);
  });
  it('an arc corner is flattened and still closes', () => {
    const items: Shape[] = [
      L(5, 0, 100, 0), L(100, 0, 100, 50), L(100, 50, 0, 50), L(0, 50, 0, 5),
      { kind: 'arc', a: { x: 0, y: 5 }, mid: { x: 5 - 5 * Math.SQRT1_2, y: 5 - 5 * Math.SQRT1_2 }, b: { x: 5, y: 0 }, width: 0.1 },
    ];
    const o = boardOutline(items, 0.01);
    expect(o.open).toBe(false);
    expect(o.outer.pts.length).toBeGreaterThan(8);
  });
  it('an open outline falls back to the bounding box and says so', () => {
    const o = boardOutline([L(0, 0, 100, 0), L(100, 0, 100, 50), L(100, 50, 0, 50)], 0.01);
    expect(o.open).toBe(true);
    expect(o.unchained).toBe(3);
    expect(o.outer.pts).toHaveLength(4);
    expect(Math.abs(signedArea(o.outer.pts))).toBeCloseTo(5000, 6);
  });
});
