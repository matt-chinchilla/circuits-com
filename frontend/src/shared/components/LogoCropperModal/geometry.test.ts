import { describe, expect, it } from 'vitest';
import { clampOffset, coverScale, sourceRect } from './geometry';

describe('crop geometry', () => {
  it('coverScale uses the short edge so the frame is always covered', () => {
    expect(coverScale(1000, 500, 320)).toBeCloseTo(0.64);
    expect(coverScale(500, 1000, 320)).toBeCloseTo(0.64);
  });

  it('clamps offsets so the image never uncovers the frame', () => {
    const s = coverScale(1000, 500, 320); // display 640x320 → maxX 160, maxY 0
    expect(clampOffset(1000, 500, 320, s, 999, 50)).toEqual({ offsetX: 160, offsetY: 0 });
    expect(clampOffset(1000, 500, 320, s, -999, -50)).toEqual({ offsetX: -160, offsetY: 0 });
  });

  it('centers the source rect at zoom 1 / no pan', () => {
    const s = coverScale(1000, 500, 320);
    const r = sourceRect(1000, 500, 320, s, 0, 0);
    expect(r.size).toBeCloseTo(500);
    expect(r.sx).toBeCloseTo(250);
    expect(r.sy).toBeCloseTo(0);
  });

  it('panning fully right reaches the left edge of the source', () => {
    const s = coverScale(1000, 500, 320);
    expect(sourceRect(1000, 500, 320, s, 160, 0).sx).toBeCloseTo(0);
  });

  it('zooming shrinks the source window and stays in bounds', () => {
    const s = coverScale(1000, 500, 320) * 2;
    const r = sourceRect(1000, 500, 320, s, 0, 0);
    expect(r.size).toBeCloseTo(250);
    expect(r.sx).toBeGreaterThanOrEqual(0);
  });

  it('geometry follows a smaller measured frame (mobile)', () => {
    const s = coverScale(1000, 500, 280);
    const r = sourceRect(1000, 500, 280, s, 0, 0);
    expect(r.size).toBeCloseTo(500); // short edge still fills the smaller frame
  });
});
