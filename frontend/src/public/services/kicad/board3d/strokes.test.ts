import { describe, expect, it } from 'vitest';
import { circleRing, strokePolygon } from './strokes';
import { signedArea } from './geom';

describe('strokePolygon', () => {
  it('a straight 10 mm × 0.15 mm track has area ≈ 10·0.15 + π·0.075²', () => {
    const ring = strokePolygon([{ x: 0, y: 0 }, { x: 10, y: 0 }], 0.15, 8);
    expect(Math.abs(signedArea(ring.pts))).toBeCloseTo(10 * 0.15 + Math.PI * 0.075 * 0.075, 3);
    expect(ring.pts.length).toBeGreaterThan(16); // caps add points
  });
  it('an L-shaped track keeps its outer corner round and its inner corner sharp', () => {
    const ring = strokePolygon([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 1, 8);
    const area = Math.abs(signedArea(ring.pts));
    // Two 10 mm legs of width 1. The task brief's range assumed the corner overlap
    // was a 1×1 square; the two offset rectangles actually overlap in a 0.5×0.5 one:
    //   20 − 0.25 + caps (2·½π·0.5²) + round outer join (¼π·0.5²) = 20.7318 exactly,
    //   20.7067 once the caps and the join are cut into 8-per-π segments.
    // The window is tight on purpose — measured, it separates this from putting the
    // fan on the wrong side (20.8240) and from mitering both sides (20.7654), while
    // still admitting a change of cap resolution (16 per π gives 20.7255).
    expect(area).toBeGreaterThan(20.65);
    expect(area).toBeLessThan(20.75);
  });
  it('returns an empty ring for a zero-length polyline', () => {
    expect(strokePolygon([{ x: 1, y: 1 }, { x: 1, y: 1 }], 1, 8).pts).toHaveLength(0);
  });
});

describe('circleRing', () => {
  it('has at least 8 points and area within tolerance of πr²', () => {
    const r = circleRing({ x: 0, y: 0 }, 0.3, 0.01);
    expect(r.pts.length).toBeGreaterThanOrEqual(8);
    expect(Math.abs(signedArea(r.pts))).toBeCloseTo(Math.PI * 0.09, 2);
  });
});
