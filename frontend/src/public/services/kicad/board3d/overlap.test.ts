import { describe, expect, it } from 'vitest';
import { circleRing } from './strokes';
import { ringContains, ringsOverlap } from './overlap';
import type { Ring, Vec2 } from './types';

const rect = (x0: number, y0: number, x1: number, y1: number): Ring => ({
  pts: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] as Vec2[],
});

describe('ringsOverlap', () => {
  it('two squares that merely share an edge do not overlap', () => {
    expect(ringsOverlap(rect(0, 0, 1, 1), rect(1, 0, 2, 1))).toBe(false);
  });
  it('two squares that meet at one corner do not overlap', () => {
    expect(ringsOverlap(rect(0, 0, 1, 1), rect(1, 1, 2, 2))).toBe(false);
  });
  it('a via drill sitting inside a pad drill overlaps', () => {
    const pad = circleRing({ x: 0, y: 0 }, 0.5, 0.01);
    const via = circleRing({ x: 0.1, y: 0 }, 0.15, 0.01);
    expect(ringsOverlap(pad, via)).toBe(true);
    expect(ringsOverlap(via, pad)).toBe(true);     // symmetric
  });
  it('crossing rectangles overlap even though no corner is inside the other', () => {
    expect(ringsOverlap(rect(-5, -1, 5, 1), rect(-1, -5, 1, 5))).toBe(true);
  });
  it('disjoint rings do not overlap', () => {
    expect(ringsOverlap(rect(0, 0, 1, 1), rect(3, 3, 4, 4))).toBe(false);
    expect(ringsOverlap(circleRing({ x: 0, y: 0 }, 0.3, 0.01), circleRing({ x: 2, y: 0 }, 0.3, 0.01))).toBe(false);
  });
  it('identical rings overlap — the case no vertex and no crossing can report', () => {
    const r = circleRing({ x: 1, y: 2 }, 0.25, 0.01);
    expect(ringsOverlap(r, { pts: [...r.pts] })).toBe(true);
  });
  it('partly overlapping squares overlap', () => {
    expect(ringsOverlap(rect(0, 0, 2, 2), rect(1, 1, 3, 3))).toBe(true);
  });
  it('a degenerate ring overlaps nothing', () => {
    expect(ringsOverlap({ pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, rect(-5, -5, 5, 5))).toBe(false);
  });
  it('two pads on a 0.5 mm pitch row stay separate', () => {
    // The class the bounding-box rule got wrong: neighbouring fine-pitch pads,
    // close but never touching.
    expect(ringsOverlap(rect(0, 0, 0.3, 1.5), rect(0.5, 0, 0.8, 1.5))).toBe(false);
  });
});

describe('ringContains', () => {
  it('a small ring wholly inside a large one is contained', () => {
    expect(ringContains(rect(0, 0, 10, 10), rect(2, 2, 3, 3))).toBe(true);
    expect(ringContains(rect(2, 2, 3, 3), rect(0, 0, 10, 10))).toBe(false);   // not the other way
  });
  it('identical rings contain each other', () => {
    const r = circleRing({ x: 0, y: 0 }, 0.4, 0.01);
    expect(ringContains(r, { pts: [...r.pts] })).toBe(true);
  });
  it('a partial overlap is NOT containment — that is the case worth counting', () => {
    expect(ringContains(rect(0, 0, 2, 2), rect(1, 1, 3, 3))).toBe(false);
    expect(ringContains(rect(-5, -1, 5, 1), rect(-1, -5, 1, 5))).toBe(false);
  });
  it('disjoint rings do not contain each other', () => {
    expect(ringContains(rect(0, 0, 1, 1), rect(3, 3, 4, 4))).toBe(false);
  });
  it('a ring sharing an edge from the inside is still contained', () => {
    expect(ringContains(rect(0, 0, 10, 10), rect(0, 0, 4, 4))).toBe(true);
  });
});
