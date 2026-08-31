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
 * The THERMAL ramp — cold purple to hot red (owner call, 2026-08-31).
 *
 * These are the heat map's own blue-cyan-green-yellow-red stops, sampled off
 * `HEAT_GRADIENT`, with purple prepended so the two maps in this panel speak
 * ONE language and the choropleth reaches further at the cold end. Six stops
 * rather than five, which also buys an extra legend bin: with a three-decade
 * window every bin is a visibly different colour instead of two neighbours
 * arguing over a hue.
 *
 * It ENDS AT RED (owner call, 2026-08-31). A white top stop was tried and
 * removed: on this card white is the ink colour, so the hottest country stopped
 * reading as "hot" and started reading as a blank hole punched in the map.
 *
 * THE TRADE, STATED PLAINLY: luminance no longer rises monotonically. The
 * previous inferno slice did, and that was its colour-blind story — a protan
 * or deutan reader could rank the bins by brightness alone. A cold-to-hot
 * rainbow cannot: red is DARKER than the yellow before it (0.27 vs 0.68
 * relative luminance), so brightness zig-zags near the top. This is the
 * classic rainbow-colormap objection and it is real.
 *
 * What carries the ordering instead: every bin is LABELLED with its own range
 * in the legend, the rank rail beside the map lists exact counts, and the two
 * ends are far apart in both hue and brightness (deep purple, hot red). The
 * ramp is decoration over numbers that are always readable, never the only
 * channel — which is the condition under which this trade is acceptable.
 * If it is ever revisited, viridis/inferno are the monotone options.
 *
 * MEASURED on the zone surface #0f1526 (2026-08-31): neighbouring stops are
 * >= 60 apart in RGB distance, and the coolest stands clear of the empty-land
 * ground so an unvisited region never reads as a merely-cold one.
 *
 * The city-dot layer draws from this same ramp via `binColorFor`, so ONE
 * legend explains the states and the dots on top of them.
 */
export const VIEWERSHIP_RAMP = [
  '#7b3fa0', // purple — coldest
  '#2c5eff', // blue    \
  '#15cae7', // cyan     |  the heat layer's own gradient stops
  '#3add87', // green    |
  '#f4d343', // yellow  /
  '#ff4221', // red     — hottest, and the heat layer's own top stop
];

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
