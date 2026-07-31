import { describe, expect, it } from 'vitest';
import { paletteFromPixels } from './brandPalette';
import { mixHex } from './color';

const px = (colors: Array<[number, number, number, number]>) => {
  const data = new Uint8ClampedArray(colors.length * 4);
  colors.forEach(([r, g, b, a], i) => data.set([r, g, b, a], i * 4));
  return data;
};

describe('paletteFromPixels', () => {
  it('single saturated hue wins as primary; secondary is the 52% white mix', () => {
    const p = paletteFromPixels(px(Array(20).fill([255, 0, 0, 255])), 20);
    expect(p.primary).toBe('#ff0000');
    expect(p.swatches[0]).toEqual({ hex: '#ff0000', pct: 100 });
    expect(p.secondary).toBe(mixHex('#ff0000', '#ffffff', 0.52)); // parity with csFx 52% branch
  });

  it('runner-up hue above 20% drives the secondary via the 72% white mix', () => {
    const p = paletteFromPixels(
      px([...Array(10).fill([255, 0, 0, 255]), ...Array(5).fill([0, 0, 255, 255])]),
      15,
    );
    expect(p.swatches).toEqual([{ hex: '#ff0000', pct: 67 }, { hex: '#0000ff', pct: 33 }]);
    expect(p.secondary).toBe(mixHex('#0000ff', '#ffffff', 0.72)); // parity with csFx 72% branch
  });

  it('near-white, near-black and transparent pixels are ignored', () => {
    const p = paletteFromPixels(px([[250, 250, 250, 255], [5, 5, 5, 255], [255, 0, 0, 10]]), 3);
    expect(p.primary).toBe('#3a6ea5'); // hard fallback — nothing survived
  });

  it('unsaturated pixels only reach the fallback average', () => {
    const p = paletteFromPixels(px(Array(4).fill([128, 128, 128, 255])), 4);
    expect(p.primary).toBe('#808080');
    expect(p.swatches).toEqual([{ hex: '#808080', pct: 100 }]); // fallback primary is the only swatch
  });

  it('ranks swatches with percentage coverage of analyzed pixels', () => {
    const p = paletteFromPixels(px([...Array(15).fill([255, 0, 0, 255]), ...Array(5).fill([0, 0, 255, 255])]), 20);
    expect(p.swatches[0]).toEqual({ hex: '#ff0000', pct: 75 });
    expect(p.swatches[1]).toEqual({ hex: '#0000ff', pct: 25 });
  });

  it('percentage denominator excludes transparent and near-white pixels', () => {
    const p = paletteFromPixels(px([[255, 0, 0, 255], [255, 0, 0, 255], [250, 250, 250, 255], [255, 0, 0, 10]]), 4);
    expect(p.swatches[0]).toEqual({ hex: '#ff0000', pct: 100 }); // 2 analyzed, both red
  });
});

// Picker mode ({ includeAchromatic: true }) — used by the brand-color modal,
// where black and white ARE legitimate brand answers (the base mode's gates
// exist for the csFx board-tint context and stay untouched by default).
describe('paletteFromPixels — includeAchromatic (picker mode)', () => {
  const opts = { includeAchromatic: true };

  it('Avnet-shaped logo (mostly black ink + tiny green accent): green primary, black + white swatches', () => {
    // 72% transparent, ~20% black ink, ~6% white, ~2% green accent — the
    // wordmark whose crop-window bug reported #939393.
    const pixels = [
      ...Array(72).fill([0, 0, 0, 0]),
      ...Array(20).fill([2, 2, 2, 255]),
      ...Array(6).fill([254, 254, 254, 255]),
      ...Array(2).fill([64, 194, 98, 255]),
    ] as Array<[number, number, number, number]>;
    const p = paletteFromPixels(px(pixels), pixels.length, opts);
    expect(p.primary).toBe('#40c262'); // the saturated accent still wins primary
    const hexes = p.swatches.map((s) => s.hex);
    expect(hexes).toContain('#020202'); // black ink IS offered
    expect(hexes).toContain('#fefefe'); // white IS offered
  });

  it('an all-achromatic logo suggests its dominant ink, not an anti-aliasing gray average', () => {
    // Black ink + white + AA edge grays: base mode would average the edge
    // grays into a meaningless mid-gray; picker mode must answer BLACK.
    const pixels = [
      ...Array(30).fill([2, 2, 2, 255]),
      ...Array(60).fill([254, 254, 254, 255]),
      ...Array(10).fill([147, 147, 147, 255]),
    ] as Array<[number, number, number, number]>;
    const p = paletteFromPixels(px(pixels), pixels.length, opts);
    expect(p.primary).toBe('#020202');
  });

  it('default mode is untouched: same pixels still fall back to the gray average', () => {
    const pixels = [
      ...Array(30).fill([2, 2, 2, 255]),
      ...Array(10).fill([147, 147, 147, 255]),
    ] as Array<[number, number, number, number]>;
    const p = paletteFromPixels(px(pixels), pixels.length);
    expect(p.primary).toBe('#939393'); // csFx parity preserved
  });
});
