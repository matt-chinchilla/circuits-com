// Map projections for the analytics geography panel (world + US drill-down).
//
// Ported from d3-geo / d3-geo-projection (ISC) rather than depended on:
//   - naturalEarth1  — the raw polynomial + its Newton invert
//   - albersUsa      — the composite lower-48 / Alaska / Hawaii conic
// d3-geo is a stream/clip machine we would use two functions of, and the whole
// of what those two functions are is the arithmetic below. No dependency.
//
// ── The Y convention (measured against echarts 6.1.0, 2026-08-30) ──────────
// `coord/geo/Geo.js` forces `View`'s `invertY` to FALSE whenever a custom
// `projection` is supplied. So with a projection in play ECharts consumes
// projected space with y increasing DOWNWARD — screen order, the same
// convention as the mercator sample in its own docs. Both consequences were
// confirmed by rendering headless (`ssr: true`) and comparing a northern probe
// against a southern one:
//   - naturalEarth1's raw y is north-POSITIVE, so it is negated here. Without
//     the negation the world renders upside down.
//   - the committed `us-states-albers.geo.json` is ALREADY y-down (d3 emits
//     SVG coordinates), so the US series takes the IDENTITY pair below.
//     Negating THAT one is what flips the country upside down.
// A raw lat/lon map with NO projection set is a third case — ECharts flips it
// itself (invertY true), which is why the world panel looked right before.

type Point = [number, number];

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

// ── naturalEarth1 ──────────────────────────────────────────────────────────
// Tom Patterson's compromise pseudocylindrical: straight parallels, curved
// meridians, poles as lines. Chosen over raw equirectangular because a 300px
// -tall card stretches equirectangular's high latitudes into nonsense.

/** [lng, lat] degrees -> planar, y DOWN (ECharts screen convention). */
export function naturalEarth1Project(point: Point): Point {
  const lambda = point[0] * DEG;
  const phi = point[1] * DEG;
  const phi2 = phi * phi;
  const phi4 = phi2 * phi2;
  const x =
    lambda *
    (0.8707 - 0.131979 * phi2 + phi4 * (-0.013791 + phi4 * (0.003971 * phi2 - 0.001529 * phi4)));
  const y =
    phi * (1.007226 + phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4)));
  return [x, -y];
}

/** Inverse of `naturalEarth1Project`. y is a degree-11 odd polynomial in phi
 *  with no closed-form root, so d3 solves it by Newton iteration; the
 *  derivative below is that polynomial differentiated term by term. */
export function naturalEarth1Unproject(point: Point): Point {
  const x = point[0];
  const y = -point[1]; // undo the screen-order negation before solving
  let phi = y;
  for (let i = 0; i < 25; i++) {
    const phi2 = phi * phi;
    const phi4 = phi2 * phi2;
    const f =
      phi * (1.007226 + phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4))) -
      y;
    const df =
      1.007226 +
      phi2 * (0.015085 * 3 + phi4 * (-0.044475 * 7 + 0.028874 * 9 * phi2 - 0.005916 * 11 * phi4));
    const delta = f / df;
    phi -= delta;
    if (Math.abs(delta) < 1e-12) break;
  }
  const phi2 = phi * phi;
  const lambda =
    x /
    (0.8707 +
      phi2 * (-0.131979 + phi2 * (-0.013791 + phi2 * phi2 * phi2 * (0.003971 - 0.001529 * phi2))));
  return [lambda / DEG, phi / DEG];
}

// ── albersUsa ──────────────────────────────────────────────────────────────
// Three conic equal-area projections stitched by clip rectangle: the lower 48,
// then an Alaska inset at 0.35 scale, then Hawaii. A coordinate that misses all
// three rectangles is not in the frame at all, and projects to null.

interface ConicSpec {
  /** Standard parallels, degrees. */
  parallels: [number, number];
  /** d3 `.rotate([x, 0])` — degrees ADDED to longitude before projecting. */
  rotateLambda: number;
  /** d3 `.center()`, degrees, in post-rotation space. */
  center: Point;
  scale: number;
  translate: Point;
  /** d3 `.clipExtent()` — [[x0, y0], [x1, y1]] in output pixels, inclusive. */
  clip: [Point, Point];
}

/** One d3 `conicEqualArea` collapsed to a point-only function. The projection
 *  pipeline d3 builds around the raw formula reduces, for a single point with
 *  no reflect and no post-rotation, to `translate + scale * (raw - rawCenter)`
 *  with y negated — that is `scaleTranslate` composed with `recenter`. */
function conicEqualArea(spec: ConicSpec): (point: Point) => Point | null {
  const sy0 = Math.sin(spec.parallels[0] * DEG);
  const n = (sy0 + Math.sin(spec.parallels[1] * DEG)) / 2;
  // d3 falls back to a cylindrical equal-area when |n| < epsilon (parallels
  // symmetric about the equator). None of the three pairs used here is, so
  // that branch is unreachable and is not ported.
  const c = 1 + sy0 * (2 * n - sy0);
  const r0 = Math.sqrt(c) / n;
  const raw = (lambda: number, phi: number): Point => {
    const r = Math.sqrt(c - 2 * n * Math.sin(phi)) / n;
    const t = lambda * n;
    return [r * Math.sin(t), r0 - r * Math.cos(t)];
  };

  const k = spec.scale;
  const [cx, cy] = raw(spec.center[0] * DEG, spec.center[1] * DEG);
  const dx = spec.translate[0] - k * cx;
  const dy = spec.translate[1] + k * cy;
  const [[x0, y0], [x1, y1]] = spec.clip;

  return (point) => {
    let lambda = (point[0] + spec.rotateLambda) * DEG;
    if (lambda > Math.PI) lambda -= TAU;
    else if (lambda < -Math.PI) lambda += TAU;
    const [px, py] = raw(lambda, point[1] * DEG);
    const x = dx + k * px;
    const y = dy - k * py;
    if (x < x0 || x > x1 || y < y0 || y > y1) return null;
    return [x, y];
  };
}

// us-atlas@3 generates states-albers-10m.json with
// `geoAlbersUsa().scale(1300).translate([487.5, 305])` into a 975x610 frame.
// Reproducing those two numbers exactly is what puts a projected city dot in
// the same planar space as the committed state outlines — change one and the
// dots drift off the states.
const K = 1300;
const UX = 487.5;
const UY = 305;
const EPS = 1e-6; // d3's epsilon, kept so the inset seams land identically

const LOWER_48 = conicEqualArea({
  parallels: [29.5, 45.5],
  rotateLambda: 96,
  center: [-0.6, 38.7],
  scale: K,
  translate: [UX, UY],
  clip: [
    [UX - 0.455 * K, UY - 0.238 * K],
    [UX + 0.455 * K, UY + 0.238 * K],
  ],
});

const ALASKA = conicEqualArea({
  parallels: [55, 65],
  rotateLambda: 154,
  center: [-2, 58.5],
  scale: K * 0.35,
  translate: [UX - 0.307 * K, UY + 0.201 * K],
  clip: [
    [UX - 0.425 * K + EPS, UY + 0.12 * K + EPS],
    [UX - 0.214 * K - EPS, UY + 0.234 * K - EPS],
  ],
});

const HAWAII = conicEqualArea({
  parallels: [8, 18],
  rotateLambda: 157,
  center: [-3, 19.9],
  scale: K,
  translate: [UX - 0.205 * K, UY + 0.212 * K],
  clip: [
    [UX - 0.214 * K + EPS, UY + 0.166 * K + EPS],
    [UX - 0.115 * K - EPS, UY + 0.234 * K - EPS],
  ],
});

/** [lng, lat] degrees -> the 975x610 us-atlas planar frame, y DOWN.
 *  `null` when the point falls outside all three zones (a bad centroid, or a
 *  city the geo database placed offshore) — callers skip those silently. */
export function albersUsaProject(point: Point): Point | null {
  return LOWER_48(point) ?? ALASKA(point) ?? HAWAII(point);
}

// ── The US series projection ───────────────────────────────────────────────
// Identity, NOT absent: see the Y-convention note at the top. Supplying a
// projection is what tells ECharts the source is already planar (it stops
// flipping y and stops applying the 0.75 geoJSON aspectScale); the transform
// itself is a no-op. Copies rather than returning the caller's array, so
// ECharts can never alias its own scratch buffer.

export function usPlanarProject(point: Point): Point {
  return [point[0], point[1]];
}

export function usPlanarUnproject(point: Point): Point {
  return [point[0], point[1]];
}
