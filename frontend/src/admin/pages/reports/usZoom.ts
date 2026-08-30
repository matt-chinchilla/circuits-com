// Click-a-state zoom for the US drill-down view.
//
// The states asset is planar (the pre-projected us-atlas frame, y down), so a
// state's bounding box is plain min/max over its rings — no projection math.
// ECharts' `geo.zoom` is RELATIVE to its own auto-fit of the whole map into
// the plot box, so the zoom that fits one state is the ratio between "scale
// that fits the state" and "scale that fits the frame", each the usual
// min(w-ratio, h-ratio) letterbox fit. Centers pass through the identity
// projection untouched.

export type BBox = [minX: number, minY: number, maxX: number, maxY: number];

interface PlanarFeature {
  properties?: { name?: string };
  geometry?: { type?: string; coordinates?: unknown };
}

interface PlanarGeoJson {
  features: PlanarFeature[];
}

function extendWithRing(box: BBox, ring: Array<[number, number]>): void {
  for (const [x, y] of ring) {
    if (x < box[0]) box[0] = x;
    if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x;
    if (y > box[3]) box[3] = y;
  }
}

const EMPTY: BBox = [Infinity, Infinity, -Infinity, -Infinity];

/** Per-state bounding boxes, keyed by `properties.name`, plus the union frame
 *  ECharts auto-fits (the whole asset's extent). */
export function featureBounds(geojson: PlanarGeoJson): {
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
        extendWithRing(box, ring);
      }
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates as Array<Array<Array<[number, number]>>>) {
        for (const ring of poly) extendWithRing(box, ring);
      }
    } else {
      continue;
    }
    if (box[0] > box[2]) continue; // no coordinates at all
    byName[name] = box;
    extendWithRing(frame, [
      [box[0], box[1]],
      [box[2], box[3]],
    ]);
  }
  return { byName, frame };
}

/** How far a state click may zoom in. Delaware alone would otherwise justify
 *  ~40x, at which point 0.6px borders and city dots stop making sense. */
export const MAX_STATE_ZOOM = 12;

/** Breathing room around the fitted state, as a fraction of the tight fit. */
const FIT_MARGIN = 0.82;

/** The `geo.center`/`geo.zoom` pair that frames one state in a plot box of
 *  `plotW`x`plotH` CSS pixels. Zoom never goes below 1 (zooming OUT past the
 *  auto-fit just letterboxes) and is capped at MAX_STATE_ZOOM. */
export function viewForBounds(
  bounds: BBox,
  frame: BBox,
  plotW: number,
  plotH: number,
): { center: [number, number]; zoom: number } {
  const [minX, minY, maxX, maxY] = bounds;
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  const frameW = Math.max(frame[2] - frame[0], 1);
  const frameH = Math.max(frame[3] - frame[1], 1);
  const fitFrame = Math.min(plotW / frameW, plotH / frameH);
  const fitState = Math.min(plotW / w, plotH / h);
  const zoom = Math.min(Math.max((FIT_MARGIN * fitState) / fitFrame, 1), MAX_STATE_ZOOM);
  return { center: [(minX + maxX) / 2, (minY + maxY) / 2], zoom };
}

/** The reset view: ECharts' own auto-fit, expressed explicitly so an
 *  imperative merge-setOption can restore it after any roam. */
export function homeView(frame: BBox): { center: [number, number]; zoom: number } {
  return { center: [(frame[0] + frame[2]) / 2, (frame[1] + frame[3]) / 2], zoom: 1 };
}
