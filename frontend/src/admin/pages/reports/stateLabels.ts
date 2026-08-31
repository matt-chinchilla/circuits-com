// The always-on state labels for the United States drill-down.
//
// Owner ask, 2026-08-31: "the names of the states [should be] always visible
// in 'United States' view. It would make visibility increase". Three things
// had to be decided to answer it, and all three are here rather than in the
// option builder, because all three are DATA about the committed asset:
//
// ── 1. Codes, not names ────────────────────────────────────────────────────
// The whole United States is ~304px wide on a 320px phone and ~630px on a
// 1440px desktop. "Rhode Island" is ~70px of text at the smallest size worth
// reading; the state it belongs to is 4px across. Two-letter USPS codes are
// the only writing that fits, and every reader of a US map already parses
// them. The asset carries only full names (`properties.name`), so the map
// from one to the other lives here — ONE home, and the only place a state is
// spelled twice.
//
// ── 2. Anchors are PRE-COMPUTED, and that is a measurement, not laziness ───
// A label belongs at the pole of inaccessibility (the point furthest from any
// edge), not the centroid: Florida's centroid is in the Gulf, Michigan's is
// in the lake, Louisiana's is offshore. Deriving it needs an iterated grid
// search over the polygon, and MEASURED on this asset that costs 80ms at a
// 16-step grid and 378ms at 40 steps — on the click that opens the drill-down,
// on whatever phone the reader is holding. So it is computed once, offline, at
// a 64-step grid, rounded to the asset's own 1-decimal precision, and shipped
// as the table below. `stateLabels.test.ts` re-derives the geometry from the
// committed asset and fails if any anchor has drifted OUTSIDE its state — the
// property that actually matters, and the one an asset swap would break.
//
// ── 3. Ten states cannot hold a label at ANY viewport ──────────────────────
// Measured inradius (distance from the label point to the nearest edge of the
// state's largest polygon), in asset units — the frame is 1014.7 x 593.6:
//
//     DC 1.1  RI 3.5  DE 5.1  MA 8.0  MD 8.1  CT 8.7  NJ 8.7  HI 9.5
//     VT 10.8  NH 11.9   |   TN 19.0  WV 19.1  FL 20.0  ME 21.4  ...
//
// A 10px two-letter label needs ~7px of clearance. At the widest desktop the
// map draws at ~0.62px per asset unit, so 7px is 11.3 units — every state
// down to and including New Hampshire fails, at EVERY size the panel is ever
// drawn. No font size and no zoom threshold rescues them; they are
// geometrically too small, and the gap to the next state up (Tennessee, 19.0)
// is wide enough that the line between the two groups is not a judgement
// call. So those ten take the standard cartographic treatment instead: the
// label is moved into open water on a leader line back to its own polygon.
//
// Nine of them are the northeastern seaboard, which is one crowd and takes
// one STACK. Hawaii is alone in the Pacific with room on every side, so it
// takes a short nudge east instead of a place in a column it is nowhere near.
//
// The coordinates are in ASSET UNITS, not pixels, on purpose. Units scale
// with the map, so the stack holds its shape at 320px and at 1440px alike; a
// pixel offset would be a tidy column on a desktop and a stack hanging off
// the edge of a phone (measured: a 36px offset that lands inside the plot at
// 1440 lands 9px OUTSIDE it at 320). Units also scale with ZOOM, which IS a
// problem — clicking New York flung Vermont's label four times further into
// the Atlantic — and `buildLabelLayer` in mapOptions.ts is where it is paid
// for: it divides every offset by the current zoom, so what is fixed in this
// file is the zoom-1 composition and what the reader sees is a constant
// pixel distance at any zoom.
//
// Where the open water IS was measured too, not eyeballed. The eastern edge
// of drawn land, by 20-unit latitude band, is 936.5 at Maine's tip, 931-933
// at Cape Cod and Nantucket, and never past 902 below New York, so x = 948 is
// clear water for the stack's whole span. It sits 9 units short of the frame's
// own right edge, which is not enough room for the text — at 320px a two-letter
// label is 55 units wide — so the label layer turns ECharts' series `clip`
// OFF and spends the plot box's own 8px inset instead (measured: the stack
// lands 3.5px inside the stage at 320, 11px at 390, 14px at 1440). With clip
// left on, the codes were sliced down the middle at both phone widths.
// East of Hawaii, a 10-unit occupancy grid over the asset shows x 340-430
// empty from y 570 down to the frame.

/** A state's label: what to draw, where the state IS, and where the label
 *  GOES. The two positions are equal for the forty-two states big enough to
 *  hold their own label; a leader line is drawn for the rest. */
export interface StateLabel {
  /** The feature name in the committed asset — the join key. */
  name: string;
  /** The two letters actually drawn. */
  code: string;
  /** The state's own label point, in the asset's planar units. */
  anchor: [number, number];
  /** Where the text is drawn. `anchor` unless the polygon is too small. */
  at: [number, number];
}

/** The Atlantic stack, north to south, in asset units. Ordered by each
 *  state's own latitude so no two leader lines can cross: both endpoints of
 *  every leader increase monotonically down the list, and all nine share an x.
 *
 *  The step is 49 units, and it is sized for the WORST case rather than the
 *  best: 49 units is ~12px at the 320px phone width, which is the tightest
 *  pitch a 10px code stays readable at, and ~31px on a desktop. That makes the
 *  rail 66% of the map's height on a desktop — deliberately, because the ten
 *  labels on it are exempt from the overlap culling that thins the rest (see
 *  `labelLayer` in mapOptions.ts), so they are drawn at EVERY width and the
 *  narrowest width is the one that has to work. A step tuned for the desktop
 *  instead (30 was tried) reads as a cramped run of touching codes at 320px.
 *  Zoom shrinks the whole offset anyway — `buildLabelLayer` divides by the
 *  zoom — so the long rail is a zoom-1 composition, not a permanent one. */
const STACK_X = 948;
const STACK_TOP = 130;
const STACK_STEP = 49;
const STACK = [
  'Vermont',
  'New Hampshire',
  'Massachusetts',
  'Rhode Island',
  'Connecticut',
  'New Jersey',
  'Maryland',
  'Delaware',
  'District of Columbia',
];

/** The moved labels that are NOT part of the seaboard stack. Hawaii's largest
 *  island is 9.5 units of clearance — it fails the same test the seaboard does
 *  — but it sits alone in the Pacific, so its label goes just east of the
 *  chain rather than 400 units north into a column about New England. */
const LONE_NUDGE: Readonly<Record<string, [number, number]>> = {
  Hawaii: [362, 590],
};

/** Name, code, and the pre-computed pole of inaccessibility of the state's
 *  LARGEST polygon (Michigan's Lower Peninsula, Hawaii's Big Island, mainland
 *  Alaska), in the asset's own planar units, at its own 1dp precision. */
const STATES: ReadonlyArray<readonly [string, string, number, number]> = [
  ['Alabama', 'AL', 674.1, 441],
  ['Alaska', 'AK', 106.1, 510.3],
  ['Arizona', 'AZ', 206.8, 393.5],
  ['Arkansas', 'AR', 561.5, 389.1],
  ['California', 'CA', 85.2, 315.9],
  ['Colorado', 'CO', 336, 290.3],
  ['Connecticut', 'CT', 888.8, 189],
  ['Delaware', 'DE', 856.2, 266.7],
  ['District of Columbia', 'DC', 828.2, 267.5],
  ['Florida', 'FL', 791.1, 535],
  ['Georgia', 'GA', 743.7, 438.3],
  ['Hawaii', 'HI', 316.8, 586.2],
  ['Idaho', 'ID', 191.9, 163.2],
  ['Illinois', 'IL', 611.6, 266.9],
  ['Indiana', 'IN', 666.6, 262.1],
  ['Iowa', 'IA', 530, 228.4],
  ['Kansas', 'KS', 467.5, 309.3],
  ['Kentucky', 'KY', 702.4, 315.6],
  ['Louisiana', 'LA', 562.3, 457.3],
  ['Maine', 'ME', 920.7, 91.4],
  ['Maryland', 'MD', 825.4, 257],
  ['Massachusetts', 'MA', 880.9, 173.7],
  ['Michigan', 'MI', 683.6, 199.9],
  ['Minnesota', 'MN', 521.2, 115.2],
  ['Mississippi', 'MS', 617, 420.6],
  ['Missouri', 'MO', 559.8, 317.1],
  ['Montana', 'MT', 276.2, 99.2],
  ['Nebraska', 'NE', 443.4, 240],
  ['Nevada', 'NV', 139.4, 239.7],
  ['New Hampshire', 'NH', 893.5, 149.8],
  ['New Jersey', 'NJ', 863, 241.7],
  ['New Mexico', 'NM', 312, 391.9],
  ['New York', 'NY', 844.3, 166.7],
  ['North Carolina', 'NC', 818.1, 350.8],
  ['North Dakota', 'ND', 448.7, 104.5],
  ['Ohio', 'OH', 720.3, 257.4],
  ['Oklahoma', 'OK', 489.9, 379.5],
  ['Oregon', 'OR', 114.5, 138.6],
  ['Pennsylvania', 'PA', 795.3, 228],
  ['Rhode Island', 'RI', 903.2, 180.6],
  ['South Carolina', 'SC', 786.4, 395],
  ['South Dakota', 'SD', 426.4, 171.6],
  ['Tennessee', 'TN', 673.5, 362.1],
  ['Texas', 'TX', 455.9, 480.5],
  ['Utah', 'UT', 227.6, 276.5],
  ['Vermont', 'VT', 871.2, 125.6],
  ['Virginia', 'VA', 810.5, 300.5],
  ['Washington', 'WA', 133, 59.5],
  ['West Virginia', 'WV', 759.1, 295.3],
  ['Wisconsin', 'WI', 594.8, 160.7],
  ['Wyoming', 'WY', 306.4, 195],
];

/** Where a state's label is DRAWN, or null to leave it on its own anchor. */
function movedPosition(name: string): [number, number] | null {
  const i = STACK.indexOf(name);
  if (i >= 0) return [STACK_X, STACK_TOP + i * STACK_STEP];
  return LONE_NUDGE[name] ?? null;
}

/** Draw order for the label layer: moved first, then the rest. */
function movedRank(name: string): number {
  const i = STACK.indexOf(name);
  if (i >= 0) return i;
  return LONE_NUDGE[name] ? STACK.length : STACK.length + 1;
}

/**
 * Every state's label, MOVED-FIRST.
 *
 * The order is load-bearing, not cosmetic. ECharts hides overlapping labels in
 * list order once priorities tie (`labelLayoutHelper.hideOverlap` sorts on
 * `priority`, which is the host symbol's area — zero for every one of these,
 * so the sort is stable and input order decides). The ten that were moved into
 * open water are exactly the ten a reader could not otherwise identify at all,
 * so they go first and survive a crowded frame; a big state whose label is
 * culled is still a big recognisable shape.
 */
export const US_STATE_LABELS: StateLabel[] = [...STATES]
  .sort((a, b) => movedRank(a[0]) - movedRank(b[0]))
  .map(([name, code, x, y]) => ({
    name,
    code,
    anchor: [x, y] as [number, number],
    at: movedPosition(name) ?? ([x, y] as [number, number]),
  }));

/** The two-letter code for a state, by the asset's own feature name. Exported
 *  for the tests and for anything that later needs the same spelling. */
export const US_STATE_CODES: Readonly<Record<string, string>> = Object.fromEntries(
  STATES.map(([name, code]) => [name, code]),
);
