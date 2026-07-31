// pieOption — filled pie / thick donut with a clock-hand fill-in sweep.
//
// The sweep is ECharts' native `animationType: 'expansion'`: the whole disc is
// revealed 0deg -> 360deg from 12 o'clock, so slices appear IN ORDER rather
// than each popping independently. It runs on the renderer's own frame loop —
// no rAF, no animated CSS filter, no conic-gradient driven by a CSS variable
// (the "deleted twice" anti-pattern from the flashlight work).
//
// Form guards (dev-only): a 2-slice pie is a stat tile; past 6 slices
// part-to-whole at a glance stops working and a horizontal stacked bar is the
// right form.

import type { EChartsCoreOption } from 'echarts/core';
import { safeHexColor } from '@shared/utils/color';
import {
  CHART_CARD,
  CHART_EASING,
  CHART_FG1,
  CHART_FG3,
  CHART_FONT,
  CHART_NEUTRAL,
  fillGradient,
  seriesColorAt,
} from '../chartTheme';
import { escapeHtml, tooltipCard, tooltipItems, tooltipRow } from './tooltip';

export interface PieSlice {
  label: string;
  value: number;
  /** Flat slice colour — the tooltip / legend key. */
  color?: string | null;
  /** Optional explicit itemStyle fill (e.g. a metallic tier gradient). When set
   *  it REPLACES the default white-lift fillGradient; `color` still supplies the
   *  flat key colour for the tooltip. */
  fill?: unknown;
}

export interface PieOptionInput {
  slices: readonly PieSlice[];
  /** Default true. `false` renders the finished state with no motion. */
  animate?: boolean;
  /** 0 = full pie (default). >0 = donut ring width, in % of the outer radius. */
  donutThickness?: number;
  /** Donut centre. Supplying either forces the legend to the BOTTOM so the
   *  centred `graphic` text lines up with the (then centred) pie. */
  centerLabel?: string;
  centerValue?: string;
  valueFormat?: (v: number) => string;
  /** Default true. */
  showLegend?: boolean;
}

const DEFAULT_FORMAT = (v: number) => v.toLocaleString();
const SWEEP_MS = 720;

export function pieOption(input: PieOptionInput): EChartsCoreOption {
  const {
    slices,
    animate = true,
    donutThickness = 0,
    centerLabel,
    centerValue,
    valueFormat = DEFAULT_FORMAT,
    showLegend = true,
  } = input;

  if (import.meta.env.DEV) {
    if (slices.length > 0 && slices.length < 3) {
      console.warn('[pieOption] a 2-slice pie is a stat tile — reconsider the form.');
    }
    if (slices.length > 6) {
      console.warn(
        `[pieOption] ${slices.length} slices — part-to-whole at a glance stops working past 6; use a horizontal stacked bar.`,
      );
    }
  }

  const hasCenterText = Boolean(centerLabel || centerValue);
  const legendRight = showLegend && !hasCenterText;
  const center: [string, string] = legendRight ? ['36%', '50%'] : ['50%', '50%'];
  const outer = 72;
  const inner = donutThickness > 0 ? Math.max(0, outer - donutThickness) : 0;

  const total = slices.reduce((sum, s) => sum + (Number(s.value) || 0), 0);

  const data = slices.map((s, i) => {
    const solid = safeHexColor(s.color ?? '') ?? seriesColorAt(i);
    return {
      name: s.label,
      value: Number(s.value) || 0,
      // An explicit `fill` (a metallic tier gradient) wins; otherwise the
      // white-lift fillGradient whose darkest stop IS the validated hex, so
      // slice contrast never falls below the measured value.
      itemStyle: { color: (s.fill ?? fillGradient(solid)) as string },
      // Carried for the tooltip line-key, which needs a flat colour.
      keyColor: solid,
    };
  });

  return {
    animation: animate,
    animationDuration: animate ? SWEEP_MS : 0,
    animationEasing: CHART_EASING,
    legend: showLegend
      ? legendRight
        ? { orient: 'vertical', right: 0, top: 'middle', itemGap: 12 }
        : { bottom: 0, left: 'center', itemGap: 16 }
      : { show: false },
    // ONE two-line rich text, not two elements: `left/top: 'center'` layout
    // overrides per-element position (and `style.y` isn't a text style), so
    // two separately-centred texts can't be nudged apart — they land on top
    // of each other. A single block centres as a whole and the lines stack.
    graphic: hasCenterText
      ? [
          {
            type: 'text',
            left: 'center',
            top: 'middle',
            silent: true,
            style: {
              text: [
                // Proportional figures on purpose: equal-width digits make a
                // large standalone number look loose.
                centerValue ? `{v|${centerValue}}` : '',
                centerLabel ? `{l|${centerLabel}}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
              rich: {
                v: { font: `600 20px ${CHART_FONT}`, fill: CHART_FG1, align: 'center' },
                l: {
                  font: `11px ${CHART_FONT}`,
                  fill: CHART_FG3,
                  align: 'center',
                  padding: [4, 0, 0, 0],
                },
              },
            },
          },
        ]
      : [],
    tooltip: {
      trigger: 'item',
      confine: true,
      formatter: (raw: unknown) => {
        const [item] = tooltipItems(raw);
        if (!item) return '';
        const datum = item.data as { keyColor?: string } | undefined;
        const color = safeHexColor(datum?.keyColor ?? item.color ?? '') ?? CHART_NEUTRAL;
        const value = Number(item.value) || 0;
        const pct = total > 0 ? ((value / total) * 100).toFixed(1) : '0.0';
        return tooltipCard(null, [
          tooltipRow(color, String(item.name ?? ''), `${valueFormat(value)}  ·  ${escapeHtml(pct)}%`),
        ]);
      },
    },
    series: [
      {
        type: 'pie',
        radius: [`${inner}%`, `${outer}%`],
        center,
        // 12 o'clock, sweeping clockwise.
        startAngle: 90,
        // The clock-hand fill-in. 'transition' on update so a data refresh
        // morphs instead of replaying the whole sweep.
        animationType: 'expansion',
        animationTypeUpdate: 'transition',
        avoidLabelOverlap: true,
        // The legend + tooltip carry identity; a number on every slice is the
        // "direct label everything" anti-pattern.
        label: { show: false },
        labelLine: { show: false },
        // The 2px surface-coloured border IS the separator. No stroke around a
        // slice — a border adds data-weight ink that is not data.
        itemStyle: { borderColor: CHART_CARD, borderWidth: 2, borderRadius: 4 },
        emphasis: { scale: true, scaleSize: 4 },
        data,
      },
    ],
  };
}
