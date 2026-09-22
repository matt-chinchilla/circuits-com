// Where each layer sits through the board's thickness, in mm with z UP and the
// board's bottom at 0 (spec 2026-09-21 §4, Layers).
//
// The one rule that governs this file: a thickness the board does not state is
// never invented. `thicknessMm` is the stackup reader's listed SUM or null —
// never `designThicknessMm`, never 1.6. A board with no `(setup (stackup …))`
// still gets a ladder to DRAW, because a viewer has to put the layers
// somewhere, but that ladder is never reported as a measurement.
import type { BoardStackup, StackupRow } from '../types';
import type { BoardWarning, LayerDef, LayerKind, Side } from './types';

export interface LayerZ { name: string; kind: LayerKind; side: Side | 'In'; z0: number; z1: number }
export interface ZLadder {
  layers: LayerZ[];
  thicknessMm: number | null;
  substrateTop: number;
  substrateBottom: number;
  warning: BoardWarning | null;
}

/** Nominal foil and mask, used only where the file itself is silent. */
const COPPER_MM = 0.035, MASK_MM = 0.01, NOMINAL_TOTAL_MM = 1.0;

interface Band { z0: number; z1: number }

/** A stackup row's own thickness, else the nominal one for its TYPE. Silk,
 *  paste and a dielectric that never stated a thickness contribute nothing:
 *  guessing a core's height would move every copper layer above it. */
function rowThickness(row: StackupRow): number {
  if (row.thicknessMm != null) return row.thicknessMm;
  const type = row.type.toLowerCase();
  if (type.includes('copper')) return COPPER_MM;
  if (type.includes('mask')) return MASK_MM;
  return 0;
}

function emit(layers: LayerDef[], bands: Map<string, Band>): LayerZ[] {
  const out: LayerZ[] = [];
  for (const layer of layers) {
    const band = bands.get(layer.name);
    if (band != null) out.push({ name: layer.name, kind: layer.kind, side: layer.side, z0: band.z0, z1: band.z1 });
  }
  return out;
}

/** The topmost copper's underside — the top of the slab the layers sit on.
 *  Read off the bands rather than the layer table's order, so a board that
 *  lists its copper in some other order still gets the right face. */
function topOfSubstrate(ladder: LayerZ[], fallback: number): number {
  const tops = ladder.filter((l) => l.kind === 'copper').map((l) => l.z0);
  return tops.length > 0 ? Math.max(...tops) : fallback;
}

/** The real stackup: every row gets its own band, walked bottom-up from 0 so
 *  the ladder's total is exactly the sum the stackup reader listed. */
function stackedLadder(layers: LayerDef[], rows: StackupRow[], thicknessMm: number | null): ZLadder {
  const bands = new Map<string, Band>();
  let z = 0;
  for (let i = rows.length - 1; i >= 0; i--) {          // file order is top → bottom
    const height = rowThickness(rows[i]);
    bands.set(rows[i].name, { z0: z, z1: z + height });
    z += height;
  }
  const ladder = emit(layers, bands);
  return { layers: ladder, thicknessMm, substrateTop: topOfSubstrate(ladder, z), substrateBottom: 0, warning: null };
}

/**
 * No stackup block: copper at nominal foil thickness, evenly spaced through the
 * board's DESIGN thickness when it states one and through a nominal 1 mm when
 * it does not. The dielectric FILLS that total rather than adding to it, so the
 * drawn board is never taller than the thickness the designer set — and the
 * scene still reports `thicknessMm: null`, because none of this was measured.
 */
function nominalLadder(layers: LayerDef[], designThicknessMm: number | null): ZLadder {
  const copper = layers.filter((l) => l.kind === 'copper');
  const total = designThicknessMm != null && designThicknessMm > 0 ? designThicknessMm : NOMINAL_TOTAL_MM;
  const dielectric = Math.max(0, total - copper.length * COPPER_MM) / Math.max(1, copper.length - 1);
  const bands = new Map<string, Band>();
  let z = 0;
  for (let i = copper.length - 1; i >= 0; i--) {        // bottom → top
    bands.set(copper[i].name, { z0: z, z1: z + COPPER_MM });
    z += COPPER_MM + (i > 0 ? dielectric : 0);
  }
  const ladder = emit(layers, bands);
  return {
    layers: ladder,
    thicknessMm: null,
    substrateTop: topOfSubstrate(ladder, total),
    substrateBottom: 0,
    warning: { kind: 'no-stackup' },
  };
}

export function zLadder(layers: LayerDef[], stackup: BoardStackup | null): ZLadder {
  const rows = stackup?.stackup;
  if (stackup == null || rows == null) return nominalLadder(layers, stackup?.designThicknessMm ?? null);
  return stackedLadder(layers, rows, stackup.listedThicknessMm);
}
