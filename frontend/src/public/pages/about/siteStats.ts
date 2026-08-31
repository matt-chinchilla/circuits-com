// The About page's stat strip: which figures it shows, and how a raw count
// becomes the short string under a label.
//
// The strip used to be four literals — `13.8` M "Distributor Parts", `23`
// "Years Online" — and that is how a marketing number becomes a lie: nobody
// edits a constant when the catalog grows, and nothing can fail on a claim
// with no data behind it ("23 Years Online" was never true at all). The tiles
// now name a FIELD of `GET /api/stats/`; the numbers live in the database.

import type { SiteStats } from '@public/types/stats';

/** What `StatTicker` renders: the animated number and its unit. Split because
 *  the ticker counts up to `num` and pins `suffix` beside it, so "314.3" and
 *  "K" cannot travel as one string. */
export interface StatDisplay {
  num: string;
  suffix: string;
}

/** One tile. `key` is the payload field, so a server-side rename breaks the
 *  build here instead of silently rendering a dash on the live page. */
export interface StatTile {
  key: keyof SiteStats;
  label: string;
}

/** Left to right, as the strip reads. */
export const STAT_TILES: readonly StatTile[] = [
  { key: 'categories', label: 'Component Categories' },
  { key: 'subcategories', label: 'Subcategories' },
  { key: 'parts', label: 'Distributor Parts' },
  { key: 'distributors', label: 'Different Distributors' },
];

/** Shown in place of a number while the totals are in flight, or when the
 *  request failed. Deliberately not a fallback figure: a stale constant is the
 *  exact defect this module exists to remove, and "we could not load it" is
 *  more honest than a plausible wrong number. */
export const NO_VALUE = '—'; // em dash

/** One decimal place, rounded half-UP.
 *
 *  NOT `(value / divisor).toFixed(1)`: 1,950 / 1,000 is stored as
 *  1.94999999999999995559…, so `toFixed` correctly rounds the value it
 *  actually holds and prints "1.9" where a reader expects "2.0". Scaling by
 *  ten BEFORE the division keeps both operands whole, so the quotient is exact
 *  and `Math.round` breaks the tie the way the label implies. */
function scaled(value: number, divisor: number, suffix: string): StatDisplay {
  return { num: (Math.round((value * 10) / divisor) / 10).toFixed(1), suffix };
}

/**
 * A count as the strip shows it: 28 -> "28", 314,253 -> "314.3" + "K",
 * 13,800,000 -> "13.8" + "M". `null` for anything that is not a real count,
 * so the caller falls back to `NO_VALUE`.
 *
 * NULL RATHER THAN ZERO for a bad value. `stats[tile.key]` is typed
 * `keyof SiteStats`, but the object came off the network — rename a field
 * server-side and TypeScript still compiles while the lookup yields
 * `undefined` at runtime. Coercing that to "0" would put "0 DISTRIBUTOR PARTS"
 * under a marketing label on a catalog of 310,500: a confident wrong number,
 * which is the entire defect this module exists to remove. A genuine zero from
 * an empty database is a real answer and still renders as "0".
 *
 * The band is chosen against the value the rounding will PRODUCE, not the one
 * it started from — picking the band first prints "1000.0K" for 999,999, since
 * 999.999 rounds up out of its own band. Hence the 999,950 boundaries: that is
 * the first count whose thousands form reads "1000.0".
 *
 * Below 1,000 the number is shown whole. There is no honest way to render 947
 * parts as "0.9K", and every one of these figures passed four digits long ago
 * anyway — the branch is here so a fresh environment mid-seed shows "12", not
 * "0.0K".
 */
export function compactCount(value: unknown): StatDisplay | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const n = Math.round(value);
  if (n < 1_000) return { num: String(n), suffix: '' };
  if (n < 999_950) return scaled(n, 1_000, 'K');
  if (n < 999_950_000) return scaled(n, 1_000_000, 'M');
  return scaled(n, 1_000_000_000, 'B');
}
