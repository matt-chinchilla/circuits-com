// Where each footprint sits on a .kicad_pcb: reference, library footprint,
// value, side, position and rotation — the facts the part panel states about a
// part's place on the board. Read straight from the file's `(footprint …)`
// blocks through `topLevelBlocks`, so nothing else on a 3 MB board is parsed,
// and read on the main thread only when a part is first identified (the page
// memoises it per project).
//
// A number is copied from the file or it is absent — never defaulted. A
// footprint with no `(at …)` is left out rather than placed at the origin.
import { atom, child, children, parse, topLevelBlocks } from './sexpr';
import { KicadReadError, type SExpr } from './types';

export interface FootprintPlacement {
  ref: string;
  /** The library footprint, as the file names it: `Package_SO:SOIC-8_3.9x4.9mm_P1.27mm`. */
  lib: string;
  /** The footprint's Value field, or null when the file carries none. */
  value: string | null;
  side: 'F' | 'B';
  /** KiCad page millimetres, y down, exactly as `(at x y rot)` states them. */
  x: number;
  y: number;
  rotDeg: number;
}

const BOARD_HEAD = /^\s*\(\s*kicad_pcb[\s()]/;

function parseBlock(text: string, start: number, end: number): SExpr[] | null {
  try {
    const node = parse(text.slice(start, end))[0];
    return Array.isArray(node) ? node : null;
  } catch {
    return null;
  }
}

function finite(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** KiCad 6 spells a field `(fp_text reference "U1" …)`; 7+ `(property "Reference" "U1" …)`. */
function fieldOf(node: SExpr[], kind: 'reference' | 'value'): string | null {
  for (const text of children(node, 'fp_text')) if (atom(text, 1) === kind) return atom(text, 2);
  const name = kind === 'reference' ? 'Reference' : 'Value';
  for (const prop of children(node, 'property')) if (atom(prop, 1) === name) return atom(prop, 2);
  return null;
}

function placementOf(node: SExpr[]): FootprintPlacement | null {
  const ref = fieldOf(node, 'reference');
  const at = child(node, 'at');
  const x = finite(at == null ? null : atom(at, 1));
  const y = finite(at == null ? null : atom(at, 2));
  if (ref == null || ref === '' || x == null || y == null) return null;
  const rot = finite(at == null ? null : atom(at, 3)) ?? 0;
  const layer = child(node, 'layer');
  return {
    ref,
    lib: atom(node, 1) ?? '',
    value: fieldOf(node, 'value'),
    side: (layer == null ? null : atom(layer, 1)) === 'B.Cu' ? 'B' : 'F',
    x,
    y,
    rotDeg: rot,
  };
}

/**
 * Every placed footprint, keyed by reference. Throws `KicadReadError` for a
 * file that is not a board or cannot be scanned, on the same terms as
 * `readStackup` — a caller reading a board the reader has already accepted
 * still wraps it, because `project.ts` picks the board by extension alone.
 *
 * A reference that appears twice (two footprints both annotated `R1`) keeps
 * the FIRST: the schematic's own annotation is the authority, and reporting
 * one of two positions is more honest than silently averaging them.
 */
export function readPlacements(boardText: string): Map<string, FootprintPlacement> {
  if (!BOARD_HEAD.test(boardText)) {
    throw new KicadReadError('That file does not open with (kicad_pcb …) — it is not a KiCad board.', 'unreadable');
  }
  let blocks: { head: string; start: number; end: number }[];
  try {
    blocks = [...topLevelBlocks(boardText)];
  } catch {
    throw new KicadReadError('That board file is truncated or malformed and could not be read.', 'unreadable');
  }
  const out = new Map<string, FootprintPlacement>();
  for (const block of blocks) {
    if (block.head !== 'footprint') continue;
    const node = parseBlock(boardText, block.start, block.end);
    const placed = node == null ? null : placementOf(node);
    if (placed != null && !out.has(placed.ref)) out.set(placed.ref, placed);
  }
  return out;
}
