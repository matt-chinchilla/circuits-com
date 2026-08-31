import { describe, it, expect } from 'vitest';
import { binColorFor, buildBins, VIEWERSHIP_RAMP } from './viewershipBins';

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
    expect(buildBins(1)).toEqual([{ gte: 1, label: '1+', color: VIEWERSHIP_RAMP[VIEWERSHIP_RAMP.length - 1] }]);
    expect(buildBins(2)).toEqual([{ gte: 1, label: '1+', color: VIEWERSHIP_RAMP[VIEWERSHIP_RAMP.length - 1] }]);
  });

  it('folds the TOP of the ladder once it outruns the ramp, never the tail', () => {
    // 5000 would need 8 half-decade edges; the first five keep the long tail's
    // resolution and the open last bin absorbs everything from 100 up.
    expect(buildBins(5000).map((b) => b.label)).toEqual([
      '1–2',
      '3–9',
      '10–29',
      '30–99',
      '100–299',
      '300+',
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

// ── The thermal ramp's own invariants ──────────────────────────────────────
// The ramp is an inferno slice whose ONE promise to a color-blind reader is
// that luminance rises with the view count. These pin that promise, and the
// clearance the darkest bin needs from the empty-land navy, so a future
// re-tint cannot quietly break either.

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `LAND_NO_DATA` in mapOptions — a region nobody visited. */
const EMPTY_LAND = '#2a3550'; // lifted 2026-08-31 with the sea-plate pass
/** `.wmCard`'s zone surface, which the legend swatches sit on. */
const ZONE_SURFACE = '#0f1526';

describe('VIEWERSHIP_RAMP', () => {
  it('is six well-formed hex stops', () => {
    expect(VIEWERSHIP_RAMP).toHaveLength(6);
    for (const stop of VIEWERSHIP_RAMP) expect(stop).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('does NOT claim monotone luminance — the rainbow trade, pinned on purpose', () => {
    // The retired inferno slice rose monotonically and that was its
    // colour-blind story. A cold-to-hot rainbow cannot: red is darker than
    // the yellow before it. This test exists so the trade stays DELIBERATE —
    // if someone restores a monotone ramp they must delete this and restore
    // the old guarantee, rather than silently changing what the map promises.
    const ls = VIEWERSHIP_RAMP.map(luminance);
    const dips = ls.filter((l, i) => i > 0 && l < ls[i - 1]);
    expect(dips.length).toBeGreaterThan(0);
    // The ends still order correctly, which is what makes the scale readable
    // at a glance even though the middle zig-zags.
    expect(ls[ls.length - 1]).toBeGreaterThan(ls[0]);
  });

  it('separates every neighbouring pair enough to read as a step', () => {
    // Measured as COLOUR distance, not luminance contrast. On a rainbow the
    // two are different questions: cyan and green sit at nearly the same
    // brightness (1.12:1) yet are obviously different colours (distance 105).
    // Luminance was the right test for the monotone inferno ramp and is the
    // wrong one here — see the ramp's own note about what this trades away.
    const rgb = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const distance = (a: string, b: string) => {
      const [ar, ag, ab] = rgb(a);
      const [br, bg, bb] = rgb(b);
      return Math.hypot(ar - br, ag - bg, ab - bb);
    };
    for (let i = 1; i < VIEWERSHIP_RAMP.length; i++) {
      expect(
        distance(VIEWERSHIP_RAMP[i], VIEWERSHIP_RAMP[i - 1]),
        `${VIEWERSHIP_RAMP[i - 1]} -> ${VIEWERSHIP_RAMP[i]}`,
      ).toBeGreaterThan(60);
    }
  });

  it('every stop is distinct, so seven bins are seven colours', () => {
    expect(new Set(VIEWERSHIP_RAMP).size).toBe(VIEWERSHIP_RAMP.length);
  });

  it('runs cool to hot: purple at the floor, red at the ceiling', () => {
    const channels = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    };
    // Coolest reads purple — blue-dominant with red above green.
    const coolest = channels(VIEWERSHIP_RAMP[0]);
    expect(coolest.b).toBeGreaterThan(coolest.g);
    expect(coolest.r).toBeGreaterThan(coolest.g);
    // Hottest reads red — red-dominant by a wide margin. White was tried as
    // a top stop and removed: it is the card's INK colour, so a white country
    // read as a hole in the map rather than as the busiest place on it.
    const hottest = channels(VIEWERSHIP_RAMP[VIEWERSHIP_RAMP.length - 1]);
    expect(hottest.r).toBeGreaterThan(200);
    expect(hottest.r - Math.max(hottest.g, hottest.b)).toBeGreaterThan(120);
    expect(VIEWERSHIP_RAMP).not.toContain('#ffffff');
  });

  it('shares the heat layer\'s own stops so the two maps speak one language', () => {
    // The middle five are sampled from HEAT_GRADIENT; purple and white only
    // extend the ends. If the heat gradient is ever retuned, these move with
    // it — that is the point of pinning them here.
    expect(VIEWERSHIP_RAMP.slice(1)).toEqual([
      '#2c5eff',
      '#15cae7',
      '#3add87',
      '#f4d343',
      '#ff4221',
    ]);
  });

  it('keeps its coolest stop clear of the empty-land navy and the surface', () => {
    // Measured 2026-08-31 on the new purple floor: an unvisited region must
    // never read as a merely-cold one.
    expect(contrast(VIEWERSHIP_RAMP[0], EMPTY_LAND)).toBeGreaterThan(1.6);
    expect(contrast(VIEWERSHIP_RAMP[0], ZONE_SURFACE)).toBeGreaterThan(2.0);
  });
});

describe('binColorFor', () => {
  it('gives a count the exact color its own legend piece carries', () => {
    const bins = buildBins(250);
    for (const bin of bins) {
      expect(binColorFor(bin.gte, bins)).toBe(bin.color);
      if (bin.lte !== undefined) expect(binColorFor(bin.lte, bins)).toBe(bin.color);
    }
  });

  it('agrees with the legend for every count in range', () => {
    const bins = buildBins(250);
    for (let v = 1; v <= 400; v++) {
      const owner = bins.find((b) => v >= b.gte && (b.lte === undefined || v <= b.lte));
      expect(binColorFor(v, bins), `views=${v}`).toBe(owner?.color);
    }
  });

  it('sends anything above the top edge to the open hottest piece', () => {
    const bins = buildBins(250);
    const hottest = bins[bins.length - 1].color;
    for (const v of [250, 1000, 999_999]) expect(binColorFor(v, bins)).toBe(hottest);
  });

  it('floors a count below the first edge instead of returning nothing', () => {
    const bins = buildBins(250);
    for (const v of [0, -3]) expect(binColorFor(v, bins)).toBe(bins[0].color);
  });

  it('still answers when there are no bins at all', () => {
    expect(binColorFor(5, [])).toBe(VIEWERSHIP_RAMP[0]);
  });

  it('works on the degenerate one-piece legend a one-view day produces', () => {
    const bins = buildBins(1);
    expect(bins).toHaveLength(1);
    expect(binColorFor(1, bins)).toBe(bins[0].color);
    expect(binColorFor(9000, bins)).toBe(bins[0].color);
  });
});
