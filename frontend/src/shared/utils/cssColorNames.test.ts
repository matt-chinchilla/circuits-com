import { describe, expect, it } from 'vitest';
import { nearestCssColor } from './cssColorNames';

describe('nearestCssColor', () => {
  it('returns exact matches for CSS named colors', () => {
    expect(nearestCssColor('#ff0000')).toEqual({ name: 'Red', exact: true });
    expect(nearestCssColor('#FF0000')).toEqual({ name: 'Red', exact: true });
  });
  it('returns the nearest name otherwise', () => {
    const r = nearestCssColor('#fe0102');
    expect(r).toEqual({ name: 'Red', exact: false });
  });
  it('handles arbitrary brand hexes', () => {
    const r = nearestCssColor('#1d3a8f');
    expect(r?.exact).toBe(false);
    expect(typeof r?.name).toBe('string');
  });
  it('rejects invalid input', () => {
    expect(nearestCssColor('zzz')).toBeNull();
  });
});
