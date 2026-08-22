// Map-only ECharts registration — deliberately NOT in EChart.tsx.
//
// ── Why this file exists ───────────────────────────────────────────────────
// `echarts.use([...])` is a side effect at module scope, so whatever module
// performs it drags those chart/component modules into its importer's graph.
// MapChart + VisualMapComponent are used by exactly ONE panel in the whole
// admin console (reports/WorldMapPanel — Visitors by Country), but they used
// to be registered in EChart.tsx, which all six Dashboard panels import. Every
// admin chart page therefore paid for the map renderer, the geo coordinate
// system and the visualMap component it never renders.
//
// Keeping them here means only WorldMapPanel reaches them in the SOURCE graph,
// and Dashboard no longer runs the map/geo/visualMap `install` functions.
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
import { MapChart } from 'echarts/charts';
import { VisualMapComponent } from 'echarts/components';

echarts.use([MapChart, VisualMapComponent]);

/** Register a GeoJSON map once per name (WorldMapPanel lazy-loads the
 *  committed world-110m asset and hands it here before first render). */
const registeredMaps = new Set<string>();

export function registerMapOnce(name: string, geoJson: object): void {
  if (registeredMaps.has(name)) return;
  echarts.registerMap(name, geoJson as Parameters<typeof echarts.registerMap>[1]);
  registeredMaps.add(name);
}
