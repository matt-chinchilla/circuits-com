// Piecewise legend bins for the viewership choropleths (world + US).
//
// A continuous visualMap over view counts is unreadable here because the
// distribution is heavy-tailed: one country sends thousands of views and forty
// send one or two, so every one of those forty paints the same near-black end
// of the gradient. Discrete log bins give the long tail its own colors.
//
// Edges come off a half-decade ladder (1, 3, 10, 30, 100, 300, ...) so a bin
// boundary is always a number a person would have picked. When the ladder runs
// longer than the ramp, it is truncated from the TOP: the bottom is where the
// mass of the data lives (forty countries at 1-2 views, one at 500), so the
// low rungs keep their own colors and the open last bin absorbs the giants —
// which the rank rail beside the map already orders by exact count. (v1
// strided the ladder instead, and the first realistic dataset collapsed the
// legend to three bins; measured 2026-08-30, max=533 → 1-9/10-99/100+.)

/**
 * The THERMAL ramp — an inferno slice, cool-dark to hot (2026-08-30).
 *
 * Replaces the single-hue green ramp (#245c44 → #82f2b2) on owner feedback:
 * a heat map should read as heat, the way geo-heatmap/heatmap-ts render one.
 * The stops are sampled from matplotlib's `inferno` between roughly its 0.36
 * and 0.88 positions — the ends are cut off deliberately. Inferno's true
 * bottom is near-black, which is indistinguishable from the empty-land navy
 * on this card, and its true top is near-white, which would out-shout the
 * card chrome around it.
 *
 * LUMINANCE RISES MONOTONICALLY across the five stops, and that monotonicity
 * is the CVD story: a protan or deutan viewer who cannot separate the magenta
 * from the red still reads the ORDER, because every step is brighter than the
 * one below it. Measured relative luminance steps land at ~1.55:1 between
 * neighbours, evenly, with 5.8:1 end to end.
 *
 * MEASURED, not eyeballed (dataviz `validate_palette.js`, ordinal mode, dark,
 * surface #0f1526 — the .wmCard zone surface): all four ordinal checks pass,
 * light-end contrast 2.06:1. Bin 1 also stands 1.74:1 off the empty-land navy
 * #1a2440, so an unvisited region never reads as a merely-cold one. The
 * inferno slice starting at #65156e FAILED that light-end check at 1.63:1,
 * which is why the bottom stop sits where it does rather than lower.
 *
 * The city-dot layer draws from this same ramp via `binColorFor`, so ONE
 * legend explains the states and the dots on top of them.
 */
export const VIEWERSHIP_RAMP = ['#832168', '#b83656', '#e15933', '#f78e12', '#f7cd3a'];

const MAX_BINS = VIEWERSHIP_RAMP.length;

/** One `visualMap.pieces` entry. `gte`/`lte` rather than `min`/`max` on
 *  purpose: ECharts' PiecewiseModel demotes a legacy `min` to an EXCLUSIVE
 *  bound when the piece has no upper bound (`useMinMax[0] && interval[1] ===
 *  Infinity && (close[0] = 0)`), which would drop the top bin's own edge
 *  value out of every piece. `gte` is always inclusive. */
export interface ViewershipBin {
  gte: number;
  /** Absent on the last bin, which is open above. */
  lte?: number;
  label: string;
  color: string;
}

/** 1, 3, 10, 30, 100, 300, ... up to and including `max`. */
function halfDecadeLadder(max: number): number[] {
  const out: number[] = [];
  for (let decade = 1; decade <= max; decade *= 10) {
    for (const multiple of [1, 3]) {
      const value = decade * multiple;
      if (value > max) return out;
      out.push(value);
    }
  }
  return out;
}

/** Spread `count` bins across the full ramp so the top bin is always the
 *  hottest and the bottom the coolest, however few bins there are. */
function rampColor(index: number, count: number): string {
  if (count < 2) return VIEWERSHIP_RAMP[VIEWERSHIP_RAMP.length - 1];
  return VIEWERSHIP_RAMP[Math.round((index * (VIEWERSHIP_RAMP.length - 1)) / (count - 1))];
}

/**
 * Legend bins covering every integer view count from 1 to infinity, exactly
 * once, in at most `VIEWERSHIP_RAMP.length` pieces.
 *
 * Degrades all the way down: a max of 1 or 2 yields the single honest bin
 * "1+" rather than five pieces of which four are empty.
 */
export function buildBins(maxViews: number): ViewershipBin[] {
  const top = Number.isFinite(maxViews) ? Math.max(1, Math.floor(maxViews)) : 1;
  const ladder = halfDecadeLadder(top);

  // The first MAX_BINS rungs — see the header for why the TOP is what folds.
  const edges = ladder.slice(0, MAX_BINS);

  return edges.map((gte, i) => {
    const color = rampColor(i, edges.length);
    const next = edges[i + 1];
    if (next === undefined) return { gte, label: `${gte}+`, color };
    const lte = next - 1;
    return { gte, lte, label: gte === lte ? `${gte}` : `${gte}–${lte}`, color };
  });
}

/**
 * The color the legend already assigns to `views`.
 *
 * This is what lets the city dots share the states' scale instead of carrying
 * a hue of their own: a dot painted by its OWN bin means the single piecewise
 * legend under the map explains both layers at once. A city is always at most
 * as busy as the state containing it, so its dot lands on the same rung or a
 * cooler one — which is exactly why the dots need a dark ring rather than a
 * contrasting fill to stay separable over a hot state.
 *
 * A count below the first edge (0, or a negative from a malformed payload)
 * takes the floor bin: the honest answer for "less than the smallest thing we
 * drew a color for". Above the last edge cannot happen — the top piece is open.
 */
export function binColorFor(views: number, bins: ViewershipBin[]): string {
  if (bins.length === 0) return VIEWERSHIP_RAMP[0];
  for (const bin of bins) {
    if (views >= bin.gte && (bin.lte === undefined || views <= bin.lte)) return bin.color;
  }
  return bins[0].color;
}
