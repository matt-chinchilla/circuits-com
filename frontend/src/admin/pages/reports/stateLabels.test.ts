import { describe, expect, it } from 'vitest';
import { US_STATE_CODES, US_STATE_LABELS } from './stateLabels';
import usStates from '@admin/components/charts/us-states-albers.geo.json';

// The label table in stateLabels.ts is PRE-COMPUTED — deriving a pole of
// inaccessibility costs 80-378ms on this asset (measured), which is not a
// price to pay on the click that opens the drill-down. The trade is that the
// table can silently drift away from the geometry it describes, so this file
// re-derives that geometry from the committed asset and checks the properties
// the table actually claims:
//
//   every state in the asset has a label, and no label invents a state;
//   every anchor is INSIDE its own state, not merely near it;
//   the ten states whose labels were moved into open water are exactly the
//     ten that cannot hold one — measured by inradius, not asserted by name;
//   every moved label lands on water inside the frame, and the nine of them
//     that form the seaboard stack are in latitude order on one meridian, so
//     no two of those leader lines can cross.
//
// Swap the asset and these fail, which is the point. A table that matched
// nothing would pass a test that only checked its own shape.

type Ring = Array<[number, number]>;
type Poly = Ring[];
interface Feature {
  properties?: { name?: string };
  geometry?: { type?: string; coordinates?: unknown };
}
const FEATURES = (usStates as unknown as { features: Feature[] }).features;

function polygons(f: Feature): Poly[] {
  if (f.geometry?.type === 'Polygon') return [f.geometry.coordinates as Poly];
  if (f.geometry?.type === 'MultiPolygon') return f.geometry.coordinates as Poly[];
  return [];
}

/** Shoelace, unsigned — only used to rank a state's parts. */
function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a / 2);
}

/** The part a label belongs on: Michigan's Lower Peninsula, Hawaii's Big
 *  Island, mainland Alaska. */
function largestPart(f: Feature): Poly {
  let best: Poly = [];
  let bestArea = -1;
  for (const poly of polygons(f)) {
    const area = ringArea(poly[0]);
    if (area > bestArea) {
      bestArea = area;
      best = poly;
    }
  }
  return best;
}

function insideRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Outer ring minus every hole. */
function insidePoly(x: number, y: number, poly: Poly): boolean {
  if (!poly.length || !insideRing(x, y, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (insideRing(x, y, poly[k])) return false;
  return true;
}

function pointToSegment(px: number, py: number, a: [number, number], b: [number, number]): number {
  let [x, y] = a;
  const dx = b[0] - x;
  const dy = b[1] - y;
  if (dx || dy) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) [x, y] = b;
    else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  return Math.hypot(px - x, py - y);
}

/** Distance to the nearest edge, positive inside. This is the number the
 *  "can this polygon hold a label" claim rests on. */
function clearance(x: number, y: number, poly: Poly): number {
  let d = Infinity;
  for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      d = Math.min(d, pointToSegment(x, y, ring[j], ring[i]));
    }
  }
  return (insidePoly(x, y, poly) ? 1 : -1) * d;
}

const PART_BY_STATE = new Map<string, Poly>(
  FEATURES.filter((f) => f.properties?.name).map((f) => [f.properties!.name!, largestPart(f)]),
);
const label = (name: string) => US_STATE_LABELS.find((l) => l.name === name);
const isStacked = (l: { anchor: [number, number]; at: [number, number] }) =>
  l.at[0] !== l.anchor[0] || l.at[1] !== l.anchor[1];

describe('the label table describes the committed asset', () => {
  it('labels every state in the asset, and invents none', () => {
    const inAsset = new Set(FEATURES.map((f) => f.properties?.name));
    const labelled = new Set(US_STATE_LABELS.map((l) => l.name));
    expect(labelled).toEqual(inAsset);
    expect(US_STATE_LABELS).toHaveLength(51);
  });

  it('gives each one a unique two-letter code', () => {
    const codes = US_STATE_LABELS.map((l) => l.code);
    for (const code of codes) expect(code).toMatch(/^[A-Z]{2}$/);
    expect(new Set(codes).size).toBe(codes.length);
    expect(Object.keys(US_STATE_CODES)).toHaveLength(51);
  });

  it('anchors every label INSIDE its own state', () => {
    // Not "near" — inside, with room. A centroid would fail this for Florida,
    // Michigan and Louisiana, all of which have theirs offshore.
    for (const l of US_STATE_LABELS) {
      const poly = PART_BY_STATE.get(l.name)!;
      expect(clearance(l.anchor[0], l.anchor[1], poly), `${l.name} anchor`).toBeGreaterThan(1);
    }
  });
});

describe('the moved labels are exactly the states that cannot hold one', () => {
  const moved = US_STATE_LABELS.filter(isStacked);
  const inPlace = US_STATE_LABELS.filter((l) => !isStacked(l));
  /** The seaboard stack: DERIVED as the largest group of moved labels sharing
   *  one x, rather than spelled as a meridian this file would then have to be
   *  edited to follow. Hawaii is moved too, but eastward into the Pacific, not
   *  into a column about New England, so it is its own group of one. */
  const byMeridian = new Map<number, typeof moved>();
  for (const l of moved) byMeridian.set(l.at[0], [...(byMeridian.get(l.at[0]) ?? []), l]);
  const stacked = [...byMeridian.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  const inradius = (name: string) => {
    const l = label(name)!;
    return clearance(l.anchor[0], l.anchor[1], PART_BY_STATE.get(name)!);
  };

  it('separates cleanly on measured room, not on a hand-picked list', () => {
    // The claim in stateLabels.ts is that these ten are geometrically too
    // small at EVERY viewport. If an eleventh were quietly moved, or one of
    // the ten put back, the two groups would interleave. This is what caught
    // Hawaii: its Big Island has less clearance (9.5) than New Hampshire.
    expect(moved).toHaveLength(10);
    expect(stacked).toHaveLength(9);
    const widest = Math.max(...moved.map((l) => inradius(l.name)));
    const tightest = Math.min(...inPlace.map((l) => inradius(l.name)));
    expect(widest).toBeLessThan(tightest);
    // And the gap is real, not a rounding accident: ~11.9 against ~19.0.
    expect(tightest - widest).toBeGreaterThan(5);
  });

  it('stacks them on one meridian, in latitude order, so no leaders cross', () => {
    // Two segments sharing an end x whose start AND end y both increase down
    // the list cannot intersect. That is the whole reason the order is fixed.
    const xs = new Set(stacked.map((l) => l.at[0]));
    expect(xs.size).toBe(1);
    for (let i = 1; i < stacked.length; i++) {
      expect(stacked[i].anchor[1]).toBeGreaterThan(stacked[i - 1].anchor[1]);
      expect(stacked[i].at[1]).toBeGreaterThan(stacked[i - 1].at[1]);
    }
  });

  it('puts every moved label over open water, inside the frame', () => {
    // Measured: drawn land reaches x=936.5 at Maine's tip and 931-933 at Cape
    // Cod. A stack drawn on top of the coastline it is explaining would be
    // worse than no stack.
    for (const l of moved) {
      for (const [name, poly] of PART_BY_STATE) {
        expect(insidePoly(l.at[0], l.at[1], poly), `${l.code} lands on ${name}`).toBe(false);
      }
      expect(l.at[0]).toBeLessThan(957.1); // the asset's own right edge
      expect(l.at[1]).toBeGreaterThan(13);
      expect(l.at[1]).toBeLessThan(606.6);
    }
  });
});
