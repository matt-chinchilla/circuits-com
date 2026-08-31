// The density layer's weight scale — a ladder of DECADES.
//
// leaflet.heat draws each grid cell at an alpha of `weight / max`, and it
// ACCUMULATES overlapping points into that cell before the division — so the
// weights it is handed are the whole visual story of the heat map. They are
// also the only part of the density view that is arithmetic rather than
// imperative map plumbing, which is why they live here, where a test can
// drive them, instead of inline in HeatMapView.
//
// ── One decade, one rung (owner, 2026-08-30) ───────────────────────────────
// The weights are page-view counts with a brutal long tail: prod's busiest
// point carries 3,000+ views while most of its ~311 points carry 1-5. That
// tail is NOT a defect to be smoothed away — it is what the data is, and the
// owner's rule is that the colors sort by orders of magnitude: tens, hundreds,
// thousands. So the scale is log10 against the window's own peak, and a
// tenfold jump in views buys the SAME step of gradient wherever it happens:
//
//        1 view -> 0.180        100 views -> 0.652
//       10 views -> 0.416      1,000 views -> 0.888
//                              3,000 views -> 1.000  (the peak, always)
//
// Those steps are 0.2358 apart, exactly and by construction — the step is
// (1 - DECADE_FLOOR) / log10(peak) for every decade in any window. Nothing is
// clipped or winsorized on the way: the peak sets the top of the ladder and
// everything else falls where its own magnitude puts it.
//
// ── Why not log1p, which is the obvious way to survive a zero ──────────────
// `log10(w + 1) / log10(peak + 1)` looks equivalent and is not. The offset is
// negligible at the top of a three-decade window and dominant at the bottom,
// so it SQUEEZES the low decades: measured against a peak of 3,000 it puts
// 1/10/100/1,000 at gaps of 0.187, 0.244, 0.252 — the bottom decade 26%
// narrower than the top, which is the one place the owner's rule most needs to
// hold, since that is where most of the points are. (Changing the log's BASE
// does nothing at all, incidentally: the base cancels in the ratio, so log10
// and log1p forms of the SAME expression are the identical number. The offset
// is the whole difference.)
//
// The zero it was guarding against is handled honestly instead: a count below
// one view is not a smaller decade, it is no decade at all, so it is read as
// the bottom rung rather than as a negative infinity.

/** `[lat, lng, weight]`, the payload's own bare-triple shape. The API emits
 *  view counts; this module hands back the same triples carrying INTENSITIES
 *  on [DECADE_FLOOR, 1] instead. */
export type HeatPoint = [lat: number, lng: number, weight: number];

/** Leaflet's `[[southWest], [northEast]]` bounds literal. */
export type HeatBounds = [[number, number], [number, number]];

/**
 * The intensity of the BOTTOM rung — a point in the ones.
 *
 * It is not decoration: log10(1) is 0, so without a floor the entire bottom
 * decade would be drawn at zero alpha and the most populous part of the data
 * would be invisible. It is set where it is because the gradient's lowest
 * stop sits at 0.2 and a rung below roughly 0.15 stops reading as blue and
 * starts reading as nothing. leaflet.heat's own `minOpacity` clamp is left at
 * its 0.05 default so it sits BELOW this and can never quietly override the
 * ladder.
 *
 * Being a floor on an affine map, it costs range but not uniformity — the
 * decade steps stay exactly even whatever it is set to.
 */
export const DECADE_FLOOR = 0.18;

/** A point Leaflet can actually place. NaN and +/-Infinity both fail these
 *  comparisons, which is the point: `L.latLng` THROWS on a non-finite pair,
 *  so one malformed row would take the whole map down rather than itself. */
function isPlottable([lat, lng]: HeatPoint): boolean {
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** The count this point sits on for laddering purposes. Fewer than one view
 *  is not a decade below the ones — it is a row that should not have been
 *  sent — so it takes the bottom rung rather than log10's negative infinity.
 *  This is a floor on nonsense at the BOTTOM, not a cap on outliers at the
 *  top: nothing here ever pulls a real peak down. */
function decadeWeight(weight: number): number {
  return Number.isFinite(weight) ? Math.max(1, weight) : 1;
}

/**
 * The same points, with their view counts replaced by intensities on
 * [DECADE_FLOOR, 1] laddered by ORDER OF MAGNITUDE — the peak of the window
 * always mapping to exactly 1, and every tenfold step below it costing the
 * same slice of gradient.
 *
 * Points Leaflet could not place are dropped. An empty input (and an input of
 * nothing but unplaceable points) yields an empty array, which the panel
 * treats as its collecting state.
 */
export function normalizeHeatDecades(points: readonly HeatPoint[]): HeatPoint[] {
  const plottable = points.filter(isPlottable);
  if (plottable.length === 0) return [];

  let peak = 1;
  for (const point of plottable) peak = Math.max(peak, decadeWeight(point[2]));

  // A window less than one decade wide has no rungs to separate: every point
  // is the same order of magnitude, so they all burn at full intensity rather
  // than dividing by log10(1) = 0.
  const decades = Math.log10(peak);
  if (decades <= 0) return plottable.map(([lat, lng]) => [lat, lng, 1]);

  return plottable.map(([lat, lng, weight]) => [
    lat,
    lng,
    DECADE_FLOOR + (1 - DECADE_FLOOR) * (Math.log10(decadeWeight(weight)) / decades),
  ]);
}

// ── The zoom-scaled brush (2026-08-30) ─────────────────────────────────────
// leaflet.heat takes radius/blur in SCREEN pixels, so a fixed brush changes
// its GEOGRAPHIC meaning with every zoom: the 42px footprint that reads as a
// metro at z7 smears across a subcontinent at z2 — which is exactly the
// continent-blob failure the owner flagged against the reference's precision.
// The honest brush is retuned per zoom.
//
// The ladder: the drawn footprint (radius + blur) DOUBLES IN AREA per zoom
// step — 2^((z-2)/2) — between two measured anchors. That is deliberately
// slower than the 2x-per-zoom that would keep the footprint geographically
// constant, so zooming in still tightens the glow's geographic extent: the
// world view shows a compact city constellation, and street level earns a
// tight metro glow. Both ends were picked by eye against the live data
// (2026-08-30): 10px at z2 keeps the NE corridor a hot STREAK instead of a
// red continent, and 42px from z6.4 up is the prior shipped tuning, which
// was right at metro scale. Radius:blur stays 4:3, the shipped ratio.

/** The smallest drawn footprint, worn at the world zooms. */
export const BRUSH_MIN_FOOTPRINT = 10;
/** The largest, from ~z6.4 up — the prior fixed 24+18 tuning. */
export const BRUSH_MAX_FOOTPRINT = 42;

/** The screen-pixel brush for a zoom level. Pure, so the ladder is testable;
 *  HeatMapView applies it on every `zoomend`. Fractional zooms interpolate. */
export function heatBrushForZoom(zoom: number): { radius: number; blur: number } {
  const footprint = Math.min(
    BRUSH_MAX_FOOTPRINT,
    Math.max(BRUSH_MIN_FOOTPRINT, BRUSH_MIN_FOOTPRINT * 2 ** ((zoom - 2) / 2)),
  );
  return { radius: (footprint * 4) / 7, blur: (footprint * 3) / 7 };
}

// ── The gradient key's ticks ───────────────────────────────────────────────
// The heat view's legend is a gradient bar with the window's own decades
// marked on it — the same ladder normalizeHeatDecades draws with, read back
// as labels. Position t is the intensity a LONE town of that count paints,
// so the key describes single-town color honestly; accumulation only ever
// moves a cell further right, which the panel's title-text caveat covers.

/** A decade tick sitting closer to the peak than this is dropped — the peak
 *  label owns the bar's right end, and two labels 6% apart just collide. */
const TICK_CROWD_GAP = 0.12;

export interface HeatLegendTick {
  count: number;
  label: string;
  /** 0..1 along the gradient bar. */
  t: number;
}

/** 1736 -> "1.7k": the ticks sit on a ~10px font over a shared bar, so the
 *  labels are compact by construction. */
function compactCount(count: number): string {
  if (count < 1000) return String(count);
  const k = count / 1000;
  const rounded = k < 10 ? Math.round(k * 10) / 10 : Math.round(k);
  return `${rounded}k`;
}

/**
 * The ticks for a window whose peak is `peak` views: every whole decade from
 * 1 up, then the peak itself at t=1. A decade crowding the peak yields its
 * place to it (the peak is the more informative endpoint), which also
 * absorbs a peak that IS a power of ten. A sub-decade window has no ladder
 * to explain — every point burns at full intensity — so it gets no ticks and
 * the panel hides the key.
 */
export function heatLegendTicks(peak: number): HeatLegendTick[] {
  const top = decadeWeight(peak);
  const decades = Math.log10(top);
  if (decades <= 0) return [];

  const ticks: HeatLegendTick[] = [];
  for (let count = 1; count <= top; count *= 10) {
    const t = DECADE_FLOOR + (1 - DECADE_FLOOR) * (Math.log10(count) / decades);
    if (t > 1 - TICK_CROWD_GAP) break;
    ticks.push({ count, label: compactCount(count), t });
  }
  ticks.push({ count: top, label: compactCount(top), t: 1 });
  return ticks;
}

/**
 * The tightest box containing every plottable point, or null when there is
 * none — which is what tells the view to fall back to a plain world framing
 * rather than fitting to nothing.
 *
 * A single point yields a degenerate (zero-area) box; Leaflet accepts one and
 * centres on it, so the caller's `maxZoom` on the fit is what stops a
 * one-point dataset from slamming to street level.
 */
export function heatBounds(points: readonly HeatPoint[]): HeatBounds | null {
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;

  for (const point of points) {
    if (!isPlottable(point)) continue;
    const [lat, lng] = point;
    if (lat < minLat) minLat = lat;
    if (lng < minLng) minLng = lng;
    if (lat > maxLat) maxLat = lat;
    if (lng > maxLng) maxLng = lng;
  }

  if (minLat > maxLat) return null;
  return [
    [minLat, minLng],
    [maxLat, maxLng],
  ];
}
