// The board's two TABLES — its layers and its nets — read without reading the
// board (spec 2026-09-22 §2.3). The Board panel lists both before any drawing
// has loaded, so these parse only the top-level `(layers …)` block and the
// top-level `(net N "name")` rows, skipping every footprint, track and zone the
// full reader would build. The full reader (`readBoardModel`) uses the same row
// functions, so the two can never disagree about a board.
import { boardBlocks, parseBlock } from '../boardFile';
import { atom, head } from '../sexpr';
import { KicadReadError, type SExpr } from '../types';
import type { LayerDef, LayerKind, NetInfo, Side } from './types';

/**
 * KiCad's own ceilings. Not a style preference: every `(layers *.Cu)` pad is
 * expanded against the copper table, so an unbounded table is multiplied by
 * the pad count — a 1 MB file declaring 2,000 copper layers allocated ~480 MB
 * in the worker (measured). 32 copper layers is KiCad's hard limit, and the
 * whole table (copper, technical and user layers) is well under 128 in every
 * version.
 */
const MAX_COPPER_LAYERS = 32;
const MAX_LAYER_ROWS = 128;

function layerKind(name: string): LayerKind {
  if (name.endsWith('.Cu')) return 'copper';
  if (name === 'F.Mask' || name === 'B.Mask') return 'mask';
  if (name === 'F.SilkS' || name === 'B.SilkS') return 'silk';
  if (name === 'F.CrtYd' || name === 'B.CrtYd') return 'courtyard';
  if (name === 'Edge.Cuts') return 'edge';
  return 'other';
}

function layerSide(name: string): Side | 'In' {
  if (name.startsWith('F.')) return 'F';
  if (name.startsWith('B.')) return 'B';
  return 'In';
}

/**
 * `(layers (0 "F.Cu" signal) …)` in file order — which is top → bottom — or a
 * `KicadReadError` for a table past KiCad's ceilings.
 */
export function layerTableOf(node: SExpr[]): LayerDef[] {
  const out: LayerDef[] = [];
  for (const row of node) {
    if (!Array.isArray(row)) continue;
    const ordinal = Number(head(row));
    const name = atom(row, 1);
    if (name == null || !Number.isFinite(ordinal)) continue;
    out.push({ ordinal, name, kind: layerKind(name), side: layerSide(name) });
  }
  if (out.length > MAX_LAYER_ROWS) {
    throw new KicadReadError(`That board declares ${out.length} layers; KiCad allows at most ${MAX_LAYER_ROWS}.`, 'unreadable');
  }
  const copper = out.filter((l) => l.kind === 'copper').length;
  if (copper > MAX_COPPER_LAYERS) {
    throw new KicadReadError(`That board declares ${copper} copper layers; KiCad allows at most ${MAX_COPPER_LAYERS}.`, 'unreadable');
  }
  return out;
}

/**
 * One top-level `(net N "name")` row, or null. Net 0 is KiCad's "no net" row —
 * every unconnected item points at it — so it is never a row of the table a
 * reader is shown.
 */
export function netRowOf(node: SExpr[]): NetInfo | null {
  const raw = atom(node, 1);
  const number = raw == null ? NaN : Number(raw);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { number, name: atom(node, 2) ?? '' };
}

/** Ascending by number, as KiCad writes them and as every consumer lists them. */
export function sortNets(nets: NetInfo[]): NetInfo[] {
  return nets.sort((a, b) => a.number - b.number);
}

/** The board's physical layer table, in file order. Throws like every board reader. */
export function readLayerTable(boardText: string): LayerDef[] {
  for (const block of boardBlocks(boardText)) {
    if (block.head !== 'layers') continue;
    const node = parseBlock(boardText, block);
    return node == null ? [] : layerTableOf(node);
  }
  return [];
}

/** The board's net table, net 0 excluded, ascending. Throws like every board reader. */
export function readNetTable(boardText: string): NetInfo[] {
  const out: NetInfo[] = [];
  for (const block of boardBlocks(boardText)) {
    if (block.head !== 'net') continue;
    const node = parseBlock(boardText, block);
    const row = node == null ? null : netRowOf(node);
    if (row != null) out.push(row);
  }
  return sortNets(out);
}
