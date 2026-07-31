# Admin chart kit — Apache ECharts

Everything the admin console needs to draw a chart. Nothing here is imported by
`src/public/` (the ESLint boundary forbids it) and nothing here may be promoted
to `@shared/` — the public site has no charts, so the ≥2-consumer rule is not
met.

```
charts/
  EChart.tsx            React wrapper — init / setOption / resize / DISPOSE
  chartTheme.ts         palette + registered theme (PURE: no echarts import)
  packHierarchy.ts      deterministic 2-level circle packing (no deps) — currently
                        unused; its only consumer (circlePackOption) was superseded
                        by the sales-force graph
  options/
    index.ts            barrel for the pure builders
    sparklineOption.ts
    comparatorOption.ts (+ expensesOption alias, month/trend adapters)
    pieOption.ts
    salesForceOption.ts (+ salesForcePhysics.ts — the interaction layer, NOT in the barrel)
    tooltip.ts          shared, HTML-ESCAPED tooltip markup
```

## Import paths — do not add a mixed barrel

`EChart.tsx` has module-level side effects (`echarts.use(...)`,
`registerTheme(...)`), so Rollup cannot tree-shake it out of a barrel. A single
`charts/index.ts` re-exporting both the wrapper and the pure builders would drag
the whole echarts chunk into any module that only wanted a palette constant.
Import explicitly:

```ts
import EChart from '@admin/components/charts/EChart';
import { comparatorOption } from '@admin/components/charts/options';
import { CHART_SERIES, CHART_TIER_RAMP } from '@admin/components/charts/chartTheme';
```

## Bundle rule

`vite.config.ts` routes `node_modules/echarts` and `node_modules/zrender` into
their own `echarts` chunk. That chunk stays **async** only while every importer
is reachable solely through a lazy route.

**`AdminLayout` is imported EAGERLY in `App.tsx`.** Import charts only from a
lazy `@admin/pages/*` module. Never from `AdminLayout`, `Navbar`, `@shared/`,
or anything the public entry statically reaches — otherwise echarts lands in
the public entry and the public LCP budget pays for it. Verify after any change:

```bash
cd frontend && npm run build
# echarts-*.js must be its own chunk, and index-*.js must not contain it
node -e "const fs=require('fs');const d='dist/assets';\
const idx=fs.readdirSync(d).find(f=>/^index-.*\.js$/.test(f));\
console.log('echarts in index:', /zrender|echarts/i.test(fs.readFileSync(d+'/'+idx,'utf8')));"
```

## Registered surface

`EChart.tsx` registers exactly: `LineChart`, `PieChart`, `CustomChart`,
`GridComponent`, `TooltipComponent`, `LegendComponent`, `GraphicComponent`,
`MarkLineComponent`, `CanvasRenderer`. Anything else is tree-shaken away, so a
`series.type` / component this list does not cover renders **nothing** (ECharts
logs a "Series … is not registered" hint in dev). `MarkPointComponent` is NOT
registered — the sparkline's trailing dot is a per-datum `symbolSize` override
instead. `TooltipComponent` transitively installs the axis pointer used by
`tooltip.axisPointer.type: 'cross'`.

## Palette (dataviz-validated 2026-07-30, light mode, surface `#ffffff`)

Charts render on `--a-card` `#ffffff`, not `--a-bg`.

| slot | role | hex | note |
|---|---|---|---|
| 1 | green | `#0e7a49` | 5.39:1 |
| 2 | blue | `#2563eb` | 5.17:1, `= --a-blue` |
| 3 | gold | `#a88d2e` | 3.22:1, `= $sponsor-gold` |
| 4 | purple | `#7c3aed` | 5.70:1, `= --a-purple` |

```
[PASS] Lightness band   all 4 inside L 0.43–0.77
[PASS] Chroma floor     all 4 >= 0.1
[PASS] CVD separation   worst adjacent #2563eb↔#0e7a49 ΔE 25.6 (deutan)
[PASS] Normal-vision    worst adjacent ΔE 27.6
[PASS] Contrast         all 4 >= 3:1
```

Three findings encoded in code, not left to taste:

1. **`#2563eb` and `#7c3aed` collapse under deuteranopia (ΔE 0.4).** Never
   adjacent slots; never together in an all-pairs form. Hence
   `CHART_SERIES_ALLPAIRS` (3 colors) for scatter / bubble / circle pack. A 4th
   group folds to "Other" or the view facets — never a generated hue.
2. **`$executive-blue #0a4a2e` is not a legal mark color** (`L .363`, `C .078`
   — reads as near-black-gray at mark scale). It stays ink / `--a-primary`.
3. **Series green is `#0e7a49`, not `#15803d`.** `#15803d` *is* `--a-ok`, the
   reserved status color; a series must never impersonate status.

Ordinal tier ramp (tiers are an *ordered* scale → one hue, not four):
`#5c4c18, #7f6a22, #a88d2e, #cba949` — `[PASS]` monotone L, adjacent ΔL ≥ 0.06,
light-end 2.26:1, single hue (3°).

Neutral / de-emphasis `#64748b` (4.76:1) — **not** a categorical slot.
Reserved status (never a series): `--a-ok #15803d`, `--a-warn #d97706`,
`--a-danger #c0392b`.

`-lift` values (`#52b985`, `#7fb2f5`, `#cba949`, `#b394f5`) are **gradient
stops only** — as solid fills they sit below the 3:1 mark gate.

Re-run before changing any hex:

```bash
node scripts/validate_palette.js "#0e7a49,#2563eb,#a88d2e,#7c3aed" --mode light --surface "#ffffff"
node scripts/validate_palette.js "#0e7a49,#2563eb,#a88d2e"          --mode light --surface "#ffffff" --pairs all
node scripts/validate_palette.js "#5c4c18,#7f6a22,#a88d2e,#cba949"  --mode light --surface "#ffffff" --ordinal
```

Dark mode is out of scope (admin is intentionally un-themed). Validated dark
steps for the day it lands: `#19a06a, #4a90ec, #b08d2a, #9575ee` on `#14161a` —
adjacent PASS; the all-pairs trio is a WARN (6.8) and would need direct labels.

### Why hexes, not `var(--a-grad-*)`

The canvas renderer cannot resolve CSS custom properties — a `var(...)` string
handed to a canvas `fillStyle` paints black. `chartTheme.ts` mirrors the
`--a-grad-*` / `--a-grid` / `--a-axis` tokens in `AdminLayout.module.scss`.
**Change one, change both.**

## House rules the kit enforces

- One y-axis. Never two scales on one plot.
- Gridlines horizontal, SOLID, 1px. A dashed grid reads as
  "threshold/projection" when it is just a grid.
- Area wash on `series[0]` only; a second wash muddies both.
- Legend at ≥2 series, omitted at exactly 1 (the card title names it).
- `dashDot` uses `cap: 'butt'` — a round cap swells the 2-unit dot into the
  gaps and the pattern degrades to a plain dash.
- Bubble area ∝ value (`r ∝ √value`). Radius ∝ value is the classic bubble lie.
- Labels that do not fit are **omitted**, never truncated.
- Easing is `cubicOut` everywhere (iOS ease-out: fast out, long settle). Never
  an overshoot bezier — the wizard spotlight de-shake settled that.
- `prefers-reduced-motion: reduce` → `EChart` forces `animation: false`.
- No animated `filter` / `drop-shadow` / `mix-blend-mode`, no rAF loop of our
  own, no CSS-var-per-pointermove.

## Security

An ECharts `tooltip.formatter` that returns a string has that string injected as
innerHTML. Series names here come from the API and DB (rep usernames, vendor and
supplier company names), so **every interpolated label goes through
`escapeHtml`** in `options/tooltip.ts`, and every color goes through
`safeHexColor` (`@shared/utils/color`) before it reaches an inline style. Use
`tooltipCard` / `tooltipRow` rather than hand-rolling a formatter string.

## Leak discipline

ECharts owns a zrender animation loop per instance. `EChart.tsx` disposes on
unmount and guards every entry point with `isDisposed()`. This repo has a
documented history of orphaned render loops (csFx, 2026-06-22: one detached
~60fps loop per interaction-then-navigate). If you profile this kit, rate it
with an **interaction-then-navigate** probe — a nav-only test under-rates that
class of leak.
