// Click-a-region zoom for the drill-down views.
//
// ECharts' `geo.zoom` is RELATIVE to its own auto-fit of the whole map into
// the plot box, so the zoom that fits one region is the ratio between "scale
// that fits the region" and "scale that fits the frame", each the usual
// min(w-ratio, h-ratio) letterbox fit.
//
// ── Bounds must be measured in PROJECTED space ─────────────────────────────
// The US asset is already planar (the pre-projected us-atlas frame, y down),
// so its features go through the identity and a bounding box is plain min/max
// over the rings. Every other country ships lat/lng and is projected at
// render time, so its boxes have to be taken AFTER the same projection the
// geo component uses — a lat/lng box would describe a rectangle the renderer
// never draws, and the fitted zoom would be wrong by the projection's own
// distortion (Mercator stretches a northern country's height by more than a
// third). Hence the `project` argument: the caller passes the very function
// it put on `geo.projection`.

export type BBox = [minX: number, minY: number, maxX: number, maxY: number];

/** The identity, for an asset that is already planar. */
const PLANAR = (point: [number, number]): [number, number] => point;

interface PlanarFeature {
  properties?: { name?: string };
  geometry?: { type?: string; coordinates?: unknown };
}

interface PlanarGeoJson {
  features: PlanarFeature[];
}

function extendWithRing(
  box: BBox,
  ring: Array<[number, number]>,
  project: (point: [number, number]) => [number, number],
): void {
  for (const point of ring) {
    const [x, y] = project(point);
    if (x < box[0]) box[0] = x;
    if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x;
    if (y > box[3]) box[3] = y;
  }
}

const EMPTY: BBox = [Infinity, Infinity, -Infinity, -Infinity];

/** Per-feature bounding boxes, keyed by `properties.name`, plus the union
 *  frame ECharts auto-fits (the whole asset's extent). Boxes come back in
 *  `project`'s output space; the default is the identity, for a planar asset.
 *
 *  A name that appears on SEVERAL features (Ireland lists Cork twice, county
 *  and city) accumulates into one box rather than the last one winning —
 *  otherwise clicking it would frame half the place. */
export function featureBounds(
  geojson: PlanarGeoJson,
  project: (point: [number, number]) => [number, number] = PLANAR,
): {
  byName: Record<string, BBox>;
  frame: BBox;
} {
  const byName: Record<string, BBox> = {};
  const frame: BBox = [...EMPTY];
  for (const f of geojson.features) {
    const name = f.properties?.name;
    const geom = f.geometry;
    if (!name || !geom) continue;
    const box: BBox = [...EMPTY];
    if (geom.type === 'Polygon') {
      for (const ring of geom.coordinates as Array<Array<[number, number]>>) {
        extendWithRing(box, ring, project);
      }
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates as Array<Array<Array<[number, number]>>>) {
        for (const ring of poly) extendWithRing(box, ring, project);
      }
    } else {
      continue;
    }
    if (box[0] > box[2]) continue; // no coordinates at all
    const prior = byName[name];
    byName[name] = prior ? (unionBounds([prior, box]) as BBox) : box;
    extendWithRing(
      frame,
      [
        [box[0], box[1]],
        [box[2], box[3]],
      ],
      PLANAR, // already projected
    );
  }
  return { byName, frame };
}

/** The smallest box containing all of `boxes`, or null for none. A region the
 *  join resolved to SEVERAL polygons (England is 150 districts) is framed by
 *  their union, not by whichever one came first. */
export function unionBounds(boxes: BBox[]): BBox | null {
  if (!boxes.length) return null;
  const out: BBox = [...EMPTY];
  for (const b of boxes) {
    if (b[0] < out[0]) out[0] = b[0];
    if (b[1] < out[1]) out[1] = b[1];
    if (b[2] > out[2]) out[2] = b[2];
    if (b[3] > out[3]) out[3] = b[3];
  }
  return out;
}

/** How far a region click may zoom in. Delaware alone would otherwise justify
 *  ~40x, at which point 0.6px borders and city dots stop making sense. */
export const MAX_STATE_ZOOM = 12;

/** Breathing room around the fitted region, as a fraction of the tight fit. */
const FIT_MARGIN = 0.82;

/** A projected frame's width / height — the shape of the geography itself,
 *  which is what the sea plate's `aspect-ratio` is set from so the frame the
 *  CSS draws and the geometry ECharts fits into it are one measurement. */
export function frameAspect(frame: BBox): number {
  const w = frame[2] - frame[0];
  const h = frame[3] - frame[1];
  return h > 0 && w > 0 ? w / h : 1;
}

/**
 * The `geo.center`/`geo.zoom` pair that frames one region. Zoom never goes
 * below 1 (zooming OUT past the auto-fit just shows more open water) and is
 * capped at MAX_STATE_ZOOM.
 *
 * ── No pixels, and that is the point (2026-08-31) ──────────────────────────
 * `geo.zoom` is relative to ECharts' own auto-fit of the whole asset into its
 * view rect, and that fit PRESERVES ASPECT now (`preserveAspect` on MAP_BOX
 * in mapOptions.ts). Frame and region are therefore scaled by the same factor
 * on both axes, and every pixel term cancels:
 *
 *     zoom = fitRegion / fitFrame
 *          = min(viewW/w, viewH/h) / min(viewW/frameW, viewH/frameH)
 *          = min(frameW/w, frameH/h)      because viewW/viewH == frameW/frameH
 *
 * This also FIXES a bug the stretch was hiding rather than merely simplifying
 * one: the caller used to hand over the whole plot rect, which after
 * letterboxing is bigger than the drawn map on one axis, so a tall region
 * would have over-zoomed by exactly that overhang. Keeping a `chart.getWidth()`
 * in this math would quietly re-couple the zoom to the box shape — the thing
 * the aspect fix exists to decouple.
 */
export function viewForBounds(bounds: BBox, frame: BBox): { center: [number, number]; zoom: number } {
  const [minX, minY, maxX, maxY] = bounds;
  const frameW = Math.max(frame[2] - frame[0], Number.MIN_VALUE);
  const frameH = Math.max(frame[3] - frame[1], Number.MIN_VALUE);
  // The degeneracy floor is a FRACTION of the frame, never an absolute 1.
  // The US asset's planar frame is ~900 units across and a 1-unit floor was
  // invisible there, but a country view is projected into radians — the whole
  // world is 2π wide — and an absolute 1 would clamp every country to a
  // rectangle bigger than itself, pinning the zoom at the auto-fit.
  const w = Math.max(maxX - minX, frameW / 1e4);
  const h = Math.max(maxY - minY, frameH / 1e4);
  const zoom = Math.min(Math.max(FIT_MARGIN * Math.min(frameW / w, frameH / h), 1), MAX_STATE_ZOOM);
  return { center: [(minX + maxX) / 2, (minY + maxY) / 2], zoom };
}
