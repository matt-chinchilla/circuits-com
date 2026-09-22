// frontend/src/public/services/kicad/boardStackup.ts
// Layer table, physical stackup and via groups from a .kicad_pcb (spec §4.4),
// parsing only the blocks it needs via topLevelBlocks so a 10 MB board's
// tracks are never materialized. Absent facts stay null — never defaulted.
import { boardBlocks, parseBlock } from './boardFile';
import { atom, child, children } from './sexpr';
import type {
  BoardStackup,
  CopperLayer,
  SExpr,
  StackupRow,
  ViaGroup,
  ViaType,
} from './types';

const KIND: Record<string, string> = { signal: 'Signal', power: 'Plane', mixed: 'Mixed', jumper: 'Jumper' };

function num(node: SExpr[] | undefined): number | null {
  const v = node == null ? null : atom(node, 1);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(node: SExpr[] | undefined): string | null {
  return node == null ? null : atom(node, 1);
}

function copperLayers(layers: SExpr[]): CopperLayer[] {
  const out: CopperLayer[] = [];
  for (const row of layers) {
    if (!Array.isArray(row)) continue;
    const name = atom(row, 1);
    if (name == null || !name.endsWith('.Cu')) continue;
    const kindToken = atom(row, 2) ?? '';
    out.push({ ordinal: out.length + 1, name, kind: KIND[kindToken] ?? kindToken });
  }
  return out;
}

function stackupRows(setup: SExpr[]): { rows: StackupRow[]; finish: string | null } | null {
  const block = child(setup, 'stackup');
  if (block == null) return null;
  const rows: StackupRow[] = [];
  for (const layer of children(block, 'layer')) {
    rows.push({
      name: atom(layer, 1) ?? '',
      type: str(child(layer, 'type')) ?? '',
      thicknessMm: num(child(layer, 'thickness')),
      material: str(child(layer, 'material')),
      epsilonR: num(child(layer, 'epsilon_r')),
      lossTangent: num(child(layer, 'loss_tangent')),
    });
  }
  return { rows, finish: str(child(block, 'copper_finish')) };
}

function viaOf(via: SExpr[]): ViaGroup | null {
  let type: ViaType = 'through';
  for (let i = 1; i < via.length; i++) {
    const token = via[i];
    if (typeof token !== 'string') break;
    // A token this reader does not know makes the whole via `unknown`, and
    // stays that way: `(via micro weird …)` is as unknown as `(via weird micro …)`.
    if (type === 'unknown') continue;
    if (token === 'blind') type = 'blind';
    else if (token === 'micro') type = 'micro';
    else if (token !== 'locked') type = 'unknown';
  }
  const layers = child(via, 'layers');
  const start = layers == null ? null : atom(layers, 1);
  const end = layers == null ? null : atom(layers, 2);
  if (start == null || end == null) return null;
  return { type, start, end, count: 1 };
}

export function readStackup(boardText: string): BoardStackup {
  const blocks = boardBlocks(boardText);
  let copper: CopperLayer[] = [];
  let stackup: StackupRow[] | null = null;
  let copperFinish: string | null = null;
  let designThicknessMm: number | null = null;
  const groups = new Map<string, ViaGroup>();

  for (const block of blocks) {
    if (block.head === 'layers') {
      const node = parseBlock(boardText, block);
      if (node) copper = copperLayers(node);
    } else if (block.head === 'general') {
      const node = parseBlock(boardText, block);
      if (node) designThicknessMm = num(child(node, 'thickness'));
    } else if (block.head === 'setup') {
      const node = parseBlock(boardText, block);
      const read = node ? stackupRows(node) : null;
      if (read) {
        stackup = read.rows;
        copperFinish = read.finish;
      }
    } else if (block.head === 'via') {
      const node = parseBlock(boardText, block);
      const via = node ? viaOf(node) : null;
      if (via == null) continue;
      const key = `${via.type}|${via.start}|${via.end}`;
      const existing = groups.get(key);
      if (existing) existing.count++;
      else groups.set(key, via);
    }
  }

  const listed = stackup == null ? null : stackup.reduce<number | null>((sum, r) => (r.thicknessMm == null ? sum : (sum ?? 0) + r.thicknessMm), null);
  return {
    copperLayers: copper,
    stackup,
    copperFinish,
    listedThicknessMm: listed,
    designThicknessMm,
    vias: [...groups.values()],
    layerCount: copper.length,
  };
}
