import { describe, expect, it } from 'vitest';
import { clampOffset, coverScale, destRect } from './geometry';

// The export path draws in DESTINATION space (see destRect's doc comment), so
// these lock the math the cropper actually ships: at cover-fit the image fills
// the output square and overflows on the long axis; below cover-fit it insets
// and letterboxes — the case a source-rect read could not express.
const OUT = 256;

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

  it('centers the destination rect at zoom 1 / no pan', () => {
    const s = coverScale(1000, 500, 320);
    const r = destRect(1000, 500, 320, s, 0, 0, OUT);
    expect(r.dh).toBeCloseTo(OUT); // short edge exactly covers
    expect(r.dw).toBeCloseTo(512); // 2:1 image overflows equally left/right
    expect(r.dx).toBeCloseTo(-128);
    expect(r.dy).toBeCloseTo(0);
  });

  it('panning fully right brings the left edge of the image into frame', () => {
    const s = coverScale(1000, 500, 320);
    // +160 display px is the clamp limit; it should land the image's left edge
    // exactly on the output's left edge (dx 0), never past it.
    expect(destRect(1000, 500, 320, s, 160, 0, OUT).dx).toBeCloseTo(0);
  });

  it('zooming enlarges the drawn image and keeps the output covered', () => {
    const s = coverScale(1000, 500, 320) * 2;
    const r = destRect(1000, 500, 320, s, 0, 0, OUT);
    expect(r.dw).toBeCloseTo(1024); // 2x zoom → 2x the zoom-1 draw size
    expect(r.dh).toBeCloseTo(512);
    expect(r.dx).toBeLessThanOrEqual(0);
    expect(r.dy).toBeLessThanOrEqual(0);
    expect(r.dx + r.dw).toBeGreaterThanOrEqual(OUT);
    expect(r.dy + r.dh).toBeGreaterThanOrEqual(OUT);
  });

  it('zoom below cover-fit letterboxes instead of reading outside the image', () => {
    const s = coverScale(1000, 500, 320) * 0.5;
    const r = destRect(1000, 500, 320, s, 0, 0, OUT);
    expect(r.dw).toBeCloseTo(256);
    expect(r.dh).toBeCloseTo(128);
    expect(r.dx).toBeCloseTo(0);
    expect(r.dy).toBeCloseTo(64); // centered → equal bg bars top and bottom
    expect(r.dy + r.dh).toBeCloseTo(OUT - 64);
  });

  it('geometry follows a smaller measured frame (mobile) — same export', () => {
    const wide = destRect(1000, 500, 320, coverScale(1000, 500, 320), 0, 0, OUT);
    const narrow = destRect(1000, 500, 280, coverScale(1000, 500, 280), 0, 0, OUT);
    // The frame is the measurement authority, not a constant: a CSS-capped
    // 280px frame at its own cover-fit must export the identical crop.
    expect(narrow.dx).toBeCloseTo(wide.dx);
    expect(narrow.dy).toBeCloseTo(wide.dy);
    expect(narrow.dw).toBeCloseTo(wide.dw);
    expect(narrow.dh).toBeCloseTo(wide.dh);
  });
});
