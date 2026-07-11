import { describe, expect, it } from 'vitest';
import { mixHex, rgbToHex, safeHexColor } from './color';

describe('safeHexColor', () => {
  it('accepts exactly #RRGGBB (any case, trimmed)', () => {
    expect(safeHexColor('#1d3a8f')).toBe('#1d3a8f');
    expect(safeHexColor('  #ABCdef ')).toBe('#ABCdef');
    for (const bad of [null, undefined, '', '1d3a8f', '#1d3a8', '#1d3a8f00', 'red', '#12345g', 'url(x)'])
      expect(safeHexColor(bad)).toBeNull();
  });
});

describe('mixHex', () => {
  it('matches color-mix(in srgb) per-channel math', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#ff0000', '#ffffff', 0.72)).toBe(rgbToHex(255, 0.28 * 255, 0.28 * 255));
  });
});
