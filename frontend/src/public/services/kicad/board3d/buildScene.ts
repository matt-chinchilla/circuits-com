// BoardModel + BoardStackup → the BoardScene a renderer draws (spec 2026-09-21 §4).
// The last pure step: everything above speaks KiCad millimetres on a y-DOWN page,
// everything below speaks typed arrays in a y-up model centred on the origin.
//
// Two rules govern the whole file. (1) Nothing is measured that the board did not
// state — `thicknessMm` is the stackup reader's listed sum or null, and every
// simplification this file makes is COUNTED into a warning rather than hidden.
// (2) A group is one draw call, so geometry is merged per (material, layer) and
// never per pad or per track.
import type { BoardStackup, KicadReadErrorKind } from '../types';
import { courtyards } from './courtyards';
import { bbox, place } from './geom';
import { zLadder } from './layers';
import { boardOutline, shapePolylines } from './outline';
import { ringContains, ringsOverlap } from './overlap';
import { drillRing, placedPadRing } from './pads';
import { circleRing, strokePolygon } from './strokes';
import { readBoardModel } from './readBoardModel';
import { MeshBuilder } from './tessellate';
import {
  TOL_MM, type BoardModel, type BoardScene, type BoardWarning, type Material,
  type MeshGroup, type PartRange, type Placement, type Quality, type Ring, type Shape, type Side, type Vec2,
} from './types';

export interface BuildInput { text: string; stackup: BoardStackup | null; quality: Quality }

/**
 * The worker's answer. Declared HERE rather than in `worker.ts` on purpose: the
 * hook needs the type, and importing it from the worker module — even as a type —
 * puts the worker's own import graph one careless edit away from the main bundle.
 * `BuildInput` and `BuildReply` are the two halves of one wire protocol, so they
 * live together.
 */
export type BuildReply =
  | { ok: true; scene: BoardScene }
  | { ok: false; message: string; kind: KicadReadErrorKind | 'error' };

/** Mask sits this far off the outer copper, and silk this far off the mask. Not a
 *  measurement — a z-fighting separation, two orders under the thinnest real layer. */
const LAYER_GAP_MM = 0.01;
/** `reduced` drops tracks finer than this: they are sub-pixel at any framing that
 *  fits a whole board on a phone, and they are the bulk of the stroke count. */
const MIN_TRACK_MM = 0.2;

/**
 * How many holes, and how many hole vertices, ONE flat face may carry. earcut
 * bridges every hole into the outer ring by scanning that ring, which grows as
 * holes join it, so a face costs O(holes × vertices): measured on a grid of
 * 0.3 mm vias, 1,000 holes 0.96 s, 2,000 4.0 s, 4,000 17.6 s, 8,000 94.8 s
 * (the whole build, `reduced`). Glasgow's busiest face (F.Mask) is 1,317
 * openings / 35.6k vertices, so it sits inside both and draws exactly as before.
 * Past the budget, the SMALLEST holes are drawn without cutting: a drill as a
 * dark mark on the mask, a pad opening as the pad raised just above the mask —
 * both read the same from any angle a reader can orbit to, and both are counted
 * into the caption's "features simplified".
 */
export const FACE_HOLE_BUDGET = { holes: 1500, vertices: 40_000 };

interface Box { min: Vec2; max: Vec2 }
interface Boxed { ring: Ring; box: Box; area: number }

const boxArea = (b: Box): number => Math.max(0, b.max.x - b.min.x) * Math.max(0, b.max.y - b.min.y);

/**
 * The boxes are only a REJECT — cached here because the pruning below is
 * quadratic and most pairs on a board are nowhere near each other. A pair whose
 * boxes do meet goes to `ringsOverlap`, which answers on the rings themselves.
 */
function overlapping(a: Boxed, b: Boxed): boolean {
  if (a.box.max.x <= b.box.min.x || b.box.max.x <= a.box.min.x) return false;
  if (a.box.max.y <= b.box.min.y || b.box.max.y <= a.box.min.y) return false;
  return ringsOverlap(a.ring, b.ring);
}

const boxed = (ring: Ring): Boxed => {
  const box = bbox(ring.pts);
  return { ring, box, area: boxArea(box) };
};

/**
 * Largest ring first, then greedily accept: a ring that overlaps one already
 * accepted is DROPPED and counted. v1 has no polygon-clipping library, so the
 * union of two overlapping holes is approximated by the bigger of the two —
 * which is why the count is surfaced as "N features simplified" rather than
 * swallowed. Two things make the count honest. "Overlaps" is a TRUE ring
 * intersection (`overlap.ts`), not the bounding-box rule this used to apply;
 * and a ring wholly CONTAINED in the one it loses to is dropped SILENTLY,
 * because the union of the two is exactly the ring that was kept — nothing was
 * approximated, so nothing is reported. All 126 of Glasgow's merged pad
 * openings are that case (a fine-pitch pad inside a footprint's large one, or
 * two coincident pads), which is why the caption used to claim 134
 * simplifications on a board where the only real one was 8 missing courtyards.
 */
function prune(rings: Ring[]): { kept: Boxed[]; dropped: number } {
  const items = rings.filter((r) => r.pts.length >= 3).map(boxed).sort((a, b) => b.area - a.area);
  const kept = new BoxIndex();
  let dropped = 0;
  for (const item of items) {
    // The FIRST kept ring it overlaps, in keep order (largest first) — the same
    // answer a linear scan gives, from the few rings whose boxes share a cell.
    const hit = kept.near(item.box).find((k) => overlapping(item, k));
    if (hit == null) kept.add(item);
    else if (!ringContains(hit.ring, item.ring)) dropped++;
  }
  return { kept: kept.all, dropped };
}

/**
 * A uniform grid over ring boxes, so an overlap query looks at neighbours rather
 * than at every ring kept so far — the linear scan made `prune` quadratic, which
 * a board of tens of thousands of vias turns into minutes. A box spanning more
 * than a handful of cells (a board cutout) goes in a short `wide` list instead
 * of into hundreds of cells. Answers come back in insertion order.
 */
class BoxIndex {
  readonly all: Boxed[] = [];
  private readonly cells = new Map<string, number[]>();
  private readonly wide: number[] = [];
  private static readonly CELL_MM = 2;
  private static readonly MAX_CELLS = 16;

  private span(b: Box): { x0: number; x1: number; y0: number; y1: number } {
    const c = BoxIndex.CELL_MM;
    return { x0: Math.floor(b.min.x / c), x1: Math.floor(b.max.x / c), y0: Math.floor(b.min.y / c), y1: Math.floor(b.max.y / c) };
  }

  add(item: Boxed): void {
    const id = this.all.push(item) - 1;
    const s = this.span(item.box);
    if ((s.x1 - s.x0 + 1) * (s.y1 - s.y0 + 1) > BoxIndex.MAX_CELLS) {
      this.wide.push(id);
      return;
    }
    for (let x = s.x0; x <= s.x1; x++) {
      for (let y = s.y0; y <= s.y1; y++) {
        const key = `${x},${y}`;
        const cell = this.cells.get(key);
        if (cell == null) this.cells.set(key, [id]);
        else cell.push(id);
      }
    }
  }

  near(box: Box): Boxed[] {
    const ids = new Set<number>(this.wide);
    const s = this.span(box);
    // A query box as wide as a cutout reads every cell it covers; that is at
    // most the cells anything was ever put in.
    if ((s.x1 - s.x0 + 1) * (s.y1 - s.y0 + 1) > this.cells.size) {
      for (const cell of this.cells.values()) for (const id of cell) ids.add(id);
    } else {
      for (let x = s.x0; x <= s.x1; x++) {
        for (let y = s.y0; y <= s.y1; y++) for (const id of this.cells.get(`${x},${y}`) ?? []) ids.add(id);
      }
    }
    return [...ids].sort((a, b) => a - b).map((id) => this.all[id]);
  }
}

/**
 * Split rings (largest first) into the ones a face can afford to cut and the
 * rest, under FACE_HOLE_BUDGET. Largest first, so board cutouts and connector
 * drills are always real holes and it is the 0.3 mm vias that give way.
 */
function withinBudget<T extends { ring: Ring; area: number }>(items: T[]): { cut: T[]; over: T[] } {
  const sorted = [...items].sort((a, b) => b.area - a.area);
  const cut: T[] = [], over: T[] = [];
  let vertices = 0;
  for (const item of sorted) {
    const n = item.ring.pts.length;
    if (cut.length < FACE_HOLE_BUDGET.holes && vertices + n <= FACE_HOLE_BUDGET.vertices) {
      cut.push(item);
      vertices += n;
    } else {
      over.push(item);
    }
  }
  return { cut, over };
}

/**
 * The rings of `items` that no ring in `against` already covers. Used for the
 * mask, where a through-hole pad's opening SUBSUMES its own drill: that is not a
 * simplification of anything, so it is filtered silently — and filtering it is
 * what keeps a hole from being nested inside another hole, which earcut does not
 * model.
 */
function withoutOverlaps(items: Boxed[], against: Boxed[]): Boxed[] {
  const index = new BoxIndex();
  for (const a of against) index.add(a);
  return items.filter((i) => !index.near(i.box).some((a) => overlapping(i, a)));
}

/** A closed shape's polyline repeats its first point; a ring must not. */
function closedRing(pts: Vec2[]): Ring {
  if (pts.length > 1) {
    const first = pts[0], last = pts[pts.length - 1];
    if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) return { pts: pts.slice(0, -1) };
  }
  return { pts };
}

/**
 * One silkscreen shape as a flat face. Filled circles/rects/polys become the
 * shape itself; everything else becomes its stroked outline, so an unfilled
 * circle draws as a ring rather than a disc. A zero-width stroke is SKIPPED
 * rather than given an invented width — it would only add degenerate triangles.
 */
function addSilkShape(
  builder: MeshBuilder, shape: Shape, pl: Placement | null, z: number, up: boolean, tolMm: number, caps: number,
): void {
  const { polylines } = shapePolylines([shape], tolMm);
  const filled = (shape.kind === 'circle' || shape.kind === 'rect' || shape.kind === 'poly') && shape.filled;
  for (const raw of polylines) {
    const pts = pl == null ? raw : raw.map((p) => place(p, pl));
    if (filled) {
      const ring = closedRing(pts);
      if (ring.pts.length >= 3) builder.addFace({ outer: ring, holes: [] }, z, up);
    } else if (shape.width > 0) {
      builder.addFace({ outer: strokePolygon(pts, shape.width, caps), holes: [] }, z, up);
    }
  }
}

/** Where the board's copper is — the box a board with no outline is drawn in. */
function contentPoints(model: BoardModel): Vec2[] {
  const out: Vec2[] = [];
  for (const fp of model.footprints) for (const pad of fp.pads) out.push(place(pad.at, fp.place));
  for (const via of model.vias) out.push(via.at);
  for (const track of model.tracks) out.push(...track.pts);
  for (const zone of model.zones) out.push(...zone.ring.pts);
  return out;
}

export function buildScene(input: BuildInput): BoardScene {
  const startedAt = performance.now();
  const model = readBoardModel(input.text, TOL_MM[input.quality]);
  return buildSceneFromModel(model, input.stackup, input.quality, startedAt);
}

/**
 * `startedAt` exists so `buildScene` can report the time the READER took as part
 * of `buildMs` — the number the caption shows is what the visitor waited for, not
 * what the tessellator alone cost.
 */
export function buildSceneFromModel(
  model: BoardModel, stackup: BoardStackup | null, quality: Quality, startedAt = performance.now(),
): BoardScene {
  const tol = TOL_MM[quality];
  const caps = quality === 'full' ? 8 : 4;
  const warnings: BoardWarning[] = [];

  // The reader already counted its own degenerate arcs; the outline adds more, and
  // one warning carries the total rather than two carrying halves of it.
  let degenerateArcs = 0;
  for (const w of model.warnings) {
    if (w.kind === 'arc-degenerate') degenerateArcs += w.count;
    else warnings.push(w);
  }

  const outline = boardOutline(model.edgeItems, tol, model.edgeItems.length > 0 ? [] : contentPoints(model));
  degenerateArcs += outline.degenerateArcs;
  if (outline.open) warnings.push({ kind: 'outline-open', segments: outline.unchained });

  const ladder = zLadder(model.layers, stackup);
  if (ladder.warning != null) warnings.push(ladder.warning);

  // Read the z bands off the ladder BY NAME. The outer copper is what fixes every
  // other height: the substrate is the dielectric BETWEEN the two copper bands
  // (never down to 0, which would bury the back copper inside the slab), the mask
  // sits just outside each copper face, and a hole is drilled through the lot.
  const bandOf = (name: string) => ladder.layers.find((l) => l.name === name) ?? null;
  const top = bandOf('F.Cu'), bottom = bandOf('B.Cu');
  const copperZ: Record<Side, number> = {
    F: top?.z1 ?? ladder.substrateTop,
    B: bottom?.z0 ?? ladder.substrateBottom,
  };
  const substrateHi = top?.z0 ?? ladder.substrateTop;
  const substrateLo = bottom?.z1 ?? ladder.substrateBottom;
  const maskZ: Record<Side, number> = { F: copperZ.F + LAYER_GAP_MM, B: copperZ.B - LAYER_GAP_MM };
  const silkZ: Record<Side, number> = { F: maskZ.F + LAYER_GAP_MM, B: maskZ.B - LAYER_GAP_MM };

  // Centre and bounds are both in MODEL space: the geometry is recentred, so a
  // camera framed on the board's own coordinates would look where it used to be.
  const board = bbox(outline.outer.pts);
  const centre: Vec2 = { x: (board.min.x + board.max.x) / 2, y: (board.min.y + board.max.y) / 2 };
  const half: Vec2 = { x: (board.max.x - board.min.x) / 2, y: (board.max.y - board.min.y) / 2 };
  const bounds = { min: { x: -half.x, y: -half.y }, max: { x: half.x, y: half.y } };

  const holeRings: Ring[] = [...outline.cutouts];
  for (const via of model.vias) if (via.drill > 0) holeRings.push(circleRing(via.at, via.drill / 2, tol));
  for (const fp of model.footprints) {
    for (const pad of fp.pads) {
      const ring = drillRing(pad, fp.place, tol);
      if (ring != null) holeRings.push(ring);
    }
  }
  const holes = prune(holeRings);
  let holesMerged = holes.dropped;
  // The slab's budget decides which drills are REAL holes (through slab and
  // both masks, walled); the rest are marked on both mask faces.
  const slabHoles = withinBudget(holes.kept);
  let holesMarked = slabHoles.over.length;
  const marks: Record<Side, Ring[]> = { F: slabHoles.over.map((h) => h.ring), B: slabHoles.over.map((h) => h.ring) };

  const groups: MeshGroup[] = [];
  const builder = () => new MeshBuilder(true, centre);
  const emit = (b: MeshBuilder, material: Material, layerName: string | null, parts?: PartRange[]): void => {
    if (b.indices.length === 0) return;
    const group = b.build(material, layerName);
    if (parts != null && parts.length > 0) group.parts = parts;
    groups.push(group);
  };
  /** Run `draw` and record which slice of the builder's indices it produced for
   *  `ref` — a picker's map from a hit triangle back to a footprint. An empty
   *  slice (a footprint with no pads on this layer) records nothing. */
  const ranged = (b: MeshBuilder, parts: PartRange[], ref: string, draw: () => void): void => {
    const start = b.indices.length;
    draw();
    const count = b.indices.length - start;
    if (count > 0) parts.push({ ref, start, count });
  };

  // Substrate: capped top and bottom, walled around the outline. The hole walls go
  // into their OWN group — they are the one surface the eye reads as thickness, and
  // the theme darkens them, so they cannot share the slab's material.
  const keptHoles = slabHoles.cut.map((h) => h.ring);
  const slab = { outer: outline.outer, holes: keptHoles };
  const substrate = builder();
  substrate.addFace(slab, substrateHi, true);
  substrate.addFace(slab, substrateLo, false);
  substrate.addWalls(outline.outer, substrateLo, substrateHi, true);
  emit(substrate, 'substrate', null);

  const walls = builder();
  for (const hole of keptHoles) walls.addWalls(hole, copperZ.B, copperZ.F, false);
  emit(walls, 'hole-wall', null);

  const sides: Side[] = ['F', 'B'];
  for (const side of sides) {
    const cuName = `${side}.Cu`;
    const up = side === 'F';
    const z = copperZ[side];

    // Computed once and used twice: the copper slab draws these, and the mask
    // subtracts the same rings as its openings. Pads are drawn FIRST and per
    // footprint, so each footprint's pads are one contiguous slice of the group's
    // indices — the range a pick maps a hit triangle back through.
    const padRings: Ring[] = [];
    const ringsOf = model.footprints.map((fp) => {
      const rings: Ring[] = [];
      for (const pad of fp.pads) {
        if (!pad.layers.includes(cuName) || !(pad.size.x > 0) || !(pad.size.y > 0)) continue;
        rings.push(placedPadRing(pad, fp.place, tol));
      }
      padRings.push(...rings);
      return rings;
    });

    // The mask's cuts, decided BEFORE the copper is drawn: an opening the face
    // cannot afford is drawn as its pad raised just above the mask instead.
    const openings = prune(padRings);
    holesMerged += openings.dropped;
    type Cut = Boxed & { pad: boolean };
    const drills = withoutOverlaps(slabHoles.cut, openings.kept);
    const maskCuts = withinBudget<Cut>([
      ...openings.kept.map((o) => ({ ...o, pad: true })),
      ...drills.map((d) => ({ ...d, pad: false })),
    ]);
    const raised = new Set<Ring>();
    for (const item of maskCuts.over) {
      if (item.pad) raised.add(item.ring);
      else marks[side].push(item.ring);
    }
    holesMarked += maskCuts.over.length;
    const raisedZ = up ? maskZ[side] + LAYER_GAP_MM / 2 : maskZ[side] - LAYER_GAP_MM / 2;

    const copper = builder();
    const padParts: PartRange[] = [];
    model.footprints.forEach((fp, i) => {
      ranged(copper, padParts, fp.ref, () => {
        for (const ring of ringsOf[i]) copper.addFace({ outer: ring, holes: [] }, raised.has(ring) ? raisedZ : z, up);
      });
    });
    for (const track of model.tracks) {
      if (track.layer !== cuName || !(track.width > 0)) continue;
      if (quality === 'reduced' && track.width < MIN_TRACK_MM) continue;
      copper.addFace({ outer: strokePolygon(track.pts, track.width, caps), holes: [] }, z, up);
    }
    for (const zone of model.zones) {
      if (zone.layer === cuName) copper.addFace({ outer: zone.ring, holes: [] }, z, up);
    }
    emit(copper, 'copper', cuName, padParts);

    const mask = builder();
    mask.addFace({ outer: outline.outer, holes: maskCuts.cut.map((c) => c.ring) }, maskZ[side], up);
    emit(mask, 'mask', `${side}.Mask`);
  }

  // The marks: each an independent small disc just outside the mask, drawn in
  // the hole-wall material — what the eye reads looking into a drill.
  for (const side of sides) {
    if (marks[side].length === 0) continue;
    const up = side === 'F';
    const markZ = up ? maskZ[side] + LAYER_GAP_MM / 2 : maskZ[side] - LAYER_GAP_MM / 2;
    const markMesh = builder();
    for (const ring of marks[side]) markMesh.addFace({ outer: ring, holes: [] }, markZ, up);
    emit(markMesh, 'hole-wall', `${side}.Marks`);
  }

  for (const side of sides) {
    const name = `${side}.SilkS`;
    const up = side === 'F';
    const silk = builder();
    for (const item of model.silk) {
      if (item.layer === name) addSilkShape(silk, item.shape, null, silkZ[side], up, tol, caps);
    }
    for (const fp of model.footprints) {
      if (fp.place.side !== side) continue;
      for (const shape of fp.silk) addSilkShape(silk, shape, fp.place, silkZ[side], up, tol, caps);
    }
    emit(silk, 'silk', name);
  }

  // Bodies are the one group `reduced` drops whole: they are the most triangles
  // per pixel on the board, and a phone reads the copper long before it reads a
  // 0402's 0.6 mm block. Skipping the courtyard pass there also skips its warning
  // — nothing was simplified, because nothing was attempted.
  if (quality === 'full') {
    const { bodies, missing } = courtyards(model, tol);
    const bodyMesh = builder();
    const bodyParts: PartRange[] = [];
    for (const body of bodies) {
      const base = maskZ[body.side];
      ranged(bodyMesh, bodyParts, body.ref, () => {
        bodyMesh.addPrism({ outer: body.ring, holes: [] }, base, body.side === 'F' ? base + body.heightMm : base - body.heightMm);
      });
    }
    emit(bodyMesh, 'body', null, bodyParts);
    if (missing > 0) warnings.push({ kind: 'no-courtyard', count: missing });
  }

  if (holesMerged > 0) warnings.push({ kind: 'holes-merged', count: holesMerged });
  if (holesMarked > 0) warnings.push({ kind: 'holes-marked', count: holesMarked });
  if (degenerateArcs > 0) warnings.push({ kind: 'arc-degenerate', count: degenerateArcs });

  let triangles = 0;
  for (const g of groups) triangles += g.indices.length / 3;
  return {
    bounds,
    thicknessMm: ladder.thicknessMm,
    groups,
    warnings,
    stats: {
      footprints: model.footprints.length,
      pads: model.footprints.reduce((n, f) => n + f.pads.length, 0),
      vias: model.vias.length,
      tracks: model.tracks.length,
      triangles,
      buildMs: performance.now() - startedAt,
    },
  };
}

/** Every typed array's buffer, for `postMessage`'s transfer list: the scene moves
 *  to the renderer's thread instead of being structured-cloned. */
export function transferList(scene: BoardScene): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const g of scene.groups) {
    out.push(g.positions.buffer as ArrayBuffer, g.normals.buffer as ArrayBuffer, g.indices.buffer as ArrayBuffer);
  }
  return out;
}
