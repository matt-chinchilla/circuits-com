// The city-intel card's data → text layer, plus the label helpers the map
// panel shares with it.
//
// Everything here is pure so it can be unit-tested without a DOM: the card
// itself is a handful of divs, and all of its judgement calls (which networks
// make the cut, how a device split rounds, whether a timestamp is readable,
// where the card can sit without leaving the map box) live in this file.
//
// Non-ASCII punctuation is written as an escape (`·`) on purpose — see
// CLAUDE.md: raw glyphs in TS/JSX get mangled to literal `\uXXXX` text by
// edit tooling, and a card that reads "1,204 views · 318 visitors" is a
// bug nobody catches until it ships.

/** The interpunct that separates every inline pair on the card. */
const SEP = ' \u00b7 ';

export interface CityNetwork {
  name: string;
  views: number;
}

export interface CityDevice {
  type: string;
  views: number;
}

/** A city label the whole panel agrees on: the dot's name, the Top-towns row
 *  and the card title are the same string, so a click never looks like it
 *  opened something else. */
export function cityLabel(row: { city: string; region?: string | null }): string {
  return row.region ? `${row.city}, ${row.region}` : row.city;
}

/** "3 views" / "1 view" — the panel's one pluralizer (tooltips use it too). */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "1,204 views · 318 visitors", or just the views when an older payload
 *  carries no visitor count for this city. */
export function viewsVisitorsLabel(views: number, visitors?: number | null): string {
  const head = plural(views, 'view');
  return visitors == null ? head : `${head}${SEP}${plural(visitors, 'visitor')}`;
}

/** The top `limit` networks as "name (views)" lines, busiest first. Sorted
 *  here rather than trusted from the payload — the card promises "top 3", and
 *  an unordered array would quietly make that a lie. */
export function networkLines(networks?: CityNetwork[] | null, limit = 3): string[] {
  return (networks ?? [])
    .filter((n) => n?.name)
    .slice()
    .sort((a, b) => b.views - a.views)
    .slice(0, limit)
    .map((n) => `${n.name} (${n.views.toLocaleString()})`);
}

/** Whole percentages that actually sum to 100. Plain rounding puts three even
 *  thirds at 33/33/33 and prints a 99% split; the leftover points go to the
 *  largest fractional parts instead (largest-remainder). */
function wholePercentages(values: number[]): number[] {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((v) => (v / total) * 100);
  const out = exact.map(Math.floor);
  let leftover = 100 - out.reduce((sum, v) => sum + v, 0);
  const byFraction = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of byFraction) {
    if (leftover <= 0) break;
    out[i] += 1;
    leftover -= 1;
  }
  return out;
}

/**
 * "desktop 70% · mobile 30%" — the whole device breakdown on one line,
 * busiest first. Null when there is nothing to say, so the caller omits the
 * section rather than printing an empty heading.
 *
 * A share that rounds to 0% is DROPPED rather than printed as "tablet 0%",
 * which means a long tail of one-view device types can leave the line summing
 * to slightly under 100. That is the honest trade: the line exists to show the
 * split, not to be an audit.
 */
export function deviceSplitLabel(devices?: CityDevice[] | null): string | null {
  const rows = (devices ?? []).filter((d) => d?.type && d.views > 0).sort((a, b) => b.views - a.views);
  if (rows.length === 0) return null;
  const pct = wholePercentages(rows.map((d) => d.views));
  const parts: string[] = [];
  rows.forEach((d, i) => {
    if (pct[i] > 0) parts.push(`${d.type} ${pct[i]}%`);
  });
  return parts.length > 0 ? parts.join(SEP) : null;
}

/**
 * Make an API timestamp something `Date.parse` reads the same way in every
 * browser. Three separate hazards, all of them live:
 *
 *  1. The analytics route sends Python's `str(datetime)`, which uses a SPACE
 *     separator — "2026-08-30 14:05:00.123456+00:00". V8 and Gecko tolerate
 *     that form; the ES grammar does not, and Safari has historically
 *     returned NaN for it.
 *  2. Python prints up to SIX fractional digits where the grammar allows
 *     exactly three.
 *  3. A value with no zone designator is UTC (that is what the API stores),
 *     but `Date.parse` reads a bare "2026-08-30T14:05:00" as LOCAL, which
 *     would shift "Last seen" by the viewer's offset. Stamp the Z ourselves.
 *
 * Date-only values are already UTC per spec and are left alone — appending a
 * Z to one produces an unparseable string.
 */
function toParsableIso(value: string): string {
  const iso = value.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso);
  return !hasZone && iso.includes('T') ? `${iso}Z` : iso;
}

/** A short local date+time, e.g. "Aug 30, 2:05 PM" — with the year appended
 *  once it differs from the current one, so a stale "Aug 30" from last year
 *  cannot masquerade as today. Null for an absent or unparseable value so the
 *  caller drops the line. */
export function formatLastSeen(value?: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(toParsableIso(value));
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms);
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  };
  if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
  return date.toLocaleString(undefined, options);
}

export interface CardBox {
  width: number;
  height: number;
}

/**
 * The card's own size, in CSS pixels. COUPLED to `.wmIntel` in
 * ReportsPage.module.scss: the width is that rule's `width`, and the height is
 * a deliberate CEILING for the tallest the card can get (title + count line +
 * three network lines + a device line + the last-seen line — MEASURED at
 * 211px rendered, 2026-08-30; the first estimate of 190 let the card hang 8px
 * off the map). Clamping against a ceiling can only place a short card higher
 * or further left than it strictly needed; the panel also re-measures the
 * real card after layout and nudges it inside, so this constant is the first
 * pass, not the guarantee.
 */
export const INTEL_CARD: CardBox = { width: 216, height: 224 };

/** Gap between the click point and the card, and between the card and the
 *  edges of the map box. */
const OFFSET = 12;
const PAD = 8;

function place(point: number, boxLength: number, cardLength: number): number {
  const max = boxLength - cardLength - PAD;
  // Box smaller than the card at all — pin to the near edge and let it clip
  // rather than solving for a position that does not exist.
  if (max < PAD) return PAD;
  const after = point + OFFSET;
  // Flip to the other side of the click when the natural side would overflow,
  // so the card never covers the dot the user just aimed at.
  const candidate = after > max ? point - OFFSET - cardLength : after;
  return Math.max(PAD, Math.min(candidate, max));
}

/** Where to put the card, in pixels inside the map box, for a click at
 *  (`x`, `y`). Always fully on-box when the box is big enough to hold it. */
export function clampCardPosition(
  x: number,
  y: number,
  box: CardBox,
  card: CardBox = INTEL_CARD,
): { left: number; top: number } {
  return {
    left: place(x, box.width, card.width),
    top: place(y, box.height, card.height),
  };
}
