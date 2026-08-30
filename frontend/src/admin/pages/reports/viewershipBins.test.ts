import { describe, it, expect } from 'vitest';
import { buildBins, VIEWERSHIP_RAMP } from './viewershipBins';

/** Every integer 1..upTo must fall in exactly one piece. */
function pieceIndexFor(bins: ReturnType<typeof buildBins>, value: number): number[] {
  const hits: number[] = [];
  bins.forEach((b, i) => {
    if (value >= b.gte && (b.lte === undefined || value <= b.lte)) hits.push(i);
  });
  return hits;
}

const MAXES = [1, 2, 4, 9, 37, 250, 5000];

describe('buildBins', () => {
  it('produces at most one piece per ramp color', () => {
    for (const max of [...MAXES, 300, 1000, 30000, 250000]) {
      expect(buildBins(max).length).toBeLessThanOrEqual(VIEWERSHIP_RAMP.length);
      expect(buildBins(max).length).toBeGreaterThan(0);
    }
  });

  it('covers every view count from 1 to max exactly once', () => {
    for (const max of MAXES) {
      const bins = buildBins(max);
      for (let v = 1; v <= max; v++) {
        expect(pieceIndexFor(bins, v), `max=${max} value=${v}`).toHaveLength(1);
      }
    }
  });

  it('leaves the top piece open so a count above max still lands somewhere', () => {
    for (const max of MAXES) {
      const bins = buildBins(max);
      expect(bins[bins.length - 1].lte).toBeUndefined();
      expect(pieceIndexFor(bins, max * 1000)).toEqual([bins.length - 1]);
    }
  });

  it('starts at 1 and puts every edge on the half-decade ladder', () => {
    const ladder = new Set([1, 3, 10, 30, 100, 300, 1000, 3000, 10000, 30000, 100000, 300000]);
    for (const max of [...MAXES, 300, 1000, 30000, 250000]) {
      const bins = buildBins(max);
      expect(bins[0].gte).toBe(1);
      for (const b of bins) expect(ladder.has(b.gte), `edge ${b.gte} (max=${max})`).toBe(true);
      // Strictly ascending, non-overlapping, gapless.
      for (let i = 1; i < bins.length; i++) {
        expect(bins[i].gte).toBe((bins[i - 1].lte ?? NaN) + 1);
      }
    }
  });

  it('labels ranges with an en dash and the open piece with a plus', () => {
    expect(buildBins(250).map((b) => b.label)).toEqual([
      '1–2',
      '3–9',
      '10–29',
      '30–99',
      '100+',
    ]);
    expect(buildBins(37).map((b) => b.label)).toEqual(['1–2', '3–9', '10–29', '30+']);
  });

  it('degrades to a single honest piece on a one-view day', () => {
    expect(buildBins(1)).toEqual([{ gte: 1, label: '1+', color: VIEWERSHIP_RAMP[4] }]);
    expect(buildBins(2)).toEqual([{ gte: 1, label: '1+', color: VIEWERSHIP_RAMP[4] }]);
  });

  it('folds the TOP of the ladder once it outruns the ramp, never the tail', () => {
    // 5000 would need 8 half-decade edges; the first five keep the long tail's
    // resolution and the open last bin absorbs everything from 100 up.
    expect(buildBins(5000).map((b) => b.label)).toEqual([
      '1–2',
      '3–9',
      '10–29',
      '30–99',
      '100+',
    ]);
  });

  it('draws colors from the ramp in order, darkest first and brightest last', () => {
    for (const max of [...MAXES, 300, 30000]) {
      const bins = buildBins(max);
      const indices = bins.map((b) => VIEWERSHIP_RAMP.indexOf(b.color));
      expect(indices.every((i) => i >= 0)).toBe(true);
      for (let i = 1; i < indices.length; i++) expect(indices[i]).toBeGreaterThan(indices[i - 1]);
      expect(indices[indices.length - 1]).toBe(VIEWERSHIP_RAMP.length - 1);
      if (bins.length > 1) expect(indices[0]).toBe(0);
    }
  });

  it('survives degenerate inputs rather than looping', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1.4]) {
      const bins = buildBins(bad);
      expect(bins.length).toBeGreaterThan(0);
      expect(bins.length).toBeLessThanOrEqual(VIEWERSHIP_RAMP.length);
      expect(bins[0].gte).toBe(1);
    }
  });
});
