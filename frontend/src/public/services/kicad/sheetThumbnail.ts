// A thumbnail of a schematic sheet, read from the FILE (owner, 2026-09-22:
// "show an image of what each of them look like in the layers-area like how
// Altium365 does"). Wires, buses, junctions, every symbol's lib graphics and
// pins placed by its instance transform, and the hierarchical sheet boxes —
// the skyline of the sheet, as SVG path data in millimetres on the sheet's
// own paper. No text: unreadable at thumbnail size, and the shapes are what
// a reader recognises a sheet by.
//
// Our own reader, not the renderer's: KiCanvas is reached only through the
// controller seam, which is frozen, and a thumbnail is a pure function of the
// text anyway — testable against Glasgow without a GPU (the pins of every
// placed symbol must land on wire ends, which is what pins the transform).
import { atom, child, children, parse } from './sexpr';
import type { SExpr } from './types';

export interface SheetThumbnail {
  /** The paper, in mm: the drawing's viewBox is `0 0 width height`. */
  width: number;
  height: number;
  /** SVG path data in mm, y down (the sheet's own frame). */
  wires: string;
  buses: string;
  symbols: string;
  sheets: string;
  /** Junction centres, mm. */
  junctions: readonly { x: number; y: number }[];
  counts: { wires: number; buses: number; symbols: number; sheets: number; pins: number };
}

/** KiCad's paper sizes, landscape, mm. */
const PAPER: Readonly<Record<string, readonly [number, number]>> = {
  A5: [210, 148],
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
  A: [279.4, 215.9],
  B: [431.8, 279.4],
  C: [558.8, 431.8],
  D: [863.6, 558.8],
  E: [1117.6, 863.6],
  USLetter: [279.4, 215.9],
  USLegal: [355.6, 215.9],
  USLedger: [431.8, 279.4],
};

type Pt = readonly [number, number];

/** One graphic of a lib symbol, in the symbol's own coordinates (y UP, as
 *  KiCad stores library graphics). Everything is a polyline: an arc is its
 *  start, mid and end; a circle is a 12-gon; a rectangle its four corners. */
interface Item {
  pts: Pt[];
  closed: boolean;
}

interface LibSymbol {
  /** Items by unit; unit 0 is common to every unit. */
  units: Map<number, Item[]>;
  /** Pin CONNECTION points (their `at`) by unit, for the transform test. */
  pinsByUnit: Map<number, Pt[]>;
  extendsName: string | null;
}

function num(s: string | null): number {
  const v = s == null ? NaN : Number(s);
  return Number.isFinite(v) ? v : 0;
}

function xy(node: SExpr): Pt {
  return [num(atom(node, 1)), num(atom(node, 2))];
}

function pts(node: SExpr[]): Pt[] {
  const list = child(node, 'pts');
  return list == null ? [] : children(list, 'xy').map(xy);
}

function paperSize(doc: SExpr[]): [number, number] {
  const paper = child(doc, 'paper');
  const name = paper == null ? null : atom(paper, 1);
  let size: readonly [number, number];
  if (name === 'User') size = [num(atom(paper!, 2)), num(atom(paper!, 3))];
  else size = (name == null ? undefined : PAPER[name]) ?? PAPER.A4!;
  if (size[0] <= 0 || size[1] <= 0) size = PAPER.A4!;
  const portrait = paper != null && paper.some((a) => a === 'portrait');
  return portrait ? [size[1], size[0]] : [size[0], size[1]];
}

function circlePoints(c: Pt, r: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return out;
}

/** The graphics directly under `node` (a lib symbol or one of its units). */
function itemsOf(node: SExpr[], into: Item[], pins: Pt[]): void {
  for (const g of node) {
    if (!Array.isArray(g)) continue;
    const kind = g[0];
    if (kind === 'rectangle') {
      const a = xy(child(g, 'start') ?? []);
      const b = xy(child(g, 'end') ?? []);
      into.push({ pts: [a, [b[0], a[1]], b, [a[0], b[1]]], closed: true });
    } else if (kind === 'polyline' || kind === 'bezier') {
      const p = pts(g);
      if (p.length >= 2) into.push({ pts: p, closed: false });
    } else if (kind === 'circle') {
      const c = xy(child(g, 'center') ?? []);
      const r = num(atom(child(g, 'radius') ?? [], 1));
      if (r > 0) into.push({ pts: circlePoints(c, r), closed: true });
    } else if (kind === 'arc') {
      const s = xy(child(g, 'start') ?? []);
      const m = xy(child(g, 'mid') ?? []);
      const e = xy(child(g, 'end') ?? []);
      into.push({ pts: [s, m, e], closed: false });
    } else if (kind === 'pin') {
      const at = child(g, 'at');
      if (at == null) continue;
      const p = xy(at);
      const rot = (num(atom(at, 3)) * Math.PI) / 180;
      const len = num(atom(child(g, 'length') ?? [], 1));
      pins.push(p);
      // Hidden pins (power symbols' invisible pins) are still drawn: at
      // thumbnail size a stub is a stub, and the connection point is what the
      // transform test reads.
      into.push({ pts: [p, [p[0] + len * Math.cos(rot), p[1] + len * Math.sin(rot)]], closed: false });
    }
  }
}

/** `Name_U_S` → [U, S]; null for a name that is not a unit's. The parent is
 *  `Library:Name`, the units are `Name_U_S` — no library prefix. */
function unitOf(name: string, parent: string): [number, number] | null {
  const short = parent.slice(parent.lastIndexOf(':') + 1);
  if (!name.startsWith(`${short}_`)) return null;
  const m = /^_(\d+)_(\d+)$/.exec(name.slice(short.length));
  return m == null ? null : [Number(m[1]), Number(m[2])];
}

function readLibSymbols(doc: SExpr[]): Map<string, LibSymbol> {
  const out = new Map<string, LibSymbol>();
  const lib = child(doc, 'lib_symbols');
  if (lib == null) return out;
  for (const sym of children(lib, 'symbol')) {
    const name = atom(sym, 1);
    if (name == null) continue;
    const units = new Map<number, Item[]>();
    const pinsByUnit = new Map<number, Pt[]>();
    const add = (unit: number, node: SExpr[]) => {
      const items = units.get(unit) ?? [];
      const pins = pinsByUnit.get(unit) ?? [];
      itemsOf(node, items, pins);
      units.set(unit, items);
      pinsByUnit.set(unit, pins);
    };
    add(0, sym);
    for (const sub of children(sym, 'symbol')) {
      const subName = atom(sub, 1);
      const us = subName == null ? null : unitOf(subName, name);
      // Style 0 is common, style 1 the base drawing; 2 and up are DeMorgan
      // alternates, which a placed symbol shows only when asked.
      if (us == null || us[1] > 1) continue;
      add(us[0], sub);
    }
    const ext = child(sym, 'extends');
    out.set(name, { units, pinsByUnit, extendsName: ext == null ? null : atom(ext, 1) });
  }
  // A derived symbol (`extends`) draws its parent's graphics. The parent is
  // named WITHOUT its library (`(extends "R")` under `Device:R_Small`), so it
  // is looked up in the derived symbol's own library first.
  const lookup = (from: string, name: string): LibSymbol | null => {
    const lib = from.slice(0, from.lastIndexOf(':') + 1);
    return out.get(`${lib}${name}`) ?? out.get(name) ?? null;
  };
  for (const [name, sym] of out) {
    let from = name;
    let parent = sym.extendsName == null ? null : lookup(from, sym.extendsName);
    let hops = 0;
    while (parent != null && hops < 8) {
      let empty = true;
      for (const [, items] of sym.units) if (items.length > 0) empty = false;
      if (!empty) break;
      sym.units = parent.units;
      sym.pinsByUnit = parent.pinsByUnit;
      from = parent.extendsName == null ? from : from;
      parent = parent.extendsName == null ? null : lookup(from, parent.extendsName);
      hops += 1;
    }
  }
  return out;
}

/** A placed symbol's frame: where a library point lands on the sheet. */
export interface Placement {
  x: number;
  y: number;
  rot: number;
  mirror: 'x' | 'y' | null;
}

/**
 * Library coordinates (y up) to sheet coordinates (y down) for a placed symbol.
 *
 * KiCad flips the library's y (paper grows downward), applies the mirror in
 * the library's frame — `(mirror x)` is a flip across the X axis, `(mirror y)`
 * across the Y axis — and then turns the result counter-clockwise on the sheet
 * by `rot`. Pinned by `sheetThumbnail.test.ts`: on Glasgow's root sheet the
 * pins of every rotated and mirrored placement land on wire ends only with
 * this order and these signs.
 */
export function placePoint(p: Pt, at: Placement): Pt {
  let x = p[0];
  let y = -p[1];
  if (at.mirror === 'x') y = -y;
  else if (at.mirror === 'y') x = -x;
  const a = (at.rot * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [at.x + x * c + y * s, at.y - x * s + y * c];
}

function readPlacement(sym: SExpr[]): Placement | null {
  const at = child(sym, 'at');
  if (at == null) return null;
  const m = child(sym, 'mirror');
  const mirror = m == null ? null : atom(m, 1);
  return { x: num(atom(at, 1)), y: num(atom(at, 2)), rot: num(atom(at, 3)), mirror: mirror === 'x' || mirror === 'y' ? mirror : null };
}

const fmt = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

function pathOf(items: Iterable<Pt[]>, closed: (i: number) => boolean): string {
  const parts: string[] = [];
  let i = 0;
  for (const pts of items) {
    if (pts.length >= 2) {
      parts.push(`M${fmt(pts[0]![0])} ${fmt(pts[0]![1])}`);
      for (let k = 1; k < pts.length; k++) parts.push(`L${fmt(pts[k]![0])} ${fmt(pts[k]![1])}`);
      if (closed(i)) parts.push('Z');
    }
    i += 1;
  }
  return parts.join('');
}

/**
 * Every placed pin's connection point on the sheet, for the transform test
 * and for anyone who wants to know where a sheet's parts connect.
 */
export function placedPins(text: string): Pt[] {
  const doc = parse(text)[0];
  if (!Array.isArray(doc)) return [];
  const lib = readLibSymbols(doc);
  const out: Pt[] = [];
  for (const sym of children(doc, 'symbol')) {
    const libId = atom(child(sym, 'lib_id') ?? [], 1);
    const at = readPlacement(sym);
    const def = libId == null ? undefined : lib.get(libId);
    if (def == null || at == null) continue;
    const unit = num(atom(child(sym, 'unit') ?? [], 1)) || 1;
    for (const u of [0, unit]) for (const p of def.pinsByUnit.get(u) ?? []) out.push(placePoint(p, at));
  }
  return out;
}

/** The thumbnail, or null for text that is not a schematic. */
export function readSheetThumbnail(text: string): SheetThumbnail | null {
  let doc: SExpr;
  try {
    doc = parse(text)[0] ?? [];
  } catch {
    return null;
  }
  if (!Array.isArray(doc) || doc[0] !== 'kicad_sch') return null;
  const [width, height] = paperSize(doc);
  const lib = readLibSymbols(doc);

  const wireRuns: Pt[][] = [];
  for (const w of children(doc, 'wire')) {
    const p = pts(w);
    if (p.length >= 2) wireRuns.push(p);
  }
  const busRuns: Pt[][] = [];
  for (const b of children(doc, 'bus')) {
    const p = pts(b);
    if (p.length >= 2) busRuns.push(p);
  }
  const junctions = children(doc, 'junction').map((j) => {
    const p = xy(child(j, 'at') ?? []);
    return { x: p[0], y: p[1] };
  });

  const symbolRuns: Pt[][] = [];
  const symbolClosed: boolean[] = [];
  let symbols = 0;
  let pins = 0;
  for (const sym of children(doc, 'symbol')) {
    const libId = atom(child(sym, 'lib_id') ?? [], 1);
    const at = readPlacement(sym);
    const def = libId == null ? undefined : lib.get(libId);
    if (def == null || at == null) continue;
    symbols += 1;
    const unit = num(atom(child(sym, 'unit') ?? [], 1)) || 1;
    for (const u of [0, unit]) {
      for (const item of def.units.get(u) ?? []) {
        symbolRuns.push(item.pts.map((p) => placePoint(p, at)));
        symbolClosed.push(item.closed);
      }
      pins += (def.pinsByUnit.get(u) ?? []).length;
    }
  }

  const sheetRuns: Pt[][] = [];
  for (const sh of children(doc, 'sheet')) {
    const at = xy(child(sh, 'at') ?? []);
    const size = xy(child(sh, 'size') ?? []);
    if (size[0] <= 0 || size[1] <= 0) continue;
    sheetRuns.push([at, [at[0] + size[0], at[1]], [at[0] + size[0], at[1] + size[1]], [at[0], at[1] + size[1]]]);
  }

  return {
    width,
    height,
    wires: pathOf(wireRuns, () => false),
    buses: pathOf(busRuns, () => false),
    symbols: pathOf(symbolRuns, (i) => symbolClosed[i] === true),
    sheets: pathOf(sheetRuns, () => true),
    junctions,
    counts: { wires: wireRuns.length, buses: busRuns.length, symbols, sheets: sheetRuns.length, pins },
  };
}
