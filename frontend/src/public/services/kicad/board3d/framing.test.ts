import { describe, expect, it } from 'vitest';
import { fitDistance, type Box3Like } from './framing';

const flat = (hx: number, hy: number): Box3Like => ({ min: { x: -hx, y: -hy, z: 0 }, max: { x: hx, y: hy, z: 0 } });

describe('fitDistance', () => {
  // Straight down, fov 90 (tan 45° = 1): a 20 mm square needs the camera 10 mm
  // up on a square canvas — the corners sit exactly on the frustum's edges.
  it('frames a square board edge to edge from straight above', () => {
    const d = fitDistance(flat(10, 10), { fovDeg: 90, aspect: 1, elevationDeg: 90, azimuthsDeg: [0], margin: 1 });
    expect(d).toBeCloseTo(10, 6);
  });
  it('a wide canvas is bound by the vertical edge, a tall one by the horizontal', () => {
    const wide = fitDistance(flat(10, 10), { fovDeg: 90, aspect: 2, elevationDeg: 90, azimuthsDeg: [0], margin: 1 });
    const tall = fitDistance(flat(10, 10), { fovDeg: 90, aspect: 0.5, elevationDeg: 90, azimuthsDeg: [0], margin: 1 });
    expect(wide).toBeCloseTo(10, 6);
    expect(tall).toBeCloseTo(20, 6);
  });
  it('a wider canvas never needs MORE distance', () => {
    const box = flat(40, 24.5);
    let last = Infinity;
    for (const aspect of [0.5, 1, 1.5, 2, 2.5]) {
      const d = fitDistance(box, { fovDeg: 35, aspect, elevationDeg: 35 });
      expect(d).toBeLessThanOrEqual(last + 1e-9);
      last = d;
    }
  });
  it('holds at every sampled azimuth, so the auto-orbit clips no corner', () => {
    const box: Box3Like = { min: { x: -40, y: -24.5, z: -1 }, max: { x: 40, y: 24.5, z: 12 } };
    const opts = { fovDeg: 35, aspect: 2.23, elevationDeg: 35, margin: 1 };
    const all = fitDistance(box, opts);
    for (let az = 0; az < 360; az += 10) {
      expect(fitDistance(box, { ...opts, azimuthsDeg: [az] })).toBeLessThanOrEqual(all + 1e-9);
    }
    // …and it is tight somewhere: one azimuth needs exactly this much.
    const tightest = Math.max(...Array.from({ length: 36 }, (_, i) => fitDistance(box, { ...opts, azimuthsDeg: [i * 10] })));
    expect(tightest).toBeCloseTo(all, 6);
  });
  it('is closer than the old diagonal rule on a wide canvas — the whole point', () => {
    // Glasgow: 80 × 49 mm, fov 35, canvas 1376 × 616. The first cut stood at
    // diagonal/2 / tan(fov/2) × 1.18 whatever the aspect.
    const box = flat(40, 24.5);
    const old = ((Math.hypot(80, 49) / 2) / Math.tan((35 / 2) * (Math.PI / 180))) * 1.18;
    const d = fitDistance(box, { fovDeg: 35, aspect: 1376 / 616, elevationDeg: 35 });
    // Measured 0.733 of the old distance: the board draws a third larger. The
    // bound is the NEAR corner's rise at a 35° elevation, not the width — a wide
    // canvas has room to spare horizontally, which is exactly what the old rule
    // never used.
    expect(d / old).toBeGreaterThan(0.7);
    expect(d / old).toBeLessThan(0.76);
  });
  it('never answers zero', () => {
    expect(fitDistance(flat(0, 0), { fovDeg: 35, aspect: 1, elevationDeg: 35 })).toBeGreaterThan(0);
  });
});
