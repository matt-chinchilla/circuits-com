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

/** Ramp validated on the zone surface #0f1526 (.wmCard) — ordinal, all pass. */
export const VIEWERSHIP_RAMP = ['#245c44', '#2f7d5b', '#3fa172', '#57c78c', '#82f2b2'];

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
 *  brightest and the bottom the darkest, however few bins there are. */
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
