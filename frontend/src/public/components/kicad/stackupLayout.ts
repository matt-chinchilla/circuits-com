// frontend/src/public/components/kicad/stackupLayout.ts
// Pure geometry and rows for StackupPanel (spec §7.3): the physical stack in
// file order joined to copper ordinals by name; counts of what the file
// carries; scaled bands for the cross-section; via spans between REAL layers.
// Absent facts are dashes, never defaults.
import type { BoardStackup, StackupRow, ViaType } from '@public/services/kicad/types';

export interface StackupTableRow {
  ordinal: string;
  layer: string;
  type: string;
  thk: string;
}

export interface StackupSummary {
  total: number;
  signal: number;
  plane: number;
  mixed: number;
  jumper: number;
  /** Copper rows whose kind this reader could not name — see `summarize`. */
  other: number;
  dielectric: number;
  listed: string | null;
  design: string | null;
  thru: number;
  blindBuried: number;
  micro: number;
  unknown: number;
  finish: string | null;
}

export type BandKind = 'copper' | 'dielectric' | 'mask' | 'other';

export interface Band {
  name: string;
  kind: BandKind;
  y: number;
  h: number;
}

export interface ViaSpan {
  type: ViaType;
  count: number;
  x: number;
  y1: number;
  y2: number;
}

/** All `bands` needs of a row — so a board with no stackup block can stand its
 *  copper layers in for the physical rows without inventing the rest. */
type BandRow = Pick<StackupRow, 'name' | 'type' | 'thicknessMm'>;

const DIELECTRIC = new Set(['core', 'prepreg']);
const HAIRLINE = 1;
const MIN_BAND = 2;
/** Where the first via lane sits and how far apart the lanes are drawn. A board
 *  with many blind and micro spans can group into a dozen lanes, so the last
 *  one sits at LANE_X + 11 × LANE_PITCH — the panel owns whether that fits. */
const LANE_X = 24;
const LANE_PITCH = 18;
/** What a figure the file never carried reads as. */
const ABSENT = '—';

/** Four decimals of a millimetre, or the placeholder. A thickness that is null
 *  (never recorded) or non-finite reads as absent — never "0", never "NaN". */
export function formatMm(value: number | null): string {
  return value != null && Number.isFinite(value) ? value.toFixed(4) : ABSENT;
}

/** A row's thickness when the file recorded a usable one. Both null (never
 *  recorded) and 0 (a row of no height) come back null, because neither can be
 *  weighed in a proportional stack — the TABLE is where the two stay apart,
 *  since formatMm renders 0 as "0.0000" and null as the placeholder. */
/** A millimetre figure with its unit, or null when there is no figure. ONE
 *  formatter for the Thk column and for the two totals (via `formatMm`), so the
 *  table and the summary can never print the same number to different
 *  precisions — and so a raw IEEE sum like 1.5999999999999999, which the reader
 *  keeps unrounded ON PURPOSE because its contract is "the sum of what the file
 *  lists", is rounded HERE, in the view, where it belongs. A non-finite figure
 *  is no figure: null, never "Infinity mm". */
function mmWithUnit(value: number | null): string | null {
  return value == null || !Number.isFinite(value) ? null : `${formatMm(value)} mm`;
}

function measuredMm(r: BandRow): number | null {
  return r.thicknessMm != null && r.thicknessMm > 0 ? r.thicknessMm : null;
}

function kindOf(name: string, type: string): BandKind {
  if (name.endsWith('.Cu') || type === 'copper') return 'copper';
  if (DIELECTRIC.has(type)) return 'dielectric';
  if (/mask/i.test(type)) return 'mask';
  return 'other';
}

export function tableRows(s: BoardStackup): StackupTableRow[] {
  if (s.stackup == null) {
    return s.copperLayers.map((c) => ({ ordinal: String(c.ordinal), layer: c.name, type: c.kind, thk: formatMm(null) }));
  }
  const ordinalByName = new Map(s.copperLayers.map((c) => [c.name, c]));
  return s.stackup.map((row) => {
    const copper = ordinalByName.get(row.name);
    return {
      ordinal: copper == null ? '-' : String(copper.ordinal),
      layer: row.name,
      type: copper == null ? row.type : copper.kind,
      thk: formatMm(row.thicknessMm),
    };
  });
}

/** What the file carries, counted. The four copper kinds are all reported —
 *  KiCad's Board Setup offers Mixed and Jumper beside Signal and Plane, and a
 *  board using one would otherwise read "4 layers · 2 signal · 1 plane" and
 *  leave a layer unaccounted for. `other` closes that gap for a kind the reader
 *  cannot name at all, so the five buckets sum to the copper count ALWAYS —
 *  each layer's kind is one string, so no layer is counted twice and the
 *  remainder can never go negative. */
export function summarize(s: BoardStackup): StackupSummary {
  const vias = (t: ViaType) => s.vias.filter((g) => g.type === t).reduce((n, g) => n + g.count, 0);
  const kind = (k: string) => s.copperLayers.filter((c) => c.kind === k).length;
  const signal = kind('Signal');
  const plane = kind('Plane');
  const mixed = kind('Mixed');
  const jumper = kind('Jumper');
  return {
    total: s.layerCount,
    signal,
    plane,
    mixed,
    jumper,
    // The copper rows none of the four named buckets claimed. `boardStackup`
    // passes a token it has no mapping for straight through, and a `.Cu` row
    // written with no type atom reads as the empty string — so a board KiCad
    // has learned a new layer kind for still adds up. Counted as the REMAINDER
    // rather than by listing tokens: the five buckets then sum to the copper
    // count for every kind, named or not, and no layer can go unaccounted for.
    other: s.copperLayers.length - signal - plane - mixed - jumper,
    dielectric: s.stackup == null ? 0 : s.stackup.filter((r) => DIELECTRIC.has(r.type)).length,
    listed: mmWithUnit(s.listedThicknessMm),
    design: mmWithUnit(s.designThicknessMm),
    thru: vias('through'),
    blindBuried: vias('blind'),
    micro: vias('micro'),
    unknown: vias('unknown'),
    finish: s.copperFinish,
  };
}

/** The rows `bands` draws: the physical stackup when the file has one, else the
 *  copper layers standing in for it. */
function drawableRows(s: BoardStackup): BandRow[] {
  return s.stackup ?? s.copperLayers.map((c) => ({ name: c.name, type: 'copper', thicknessMm: null }));
}

/** How a row is weighed and how short it is allowed to get. ONE home, because
 *  `minHeightPx` is only worth anything if it reports the very floors `bands`
 *  reserves — two copies of this rule would drift, and the panel would size its
 *  box to a number the layout does not share. */
function scale(rows: BandRow[]): { weigh: (r: BandRow) => number; floorOf: (r: BandRow) => number } {
  const anyMeasured = rows.some((r) => measuredMm(r) != null);
  const weigh = (r: BandRow): number => (anyMeasured ? (measuredMm(r) ?? 0) : 1);
  return { weigh, floorOf: (r: BandRow): number => (weigh(r) > 0 ? MIN_BAND : HAIRLINE) };
}

/** The shortest box this stack fits in: the sum of the per-row floors `bands`
 *  reserves before it shares out any remainder. A real 13-row board returns 22.
 *
 *  A caller that sizes its own drawing box MUST NOT go below this. `bands` keeps
 *  the floors and overflows a box too short for them — which is the honest
 *  choice for the geometry, and invisible in an SVG, where the overflow is
 *  simply clipped away outside the viewBox. */
export function minHeightPx(s: BoardStackup): number {
  const rows = drawableRows(s);
  const { floorOf } = scale(rows);
  return rows.reduce((n, r) => n + floorOf(r), 0);
}

/** The physical rows as a drawable column. A row's thickness is its weight, so
 *  a 1mm core towers over a 35um foil; rows the file never measured get a
 *  hairline. Every drawn row is reserved its minimum height FIRST and only the
 *  remainder is shared out by weight — a minimum added after the split would
 *  push the stack past the box it is drawn in. Bottoms are accumulated rather
 *  than heights summed, so the last row lands exactly on heightPx (a fractional
 *  height included) instead of drifting a rounding error past it. Without a
 *  stackup block the copper layers weigh the same and are drawn as equal bands,
 *  so the via spans still have anchors to run between.
 *
 *  A box too short for the reserved minimums themselves — below 22px for a real
 *  13-row board — keeps the minimums and overflows rather than shrink every row
 *  to a sub-pixel sliver that reports success and shows nothing. A heightPx that
 *  is not a finite number is read as no room at all and gets that same floor
 *  layout, so 0, a negative and NaN all behave the one way. */
export function bands(s: BoardStackup, heightPx: number): Band[] {
  const box = Number.isFinite(heightPx) ? heightPx : 0;
  const rows = drawableRows(s);
  const { weigh, floorOf } = scale(rows);
  const totalWeight = rows.reduce((n, r) => n + weigh(r), 0);
  const floors = rows.reduce((n, r) => n + floorOf(r), 0);
  const spare = Math.max(0, box - floors);
  let seen = 0;
  let reserved = 0;
  let y = 0;
  return rows.map((r) => {
    seen += weigh(r);
    reserved += floorOf(r);
    const bottom = totalWeight > 0 ? reserved + (seen / totalWeight) * spare : reserved;
    const band: Band = { name: r.name, kind: kindOf(r.name, r.type), y, h: bottom - y };
    y = bottom;
    return band;
  });
}

/** One lane per via group, run between the centres of the bands it connects.
 *  Lanes are numbered by DRAWN order, not by position in the file's groups, so
 *  a group this stack cannot anchor leaves no empty lane behind it. */
export function viaSpans(s: BoardStackup, drawn: Band[]): ViaSpan[] {
  const centre = (name: string): number | null => {
    const b = drawn.find((x) => x.name === name);
    return b == null ? null : b.y + b.h / 2;
  };
  const out: ViaSpan[] = [];
  for (const g of s.vias) {
    const a = centre(g.start);
    const z = centre(g.end);
    // Both ends have to be drawn for a span to mean anything, and both ends on
    // ONE band would draw as a zero-length line — invisible, and it would carry
    // its own count label out of sight with it.
    if (a == null || z == null || a === z) continue;
    out.push({
      type: g.type,
      count: g.count,
      x: LANE_X + out.length * LANE_PITCH,
      y1: Math.min(a, z),
      y2: Math.max(a, z),
    });
  }
  return out;
}
