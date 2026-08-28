// Bar + Sankey registration for the CUSTOMER board — deliberately NOT in
// EChart.tsx, for the reason spelled out in ./../../../../components/charts/echartsMap.ts:
// `echarts.use([...])` is a module-scope side effect, so whichever module runs
// it drags those chart types into every importer's graph. EChart.tsx is
// imported by all eleven staff panels; the bar renderer and the Sankey layout
// are used by three customer panels and by nothing else in the console.
//
// Import it for its side effect from the panel that needs it, the way
// WorldMapPanel reaches echartsMap:
//
//     import './echartsCustomer';
//
// `echarts.use` is idempotent, so several panels importing it costs one
// registration. Do NOT import it from EChart.tsx, from a staff panel, or from
// an option builder — the builders in the kit stay free of runtime echarts
// imports so a page can construct an option without pulling the library.

import * as echarts from 'echarts/core';
import { BarChart, SankeyChart } from 'echarts/charts';

echarts.use([BarChart, SankeyChart]);
