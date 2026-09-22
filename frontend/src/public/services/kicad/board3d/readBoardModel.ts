// A .kicad_pcb's text → the BoardModel the 3D pipeline draws (spec 2026-09-21 §4).
// KiCad 6 through 9 in one reader: the dialects differ in how they SPELL a thing
// — `(tstamp …)` vs `(uuid …)`, `(fp_text reference "C1" …)` vs
// `(property "Reference" "C1" …)`, one line vs ten — never in what it means, so
// every function below reads by child NAME rather than by position, and the two
// spellings fall out as two lookups instead of two code paths.
//
// `(model …)` is never read: a 3D model path is a reference to a file on the
// author's disk and nothing here may follow it (spec §2).
import { boardBlocks, footprintField, parseBlock } from '../boardFile';
import { atom, child, children, head } from '../sexpr';
import type { SExpr } from '../types';
import { flattenThreePoint } from './arcs';
import { dist, placeShape } from './geom';
import { layerTableOf, netRowOf, sortNets } from './layerTable';
import type {
  BoardModel, FootprintModel, NetInfo, PadDrill, PadModel, PadShape,
  Placement, Shape, Side, TrackModel, Vec2, ViaModel, ZoneFill,
} from './types';

const PAD_KINDS: readonly PadModel['kind'][] = ['smd', 'thru_hole', 'np_thru_hole', 'connect'];
const PAD_SHAPES: readonly PadShape[] = ['circle', 'oval', 'rect', 'roundrect', 'trapezoid', 'custom'];
const FP_GRAPHICS = ['fp_line', 'fp_arc', 'fp_circle', 'fp_rect', 'fp_poly'];
const TOP_HEADS = new Set(['version', 'layers', 'net', 'footprint', 'via', 'segment', 'arc', 'zone']);

// ── atoms ───────────────────────────────────────────────────────────────────

/** The number at `index`, or 0 — a missing coordinate is the origin, not NaN. */
function num(node: SExpr[] | undefined, index: number): number {
  const raw = node == null ? null : atom(node, index);
  const value = raw == null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function str(node: SExpr[] | undefined, index = 1): string | null {
  return node == null ? null : atom(node, index);
}

/** `(start x y)`, `(at x y …)`, `(xy x y)` — all the same two numbers. */
function pt(node: SExpr[] | undefined): Vec2 {
  return { x: num(node, 1), y: num(node, 2) };
}

function ptsOf(node: SExpr[]): Vec2[] {
  const pts = child(node, 'pts');
  return pts == null ? [] : children(pts, 'xy').map((xy) => pt(xy));
}

// ── nets ────────────────────────────────────────────────────────────────────

/**
 * Every item's net resolves through ONE table. KiCad 6–9 write `(net 3)` on a
 * track and `(net 3 "GND")` on a pad, both numbers into the board's top-level
 * table; a writer that names the net instead (`(net "GND")`, with no table to
 * number it) is resolved by name, and a name the table lacks is ADDED to it
 * under the next free number — so a net an item names is always a row of
 * `BoardModel.nets`, and the 3D view can name what it highlights. A number the
 * table lacks (a hand-edited file) is kept as written: it still highlights.
 */
class NetTable {
  private readonly rows: NetInfo[] = [];
  private readonly byName = new Map<string, number>();
  private readonly numbers = new Set<number>();
  private next = 1;

  addRow(row: NetInfo): void {
    if (this.numbers.has(row.number)) return;
    this.rows.push(row);
    this.numbers.add(row.number);
    if (!this.byName.has(row.name)) this.byName.set(row.name, row.number);
    this.next = Math.max(this.next, row.number + 1);
  }

  /** The item's `(net …)` as a number; 0 when it has none. */
  of(node: SExpr[]): number {
    const net = child(node, 'net');
    const raw = net == null ? null : atom(net, 1);
    if (raw == null) return 0;
    const number = Number(raw);
    if (/^\d+$/.test(raw) && Number.isSafeInteger(number)) return number;
    if (raw === '') return 0;
    const known = this.byName.get(raw);
    if (known != null) return known;
    const added = this.next;
    this.addRow({ number: added, name: raw });
    return added;
  }

  list(): NetInfo[] {
    return sortNets([...this.rows]);
  }
}

// ── layers ──────────────────────────────────────────────────────────────────

/**
 * `*.Cu` means every copper layer THIS board declares (two on a 2-layer board,
 * four on Glasgow), and any other `*.X` means both sides of X. Expanding against
 * the board's own table is why the layer block is read before any footprint —
 * which every KiCad writer emits in that order.
 */
function expandLayers(node: SExpr[], copperNames: string[]): string[] {
  const block = child(node, 'layers');
  if (block == null) return [];
  const out: string[] = [];
  for (let i = 1; i < block.length; i++) {
    const name = atom(block, i);
    if (name == null) continue;
    if (name === '*.Cu') out.push(...copperNames);
    else if (name.startsWith('*.')) out.push(`F.${name.slice(2)}`, `B.${name.slice(2)}`);
    else out.push(name);
  }
  return out;
}

// ── graphics ────────────────────────────────────────────────────────────────

/** KiCad 5/6 wrote `(width w)` directly; 7+ wrap it in `(stroke (width w) …)`. */
function widthOf(node: SExpr[]): number {
  const stroke = child(node, 'stroke');
  return stroke == null ? num(child(node, 'width'), 1) : num(child(stroke, 'width'), 1);
}

/** `(fill solid)` is the old spelling of `(fill yes)`; anything else is hollow. */
function filledOf(node: SExpr[]): boolean {
  const fill = child(node, 'fill');
  const value = fill == null ? null : atom(fill, 1);
  return value === 'solid' || value === 'yes';
}

/** `fp_*` and `gr_*` share one geometry vocabulary; only the prefix differs. */
function shapeOf(node: SExpr[]): Shape | null {
  const width = widthOf(node);
  switch ((head(node) ?? '').replace(/^(?:fp|gr)_/, '')) {
    case 'line':
      return { kind: 'line', a: pt(child(node, 'start')), b: pt(child(node, 'end')), width };
    case 'arc':
      return { kind: 'arc', a: pt(child(node, 'start')), mid: pt(child(node, 'mid')), b: pt(child(node, 'end')), width };
    case 'circle': {
      const c = pt(child(node, 'center'));
      return { kind: 'circle', c, r: dist(c, pt(child(node, 'end'))), width, filled: filledOf(node) };
    }
    case 'rect':
      return { kind: 'rect', a: pt(child(node, 'start')), b: pt(child(node, 'end')), width, filled: filledOf(node) };
    case 'poly': {
      const pts = ptsOf(node);
      return pts.length >= 3 ? { kind: 'poly', pts, width, filled: filledOf(node) } : null;
    }
    default:
      return null;      // gr_text, gr_curve, gr_bbox … nothing this pipeline draws
  }
}

// ── footprints ──────────────────────────────────────────────────────────────

/** `(drill d)`, `(drill oval w h)`; a slot's `d` is its narrow dimension. */
function readDrill(node: SExpr[]): PadDrill | null {
  const drill = child(node, 'drill');
  if (drill == null) return null;
  if (atom(drill, 1) === 'oval') {
    const w = num(drill, 2), h = num(drill, 3);
    return w > 0 && h > 0 ? { d: Math.min(w, h), slotW: w, slotH: h } : null;
  }
  const d = num(drill, 1);
  return d > 0 ? { d } : null;
}

function readPad(node: SExpr[], ref: string, copperNames: string[], nets: NetTable): PadModel {
  const at = child(node, 'at');
  const size = child(node, 'size');
  const rratio = child(node, 'roundrect_rratio');
  const kindToken = atom(node, 2), shapeToken = atom(node, 3);
  return {
    ref,
    number: atom(node, 1) ?? '',
    kind: PAD_KINDS.find((k) => k === kindToken) ?? 'smd',
    shape: PAD_SHAPES.find((s) => s === shapeToken) ?? 'rect',
    at: pt(at),
    rotDeg: num(at, 3),
    size: { x: num(size, 1), y: num(size, 2) },
    rratio: rratio == null ? null : num(rratio, 1),
    layers: expandLayers(node, copperNames),
    drill: readDrill(node),
    net: nets.of(node),
  };
}

/**
 * `edgeOut` collects the footprint's own Edge.Cuts graphics, PLACED on the
 * board: KiCad counts a footprint's outline, slot or notch as part of the board
 * edge (connector cut-outs, outline footprints), so they belong beside the
 * gr_* edge items, not in the footprint.
 */
function readFootprint(node: SExpr[], copperNames: string[], edgeOut: Shape[], nets: NetTable): FootprintModel {
  const at = child(node, 'at');
  const side: Side = str(child(node, 'layer')) === 'B.Cu' ? 'B' : 'F';
  const place: Placement = { at: pt(at), rotDeg: num(at, 3), side };
  const ref = footprintField(node, 'reference') ?? '';
  const courtyard: Shape[] = [], silk: Shape[] = [];
  for (const item of node) {
    if (!Array.isArray(item) || !FP_GRAPHICS.includes(head(item) ?? '')) continue;
    const layer = str(child(item, 'layer'));
    if (layer === 'Edge.Cuts') {
      const edge = shapeOf(item);
      if (edge != null) edgeOut.push(placeShape(edge, place));
      continue;
    }
    const bucket = layer === `${side}.CrtYd` ? courtyard : layer === `${side}.SilkS` ? silk : null;
    const shape = bucket == null ? null : shapeOf(item);
    if (shape != null) bucket?.push(shape);
  }
  return { ref, lib: atom(node, 1) ?? '', place, pads: children(node, 'pad').map((p) => readPad(p, ref, copperNames, nets)), courtyard, silk };
}

// ── the rest of the board ───────────────────────────────────────────────────

function readVia(node: SExpr[], nets: NetTable): ViaModel | null {
  const layers = child(node, 'layers');
  const from = str(layers, 1), to = str(layers, 2);
  if (from == null || to == null) return null;
  return { at: pt(child(node, 'at')), size: num(child(node, 'size'), 1), drill: num(child(node, 'drill'), 1), layers: [from, to], net: nets.of(node) };
}

function readSegment(node: SExpr[], nets: NetTable): TrackModel | null {
  const layer = str(child(node, 'layer'));
  if (layer == null) return null;
  return { layer, width: num(child(node, 'width'), 1), pts: [pt(child(node, 'start')), pt(child(node, 'end'))], net: nets.of(node) };
}

/** A KiCad 7+ curved track. Flattened here so every TrackModel is a polyline. */
function readArcTrack(node: SExpr[], tolMm: number, nets: NetTable): { track: TrackModel | null; degenerate: boolean } {
  const layer = str(child(node, 'layer'));
  if (layer == null) return { track: null, degenerate: false };
  const flat = flattenThreePoint(pt(child(node, 'start')), pt(child(node, 'mid')), pt(child(node, 'end')), tolMm);
  return { track: { layer, width: num(child(node, 'width'), 1), pts: flat.pts, net: nets.of(node) }, degenerate: flat.degenerate };
}

/** A zone states one `(layer …)` or several `(layers …)`; its fills say which. */
function zoneLayerNames(node: SExpr[]): string[] {
  const one = str(child(node, 'layer'));
  if (one != null) return [one];
  const many = child(node, 'layers');
  if (many == null) return [];
  const out: string[] = [];
  for (let i = 1; i < many.length; i++) {
    const name = atom(many, i);
    if (name != null) out.push(name);
  }
  return out;
}

/**
 * One ZoneFill per `filled_polygon`, on ITS own layer — a zone spanning F.Cu and
 * B.Cu writes one polygon per side. `unfilled` is only ever true for a real
 * copper POUR: a keepout writes `(fill (thermal_gap …))` with no `yes`, has
 * nothing to fill, and must not raise "saved unfilled" — and neither may a zone
 * on a non-copper layer (a mask or silk zone, which the 3D view never draws),
 * or the caption would report copper pours the board does not have.
 */
function readZone(node: SExpr[], nets: NetTable): { fills: ZoneFill[]; unfilled: boolean } {
  const names = zoneLayerNames(node);
  const fallback = names[0] ?? '';
  // `F&B.Cu` is KiCad 7+'s spelling of a two-sided zone.
  const onCopper = names.some((n) => n.endsWith('.Cu'));
  const net = nets.of(node);
  const fills: ZoneFill[] = [];
  for (const poly of children(node, 'filled_polygon')) {
    const pts = ptsOf(poly);
    if (pts.length >= 3) fills.push({ layer: str(child(poly, 'layer')) ?? fallback, ring: { pts }, net });
  }
  const fill = child(node, 'fill');
  const pours = fill == null || atom(fill, 1) === 'yes';
  return { fills, unfilled: onCopper && pours && fills.length === 0 };
}

function readGraphic(node: SExpr[], model: BoardModel): void {
  const layer = str(child(node, 'layer'));
  const shape = layer == null ? null : shapeOf(node);
  if (shape == null || layer == null) return;
  if (layer === 'Edge.Cuts') model.edgeItems.push(shape);
  else if (layer === 'F.SilkS' || layer === 'B.SilkS') model.silk.push({ layer, shape });
}

// ── the reader ──────────────────────────────────────────────────────────────

export function readBoardModel(text: string, tolMm: number): BoardModel {
  const blocks = boardBlocks(text);
  const model: BoardModel = {
    version: 0, layers: [], edgeItems: [], footprints: [], vias: [], tracks: [],
    zones: [], zonesUnfilled: 0, silk: [], warnings: [], nets: [],
  };
  const copperNames: string[] = [];
  const nets = new NetTable();
  let degenerate = 0;

  for (const block of blocks) {
    if (!TOP_HEADS.has(block.head) && !block.head.startsWith('gr_')) continue;
    const node = parseBlock(text, block);
    if (node == null) continue;
    switch (block.head) {
      case 'version':
        model.version = num(node, 1);
        break;
      case 'layers':
        model.layers = layerTableOf(node);
        for (const l of model.layers) if (l.kind === 'copper') copperNames.push(l.name);
        break;
      case 'net': {
        const row = netRowOf(node);
        if (row != null) nets.addRow(row);
        break;
      }
      case 'footprint':
        model.footprints.push(readFootprint(node, copperNames, model.edgeItems, nets));
        break;
      case 'via': {
        const via = readVia(node, nets);
        if (via != null) model.vias.push(via);
        break;
      }
      case 'segment': {
        const track = readSegment(node, nets);
        if (track != null) model.tracks.push(track);
        break;
      }
      case 'arc': {
        const read = readArcTrack(node, tolMm, nets);
        if (read.track != null) model.tracks.push(read.track);
        if (read.degenerate) degenerate++;
        break;
      }
      case 'zone': {
        const zone = readZone(node, nets);
        model.zones.push(...zone.fills);
        if (zone.unfilled) model.zonesUnfilled++;
        break;
      }
      default:
        readGraphic(node, model);
    }
  }

  model.nets = nets.list();
  if (degenerate > 0) model.warnings.push({ kind: 'arc-degenerate', count: degenerate });
  if (model.zonesUnfilled > 0) model.warnings.push({ kind: 'zones-unfilled', count: model.zonesUnfilled });
  return model;
}
