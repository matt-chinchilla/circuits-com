import { describe, expect, it } from 'vitest';
import { bbox, place, rotate, signedArea } from './geom';

describe('geom', () => {
  it('rotate follows KiCad: +90° turns +x into −y on the y-down page', () => {
    const p = rotate({ x: 1, y: 0 }, 90);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(-1, 9);
  });
  it('place: Glasgow C(0402) at (127, 107.6, 90) puts pad 1 at (−0.485, 0) → (127, 108.085)', () => {
    // pad "1" (at -0.485 0 90) inside footprint (at 127 107.6 90): the pad's own
    // rotation is absolute in KiCad 6 files; only the OFFSET is rotated by the footprint.
    const p = place({ x: -0.485, y: 0 }, { at: { x: 127, y: 107.6 }, rotDeg: 90, side: 'F' });
    expect(p.x).toBeCloseTo(127, 6);
    expect(p.y).toBeCloseTo(108.085, 6);
  });
  it('place on the back does NOT mirror: the file saves back-side children already flipped', () => {
    const p = place({ x: 1, y: 2 }, { at: { x: 0, y: 0 }, rotDeg: 0, side: 'B' });
    expect(p).toEqual({ x: 1, y: 2 });
  });
  it('signedArea and bbox', () => {
    expect(Math.abs(signedArea([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 }]))).toBeCloseTo(2);
    expect(bbox([{ x: 3, y: -1 }, { x: -2, y: 5 }])).toEqual({ min: { x: -2, y: -1 }, max: { x: 3, y: 5 } });
  });
});
