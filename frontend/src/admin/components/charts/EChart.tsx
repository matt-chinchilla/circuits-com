// EChart — the ONE React wrapper around Apache ECharts for the admin console.
//
// ── Bundle discipline ──────────────────────────────────────────────────────
// This file is the sole entry point to the library. It imports from
// `echarts/core` and registers ONLY the chart types / components the kit
// actually uses, so the tree-shaken build stays lean. `vite.config.ts`
// manualChunks routes `node_modules/echarts` + `node_modules/zrender` into
// their own async `echarts` chunk.
//
// IMPORTANT for anyone wiring this in: `AdminLayout` is imported EAGERLY in
// App.tsx. Import charts ONLY from a LAZY admin page (`pages/*`), never from
// AdminLayout or any module the public entry statically reaches — otherwise
// the echarts chunk gets hoisted into the public/index entry and the public
// LCP budget pays for it.
//
// ── Leak discipline ────────────────────────────────────────────────────────
// This repo has a documented history of orphaned render loops (csFx, 2026-06-22:
// one detached ~60fps canvas loop per interaction-then-navigate). ECharts owns
// a zrender animation loop per instance, so `dispose()` on unmount is MANDATORY
// and every post-unmount entry point is guarded with `isDisposed()`.

import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import * as echarts from 'echarts/core';
import type { EChartsCoreOption, EChartsType } from 'echarts/core';
import { CustomChart, GraphChart, LineChart, PieChart } from 'echarts/charts';
import {
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { ADMIN_CHART_THEME_NAME, buildAdminTheme, prefersReducedMotion } from './chartTheme';

// Explicit registration — anything not listed here is tree-shaken away.
// TooltipComponent transitively installs the axis-pointer used by
// `tooltip.axisPointer: { type: 'cross' }`, so it needs no separate entry.
echarts.use([
  LineChart,
  PieChart,
  CustomChart,
  GraphChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  GraphicComponent,
  MarkLineComponent,
  CanvasRenderer,
]);

// The theme is (re)registered per-init from buildAdminTheme() so a dark/light
// toggle (which remounts the charts) picks up the swapped chrome.

export type EChartEventHandler = (params: unknown) => void;

export interface EChartProps {
  /** A full option object from `./options/*`. Rebuild it (new identity) to
   *  update the chart — it is applied with `notMerge: true`, so a rebuilt
   *  option never inherits stale series/axes from the previous one. Memoize
   *  it (`useMemo`) so an unrelated parent re-render is not a full redraw. */
  option: EChartsCoreOption;
  /** Merged OVER the `{ width: 100%, height: 260 }` default. A host with no
   *  resolved height inits ECharts at 0px — always give it one. */
  style?: CSSProperties;
  className?: string;
  /** ECharts event name -> handler, e.g. `{ click: (p) => ... }`. Memoize the
   *  object; a new identity re-binds (cheap, but pointless churn). */
  onEvents?: Record<string, EChartEventHandler>;
  /** Called once per chart INSTANCE, right after init — the escape hatch for
   *  imperative interaction layers (e.g. salesForcePhysics). The instance is
   *  disposed on unmount (twice-inited under StrictMode), so consumers MUST
   *  guard every later use with `chart.isDisposed()`. */
  onReady?: (chart: EChartsType) => void;
}

/** Top-level `animation:false` disables entry, update AND series-level motion.
 *  `prefersReducedMotion` is read here at EVERY setOption rather than cached,
 *  so a mid-session toggle takes effect on the next data refresh. */
function applyMotionPreference(option: EChartsCoreOption): EChartsCoreOption {
  return prefersReducedMotion() ? { ...option, animation: false } : option;
}

export default function EChart({ option, style, className, onEvents, onReady }: EChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  // Latest-ref: the lifecycle effect below has [] deps, so it must not close
  // over a stale onReady — and a new callback identity must not re-init.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // (1) Lifecycle. Runs once (twice under StrictMode, which tears down and
  // re-runs EVERY effect — including the setOption effect below, so the
  // re-created instance is never left blank).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    echarts.registerTheme(ADMIN_CHART_THEME_NAME, buildAdminTheme());
    const chart = echarts.init(host, ADMIN_CHART_THEME_NAME, { renderer: 'canvas' });
    chartRef.current = chart;
    onReadyRef.current?.(chart);

    // Resize on container change. ECharts warns (and lays out garbage) on a
    // 0-sized box, which is exactly what a collapsed/hidden panel reports.
    const ro = new ResizeObserver(() => {
      if (chart.isDisposed()) return;
      const { clientWidth, clientHeight } = host;
      if (clientWidth <= 0 || clientHeight <= 0) return;
      chart.resize();
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      chartRef.current = null;
      chart.dispose();
    };
  }, []);

  // (2) Option. Declared AFTER the lifecycle effect, so on mount the instance
  // already exists. `notMerge: true` — see EChartProps.option.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || chart.isDisposed()) return;
    chart.setOption(applyMotionPreference(option), { notMerge: true });
  }, [option]);

  // (3) Events. Bound off the instance, torn down on unmount / handler change.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || chart.isDisposed() || !onEvents) return;
    const entries = Object.entries(onEvents);
    for (const [name, handler] of entries) chart.on(name, handler);
    return () => {
      if (chart.isDisposed()) return;
      for (const [name, handler] of entries) chart.off(name, handler);
    };
  }, [onEvents]);

  return (
    <div ref={hostRef} className={className} style={{ width: '100%', height: 260, ...style }} />
  );
}
