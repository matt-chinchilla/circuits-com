// A part's pins and terminals, from its REAL pads (spec 2026-09-22 3D parts
// §1.2–1.3). The body alone is a block; what makes a block read as a chip, a
// gull-wing IC or a header is the metal where it meets the board, and a KiCad
// board states exactly where that metal is: the pads. Every solid here is
// built from a pad the file placed, against the body `courtyards.ts` drew —
// the heights are estimates like the body's own, and nothing is read from the
// author's 3D model.
//
// Pure and footprint-local: each footprint's pads and body are taken back into
// the footprint's own frame (where a package is axis-aligned), the metal is
// laid out there, and the result is placed on the board by the same rigid
// motion (`geom.place`) every other part of this pipeline uses.
import type { Courtyard } from './courtyards';
import { bbox, place, rotate, type Box } from './geom';
import type { PartFamily } from './partFamily';
import type { FootprintModel, PadModel, Ring, Vec2 } from './types';

/** A point of a lead in board millimetres (placed), at `level` mm above the
 *  mask on the part's own side — the caller turns a level into a model z. */
export interface LeadPoint { x: number; y: number; level: number }

export type LeadSolid =
  /** A vertical prism over `ring` (placed, closed, any winding) from level
   *  `lo` to level `hi`: a chip's end termination, a gull-wing's flat foot, a
   *  through-hole pin. */
  | { kind: 'termination' | 'foot' | 'post'; ring: Ring; lo: number; hi: number; pad: string }
  /** A sloped slab from a foot's inner end up to the body wall: eight
   *  corners, `corners[0..3]` the underside and `[4..7]` the top, in order. */
  | { kind: 'shoulder'; corners: LeadPoint[]; pad: string };

/** A foot is this tall — a formed lead's sheet-metal thickness, near enough. */
export const FOOT_MM = 0.12;
/** A shoulder meets the body wall at this share of the body's height. */
export const SHOULDER_SHARE = 0.4;
/** When a pad runs under the body, the foot is its outer share of the part
 *  that sticks out, and the shoulder climbs across the rest. */
const FOOT_SHARE = 0.55;
/** A lead is narrower than the pad it is soldered to, so the copper shows
 *  round it the way a real joint does. */
const LEAD_WIDTH_SHARE = 0.8;
/** A termination rises this far above the body's top, and stands this far
 *  proud of its end and sides, so the metal and the body never share a face. */
const TERMINATION_PROUD_MM = 0.005;
/** A through-hole pin's square side is this share of the drill, at least the
 *  minimum; it rises past the body top by the connector or the plain rise. */
const POST_SHARE = 0.64, POST_MIN_MM = 0.3, POST_RISE_CONNECTOR_MM = 2.0, POST_RISE_MM = 0.3;
/** Shorter than this, a shoulder is not drawn: the foot already meets the wall. */
const MIN_SHOULDER_MM = 0.02;
const EPS = 1e-6;

/** A LEADLESS package, by its footprint name: a QFN/DFN/SON's terminals are
 *  flush with its sides and a BGA's balls are under it, so a pad that sticks
 *  out past such a body is solder fillet, never a formed lead climbing a wall. */
const LEADLESS = /(?:^|[:_-])(?:[UVWX]?[DQ]FN|[UVWX]?SON|LGA|BGA|W?LCSP)(?=[-_\d]|$)/i;
/** A CHIP passive, by the imperial size code its name carries as a token (the
 *  `x` admits an array's `4x0402`): the one passive whose metal is a cap over
 *  each end. Anything else — an electrolytic can, a moulded inductor — stands
 *  on flat tabs, and a termination the height of a 6 mm can would read as a
 *  metal wall through its middle. */
const CHIP = /(?:^|[:_x])(?:01005|0201|0402|0603|0805|1008|1206|1210|1812|2010|2220|2512)(?=[_A-Za-z]|$)/;

export const isLeadless = (lib: string): boolean => LEADLESS.test(lib);
export const isChipPackage = (lib: string): boolean => CHIP.test(lib);

/** Board → footprint-local: the inverse of `place`. */
function unplace(p: Vec2, fp: FootprintModel): Vec2 {
  return rotate({ x: p.x - fp.place.at.x, y: p.y - fp.place.at.y }, -fp.place.rotDeg);
}

/** The pad's axis-aligned box in the footprint's frame. A pad's `rotDeg` is
 *  absolute, so its turn in the footprint's frame is the difference; a pad at
 *  an odd angle is boxed round its turned rectangle. */
function padBox(pad: PadModel, fp: FootprintModel): Box {
  const t = ((pad.rotDeg - fp.place.rotDeg) * Math.PI) / 180;
  const c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
  const hx = (c * pad.size.x + s * pad.size.y) / 2, hy = (s * pad.size.x + c * pad.size.y) / 2;
  return { min: { x: pad.at.x - hx, y: pad.at.y - hy }, max: { x: pad.at.x + hx, y: pad.at.y + hy } };
}

/** A local box → a placed ring, corner order as `rectCorners`. */
function placedBox(b: Box, fp: FootprintModel): Ring {
  const corners = [b.min, { x: b.max.x, y: b.min.y }, b.max, { x: b.min.x, y: b.max.y }];
  return { pts: corners.map((p) => place(p, fp.place)) };
}

const hasArea = (b: Box): boolean => b.max.x - b.min.x > EPS && b.max.y - b.min.y > EPS;

/** The body's box in the footprint's own frame; null when it has no area. */
export function localBodyBox(fp: FootprintModel, body: Courtyard): Box | null {
  const b = bbox(body.ring.pts.map((p) => unplace(p, fp)));
  return hasArea(b) ? b : null;
}

/**
 * A chip passive's end metal: the pad's rectangle where it lies under the
 * body, made a hair proud of the body on every side. On an 0402 that is the
 * last 0.3 mm of each end of the chip, which is exactly where the real
 * termination is — the pads are laid out to meet it.
 */
function termination(pad: PadModel, fp: FootprintModel, body: Box, height: number): LeadSolid | null {
  const p = padBox(pad, fp);
  const inter: Box = {
    min: { x: Math.max(p.min.x, body.min.x), y: Math.max(p.min.y, body.min.y) },
    max: { x: Math.min(p.max.x, body.max.x), y: Math.min(p.max.y, body.max.y) },
  };
  if (!hasArea(inter)) return null;
  const d = TERMINATION_PROUD_MM;
  const grown: Box = { min: { x: inter.min.x - d, y: inter.min.y - d }, max: { x: inter.max.x + d, y: inter.max.y + d } };
  return { kind: 'termination', ring: placedBox(grown, fp), lo: 0, hi: height + d, pad: pad.number };
}

/**
 * A gull-wing lead, for a pad that sticks out past the body: a flat FOOT on
 * the pad's outer part and a SHOULDER climbing from the foot's inner end to
 * the body wall at `SHOULDER_SHARE` of its height. The side the pad sticks
 * out of is the one it overhangs most. A pad entirely under the body (a QFN's,
 * a BGA's) has no visible lead and draws nothing.
 */
function gullWing(pad: PadModel, fp: FootprintModel, body: Box, height: number, flat = false): LeadSolid[] {
  const p = padBox(pad, fp);
  const over = [body.min.x - p.min.x, p.max.x - body.max.x, body.min.y - p.min.y, p.max.y - body.max.y];
  let side = 0;
  for (let i = 1; i < 4; i++) if (over[i] > over[side]) side = i;
  if (!(over[side] > EPS)) return [];
  const alongX = side < 2;
  const dir = side % 2 === 0 ? -1 : 1;
  const wall = alongX ? (dir < 0 ? body.min.x : body.max.x) : (dir < 0 ? body.min.y : body.max.y);
  const toe = alongX ? (dir < 0 ? p.min.x : p.max.x) : (dir < 0 ? p.min.y : p.max.y);
  const heel = alongX ? (dir < 0 ? p.max.x : p.min.x) : (dir < 0 ? p.max.y : p.min.y);
  // Distances OUT from the wall: the toe's, and the heel's (negative when the
  // pad runs under the body).
  const toeOut = (toe - wall) * dir, heelOut = (heel - wall) * dir;
  // A flat tab (a leadless package's fillet, a can's tab) runs from the body
  // wall to the toe, and has no shoulder.
  const footStart = flat ? 0 : heelOut > EPS ? heelOut : toeOut * (1 - FOOT_SHARE);
  const crossMin = alongX ? p.min.y : p.min.x, crossMax = alongX ? p.max.y : p.max.x;
  const mid = (crossMin + crossMax) / 2, half = ((crossMax - crossMin) * LEAD_WIDTH_SHARE) / 2;
  const c0 = mid - half, c1 = mid + half;
  /** (distance out from the wall, cross-axis) → footprint-local. */
  const at = (out: number, cross: number): Vec2 => alongX ? { x: wall + dir * out, y: cross } : { x: cross, y: wall + dir * out };
  const box = (a: Vec2, b: Vec2): Box => ({
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
  });
  const out: LeadSolid[] = [];
  const footBox = box(at(footStart, c0), at(toeOut, c1));
  if (hasArea(footBox)) out.push({ kind: 'foot', ring: placedBox(footBox, fp), lo: 0, hi: FOOT_MM, pad: pad.number });
  if (!flat && footStart > MIN_SHOULDER_MM) {
    const top = SHOULDER_SHARE * height;
    const pt = (o: number, c: number, level: number): LeadPoint => { const q = place(at(o, c), fp.place); return { x: q.x, y: q.y, level }; };
    out.push({
      kind: 'shoulder',
      pad: pad.number,
      corners: [
        pt(footStart, c0, 0), pt(footStart, c1, 0), pt(0, c1, top - FOOT_MM), pt(0, c0, top - FOOT_MM),
        pt(footStart, c0, FOOT_MM), pt(footStart, c1, FOOT_MM), pt(0, c1, top), pt(0, c0, top),
      ],
    });
  }
  return out;
}

/** A through-hole pin: a square post on the drill, from the mask up past the
 *  body's top — well past it on a connector, whose pins are what a mating
 *  part plugs onto. */
function post(pad: PadModel, fp: FootprintModel, body: Box, height: number, family: PartFamily): LeadSolid | null {
  if (pad.drill == null || !(pad.drill.d > 0)) return null;
  // A plated hole under a part that is not a connector is a thermal via in an
  // exposed pad, or the hole of a mounting pad — no pin stands in it, and a
  // post would poke a stud through the top of the package.
  if (family !== 'connector' && pad.at.x > body.min.x && pad.at.x < body.max.x && pad.at.y > body.min.y && pad.at.y < body.max.y) {
    return null;
  }
  const h = Math.max(POST_MIN_MM, POST_SHARE * pad.drill.d) / 2;
  const b: Box = { min: { x: pad.at.x - h, y: pad.at.y - h }, max: { x: pad.at.x + h, y: pad.at.y + h } };
  const rise = family === 'connector' ? POST_RISE_CONNECTOR_MM : POST_RISE_MM;
  return { kind: 'post', ring: placedBox(b, fp), lo: 0, hi: height + rise, pad: pad.number };
}

/**
 * Every lead solid of one footprint, in pad order. Through-hole pads get a
 * post whatever the part (unless the hole is under a non-connector's body);
 * surface pads get a termination on a chip passive, a flat tab on any other
 * passive and on a leadless IC, and a gull-wing on a leaded IC or a connector; an LED and an unclassified part draw no
 * surface leads (their pads say too little about the package to guess). A
 * body with no area, or a footprint with no body, has no leads.
 */
export function leadsOf(fp: FootprintModel, body: Courtyard, family: PartFamily): LeadSolid[] {
  const box = localBodyBox(fp, body);
  if (box == null) return [];
  const out: LeadSolid[] = [];
  for (const pad of fp.pads) {
    if (pad.kind === 'thru_hole') {
      const solid = post(pad, fp, box, body.heightMm, family);
      if (solid != null) out.push(solid);
      continue;
    }
    if (pad.kind !== 'smd' || !(pad.size.x > 0) || !(pad.size.y > 0)) continue;
    if (family === 'passive' && isChipPackage(fp.lib)) {
      const solid = termination(pad, fp, box, body.heightMm);
      if (solid != null) out.push(solid);
    } else if (family === 'passive') {
      out.push(...gullWing(pad, fp, box, body.heightMm, true));
    } else if (family === 'ic' || family === 'connector') {
      out.push(...gullWing(pad, fp, box, body.heightMm, isLeadless(fp.lib)));
    }
  }
  return out;
}

/** Pin 1's names: KiCad's plain `1`, and a grid array's `A1`. */
const PIN_ONE = new Set(['1', 'A1']);

/**
 * Where an IC's pin-1 dimple sits: a disc on the top face in the body corner
 * nearest pad 1, of radius 0.12 × the body's smaller side clamped to
 * 0.15–0.6 mm, set in from both edges by twice its radius. Null for anything
 * that is not an IC, has no pad 1, or is too small to carry the mark.
 */
export function pin1Mark(fp: FootprintModel, body: Courtyard, family: PartFamily): { c: Vec2; r: number } | null {
  if (family !== 'ic') return null;
  const pad = fp.pads.find((p) => PIN_ONE.has(p.number));
  if (pad == null) return null;
  const box = localBodyBox(fp, body);
  if (box == null) return null;
  const w = box.max.x - box.min.x, h = box.max.y - box.min.y;
  const r = Math.min(0.6, Math.max(0.15, 0.12 * Math.min(w, h)));
  if (4 * r > Math.min(w, h)) return null;
  const midX = (box.min.x + box.max.x) / 2, midY = (box.min.y + box.max.y) / 2;
  const x = pad.at.x < midX ? box.min.x + 2 * r : box.max.x - 2 * r;
  const y = pad.at.y < midY ? box.min.y + 2 * r : box.max.y - 2 * r;
  return { c: place({ x, y }, fp.place), r };
}
