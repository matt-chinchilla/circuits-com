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
import { drillRing, placedPadRing } from './pads';
import { circleRing, strokePolygon } from './strokes';
import { readBoardModel } from './readBoardModel';
import { MeshBuilder } from './tessellate';
import {
  TOL_MM, type BoardModel, type BoardScene, type BoardWarning, type Material,
  type MeshGroup, type Placement, type Quality, type Ring, type Shape, type Side, type Vec2,
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
/** A ring covering more than this fraction of a smaller neighbour's box is the
 *  same hole twice (a via landing on a pad drill) — the realistic overlap. */
const OVERLAP_FRACTION = 0.25;

interface Box { min: Vec2; max: Vec2 }
interface Boxed { ring: Ring; box: Box; area: number }

const boxArea = (b: Box): number => Math.max(0, b.max.x - b.min.x) * Math.max(0, b.max.y - b.min.y);

function overlapping(a: Boxed, b: Boxed): boolean {
  const w = Math.min(a.box.max.x, b.box.max.x) - Math.max(a.box.min.x, b.box.min.x);
  const h = Math.min(a.box.max.y, b.box.max.y) - Math.max(a.box.min.y, b.box.min.y);
  if (w <= 0 || h <= 0) return false;
  return w * h > OVERLAP_FRACTION * Math.min(a.area, b.area);
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
 * swallowed. Bounding boxes only: exact ring intersection would cost more than
 * the artefact it prevents.
 */
function prune(rings: Ring[]): { kept: Boxed[]; dropped: number } {
  const items = rings.filter((r) => r.pts.length >= 3).map(boxed).sort((a, b) => b.area - a.area);
  const kept: Boxed[] = [];
  let dropped = 0;
  for (const item of items) {
    if (kept.some((k) => overlapping(item, k))) dropped++;
    else kept.push(item);
  }
  return { kept, dropped };
}

/**
 * The rings of `items` that no ring in `against` already covers. Used for the
 * mask, where a through-hole pad's opening SUBSUMES its own drill: that is not a
 * simplification of anything, so it is filtered silently — and filtering it is
 * what keeps a hole from being nested inside another hole, which earcut does not
 * model.
 */
function withoutOverlaps(items: Boxed[], against: Boxed[]): Ring[] {
  return items.filter((i) => !against.some((a) => overlapping(i, a))).map((i) => i.ring);
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

  const outline = boardOutline(model.edgeItems, tol);
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

  const groups: MeshGroup[] = [];
  const builder = () => new MeshBuilder(true, centre);
  const emit = (b: MeshBuilder, material: Material, layerName: string | null): void => {
    if (b.indices.length > 0) groups.push(b.build(material, layerName));
  };

  // Substrate: capped top and bottom, walled around the outline. The hole walls go
  // into their OWN group — they are the one surface the eye reads as thickness, and
  // the theme darkens them, so they cannot share the slab's material.
  const keptHoles = holes.kept.map((h) => h.ring);
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
    // subtracts the same rings as its openings.
    const padRings: Ring[] = [];
    for (const fp of model.footprints) {
      for (const pad of fp.pads) {
        if (!pad.layers.includes(cuName) || !(pad.size.x > 0) || !(pad.size.y > 0)) continue;
        padRings.push(placedPadRing(pad, fp.place, tol));
      }
    }

    const copper = builder();
    for (const ring of padRings) copper.addFace({ outer: ring, holes: [] }, z, up);
    for (const track of model.tracks) {
      if (track.layer !== cuName || !(track.width > 0)) continue;
      if (quality === 'reduced' && track.width < MIN_TRACK_MM) continue;
      copper.addFace({ outer: strokePolygon(track.pts, track.width, caps), holes: [] }, z, up);
    }
    for (const zone of model.zones) {
      if (zone.layer === cuName) copper.addFace({ outer: zone.ring, holes: [] }, z, up);
    }
    emit(copper, 'copper', cuName);

    const openings = prune(padRings);
    holesMerged += openings.dropped;
    const mask = builder();
    mask.addFace(
      { outer: outline.outer, holes: [...openings.kept.map((p) => p.ring), ...withoutOverlaps(holes.kept, openings.kept)] },
      maskZ[side],
      up,
    );
    emit(mask, 'mask', `${side}.Mask`);
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
    for (const body of bodies) {
      const base = maskZ[body.side];
      bodyMesh.addPrism({ outer: body.ring, holes: [] }, base, body.side === 'F' ? base + body.heightMm : base - body.heightMm);
    }
    emit(bodyMesh, 'body', null);
    if (missing > 0) warnings.push({ kind: 'no-courtyard', count: missing });
  }

  if (holesMerged > 0) warnings.push({ kind: 'holes-merged', count: holesMerged });
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
