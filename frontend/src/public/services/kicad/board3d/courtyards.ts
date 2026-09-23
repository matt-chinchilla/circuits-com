// A footprint's outline → the body the scene stands in its place (spec
// 2026-09-21 §4, 2026-09-22 3D parts §1). Two outlines a KiCad board states
// for a part are candidates: the Fab drawing, which by the library convention
// IS the physical package (the chip, the moulding, the housing), and the
// courtyard, which is the package plus its assembly clearance. The Fab outline
// wins when it closes — a body drawn from the courtyard is too big and buries
// the part's own pads — and the courtyard stands in when it does not. The
// height is an estimate either way and the viewer captions it as one.
// `(model …)` — the path to the author's own 3D file — is never read, here or
// anywhere in this pipeline.
import { place, signedArea } from './geom';
import { chainLoops, orient, shapePolylines } from './outline';
import { partFamily } from './partFamily';
import type { BoardModel, FootprintModel, Ring, Shape, Side } from './types';

export interface Courtyard {
  ref: string;
  /** The footprint's library id, for the family its body is tinted by. */
  lib: string;
  ring: Ring;
  heightMm: number;
  side: Side;
  areaMm2: number;
  /** Which outline the ring is: the package drawing, or the courtyard. */
  source: 'fab' | 'courtyard';
}

/** Body height from courtyard area, and nothing else. An 0402 (1.7 mm²) and a
 *  QFN-48 (81 mm²) sit 0.6 and 3.2 mm tall — the right ORDER for a board that
 *  reads as a board, never a claim about the actual part. */
const HEIGHT_COEFF = 0.35, HEIGHT_MIN = 0.6, HEIGHT_MAX = 12;

export function estimateHeightMm(areaMm2: number): number {
  const h = HEIGHT_COEFF * Math.sqrt(Math.max(0, areaMm2));
  return Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, h));
}

/** Endpoint snap for courtyard chaining. A courtyard is hand- or generator-drawn
 *  at 10 µm precision on 50 µm strokes, and Glasgow's J4 misses closure by 8 µm
 *  at one corner — a body-less connector for a gap a fifth of its own line
 *  width. 20 µm closes it and stays well under the stroke; the BOARD outline keeps
 *  the reader's 1 µm default, where a false closure would fabricate a board. */
const COURTYARD_SNAP_MM = 0.02;

/**
 * A Fab loop smaller than this share of the courtyard's area is not the
 * package: it is a mark drawn inside it (a pin-1 circle, a polarity bar that
 * happens to close). The smallest real ratio on the fixtures is a chip
 * passive's body against its courtyard, ~18 % for an 0201 and ~29 % for an
 * 0402; a pin-1 circle on an IC is under 1 %.
 */
const FAB_MIN_SHARE = 0.1;

/**
 * EIA nominal chip thickness by imperial size code — the typical height a
 * datasheet lists for a ceramic chip of that size. Still an estimate (a real
 * 0603 capacitor runs 0.45–0.9 mm with its value), but a far closer one than
 * the area rule, which floors every chip at 0.6 mm.
 */
const CHIP_THICKNESS_MM: Record<string, number> = { '0201': 0.3, '0402': 0.35, '0603': 0.45, '0805': 0.6, '1206': 0.7 };

/**
 * The nominal thickness of a CHIP passive named `lib`, from the imperial size
 * code its name carries as a token (`C_0402_1005Metric`, `R_0603_…`) — the
 * first such token wins, so an 0201 is not read as the 0603 its metric name
 * spells. Null for anything else: an array (`4x0402`) is not a chip, and a
 * non-passive (an `LED_0603`) keeps the area rule.
 */
export function chipThicknessMm(lib: string, ref = ''): number | null {
  if (partFamily(lib, ref) !== 'passive') return null;
  const match = /(?:^|[:_])(0201|0402|0603|0805|1206)(?=[_A-Za-z]|$)/.exec(lib);
  return match == null ? null : CHIP_THICKNESS_MM[match[1]];
}

/** The largest closed loop of `shapes`, placed; null when none closes. The
 *  largest wins: a courtyard drawn as an outer boundary plus an inner
 *  keep-clear (a connector's mating area) is one body, not two, and a Fab
 *  drawing's pin outlines and marks are smaller than the package they sit on. */
function largestLoop(shapes: Shape[], fp: FootprintModel, tolMm: number): { ring: Ring; area: number } | null {
  if (shapes.length === 0) return null;
  const { polylines } = shapePolylines(shapes, tolMm);
  if (polylines.length === 0) return null;
  // Placed AFTER flattening: place() is a rigid motion (turn, translate),
  // so flattening first and placing the points gives the same curve for less work.
  const placed = polylines.map((pl) => pl.map((p) => place(p, fp.place)));
  const { loops } = chainLoops(placed, COURTYARD_SNAP_MM);
  let best: Ring | null = null;
  let bestArea = 0;
  for (const loop of loops) {
    const area = Math.abs(signedArea(loop.pts));
    if (area > bestArea) { best = loop; bestArea = area; }
  }
  return best == null || bestArea <= 0 ? null : { ring: best, area: bestArea };
}

/**
 * The footprint's body: its Fab outline when that closes (and is not a mark
 * too small to be the package — `FAB_MIN_SHARE`), else its courtyard, placed
 * on the board as one closed ring. Returns null when neither closes — "this
 * part has no body", which the caller counts and reports once rather than
 * guessing an outline per part.
 *
 * The height is the area rule on the COURTYARD when there is one — the same
 * number the courtyard-only bodies had, so a part changes shape here and not
 * height — and on the Fab outline when there is not. A chip passive takes its
 * size code's nominal thickness instead (`chipThicknessMm`).
 */
export function courtyardOf(fp: FootprintModel, tolMm: number): Courtyard | null {
  const court = largestLoop(fp.courtyard, fp, tolMm);
  const fab = largestLoop(fp.fab, fp, tolMm);
  const useFab = fab != null && (court == null || fab.area >= FAB_MIN_SHARE * court.area);
  const chosen = useFab ? fab : court;
  if (chosen == null) return null;
  const heightMm = chipThicknessMm(fp.lib, fp.ref) ?? estimateHeightMm((court ?? chosen).area);
  return {
    ref: fp.ref, lib: fp.lib, ring: { pts: orient(chosen.ring.pts, 'outer') }, heightMm, side: fp.place.side,
    areaMm2: chosen.area, source: useFab ? 'fab' : 'courtyard',
  };
}

export function courtyards(model: BoardModel, tolMm: number): { bodies: Courtyard[]; missing: number } {
  const bodies: Courtyard[] = [];
  let missing = 0;
  for (const fp of model.footprints) {
    const body = courtyardOf(fp, tolMm);
    if (body == null) missing++;
    else bodies.push(body);
  }
  return { bodies, missing };
}
