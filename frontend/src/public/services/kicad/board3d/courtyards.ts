// A footprint's courtyard → the translucent body the scene stands in its place
// (spec 2026-09-21 §4). The courtyard is the only outline a KiCad board states
// for a part that is true to the real component's FOOTPRINT; its height is an
// estimate and the viewer captions it as one. `(model …)` — the path to the
// author's own 3D file — is never read, here or anywhere in this pipeline.
import { place, signedArea } from './geom';
import { chainLoops, orient, shapePolylines } from './outline';
import type { BoardModel, FootprintModel, Ring, Side } from './types';

export interface Courtyard { ring: Ring; heightMm: number; side: Side; areaMm2: number }

/** Body height from courtyard area, and nothing else. An 0402 (1.7 mm²) and a
 *  QFN-48 (81 mm²) sit 0.6 and 3.2 mm tall — the right ORDER for a board that
 *  reads as a board, never a claim about the actual part. */
const HEIGHT_COEFF = 0.35, HEIGHT_MIN = 0.6, HEIGHT_MAX = 12;

export function estimateHeightMm(areaMm2: number): number {
  const h = HEIGHT_COEFF * Math.sqrt(Math.max(0, areaMm2));
  return Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, h));
}

/**
 * The footprint's courtyard graphics, placed on the board and chained into one
 * closed ring. Returns null when the footprint draws no courtyard at all AND
 * when what it draws never closes — both are "this part has no body", which the
 * caller counts and reports once rather than guessing an outline per part.
 *
 * The largest loop wins: a courtyard drawn as an outer boundary plus an inner
 * keep-clear (a connector's mating area) is one body, not two.
 */
/** Endpoint snap for courtyard chaining. A courtyard is hand- or generator-drawn
 *  at 10 µm precision on 50 µm strokes, and Glasgow's J4 misses closure by 8 µm
 *  at one corner — a body-less connector for a gap a fifth of its own line
 *  width. 20 µm closes it and stays well under the stroke; the BOARD outline keeps
 *  the reader's 1 µm default, where a false closure would fabricate a board. */
export const COURTYARD_SNAP_MM = 0.02;

export function courtyardOf(fp: FootprintModel, tolMm: number): Courtyard | null {
  const { polylines } = shapePolylines(fp.courtyard, tolMm);
  if (polylines.length === 0) return null;
  // Placed AFTER flattening: place() is a rigid motion (mirror, turn, translate),
  // so flattening first and placing the points gives the same curve for less work.
  const placed = polylines.map((pl) => pl.map((p) => place(p, fp.place)));
  const { loops } = chainLoops(placed, COURTYARD_SNAP_MM);
  let best: Ring | null = null;
  let bestArea = 0;
  for (const loop of loops) {
    const area = Math.abs(signedArea(loop.pts));
    if (area > bestArea) { best = loop; bestArea = area; }
  }
  if (best == null || bestArea <= 0) return null;
  return { ring: { pts: orient(best.pts, 'outer') }, heightMm: estimateHeightMm(bestArea), side: fp.place.side, areaMm2: bestArea };
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
