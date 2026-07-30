// comparatorOption — multi-line comparison plot (trends, revenue-compare,
// expenses-compare).
//
// Non-negotiables carried over from the chart spec:
//  - ONE y-axis. Two measures of different magnitude become two charts, or get
//    indexed to 100 at t0. A second scale is the top-ranked anti-pattern.
//  - Gridlines horizontal only, SOLID, 1px (a dashed grid reads as
//    "threshold/projection" when it is just a grid). The theme sets this; the
//    numeric x-axis has to opt OUT of the shared valueAxis splitLine.
//  - Area wash on series[0] ONLY. A second wash muddies both.
//  - Legend at >= 2 series, omitted at exactly 1 (a one-swatch legend restates
//    the card title).
//  - Colour follows the ENTITY: callers assign `color` per series from a stable
//    key, so filtering a series out never repaints the survivors.

import type { EChartsCoreOption } from 'echarts/core';
import { safeHexColor } from '@shared/utils/color';
import {
  CHART_AXIS,
  CHART_CARD,
  CHART_DURATION,
  CHART_EASING,
  CHART_NEUTRAL,
  areaGradient,
  seriesColorAt,
} from '../chartTheme';
import { numericValue, tooltipCard, tooltipItems, tooltipRow } from './tooltip';

export type ComparatorLineStyle = 'solid' | 'dashed' | 'dashDot';

export interface ComparatorPoint {
  x: number;
  y: number;
}

export interface ComparatorSeries {
  label: string;
  color: string;
  lineStyle?: ComparatorLineStyle;
  points: readonly ComparatorPoint[];
}

export interface ComparatorOptionInput {
  series: readonly ComparatorSeries[];
  /** y tick + tooltip formatter. Default `v => v.toLocaleString()`. */
  yFormat?: (v: number) => string;
  /** When present the x-axis is CATEGORICAL and each point's `x` is read as an
   *  index into this array. Omit for a numeric x-axis (the honest choice when
   *  two series share a scale but not a cadence — e.g. months of unequal
   *  length overlaid on day-of-month). */
  xLabels?: readonly string[];
  /** Numeric-x tick formatter. Ignored when `xLabels` is set. */
  xFormat?: (v: number) => string;
  /** Gradient wash under series[0]. Default true. */
  areaOnPrimary?: boolean;
  /** Default `series.length >= 2`. */
  showLegend?: boolean;
  /** y floor. Default 0 (counts + money). `null` lets ECharts auto-scale. */
  yMin?: number | null;
  /** Tooltip title override, e.g. `(x) => 'Day ' + x`. */
  tooltipTitle?: (axisLabel: string) => string;
}

// `dashDot` MUST use a butt cap: with a round cap the 2-unit dot grows a
// 1-unit cap at each end at stroke-width 2 and merges with the 4-unit gaps —
// the pattern silently degrades to a plain dash. This is the single most
// common way a dash-dot renders wrong.
const DASH: Record<ComparatorLineStyle, { type: 'solid' | number[]; cap: 'round' | 'butt' }> = {
  solid: { type: 'solid', cap: 'round' },
  dashed: { type: [7, 5], cap: 'round' },
  dashDot: { type: [9, 4, 2, 4], cap: 'butt' },
};

const DEFAULT_FORMAT = (v: number) => v.toLocaleString();

export function comparatorOption(input: ComparatorOptionInput): EChartsCoreOption {
  const {
    series,
    yFormat = DEFAULT_FORMAT,
    xLabels,
    xFormat,
    areaOnPrimary = true,
    showLegend = series.length >= 2,
    yMin = 0,
    tooltipTitle,
  } = input;

  if (import.meta.env.DEV && series.length > 4) {
    console.warn(
      `[comparatorOption] ${series.length} series — past 4 lines this should be small multiples.`,
    );
  }

  const categorical = Array.isArray(xLabels) && xLabels.length > 0;
  const labels = categorical ? [...(xLabels as readonly string[])] : [];

  const echartSeries = series.map((s, i) => {
    const color = safeHexColor(s.color) ?? seriesColorAt(i);
    const dash = DASH[s.lineStyle ?? 'solid'];
    const data = s.points.map((p) =>
      categorical ? [labels[Math.round(p.x)] ?? String(p.x), p.y] : [p.x, p.y],
    );
    return {
      name: s.label,
      type: 'line' as const,
      data,
      smooth: true,
      smoothMonotone: 'x',
      showSymbol: false,
      symbol: 'circle',
      symbolSize: 8,
      connectNulls: false,
      lineStyle: { width: 2, color, type: dash.type, cap: dash.cap, join: 'round' },
      itemStyle: { color, borderColor: CHART_CARD, borderWidth: 2 },
      areaStyle: areaOnPrimary && i === 0 ? { color: areaGradient(color, 0.2) } : undefined,
      emphasis: { focus: 'none', scale: true },
      z: series.length - i,
    };
  });

  const xAxis = categorical
    ? {
        type: 'category' as const,
        data: labels,
        boundaryGap: false,
        axisLine: { show: true, lineStyle: { color: CHART_AXIS, width: 1 } },
        splitLine: { show: false },
      }
    : {
        type: 'value' as const,
        min: 'dataMin',
        max: 'dataMax',
        minInterval: 1,
        // The shared valueAxis theme turns splitLine ON; a numeric x-axis must
        // opt out or the plot grows vertical gridlines.
        splitLine: { show: false },
        axisLine: { show: true, lineStyle: { color: CHART_AXIS, width: 1 } },
        axisLabel: xFormat ? { formatter: (v: number) => xFormat(v) } : undefined,
      };

  return {
    animation: true,
    animationDuration: CHART_DURATION,
    animationEasing: CHART_EASING,
    grid: {
      left: 6,
      right: 14,
      top: 14,
      bottom: showLegend ? 30 : 6,
      containLabel: true,
    },
    legend: showLegend
      ? { bottom: 0, left: 'center', data: series.map((s) => s.label) }
      : { show: false },
    xAxis,
    yAxis: {
      type: 'value',
      min: yMin === null ? undefined : yMin,
      axisLabel: { formatter: (v: number) => yFormat(v) },
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      // Cross pointer: the reader never has to land ON a line to read every
      // series at that x.
      axisPointer: { type: 'cross', snap: true },
      formatter: (raw: unknown) => {
        const items = tooltipItems(raw);
        if (!items.length) return '';
        const head = String(items[0].axisValueLabel ?? items[0].axisValue ?? '');
        const rows = items.map((item) => {
          const v = numericValue(item.value);
          const color = safeHexColor(item.color ?? '') ?? CHART_NEUTRAL;
          return tooltipRow(color, String(item.seriesName ?? ''), v == null ? '—' : yFormat(v));
        });
        return tooltipCard(tooltipTitle ? tooltipTitle(head) : head, rows);
      },
    },
    series: echartSeries,
  };
}

// ── Adapters ───────────────────────────────────────────────────────────────

/** A `/dashboard/revenue-compare` or `/dashboard/expenses` month row. */
export interface MonthlyDailyMonth {
  key: string;
  label: string;
  daily: readonly { day: number; value: number }[];
}

/**
 * Overlay N months on a shared 1..31 day-of-month axis.
 *
 * The API returns NEWEST FIRST, so slot 0 (solid, and the one that gets the
 * area wash) is the current month and older months step back through the
 * validated adjacent-safe palette with progressively lighter line styles.
 * Numeric x on purpose: February and March do not share a length, and pinning
 * them to a category index would misalign the 29th onward.
 */
export function monthsToComparatorSeries(
  months: readonly MonthlyDailyMonth[],
): ComparatorSeries[] {
  const styles: ComparatorLineStyle[] = ['solid', 'dashed', 'dashDot', 'dashed'];
  return months.map((m, i) => ({
    label: m.label,
    color: seriesColorAt(i),
    lineStyle: styles[i % styles.length],
    points: m.daily.map((d) => ({ x: d.day, y: Number(d.value) || 0 })),
  }));
}

/** A `/dashboard/trends` day series -> comparator points (x = day index). */
export function trendToComparatorSeries(
  label: string,
  color: string,
  points: readonly { day: string; value: number }[],
): { series: ComparatorSeries; labels: string[] } {
  return {
    series: {
      label,
      color,
      lineStyle: 'solid',
      points: points.map((p, i) => ({ x: i, y: Number(p.value) || 0 })),
    },
    labels: points.map((p) => p.day),
  };
}

/**
 * expensesOption — `/dashboard/expenses` has the SAME wire shape as
 * `/dashboard/revenue-compare`, so it is the same chart. Kept as a named
 * export so call sites read intentionally and a future divergence has one
 * place to land.
 */
export const expensesOption = comparatorOption;
