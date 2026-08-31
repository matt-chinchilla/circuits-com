// The two ECharts options behind the geography panel, as pure builders.
//
// Split out of WorldMapPanel (2026-08-30) so the SHAPE of each shipped option
// is unit-testable: the panel around them is state, refs and effects no test
// in this repo can drive, while everything a regression would silently break
// — roam, the per-item bin fills, the absence of a visualMap, the suppressed
// emphasis labels — is a plain object this file returns.
//
// ── The two views differ STRUCTURALLY, not just in data ────────────────────
//   world — a bare `series-map` over `world110`, naturalEarth1-projected.
//   us    — a `geo` COMPONENT carrying the states, with the choropleth map
//           series bound by `geoIndex` and the city scatter bound by
//           `coordinateSystem: 'geo'`. A scatter cannot address a map series'
//           private coordinate system, so the dots are what force the geo
//           component; the world view is left alone.
//
// The palette is THERMAL — an inferno slice, cool-dark to hot, which is the
// palette a reader already associates with a heat map. The ramp, its
// measurements and the reason the bottom stop sits where it does all live in
// viewershipBins.ts — change it there, never here.

import type { EChartsCoreOption } from 'echarts/core';
import type { AnalyticsData } from '@admin/types/admin';
import { countryName, flagEmoji } from '@admin/services/country';
import {
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

const LAND_NO_DATA = '#1a2440';
const BORDER = '#2b3a5e';
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
/** A state that HAS data also gets this edge, so the choropleth reads as
 *  color-coded even where the COOL low bins sit close to the empty navy —
 *  that is the job, and this orchid is picked for it: measured 4.98:1 against
 *  the empty land and 2.87:1 against bin 1, staying in the purple family that
 *  anchors the ramp's cool end. It goes quiet against the hot bins (1.20:1 on
 *  bin 4), which is fine — a state that bright needs no edge to be noticed. */
const VISITED_BORDER = '#b083bd';

const WORLD_PROJECTION = {
  project: naturalEarth1Project,
  unproject: naturalEarth1Unproject,
};
// Identity, and NOT omitted — see the Y-convention note in mapProjections.ts.
const US_PROJECTION = { project: usPlanarProject, unproject: usPlanarUnproject };

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
 *  frame), so the box no longer reserves a bottom row for it. The panel reads
 *  these same insets to size the plot for its click-to-zoom fit math. */
export const MAP_BOX = { top: 8, bottom: 10, left: 8, right: 8 };

const LAND_STYLE = {
  itemStyle: { areaColor: LAND_NO_DATA, borderColor: BORDER, borderWidth: 0.6 },
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
        data: countries.map((c) => ({
          name: c.code,
          value: c.views,
          itemStyle: { areaColor: binColorFor(c.views, bins) },
        })),
      },
    ],
  };
}

/** The US drill-down: the geo component carrying the state outlines, the
 *  choropleth bound to it by `geoIndex`, and the city dots on top of both. */
export function buildUsOption({
  stateRows,
  cityPoints,
  bins,
}: {
  stateRows: UsStateRow[];
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
        const row = stateRows.find((s) => s.name === name);
        if (!row) return `${name}<br/>No visits recorded`;
        return `${name}<br/>${plural(row.views, 'view')} · ${plural(row.visitors, 'visitor')}`;
      },
    },
    geo: {
      map: US_MAP_NAME,
      nameProperty: 'name',
      projection: US_PROJECTION,
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
      regions: stateRows.map((s) => ({
        name: s.name,
        itemStyle: {
          areaColor: binColorFor(s.views, bins),
          borderColor: VISITED_BORDER,
          borderWidth: 0.9,
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
        // Values only — the paint is on `geo.regions` above. The series still
        // carries the numbers so the tooltip and hit-testing work.
        data: stateRows.map((s) => ({ name: s.name, value: s.views })),
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
