// The two ECharts options behind the geography panel, as pure builders.
//
// Split out of WorldMapPanel (2026-08-30) so the SHAPE of each shipped option
// is unit-testable: the panel around them is state, refs and effects no test
// in this repo can drive, while everything a regression would silently break
// — roam, the per-item bin fills, the absence of a visualMap, the suppressed
// emphasis labels — is a plain object this file returns.
//
// ── The two views differ STRUCTURALLY, not just in data ────────────────────
//   world   — a bare `series-map` over `world110`, naturalEarth1-projected.
//   country — a `geo` COMPONENT carrying the subdivisions, with the
//             choropleth map series bound by `geoIndex` and the city scatter
//             bound by `coordinateSystem: 'geo'`. A scatter cannot address a
//             map series' private coordinate system, so the dots are what
//             force the geo component; the world view is left alone.
//
// ── One country builder, two callers (2026-08-30) ──────────────────────────
// The drill-down was United-States-only and `buildUsOption` was its builder.
// Every country drills in now, and rather than a second near-copy the US is
// one CALL of `buildCountryOption` — same option shape, same regressions
// guarded once. What varies is only what genuinely differs between them:
//
//   registered map name  — one asset per country.
//   projection           — the US asset is PRE-PROJECTED (AlbersUSA, insets
//                          and all), so it takes the identity; every other
//                          country ships lat/lng and takes mercator.
//   region entries       — a US state row IS a feature name. Elsewhere one
//                          DB-IP subdivision can own several Natural Earth
//                          features (England is 150 districts), so the caller
//                          hands over a per-FEATURE list carrying the label
//                          and numbers of the row that owns it.
//
// The palette is THERMAL — an inferno slice, cool-dark to hot, which is the
// palette a reader already associates with a heat map. The ramp, its
// measurements and the reason the bottom stop sits where it does all live in
// viewershipBins.ts — change it there, never here.

import type { EChartsCoreOption } from 'echarts/core';
import type { AnalyticsData } from '@admin/types/admin';
import { countryName, flagEmoji } from '@admin/services/country';
import {
  mercatorProject,
  mercatorUnproject,
  naturalEarth1Project,
  naturalEarth1Unproject,
  usPlanarProject,
  usPlanarUnproject,
} from './mapProjections';
import { plural } from './cityIntel';
import { binColorFor } from './viewershipBins';
import type { ViewershipBin } from './viewershipBins';
import { MAX_STATE_ZOOM } from './usZoom';

/** Registered map names — `registerMapOnce` in the panel and `map:` here must
 *  agree, so both read them from one place. */
export const MAP_NAME = 'world110';
export const US_MAP_NAME = 'usStatesAlbers';

export type CountryRow = AnalyticsData['countries'][number];
export type UsStateRow = NonNullable<AnalyticsData['us_states']>[number];
export type UsCityRow = NonNullable<AnalyticsData['us_cities']>[number];

/** A city already projected into the states asset's planar frame. The whole
 *  source row rides along as `row` so the click handler reads it straight off
 *  `params.data` — matching a clicked dot back by name would break the moment
 *  two states share a town name. */
export interface CityPoint {
  name: string;
  value: [number, number, number];
  symbolSize: number;
  itemStyle: { color: string };
  row: UsCityRow;
}

/** The geography's own base, retinted 2026-08-31 (owner: "very hard to see the
 *  different countries against the dark-blue"). The canvas stays transparent;
 *  what shows behind it is the SEA PLATE `.wmStage` paints in the SCSS —
 *  #0b1020, DARKER than the card, with a faint graticule that only ever shows
 *  over open water because opaque land covers it. Land is a lifted slate that
 *  reads as ground against that sea (1.55:1, up from 1.19:1 against the old
 *  card-as-ocean), and the border doubles as the COASTLINE — 2.57:1 against
 *  the sea is what makes a continent's edge findable at world scale. Ceiling
 *  on the land tone: bin 1 of the ramp (#7b3fa0) must stay clear of it —
 *  1.78:1 measured, and viewershipBins.test.ts pins the >1.6 floor. */
const LAND_NO_DATA = '#2a3550';
const BORDER = '#44557f';
/** Hover reads as HEAT taken to its limit — a pale gold above the ramp's
 *  hottest stop — so the highlight belongs to the same language as the fill
 *  underneath it instead of arriving from a different palette. */
const HOVER_LAND = '#ffe3a3';
const HOVER_BORDER = '#fff3d6';
/** City dots are ringed in the card's own ground rather than tinted: each dot
 *  wears its OWN bin's color, so the only thing that can separate a dot from
 *  a hot state beneath it is a dark edge. */
const CITY_DOT_EDGE = '#0f1526';
const CITY_DOT_EDGE_HOVER = '#fff3d6';
/** A region that HAS data also gets this edge, so the choropleth reads as
 *  color-coded even where the COOL low bins sit close to the empty slate —
 *  that is the job, and this orchid is picked for it: measured 3.96:1 against
 *  the empty land and 2.23:1 against bin 1, staying in the purple family that
 *  anchors the ramp's cool end. It goes quiet against the hot bins, which is
 *  fine — a region that bright needs no edge to be noticed. */
const VISITED_BORDER = '#b083bd';

const WORLD_PROJECTION = {
  project: naturalEarth1Project,
  unproject: naturalEarth1Unproject,
};
/** Identity, and NOT omitted — see the Y-convention note in mapProjections.ts.
 *  Exported for the same reason COUNTRY_PROJECTION is: the panel hands this
 *  exact function to `featureBounds`, so the zoom fit is measured in the
 *  space the renderer actually draws in. */
export const US_PROJECTION = { project: usPlanarProject, unproject: usPlanarUnproject };

// SECURITY: every tooltip `formatter` below returns an HTML string. All
// interpolated values today come from the committed geojson properties or
// the API's own place labels — never from anything a visitor controls (UA,
// referrer and path never reach a geo field). Keep it that way: free-form
// strings like network names belong on the intel card, which renders React
// TEXT nodes, not here.
const TOOLTIP_CHROME = {
  backgroundColor: '#141d36',
  borderColor: '#2b3a63',
  textStyle: { color: '#e8eef9', fontSize: 12 },
};

/** Layout shared by both views so the two maps sit in the same box. The
 *  legend lives in the DOM below the canvas (owner call, 2026-08-30 — the
 *  in-canvas visualMap printed on top of the states once a zoom filled the
 *  frame), so the box no longer reserves a bottom row for it.
 *
 *  ── `preserveAspect` is THE geometry fix (2026-08-31) ─────────────────────
 *  Without it ECharts STRETCHES the geography to exactly fill this box — it
 *  fits, it never letterboxes. Measured on the live canvas by scanning the
 *  drawn ink's bounding box: the ink aspect equalled the plot-rect aspect at
 *  every viewport, so the world (true projected aspect 2.298) rendered at
 *  0.833 on a 320px phone — 2.8x too tall — and at 1.93 on a 1440px desktop.
 *  It is NOT a mobile-only bug; every size was warped, by a different amount.
 *
 *  The mechanism, from echarts 6.1.0 source: `coord/geo/geoCreator.js`
 *  computes the right aspect (`rect.width / rect.height * aspectScale`) and
 *  then `util/layout.js applyPreserveAspect` DISCARDS it unless this option
 *  is set — `GeoModel.defaultOption` never sets it, and `getLayoutRect` only
 *  consults an aspect when a dimension is indeterminate, which the four
 *  insets above never leave. `aspectScale` is not an alternative lever:
 *  `Geo.js` pins it to 1 whenever a custom `projection` is supplied, which
 *  is always, here.
 *
 *  `true` means CONTAIN, centered (`'cover'` is the crop variant) — so the
 *  box's shape is now a free design choice and no CSS change can warp the
 *  map again. It lives on MAP_BOX rather than in each builder because the
 *  guarantee is only worth anything if BOTH views have it, and both spread
 *  this one object.
 *
 *  `roamTrigger` is the other half of the same change, not a spare: roam is
 *  hit-tested against `coordinateSystem.containPoint` (`MapDraw.js`), which
 *  is the FITTED rect — so the open water that letterboxing creates would
 *  swallow the wheel and the drag. 'global' hands the whole canvas back. */
export const MAP_BOX = {
  top: 8,
  bottom: 10,
  left: 8,
  right: 8,
  preserveAspect: true,
  roamTrigger: 'global',
};

/** The world asset's TRUE projected aspect: the naturalEarth1 extent of
 *  `world-110m.geo.json` with Antarctica filtered out, width / height =
 *  5.404999 / 2.351896. Computed over every ring of every feature, and
 *  re-derived from the committed asset by `mapAspect.test.ts` so it cannot
 *  drift if the asset is ever replaced.
 *
 *  The panel publishes this to the SCSS as `--wm-aspect`, which is why the
 *  number lives here and not in ReportsPage.module.scss: the frame the sea
 *  plate draws and the geometry ECharts fits into it are then the same
 *  measurement, and a stale CSS ratio can only ever cost a band of open
 *  water — never a stretched continent. */
export const WORLD_FRAME_ASPECT = 2.2981;

const LAND_STYLE = {
  // 0.8, up from the shipped 0.6 hairline — at world scale the border is the
  // only thing separating unvisited neighbours, and 0.6 of the old ink was
  // invisible (1.36:1 over the land it divided; now 1.65:1 over the lighter
  // land and it holds a visible line).
  itemStyle: { areaColor: LAND_NO_DATA, borderColor: BORDER, borderWidth: 0.8 },
  emphasis: {
    label: { show: false },
    itemStyle: { areaColor: HOVER_LAND, borderColor: HOVER_BORDER },
  },
  select: { disabled: true },
};

/** The world choropleth: countries colored per item off the shared bins (the
 *  DOM legend below the canvas is the one scale for everything) — there is no
 *  visualMap anywhere in this panel anymore, so an empty map needs no special
 *  casing to stay honestly navy. */
export function buildWorldOption({
  countries,
  bins,
}: {
  countries: CountryRow[];
  bins: ViewershipBin[];
}): EChartsCoreOption {
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      ...TOOLTIP_CHROME,
      formatter: (p: { name?: string; value?: number }) => {
        const code = p.name ?? '';
        if (!code) return '';
        const v = typeof p.value === 'number' && !Number.isNaN(p.value) ? p.value : 0;
        const row = countries.find((c) => c.code === code);
        const visitors = row ? ` · ${plural(row.visitors, 'visitor')}` : '';
        return `${flagEmoji(code)} ${countryName(code)}<br/>${plural(v, 'view')}${visitors}`;
      },
    },
    series: [
      {
        type: 'map',
        map: MAP_NAME,
        nameProperty: 'iso',
        projection: WORLD_PROJECTION,
        // Wheel-over-map means "zoom the map", not "scroll the page" — owner
        // call, 2026-08-30, after the world view ignored the wheel while the
        // US view obeyed it. Both views roam, under the same ceiling.
        roam: true,
        scaleLimit: { min: 1, max: MAX_STATE_ZOOM },
        ...MAP_BOX,
        ...LAND_STYLE,
        // The visited edge the country views already wear (2026-08-31). Now
        // that empty land is light enough to read as land, the orchid ring is
        // what keeps a 1-view country — often a small polygon in a crowded
        // neighbourhood — louder than the ground around it.
        data: countries.map((c) => ({
          name: c.code,
          value: c.views,
          itemStyle: {
            areaColor: binColorFor(c.views, bins),
            borderColor: VISITED_BORDER,
            borderWidth: 0.9,
          },
        })),
      },
    ],
  };
}

/** One paintable feature: the polygon's own name in the asset, plus the label
 *  and numbers of the subdivision that owns it. For the United States the
 *  three collapse into one state row; elsewhere `feature` is a Natural Earth
 *  admin-1 polygon and `label` is the DB-IP subdivision above it. */
export interface RegionPaint {
  feature: string;
  label: string;
  views: number;
  visitors: number;
}

/** A country drill-down: the geo component carrying that country's outlines,
 *  the choropleth bound to it by `geoIndex`, and the city dots on top of
 *  both. */
export function buildCountryOption({
  mapName,
  projection,
  regions,
  cityPoints,
  bins,
}: {
  mapName: string;
  projection: { project: (p: [number, number]) => [number, number]; unproject: (p: [number, number]) => [number, number] };
  regions: RegionPaint[];
  cityPoints: CityPoint[];
  bins: ViewershipBin[];
}): EChartsCoreOption {
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      ...TOOLTIP_CHROME,
      formatter: (p: {
        seriesType?: string;
        name?: string;
        value?: number | number[];
        data?: { name?: string; value?: number[] };
      }) => {
        const name = p.name ?? '';
        if (!name) return '';
        if (p.seriesType === 'scatter') {
          const views = p.data?.value?.[2] ?? 0;
          return `${name}<br/>${plural(views, 'view')}`;
        }
        // Hit-testing names the POLYGON; the reader wants the subdivision the
        // API reported. Hovering any English district must say "England".
        const row = regions.find((r) => r.feature === name);
        if (!row) return `${name}<br/>No visits recorded`;
        return `${row.label}<br/>${plural(row.views, 'view')} · ${plural(row.visitors, 'visitor')}`;
      },
    },
    geo: {
      map: mapName,
      nameProperty: 'name',
      projection,
      roam: true,
      scaleLimit: { min: 1, max: MAX_STATE_ZOOM },
      ...MAP_BOX,
      ...LAND_STYLE,
      // THE FILLS LIVE HERE, NOT ON THE SERIES DATA (fixed 2026-08-30 after
      // shipping the bug). A `series-map` bound through `geoIndex` hands
      // region rendering to the geo component, and the series' per-item
      // `itemStyle` is then ignored — the world view colors correctly only
      // because it has no geo component. Symptom to recognise: every state
      // paints LAND_NO_DATA navy while the city dots keep their colors.
      // Measured on the live canvas: 117,011 navy pixels against 367 of ramp.
      // Each region ALSO re-asserts the no-label hover (found 2026-08-30 on
      // the live canvas): after the click-to-zoom's merge-setOption touches
      // the geo, hovering a state started stamping its name in ECharts'
      // default grey even though the component-level suppression above was
      // still in the option. Region-level emphasis survives that path; the
      // hover fill is repeated with it so the highlight stays in the ramp's
      // language rather than falling back to ECharts' default gold.
      regions: regions.map((r) => ({
        name: r.feature,
        itemStyle: {
          areaColor: binColorFor(r.views, bins),
          borderColor: VISITED_BORDER,
          borderWidth: 0.9,
        },
        emphasis: {
          label: { show: false },
          itemStyle: { areaColor: HOVER_LAND, borderColor: HOVER_BORDER },
        },
      })),
    },
    series: [
      {
        type: 'map',
        geoIndex: 0,
        // The geo component's no-label emphasis does NOT reach the series —
        // without this, hovering a state stamps its name on the map while
        // hovering a country never does.
        emphasis: { label: { show: false } },
        // And neither does the geo's disabled SELECT (found 2026-08-30 on
        // the live canvas): the click that zooms a state was ALSO selecting
        // it on this series, leaving the state parked in ECharts' default
        // select style — pale gold fill with a grey name stamped on it —
        // until the next click. The world view never showed it because its
        // series carries the full LAND_STYLE, select.disabled included.
        select: { disabled: true },
        // Values only — the paint is on `geo.regions` above. The series still
        // carries the numbers so the tooltip and hit-testing work.
        data: regions.map((r) => ({ name: r.feature, value: r.views })),
      },
      {
        type: 'scatter',
        coordinateSystem: 'geo',
        geoIndex: 0,
        symbol: 'circle',
        // Near-opaque: the fill has to match its legend swatch to be worth
        // reading off the legend at all. Overlapping dots are separated by
        // the ring, not by translucency.
        itemStyle: {
          opacity: 0.9,
          borderColor: CITY_DOT_EDGE,
          borderWidth: 1,
        },
        emphasis: {
          scale: 1.2,
          itemStyle: { opacity: 1, borderColor: CITY_DOT_EDGE_HOVER, borderWidth: 1.4 },
        },
        label: { show: false },
        data: cityPoints,
      },
    ],
  };
}

/** The United States drill-down — the country builder above, wired to the
 *  pre-projected AlbersUSA asset. A state row IS its own polygon here, so the
 *  join the rest of the world needs collapses to the identity. */
export function buildUsOption({
  stateRows,
  cityPoints,
  bins,
}: {
  stateRows: UsStateRow[];
  cityPoints: CityPoint[];
  bins: ViewershipBin[];
}): EChartsCoreOption {
  return buildCountryOption({
    mapName: US_MAP_NAME,
    projection: US_PROJECTION,
    regions: stateRows.map((s) => ({
      feature: s.name,
      label: s.name,
      views: s.views,
      visitors: s.visitors,
    })),
    cityPoints,
    bins,
  });
}

/** The projection every non-US country view uses. Exported so the panel can
 *  hand the SAME function to `featureBounds` — a zoom fitted in unprojected
 *  degrees would be wrong by exactly the projection's own distortion. */
export const COUNTRY_PROJECTION = {
  project: mercatorProject,
  unproject: mercatorUnproject,
};
