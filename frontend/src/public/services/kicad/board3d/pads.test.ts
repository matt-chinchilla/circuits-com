import { describe, expect, it } from 'vitest';
import { drillRing, padRing, placedPadRing } from './pads';
import { signedArea, bbox } from './geom';
import type { PadModel } from './types';

const base: PadModel = { ref: 'C1', number: '1', kind: 'smd', shape: 'rect', at: { x: 0, y: 0 }, rotDeg: 0, size: { x: 2, y: 1 }, rratio: null, layers: ['F.Cu'], drill: null };

describe('padRing', () => {
  it('rect', () => { expect(Math.abs(signedArea(padRing('rect', { x: 2, y: 1 }, null, 0.01).pts))).toBeCloseTo(2, 6); });
  it('roundrect with rratio .25 loses the four corner squares minus quarter circles', () => {
    const a = Math.abs(signedArea(padRing('roundrect', { x: 2, y: 1 }, 0.25, 0.005).pts));
    const r = 0.25; // .25 × min(2,1)
    expect(a).toBeCloseTo(2 - (4 - Math.PI) * r * r, 2);
  });
  it('oval is a stadium', () => {
    const a = Math.abs(signedArea(padRing('oval', { x: 2, y: 1 }, null, 0.005).pts));
    expect(a).toBeCloseTo(1 * 1 + Math.PI * 0.25, 2);
  });
  it('circle uses the first size component as diameter', () => {
    expect(Math.abs(signedArea(padRing('circle', { x: 1, y: 1 }, null, 0.005).pts))).toBeCloseTo(Math.PI / 4, 2);
  });
  it('custom and trapezoid fall back to the anchor rect', () => {
    expect(Math.abs(signedArea(padRing('custom', { x: 2, y: 1 }, null, 0.01).pts))).toBeCloseTo(2, 6);
  });
});

describe('placement', () => {
  it('pad rotation is absolute (KiCad 6+): a 90° pad in a 90° footprint is rotated once', () => {
    const ring = placedPadRing({ ...base, at: { x: -0.485, y: 0 }, rotDeg: 90, size: { x: 0.59, y: 0.64 } }, { at: { x: 127, y: 107.6 }, rotDeg: 90, side: 'F' }, 0.01);
    const b = bbox(ring.pts);
    expect(b.max.x - b.min.x).toBeCloseTo(0.64, 6);  // rotated 90°: width becomes the y size
    expect(b.max.y - b.min.y).toBeCloseTo(0.59, 6);
    expect((b.min.x + b.max.x) / 2).toBeCloseTo(127, 6);
    expect((b.min.y + b.max.y) / 2).toBeCloseTo(108.085, 6);
  });
  it('drill rings: round and slot', () => {
    const round = drillRing({ ...base, kind: 'thru_hole', drill: { d: 0.8 } }, { at: { x: 10, y: 10 }, rotDeg: 0, side: 'F' }, 0.01)!;
    expect(Math.abs(signedArea(round.pts))).toBeCloseTo(Math.PI * 0.16, 2);
    const slot = drillRing({ ...base, kind: 'thru_hole', rotDeg: 270, drill: { d: 0.6, slotW: 0.6, slotH: 1.7 } }, { at: { x: 0, y: 0 }, rotDeg: 0, side: 'F' }, 0.005)!;
    const b = bbox(slot.pts);
    expect(b.max.y - b.min.y).toBeCloseTo(0.6, 3);   // 270° turns the 1.7 mm long axis onto x
    expect(b.max.x - b.min.x).toBeCloseTo(1.7, 3);
    expect(drillRing(base, { at: { x: 0, y: 0 }, rotDeg: 0, side: 'F' }, 0.01)).toBeNull();
  });
});
