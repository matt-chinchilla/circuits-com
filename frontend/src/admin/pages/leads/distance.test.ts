// The Location column's distance grammar — mirrors the owner's spec:
// whole miles at ≥10, tenths below 10 (centroid resolution makes a
// whole-mile round render every same-town lead as "0 miles").
import { describe, expect, it } from 'vitest';

import { DISTANCE_CHOICES, distanceParams, formatMiles } from './distance';

describe('formatMiles', () => {
  it('rounds to whole miles at ten and above', () => {
    expect(formatMiles(2478.6)).toBe('2479 miles');
    expect(formatMiles(120)).toBe('120 miles');
    expect(formatMiles(10)).toBe('10 miles');
  });

  it('keeps tenths below ten miles', () => {
    expect(formatMiles(8.3)).toBe('8.3 miles');
    expect(formatMiles(1.2)).toBe('1.2 miles');
    expect(formatMiles(0)).toBe('0.0 miles');
  });

  it('does not let 9.97 round up into the whole-mile grammar', () => {
    // toFixed carries 9.97 → "10.0 miles" — still the tenths format, never
    // a bare "10 miles" from the < 10 branch.
    expect(formatMiles(9.97)).toBe('10.0 miles');
  });
});

describe('distanceParams', () => {
  it('maps the neutral key to no params', () => {
    expect(distanceParams('all')).toEqual({});
  });

  it('maps within-N buckets to max_miles', () => {
    expect(distanceParams('50')).toEqual({ max_miles: 50 });
    expect(distanceParams('1000')).toEqual({ max_miles: 1000 });
  });

  it('maps the beyond bucket to min_miles only', () => {
    expect(distanceParams('far')).toEqual({ min_miles: 1000 });
  });

  it('every non-neutral choice produces a filter', () => {
    for (const { key } of DISTANCE_CHOICES) {
      if (key === 'all') continue;
      expect(Object.keys(distanceParams(key)).length).toBeGreaterThan(0);
    }
  });
});
