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

export function formatMm(value: number | null): string {
  return value == null ? '—' : value.toFixed(4);
}

/** A row's thickness when the file actually carried one. null is a fact the
 *  file never recorded and 0 is a row that takes up no room; neither can be
 *  weighed, and neither is the other. */
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
  const ordinalByName = new Map(s.copperLayers.map((c) => [c.name, c]));
  if (s.stackup == null) {
    return s.copperLayers.map((c) => ({ ordinal: String(c.ordinal), layer: c.name, type: c.kind, thk: '—' }));
  }
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

export function summarize(s: BoardStackup): StackupSummary {
  const count = (t: ViaType) => s.vias.filter((g) => g.type === t).reduce((n, g) => n + g.count, 0);
  return {
    total: s.layerCount,
    signal: s.copperLayers.filter((c) => c.kind === 'Signal').length,
    plane: s.copperLayers.filter((c) => c.kind === 'Plane').length,
    dielectric: s.stackup == null ? 0 : s.stackup.filter((r) => DIELECTRIC.has(r.type)).length,
    listed: s.listedThicknessMm == null ? null : `${s.listedThicknessMm.toFixed(3)} mm`,
    design: s.designThicknessMm == null ? null : `${s.designThicknessMm.toFixed(3)} mm`,
    thru: count('through'),
    blindBuried: count('blind'),
    micro: count('micro'),
    unknown: count('unknown'),
    finish: s.copperFinish,
  };
}

/** The physical rows as a drawable column. A row's thickness is its weight, so
 *  a 1mm core towers over a 35um foil; rows the file never measured get a
 *  hairline. Every drawn row is reserved its minimum height FIRST and only the
 *  remainder is shared out by weight — a minimum added after the split would
 *  push the stack past the box it is drawn in. Bottoms are accumulated rather
 *  than heights summed, so the last row lands exactly on heightPx instead of
 *  drifting a rounding error past it. Without a stackup block the copper layers
 *  weigh the same and are drawn as equal bands, so the via spans still have
 *  anchors to run between. */
export function bands(s: BoardStackup, heightPx: number): Band[] {
  const rows: BandRow[] = s.stackup ?? s.copperLayers.map((c) => ({ name: c.name, type: 'copper', thicknessMm: null }));
  const anyMeasured = rows.some((r) => measuredMm(r) != null);
  const weigh = (r: BandRow): number => (anyMeasured ? (measuredMm(r) ?? 0) : 1);
  const floorOf = (r: BandRow): number => (weigh(r) > 0 ? MIN_BAND : HAIRLINE);
  const totalWeight = rows.reduce((n, r) => n + weigh(r), 0);
  const floors = rows.reduce((n, r) => n + floorOf(r), 0);
  const spare = Math.max(0, heightPx - floors);
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

export function viaSpans(s: BoardStackup, drawn: Band[]): ViaSpan[] {
  const centre = (name: string): number | null => {
    const b = drawn.find((x) => x.name === name);
    return b == null ? null : b.y + b.h / 2;
  };
  const out: ViaSpan[] = [];
  s.vias.forEach((g, i) => {
    const y1 = centre(g.start);
    const y2 = centre(g.end);
    if (y1 == null || y2 == null) return;
    out.push({ type: g.type, count: g.count, x: 24 + i * 18, y1: Math.min(y1, y2), y2: Math.max(y1, y2) });
  });
  return out;
}
