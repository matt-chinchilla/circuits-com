// Map-only ECharts registration — deliberately NOT in EChart.tsx.
//
// ── Why this file exists ───────────────────────────────────────────────────
// `echarts.use([...])` is a side effect at module scope, so whatever module
// performs it drags those chart/component modules into its importer's graph.
// Everything registered below is used by exactly ONE panel in the whole admin
// console (reports/WorldMapPanel — Visitors by Country), but MapChart +
// VisualMapComponent used to be registered in EChart.tsx, which all six
// Dashboard panels import. Every admin chart page therefore paid for the map
// renderer, the geo coordinate system and the visualMap component it never
// renders.
//
// Keeping them here means only WorldMapPanel reaches them in the SOURCE graph,
// and Dashboard no longer runs the map/geo/visualMap `install` functions.
//
// ── What is registered, and why each one ───────────────────────────────────
//   MapChart           — both choropleths (world countries, US states).
//   GeoComponent       — the US drill-down only. A `series-scatter` can bind
//                        to `coordinateSystem: 'geo'` but NOT to a map
//                        series' private coordinate system, so the city-dot
//                        layer forces the US view into a `geo` component with
//                        the map series attached by `geoIndex`. The world view
//                        stays a bare map series and never installs it at
//                        runtime (the import cost is shared either way).
//   ScatterChart       — the US city dots.
//   (VisualMapComponent was here 2026-08-30, briefly: the in-canvas legend
//   painted over the states once a zoom filled the frame, so the legend is
//   DOM now and every region/dot is colored per data item instead.)
//
// ── The byte split is NOT achievable today (measured 2026-08-21) ───────────
// `vite.config.ts` manualChunks groups by module path, so all of
// node_modules/echarts lands in one `echarts` chunk regardless of importer —
// this move alone leaves that chunk byte-identical (697.00 kB / 236.32 kB gz).
// Forcing `lib/chart/map/*` + `lib/component/visualMap/*` into an
// `echarts-map` chunk DOES split them (643.94 + 54.79 kB) but Rollup then
// reports `Circular chunk: echarts-map -> echarts -> echarts-map`, because the
// `lib/export/charts.js` barrel statically re-exports MapChart. The core chunk
// then imports the map chunk, so any page loading echarts fetches BOTH
// (659.60 + 38.67 = 698.27 kB — larger than the monolith). Breaking that edge
// needs deep `echarts/lib/...` imports, which the package `exports` map blocks
// and which ship no `.d.ts`. Do not re-attempt without an upstream fix.
//
// Do NOT import this from EChart.tsx or from any Dashboard panel.

import * as echarts from 'echarts/core';
import { MapChart, ScatterChart } from 'echarts/charts';
import { GeoComponent } from 'echarts/components';

echarts.use([MapChart, ScatterChart, GeoComponent]);

/** Register a GeoJSON map once per name (WorldMapPanel lazy-loads the
 *  committed world-110m and us-states-albers assets and hands each here
 *  before that view's first render). */
const registeredMaps = new Set<string>();

export function registerMapOnce(name: string, geoJson: object): void {
  if (registeredMaps.has(name)) return;
  echarts.registerMap(name, geoJson as Parameters<typeof echarts.registerMap>[1]);
  registeredMaps.add(name);
}
