// The three .kicad_pcb readers — the stackup tab's (`boardStackup`), the part
// panel's placements (`boardPlacements`) and the 3D pipeline's
// (`board3d/readBoardModel`) — open a board the same way: refuse a file that is
// not one, scan its top-level blocks without building a tree, and parse only
// the blocks they want. One home, so the three refuse the same files with the
// same sentence.
import { atom, children, parse, topLevelBlocks, type TopLevelBlock } from './sexpr';
import { KicadReadError, type SExpr } from './types';

/** A board must open with (kicad_pcb …). buildProject accepts a .kicad_pcb that
 *  carries no (version …), so a file that is not a board at all can reach here. */
const BOARD_HEAD = /^\s*\(\s*kicad_pcb[\s()]/;

/**
 * The board's top-level blocks, or a `KicadReadError('unreadable')`. One error
 * contract for every reader: a truncated or unbalanced board makes the scanner
 * throw a plain Error, which the pages never see — it is the same 'unreadable'
 * as a file that is not a board at all.
 */
export function boardBlocks(text: string): TopLevelBlock[] {
  if (!BOARD_HEAD.test(text)) {
    throw new KicadReadError('That file does not open with (kicad_pcb …) — it is not a KiCad board.', 'unreadable');
  }
  try {
    return [...topLevelBlocks(text)];
  } catch (err) {
    if (err instanceof KicadReadError) throw err;
    throw new KicadReadError('That board file is truncated or malformed and could not be read.', 'unreadable');
  }
}

/** One block of `boardBlocks`, parsed; null when it does not parse to a list. */
export function parseBlock(text: string, block: TopLevelBlock): SExpr[] | null {
  try {
    const node = parse(text.slice(block.start, block.end))[0];
    return Array.isArray(node) ? node : null;
  } catch {
    return null;
  }
}

/** A footprint's Reference or Value field. KiCad 6 spells it
 *  `(fp_text reference "U1" …)`; 7+ `(property "Reference" "U1" …)`. */
export function footprintField(node: SExpr[], kind: 'reference' | 'value'): string | null {
  for (const text of children(node, 'fp_text')) if (atom(text, 1) === kind) return atom(text, 2);
  const name = kind === 'reference' ? 'Reference' : 'Value';
  for (const prop of children(node, 'property')) if (atom(prop, 1) === name) return atom(prop, 2);
  return null;
}
