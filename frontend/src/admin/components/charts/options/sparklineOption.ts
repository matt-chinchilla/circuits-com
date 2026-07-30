// sparklineOption — the stat-tile trend line.
//
// No gridlines, no axes, no legend: the tile's own label names the series.
// Shape is the message, so the area wash is anchored to the PLOT FLOOR (a
// padded data min), not to a distant zero that would flatten the curve.

import type { EChartsCoreOption } from 'echarts/core';
import { safeHexColor } from '@shared/utils/color';
import {
  CHART_CARD,
  CHART_DURATION,
  CHART_EASING,
  CHART_NEUTRAL,
  CHART_SERIES,
  areaGradient,
} from '../chartTheme';
import { numericValue, tooltipCard, tooltipItems, tooltipRow } from './tooltip';

export interface SparklinePoint {
  day: string;
  value: number;
}

export interface SparklineOptionInput {
  data: readonly SparklinePoint[];
  /** Series hex. Defaults to slot 2 (`--a-grad-blue`). */
  color?: string;
  /** Tooltip value formatter. Default `v => v.toLocaleString()`. */
  valueFormat?: (v: number) => string;
  /** Hover readout (date + value). Default true. */
  showTooltip?: boolean;
  /** Trailing dot on the last point. Default true. */
  showTrailingDot?: boolean;
}

const DEFAULT_FORMAT = (v: number) => v.toLocaleString();

export function sparklineOption(input: SparklineOptionInput): EChartsCoreOption {
  const {
    data,
    color: rawColor,
    valueFormat = DEFAULT_FORMAT,
    showTooltip = true,
    showTrailingDot = true,
  } = input;

  const color = safeHexColor(rawColor ?? CHART_SERIES[1]) ?? CHART_NEUTRAL;
  const days = data.map((d) => d.day);
  const values = data.map((d) => (Number.isFinite(d.value) ? d.value : 0));

  // 6% headroom top and bottom. A flat series (max === min) gets a +/-1 band,
  // which renders an honest centered flat line instead of a divide-by-zero.
  const max = values.length ? Math.max(...values) : 0;
  const min = values.length ? Math.min(...values) : 0;
  const pad = (max - min) * 0.06 || 1;

  return {
    animation: true,
    animationDuration: CHART_DURATION,
    animationEasing: CHART_EASING,
    grid: { left: 3, right: 3, top: 6, bottom: 4, containLabel: false },
    xAxis: { type: 'category', data: days, show: false, boundaryGap: false },
    yAxis: { type: 'value', show: false, min: min - pad, max: max + pad },
    tooltip: showTooltip
      ? {
          trigger: 'axis',
          confine: true,
          axisPointer: { type: 'line' },
          formatter: (raw: unknown) => {
            const [item] = tooltipItems(raw);
            if (!item) return '';
            const v = numericValue(item.value);
            return tooltipCard(String(item.axisValueLabel ?? item.axisValue ?? ''), [
              tooltipRow(color, '', v == null ? '—' : valueFormat(v)),
            ]);
          },
        }
      : { show: false },
    series: [
      {
        type: 'line',
        // Trailing dot WITHOUT the MarkPointComponent (not registered — see
        // EChart.tsx): the series draws symbols at size 0 and only the last
        // datum overrides symbolSize, so exactly one ringed dot paints.
        data: values.map((v, i) =>
          showTrailingDot && i === values.length - 1
            ? {
                value: v,
                symbolSize: 7,
                itemStyle: { color, borderColor: CHART_CARD, borderWidth: 2 },
              }
            : v,
        ),
        smooth: true,
        smoothMonotone: 'x', // no phantom dip below a rising series
        showSymbol: true,
        symbol: 'circle',
        symbolSize: 0,
        lineStyle: { width: 2, color, cap: 'round', join: 'round' },
        itemStyle: { color, borderColor: CHART_CARD, borderWidth: 2 },
        areaStyle: { color: areaGradient(color, 0.22), origin: 'start' },
        emphasis: { scale: false, focus: 'none' },
      },
    ],
  };
}
