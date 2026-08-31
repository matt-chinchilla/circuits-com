import { describe, it, expect } from 'vitest';
import {
  BRUSH_MAX_FOOTPRINT,
  BRUSH_MIN_FOOTPRINT,
  DECADE_FLOOR,
  heatBounds,
  heatBrushForZoom,
  heatLegendTicks,
  normalizeHeatDecades,
} from './heatWeights';
import type { HeatPoint } from './heatWeights';

/** The shape the panel actually gets: one giant and a crowd of ones and
 *  twos. Every claim about the tail is measured against this, not against a
 *  tidy uniform sample. */
const LONG_TAIL: HeatPoint[] = [
  [40.71, -74.01, 3000],
  [51.51, -0.13, 500],
  [35.69, 139.69, 50],
  [-33.87, 151.21, 5],
  [55.75, 37.62, 1],
  [-23.55, -46.63, 1],
];

/** One point per order of magnitude, spread out so nothing overlaps. */
const DECADE_LADDER: HeatPoint[] = [
  [0, 0, 1],
  [10, 20, 10],
  [20, 40, 100],
  [30, 60, 1000],
  [40, 80, 10000],
];

const weights = (points: HeatPoint[]) => points.map((p) => p[2]);
const gapsBetween = (values: number[]) => values.slice(1).map((v, i) => v - values[i]);

describe('normalizeHeatDecades', () => {
  it('maps the window peak to the top of the scale', () => {
    expect(normalizeHeatDecades(LONG_TAIL)[0][2]).toBe(1);
  });

  // The owner's rule, and the reason this module exists: a tenfold jump in
  // views must buy the same step of gradient wherever on the ladder it
  // happens, so decades read as decades.
  it('puts consecutive powers of ten on evenly spaced rungs', () => {
    const gaps = gapsBetween(weights(normalizeHeatDecades(DECADE_LADDER)));
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 12);
    // Evenly spaced is not enough — the rungs also have to be far enough
    // apart to be told apart on the gradient.
    expect(gaps[0]).toBeGreaterThan(0.15);
  });

  it('keeps the decade step uniform when the peak is not a power of ten', () => {
    // Peak 3,000 — the real prod shape, where log10(peak) is 3.477.
    const ladder: HeatPoint[] = [...DECADE_LADDER.slice(0, 4), [50, 100, 3000]];
    const gaps = gapsBetween(weights(normalizeHeatDecades(ladder)).slice(0, 4));
    for (const gap of gaps) expect(gap).toBeCloseTo(0.2358, 4);
  });

  it('lands the long tail on its own rungs rather than one smear', () => {
    const [top, big, mid, small, one] = weights(normalizeHeatDecades(LONG_TAIL));
    expect(top).toBe(1);
    expect(big).toBeCloseTo(0.8165, 4); // 500
    expect(mid).toBeCloseTo(0.5807, 4); // 50
    expect(small).toBeCloseTo(0.3448, 4); // 5
    expect(one).toBe(DECADE_FLOOR); // 1 — the bottom rung, exactly
  });

  it('never leaves the [DECADE_FLOOR, 1] band and never inverts the order', () => {
    const scaled = weights(normalizeHeatDecades(LONG_TAIL));
    for (const w of scaled) {
      expect(w).toBeGreaterThanOrEqual(DECADE_FLOOR);
      expect(w).toBeLessThanOrEqual(1);
    }
    // LONG_TAIL is already sorted hottest-first (so is the payload).
    for (let i = 1; i < scaled.length; i++) expect(scaled[i]).toBeLessThanOrEqual(scaled[i - 1]);
  });

  it('does not clip or winsorize the peak — an extreme outlier still tops out', () => {
    // A point three decades clear of the rest is drawn as three decades clear,
    // not pulled back toward the pack.
    const scaled = weights(
      normalizeHeatDecades([
        [0, 0, 1_000_000],
        [10, 10, 1000],
        [20, 20, 1],
      ]),
    );
    expect(scaled[0]).toBe(1);
    expect(scaled[1]).toBeCloseTo(DECADE_FLOOR + (1 - DECADE_FLOOR) * 0.5, 12);
    expect(scaled[2]).toBe(DECADE_FLOOR);
  });

  it('is safe on an empty window', () => {
    expect(normalizeHeatDecades([])).toEqual([]);
  });

  it('gives a lone point the top of the scale', () => {
    expect(normalizeHeatDecades([[40.71, -74.01, 7]])).toEqual([[40.71, -74.01, 1]]);
  });

  it('burns a sub-decade window at full intensity rather than dividing by zero', () => {
    // Every point the same order of magnitude: there are no rungs to separate.
    expect(weights(normalizeHeatDecades([[10, 10, 1], [20, 20, 1]]))).toEqual([1, 1]);
    expect(weights(normalizeHeatDecades([[10, 10, 4], [20, 20, 4]]))).toEqual([1, 1]);
  });

  it('does not explode on zero, negative or non-numeric weights', () => {
    const scaled = weights(
      normalizeHeatDecades([
        [10, 10, 100],
        [20, 20, 0],
        [30, 30, -5],
        [40, 40, Number.NaN],
      ]),
    );
    expect(scaled[0]).toBe(1);
    // All three malformed rows read as the bottom rung — not a NaN, and not
    // something below the floor.
    expect(scaled.slice(1)).toEqual([DECADE_FLOOR, DECADE_FLOOR, DECADE_FLOOR]);
  });

  it('drops coordinates Leaflet would throw on instead of passing them through', () => {
    const scaled = normalizeHeatDecades([
      [40.71, -74.01, 10],
      [Number.NaN, 12, 10],
      [10, Number.POSITIVE_INFINITY, 10],
      [91, 0, 10], // past the pole
      [0, 181, 10], // past the antimeridian
    ]);
    expect(scaled).toEqual([[40.71, -74.01, 1]]);
  });
});

describe('heatBrushForZoom', () => {
  const footprint = (z: number) => {
    const b = heatBrushForZoom(z);
    return b.radius + b.blur;
  };

  it('wears the smallest brush at the world zooms', () => {
    expect(footprint(2)).toBeCloseTo(BRUSH_MIN_FOOTPRINT, 10);
    // Below the anchor the clamp holds — zooming OUT never shrinks further.
    expect(footprint(1)).toBeCloseTo(BRUSH_MIN_FOOTPRINT, 10);
  });

  it('doubles the footprint area per zoom step between the anchors', () => {
    // 2^((z-2)/2): one zoom step multiplies the linear footprint by sqrt(2).
    expect(footprint(4)).toBeCloseTo(20, 10);
    expect(footprint(6)).toBeCloseTo(40, 10);
  });

  it('tops out at the shipped metro brush and stays there', () => {
    // 24 + 18 — the prior fixed tuning, which was measured right at metro
    // scale; every deeper zoom keeps it.
    expect(heatBrushForZoom(7)).toEqual({ radius: 24, blur: 18 });
    expect(heatBrushForZoom(19)).toEqual({ radius: 24, blur: 18 });
    expect(footprint(7)).toBeCloseTo(BRUSH_MAX_FOOTPRINT, 10);
  });

  it('keeps the 4:3 radius:blur ratio at every zoom', () => {
    for (let z = 1; z <= 19; z += 0.5) {
      const b = heatBrushForZoom(z);
      expect(b.radius / b.blur).toBeCloseTo(4 / 3, 10);
    }
  });

  it('never shrinks as the zoom deepens', () => {
    for (let z = 1.5; z <= 19; z += 0.5) {
      expect(footprint(z)).toBeGreaterThanOrEqual(footprint(z - 0.5));
    }
  });
});

describe('heatLegendTicks', () => {
  it('ticks the prod-shaped window: whole decades, then the peak at the end', () => {
    // Peak 1,736 — the real window. log10 = 3.2395, so the decade step is
    // 0.82/3.2395 = 0.2531 wide.
    const ticks = heatLegendTicks(1736);
    expect(ticks.map((t) => t.label)).toEqual(['1', '10', '100', '1.7k']);
    expect(ticks[0].t).toBe(DECADE_FLOOR);
    expect(ticks[1].t).toBeCloseTo(0.4331, 4);
    expect(ticks[2].t).toBeCloseTo(0.6862, 4);
    expect(ticks[3].t).toBe(1);
  });

  it('drops a decade that crowds the peak — the peak owns the right end', () => {
    // t(1000) for this window is 0.9394, within the crowd gap of the peak
    // label, so "1k" yields rather than colliding with "1.7k".
    expect(heatLegendTicks(1736).some((t) => t.label === '1k')).toBe(false);
  });

  it('absorbs a peak that IS a power of ten into one tick', () => {
    const ticks = heatLegendTicks(1000);
    expect(ticks.map((t) => t.label)).toEqual(['1', '10', '100', '1k']);
    expect(ticks[ticks.length - 1].t).toBe(1);
  });

  it('handles a shallow window with just the bottom rung and the peak', () => {
    const ticks = heatLegendTicks(5);
    expect(ticks.map((t) => t.label)).toEqual(['1', '5']);
    expect(ticks[0].t).toBe(DECADE_FLOOR);
    expect(ticks[1].t).toBe(1);
  });

  it('returns nothing for a sub-decade window — there is no ladder to explain', () => {
    expect(heatLegendTicks(1)).toEqual([]);
  });

  it('compacts thousands the way the towns rail would read them', () => {
    expect(heatLegendTicks(12345).map((t) => t.label)).toEqual(['1', '10', '100', '1k', '12k']);
  });
});

describe('heatBounds', () => {
  it('boxes every point', () => {
    expect(heatBounds(LONG_TAIL)).toEqual([
      [-33.87, -74.01],
      [55.75, 151.21],
    ]);
  });

  it('returns null when there is nothing to frame', () => {
    expect(heatBounds([])).toBeNull();
    expect(heatBounds([[Number.NaN, Number.NaN, 1]])).toBeNull();
  });

  it('ignores unplaceable points rather than stretching the box to infinity', () => {
    expect(
      heatBounds([
        [10, 20, 1],
        [Number.POSITIVE_INFINITY, 0, 1],
        [30, 40, 1],
      ]),
    ).toEqual([
      [10, 20],
      [30, 40],
    ]);
  });

  it('gives a lone point a degenerate box', () => {
    expect(heatBounds([[12.5, -3.25, 9]])).toEqual([
      [12.5, -3.25],
      [12.5, -3.25],
    ]);
  });
});
