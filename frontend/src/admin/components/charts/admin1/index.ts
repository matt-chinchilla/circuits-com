// Admin-1 (state / province / prefecture) outlines, one committed asset per
// country, for the analytics map's drill-down.
//
// ── Provenance ─────────────────────────────────────────────────────────────
// Natural Earth 10m `admin_1_states_provinces` (public domain), converted
// offline on 2026-08-30. 10m is the ONLY Natural Earth admin-1 tier with
// worldwide coverage — measured: the 110m file carries the United States and
// nothing else (51 features, 1 country); the 50m file carries 9 countries;
// the 10m file carries 4,596 features across 241. The raw download is 40.7 MB
// of GeoJSON.
//
// The conversion, per country: build a TopoJSON topology (so shared borders
// stay shared and simplification cannot open gaps between neighbours),
// Visvalingam-simplify to a weight of one 1.6px triangle at this panel's
// ~600px plot width, drop islands and holes narrower than 3 rendered px,
// round coordinates to about half a rendered pixel, and strip every property
// but the four the join and the label need.
//
// ── Why one file per country, and not one file for the world ───────────────
// Measured on the converted output: 237 countries, 4.62 MB total, median
// 17.6 kB, mean 19.9 kB, largest 107 kB (the United Kingdom, whose Natural
// Earth admin-1 level is 231 districts). Concatenated and gzipped the whole
// world is 1.16 MB.
//
// A drill-down needs exactly ONE country. Per-country assets fetch ~18 kB for
// it; a single global asset would fetch 1.16 MB compressed to paint Germany —
// roughly sixty times the bytes for the same picture, on a panel whose entire
// point is that it is cheap to open. Vite gives each file its own chunk, so
// nothing is downloaded until a country is actually clicked.
//
// ── The United States is NOT here ──────────────────────────────────────────
// It keeps `../us-states-albers.geo.json`: a PRE-PROJECTED AlbersUSA frame
// whose Alaska and Hawaii insets are part of the geometry. Reprojecting it
// through the generic country path would scatter those insets back to their
// true positions and shrink the lower 48 to a corner. `US.geo.json` is
// deliberately absent from this directory so nothing can load it by accident.

/** The four properties the conversion keeps. Everything here is a JOIN key
 *  except `name`, which is also the label. */
export interface Admin1Properties {
  /** English label, `name_en` where Natural Earth carries one. */
  name: string;
  /** ISO 3166-2, e.g. `DE-BY`. Absent on a few disputed subdivisions. */
  code?: string;
  /** Other spellings for the same subdivision — local names, Natural Earth's
   *  `name_alt` alternatives, GeoNames' and Yahoo's labels. Only entries that
   *  normalize differently from `name` survive the conversion. */
  alt?: string[];
  /** COARSER groupings this subdivision sits inside (Natural Earth's `region`
   *  and `geonunit`). This is what lets "Lazio" find its five provinces and
   *  "England" find its 150 districts — DB-IP reports first-level ISO 3166-2
   *  subdivisions, which for several countries are a level ABOVE Natural
   *  Earth's admin-1. */
  in?: string[];
}

export interface Admin1Feature {
  type: 'Feature';
  properties: Admin1Properties;
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: number[][][] | number[][][][];
  };
}

export interface Admin1Collection {
  type: 'FeatureCollection';
  features: Admin1Feature[];
}

// One lazy loader per committed file. `import.meta.glob` is what keeps this
// list from being a generated constant that could drift from the directory:
// the keys ARE the directory. It is lazy by default, so this module costs a
// map of thunks and no geometry.
const ASSETS = import.meta.glob<{ default: Admin1Collection }>('./*.geo.json');

const CODE_FROM_PATH = /^\.\/([A-Z]{2})\.geo\.json$/;

/** Every country this panel can draw shapes for — ISO alpha-2, US excluded
 *  (it has its own asset; see the note above). A country with visitor data
 *  but no entry here still drills in and still lists its regions; there is
 *  simply no geometry to paint them on. */
export const ADMIN1_COUNTRIES: ReadonlySet<string> = new Set(
  Object.keys(ASSETS)
    .map((path) => CODE_FROM_PATH.exec(path)?.[1])
    .filter((code): code is string => code !== undefined),
);

/** Fetch one country's outlines. Rejects for a country with no asset, which
 *  the caller degrades the same way it degrades a failed chunk — the rank
 *  rail keeps working and the map box says what happened. */
export function loadAdmin1(code: string): Promise<Admin1Collection> {
  const load = ASSETS[`./${code}.geo.json`];
  if (!load) return Promise.reject(new Error(`no admin-1 asset for ${code}`));
  return load().then((mod) => mod.default);
}
