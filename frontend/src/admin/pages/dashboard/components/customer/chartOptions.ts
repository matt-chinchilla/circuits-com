// Option builders for the customer board.
//
// Same contract as the shared kit in `@admin/components/charts/options`: each
// returns a plain option object and imports NOTHING from echarts at runtime
// (the type import is erased), so a panel can build an option without pulling
// the library in. They live here rather than in the kit because they are the
// customer board's shapes — a ranked horizontal bar, a twelve-month series, a
// placement Sankey and a single-hub counterparty graph — and three of them
// need chart types the staff console does not register (./echartsCustomer).
//
// Colour comes from `chartTheme` in every case, never from a literal: a canvas
// cannot resolve `var(--a-*)`, and the theme module is the mirror that keeps
// the two in step.

import type { EChartsCoreOption } from 'echarts/core';
import {
  CHART_AXIS,
  CHART_FG3,
  CHART_FONT,
  CHART_NEUTRAL,
  CHART_SERIES,
  areaGradient,
  fillGradient,
  sphereFill,
  tierColor,
  withAlpha,
} from '@admin/components/charts/chartTheme';
import {
  numericValue,
  tooltipCard,
  tooltipItems,
  tooltipRow,
} from '@admin/components/charts/options';
import { normalizeSponsorTier } from '@admin/services/sponsorTier';
import { safeHexColor } from '@shared/utils/color';
import type {
  AccountBookNode,
  AccountSankeyLink,
  AccountSankeyNode,
} from '@admin/types/account';
import { bookLayout, bookNodeSize } from './bookLayout';

/** A labelled magnitude — a category, a month, a company. */
export interface CategoricalPoint {
  label: string;
  value: number;
}

type ValueFormat = (value: number) => string;

/** Axis and in-canvas labels have no ellipsis of their own. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function safe(color: string): string {
  return safeHexColor(color) ?? CHART_NEUTRAL;
}

/** One-row axis tooltip, shared by the three cartesian builders. */
function axisTooltip(color: string, valueFormat: ValueFormat) {
  return {
    trigger: 'axis' as const,
    confine: true,
    axisPointer: { type: 'shadow' as const },
    formatter: (raw: unknown) => {
      const [item] = tooltipItems(raw);
      if (!item) return '';
      const v = numericValue(item.value);
      return tooltipCard(String(item.axisValueLabel ?? item.axisValue ?? ''), [
        tooltipRow(color, '', v == null ? '—' : valueFormat(v)),
      ]);
    },
  };
}

export interface RankedBarInput {
  points: readonly CategoricalPoint[];
  color: string;
  /** Tooltip / headline formatter. */
  valueFormat: ValueFormat;
  /** Axis-tick formatter — compacted, because ticks are read at a glance. */
  axisFormat: ValueFormat;
}

/**
 * The KPI chart: a ranked HORIZONTAL bar.
 *
 * Horizontal because every KPI in the registry is a top-eight of named things
 * — categories, makers, distributors — and their names are long. A vertical
 * bar chart would either rotate the labels 45° or truncate them to nothing;
 * laid on its side each name gets a full line of its own.
 *
 * Largest at the TOP (`inverse`), which is the direction a ranked list is
 * read.
 */
export function rankedBarOption(input: RankedBarInput): EChartsCoreOption {
  const { points, valueFormat, axisFormat } = input;
  const color = safe(input.color);
  const labels = points.map((p) => p.label);
  const values = points.map((p) => (Number.isFinite(p.value) ? p.value : 0));

  return {
    grid: { left: 4, right: 16, top: 8, bottom: 4, containLabel: true },
    tooltip: axisTooltip(color, valueFormat),
    xAxis: {
      type: 'value',
      axisLabel: { formatter: (v: number) => axisFormat(v) },
    },
    yAxis: {
      type: 'category',
      // Rank order arrives newest-strongest first; `inverse` puts that row at
      // the top instead of the bottom.
      inverse: true,
      data: labels,
      axisLabel: {
        formatter: (value: string) => truncate(String(value), 22),
      },
    },
    series: [
      {
        type: 'bar',
        data: values,
        barMaxWidth: 22,
        itemStyle: { color: fillGradient(color), borderRadius: [0, 4, 4, 0] },
        emphasis: { itemStyle: { color } },
      },
    ],
  };
}

export interface MonthlySeriesInput {
  /** Oldest first — the axis reads left to right. */
  points: readonly CategoricalPoint[];
  color: string;
  valueFormat: ValueFormat;
  axisFormat: ValueFormat;
}

/** Twelve months of a count, as bars. Discrete periods, so discrete marks. */
export function monthlyBarOption(input: MonthlySeriesInput): EChartsCoreOption {
  const { points, valueFormat, axisFormat } = input;
  const color = safe(input.color);

  return {
    grid: { left: 4, right: 10, top: 12, bottom: 4, containLabel: true },
    tooltip: axisTooltip(color, valueFormat),
    xAxis: {
      type: 'category',
      data: points.map((p) => p.label),
      axisLabel: { interval: 0, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: (v: number) => axisFormat(v) },
    },
    series: [
      {
        type: 'bar',
        data: points.map((p) => (Number.isFinite(p.value) ? p.value : 0)),
        barMaxWidth: 26,
        itemStyle: { color: fillGradient(color), borderRadius: [4, 4, 0, 0] },
        emphasis: { itemStyle: { color } },
      },
    ],
  };
}

/**
 * Twelve months of money, as a washed line — the staff Revenue panel's
 * treatment (solid electric line, area gradient, no symbols) on the one series
 * a single company has. The staff chart overlays month-to-date curves because
 * it is comparing months against each other; a customer's own history is a
 * trend, so it runs along the year instead.
 */
export function monthlyLineOption(input: MonthlySeriesInput): EChartsCoreOption {
  const { points, valueFormat, axisFormat } = input;
  const color = safe(input.color);

  return {
    grid: { left: 4, right: 10, top: 12, bottom: 4, containLabel: true },
    tooltip: axisTooltip(color, valueFormat),
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: points.map((p) => p.label),
      axisLabel: { interval: 0, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: (v: number) => axisFormat(v) },
    },
    series: [
      {
        type: 'line',
        data: points.map((p) => (Number.isFinite(p.value) ? p.value : 0)),
        smooth: true,
        smoothMonotone: 'x',
        showSymbol: false,
        lineStyle: { width: 2, color, cap: 'round', join: 'round' },
        itemStyle: { color },
        areaStyle: { color: areaGradient(color, 0.22) },
      },
    ],
  };
}

export interface SponsorSankeyInput {
  nodes: readonly AccountSankeyNode[];
  links: readonly AccountSankeyLink[];
  valueFormat: ValueFormat;
}

/**
 * Where a company's sponsorship money goes: name-keyed Sankey, exactly the
 * shape the wire sends.
 *
 * A node whose name IS a tier wears that tier's board colour — the same
 * lavender/ENIG/steel the public boards use — so the flow is legible without a
 * legend. Everything else (the company, a category, a keyword) takes a stable
 * slot from the validated series order. Nothing here compares against a tier
 * LITERAL: `tier` is a free string in the database and arrives in whatever
 * casing the admin typed.
 */
export function sponsorSankeyOption(input: SponsorSankeyInput): EChartsCoreOption {
  const { nodes, links, valueFormat } = input;

  const data = nodes.map((node, index) => {
    const tier = normalizeSponsorTier(node.name);
    return {
      name: node.name,
      itemStyle: {
        color: tier ? tierColor(tier) : CHART_SERIES[index % CHART_SERIES.length],
        borderWidth: 0,
      },
    };
  });

  return {
    tooltip: {
      trigger: 'item',
      confine: true,
      formatter: (raw: unknown) => {
        const [item] = tooltipItems(raw);
        if (!item) return '';
        const value = numericValue(item.value);
        const color = safe(String(item.color ?? CHART_NEUTRAL));
        // An edge's `name` is `source > target`; ECharts builds it, so it is
        // printed as the card's title rather than re-derived here.
        return tooltipCard(String(item.name ?? ''), [
          tooltipRow(color, '', value == null ? '—' : valueFormat(value)),
        ]);
      },
    },
    series: [
      {
        type: 'sankey',
        left: 8,
        right: 8,
        top: 12,
        bottom: 12,
        data,
        links: links.map((link) => ({ ...link })),
        nodeAlign: 'left',
        nodeGap: 14,
        nodeWidth: 12,
        emphasis: { focus: 'adjacency' },
        label: {
          color: CHART_FG3,
          fontFamily: CHART_FONT,
          fontSize: 11,
          formatter: (params: unknown) =>
            truncate(String((params as { name?: string })?.name ?? ''), 18),
        },
        lineStyle: { color: 'gradient', opacity: 0.32, curveness: 0.5 },
      },
    ],
  };
}

export interface BookGraphInput {
  centerName: string;
  /** Already trimmed to `BOOK_MAX_NODES` and ordered by parts_count desc. */
  nodes: readonly AccountBookNode[];
  /** The two counterparty kinds, by their legend colours. */
  colorFor: (kind: AccountBookNode['kind']) => string;
  centerColor: string;
  valueFormat: ValueFormat;
}

/** The centre sphere — larger than any counterparty, because it is the
 *  company the whole graph is about. */
const CENTER_NODE = 62;

interface BookDatum {
  name: string;
  displayName: string;
  kind: 'center' | AccountBookNode['kind'];
  value: number;
  x: number;
  y: number;
  symbolSize: number;
  itemStyle: Record<string, unknown>;
  label: Record<string, unknown>;
}

/**
 * Book of business as a single-hub radial graph — their company at the centre,
 * every counterparty on a ring around it, bubble area by how many of their
 * parts that counterparty accounts for.
 *
 * `layout: 'none'` with computed geometry (./bookLayout), and `roam: 'scale'`
 * so the graph can be zoomed but never dragged out of its bordered arena —
 * the staff board's treatment, for the same two reasons: a force simulation
 * cannot hold an even angular division, and ECharts' force layout mis-fits a
 * bounded viewport.
 *
 * Node `name` is the counterparty's ID, never its display text: a distributor
 * and a manufacturer can share a company name (Digi-Key sells and Digi-Key
 * brands), and a duplicate node name breaks ECharts' internal graph map.
 */
export function bookGraphOption(input: BookGraphInput): EChartsCoreOption {
  const { centerName, nodes, colorFor, valueFormat } = input;
  const centerColor = safe(input.centerColor);
  const placements = bookLayout(nodes.length);
  const max = nodes.reduce((best, n) => Math.max(best, Number(n.parts_count) || 0), 0);

  const data: BookDatum[] = [
    {
      name: 'center',
      displayName: centerName,
      kind: 'center',
      // The centre's own magnitude is how many counterparties orbit it —
      // SUMMING their part counts would double-count every part two of them
      // both carry, which is most of them.
      value: nodes.length,
      x: 0,
      y: 0,
      symbolSize: CENTER_NODE,
      itemStyle: {
        color: sphereFill(centerColor),
        borderColor: withAlpha(centerColor, 0.5),
        borderWidth: 1,
        shadowBlur: 16,
        shadowColor: withAlpha(centerColor, 0.4),
        shadowOffsetY: 4,
      },
      label: {
        show: true,
        position: 'inside',
        formatter: truncate(centerName, 14),
        fontFamily: CHART_FONT,
        fontSize: 11,
        fontWeight: 800,
        color: '#ffffff',
      },
    },
  ];

  nodes.forEach((node, index) => {
    const place = placements[index];
    const color = safe(colorFor(node.kind));
    const value = Number(node.parts_count) || 0;
    data.push({
      name: node.id,
      displayName: node.name,
      kind: node.kind,
      value,
      x: place.x,
      y: place.y,
      symbolSize: bookNodeSize(value, max),
      itemStyle: {
        color: sphereFill(color),
        borderColor: withAlpha(color, 0.45),
        borderWidth: 1,
        shadowBlur: 10,
        shadowColor: withAlpha(color, 0.32),
        shadowOffsetY: 3,
      },
      label: {
        show: true,
        position: 'bottom',
        distance: 6,
        formatter: truncate(node.name, 16),
        fontFamily: CHART_FONT,
        fontSize: 11,
        color: CHART_FG3,
      },
    });
  });

  return {
    animation: true,
    tooltip: {
      trigger: 'item',
      confine: true,
      formatter: (raw: unknown) => {
        const [item] = tooltipItems(raw);
        const datum = item?.data as BookDatum | undefined;
        if (!datum) return '';
        if (datum.kind === 'center') {
          return tooltipCard(datum.displayName, [
            tooltipRow(centerColor, 'counterparties', valueFormat(datum.value)),
          ]);
        }
        const kindLabel = datum.kind === 'manufacturer' ? 'Manufacturer' : 'Distributor';
        return tooltipCard(kindLabel, [
          tooltipRow(safe(colorFor(datum.kind)), datum.displayName, valueFormat(datum.value)),
        ]);
      },
    },
    series: [
      {
        type: 'graph',
        layout: 'none',
        roam: 'scale',
        scaleLimit: { min: 0.6, max: 2.4 },
        emphasis: { focus: 'adjacency', scale: true },
        data,
        links: nodes.map((node) => ({
          source: 'center',
          target: node.id,
          lineStyle: {
            color: withAlpha(safe(colorFor(node.kind)), 0.3),
            width: 1,
            curveness: 0,
          },
        })),
        lineStyle: { color: CHART_AXIS, width: 1 },
      },
    ],
  };
}
