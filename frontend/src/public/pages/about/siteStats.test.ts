import { describe, it, expect } from 'vitest';
import { STAT_TILES, compactCount, NO_VALUE } from './siteStats';

describe('compactCount', () => {
  it('shows a small count whole', () => {
    // 28 categories and 189 subcategories are the strip's real small figures.
    expect(compactCount(28)).toEqual({ num: '28', suffix: '' });
    expect(compactCount(189)).toEqual({ num: '189', suffix: '' });
    expect(compactCount(999)).toEqual({ num: '999', suffix: '' });
  });

  it('abbreviates thousands to one decimal', () => {
    // The live catalog figure at the time this shipped.
    expect(compactCount(314_253)).toEqual({ num: '314.3', suffix: 'K' });
    expect(compactCount(1_000)).toEqual({ num: '1.0', suffix: 'K' });
    expect(compactCount(12_345)).toEqual({ num: '12.3', suffix: 'K' });
  });

  it('abbreviates millions to one decimal', () => {
    expect(compactCount(13_800_000)).toEqual({ num: '13.8', suffix: 'M' });
    expect(compactCount(2_500_000)).toEqual({ num: '2.5', suffix: 'M' });
  });

  it('never prints a number that has rounded out of its own band', () => {
    // The trap: picking the band before rounding renders 999,999 as
    // "1000.0K". The boundary is the first count whose thousands form
    // reads 1000.0, not the first count that reaches a million.
    expect(compactCount(999_949)).toEqual({ num: '999.9', suffix: 'K' });
    expect(compactCount(999_950)).toEqual({ num: '1.0', suffix: 'M' });
    expect(compactCount(999_999)).toEqual({ num: '1.0', suffix: 'M' });
    expect(compactCount(999_949_999)).toEqual({ num: '999.9', suffix: 'M' });
    expect(compactCount(999_950_000)).toEqual({ num: '1.0', suffix: 'B' });
  });

  it('rounds a half up, where toFixed alone rounds it down', () => {
    // 1950/1000 is stored as 1.94999999999999995559..., so
    // `(1950/1000).toFixed(1)` is "1.9". The formatter scales before it
    // divides so the tie breaks the way the label implies.
    expect(compactCount(1_949)).toEqual({ num: '1.9', suffix: 'K' });
    expect(compactCount(1_950)).toEqual({ num: '2.0', suffix: 'K' });
    expect((1_950 / 1_000).toFixed(1)).toBe('1.9'); // the trap, pinned
    expect(compactCount(1_050)).toEqual({ num: '1.1', suffix: 'K' });
  });

  it('renders a fresh empty environment as a real 0, not as NaN or "0.0K"', () => {
    // A genuine zero is an answer, so it is NOT null.
    expect(compactCount(0)).toEqual({ num: '0', suffix: '' });
  });

  it('returns null — never "0" — for a value the API could not legitimately send', () => {
    // The case that matters: rename a field server-side and `stats[tile.key]`
    // is `undefined` at runtime while TypeScript still compiles. Coercing that
    // to "0" would print "0 DISTRIBUTOR PARTS" on a catalog of 310,500 — a
    // confident wrong number, which is the defect this module removes. The
    // caller renders NO_VALUE instead.
    expect(compactCount(undefined)).toBeNull();
    expect(compactCount(null)).toBeNull();
    expect(compactCount('314253')).toBeNull();
    expect(compactCount(Number.NaN)).toBeNull();
    expect(compactCount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(compactCount(-5)).toBeNull();
  });

  it('emits a decimal point exactly when the ticker should keep one', () => {
    // StatTicker branches on `value.includes('.')` to decide between
    // toFixed(1) and integer locale formatting. These two must agree, or an
    // abbreviated figure animates up as "314" and lands on "314.3".
    expect(compactCount(314_253)?.num).toContain('.');
    expect(compactCount(28)?.num).not.toContain('.');
  });
});

describe('STAT_TILES', () => {
  it('names the four figures the strip shows, in reading order', () => {
    expect(STAT_TILES.map((t) => t.key)).toEqual([
      'categories',
      'subcategories',
      'parts',
      'distributors',
    ]);
  });

  it('no longer claims a number the site cannot back', () => {
    // "23 Years Online" was the tile this replaced: a hardcoded figure with
    // no field behind it. Every tile must name a payload field.
    const labels = STAT_TILES.map((t) => t.label);
    expect(labels).toContain('Different Distributors');
    expect(labels.join(' ')).not.toMatch(/years/i);
  });

  it('has one tile per label, so two tiles cannot read the same', () => {
    expect(new Set(STAT_TILES.map((t) => t.label)).size).toBe(STAT_TILES.length);
    expect(new Set(STAT_TILES.map((t) => t.key)).size).toBe(STAT_TILES.length);
  });
});

describe('NO_VALUE', () => {
  it('is an em dash, not a zero or a stale constant', () => {
    // Showing 0 would read as "we have no parts"; showing the last known
    // figure is the defect this whole module removes.
    expect(NO_VALUE).toBe('—');
  });
});
