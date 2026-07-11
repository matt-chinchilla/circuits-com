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
