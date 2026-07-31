// salesForceOption — the "book of business" as a force-directed graph.
//
// Each sales rep is a labelled HUB; their sponsored customers are leaf nodes
// linked to it, sized by monthly value (AREA ∝ value → radius ∝ √value) and
// coloured by sponsor TIER (the public-board materials). The force layout
// settles with a gentle jiggle, repels nodes so they stop sitting on top of
// each other, and every node is DRAGGABLE — so it reads as a live, physical
// book you can nudge around. Every company carries its own always-on label, so
// you never have to hover to see what a bubble is.
//
// This is a graph, not the old circle-pack: force layout is what gives the
// physics + the breathing room the pack couldn't.

import type { EChartsCoreOption } from 'echarts/core';
import { safeHexColor } from '@shared/utils/color';
import {
  CHART_CARD,
  CHART_FG1,
  CHART_FG3,
  CHART_FONT,
  CHART_NEUTRAL,
  sphereFill,
  tierColor,
  tierColorSet,
  tierRadial,
  withAlpha,
} from '../chartTheme';
import { tooltipCard, tooltipItems, tooltipRow } from './tooltip';

export interface SalesForceCustomer {
  label: string;
  value: number;
  tier?: string | null;
}

export interface SalesForceGroup {
  name: string;
  /** Hub + link colour (identifies the rep cluster; leaves stay tier-coloured). */
  color: string;
  total: number;
  children: readonly SalesForceCustomer[];
}

export interface SalesForceOptionInput {
  groups: readonly SalesForceGroup[];
  valueFormat?: (v: number) => string;
  emptyMessage?: string;
}

const DEFAULT_FORMAT = (v: number) => v.toLocaleString();
const MIN_NODE = 18;
const MAX_NODE = 58;
// Big enough that a rep name (Anthony / Ronald / Demo) sits INSIDE the hub
// instead of spilling past its edge.
const HUB_NODE = 54;

/** Radius so bubble AREA is proportional to value — the largest customer hits
 *  MAX_NODE, the smallest floors at MIN_NODE (a $14 bubble must still be a
 *  hittable, labelled target). */
function nodeSize(value: number, max: number): number {
  if (max <= 0) return MIN_NODE;
  const r = Math.sqrt(Math.max(0, value) / max);
  return Math.round(MIN_NODE + (MAX_NODE - MIN_NODE) * r);
}

function truncate(text: string, n = 14): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

interface ForceNode {
  /** Unique key (`n<index>`) — NOT the display text. Two sellers can sponsor
   *  the same company, so node names must be unique or ECharts' internal graph
   *  map collides ("Cannot set properties of undefined (setting 'dataIndex')").*/
  name: string;
  /** The company / rep name actually shown (label + tooltip). */
  displayName: string;
  kind: 'hub' | 'leaf';
  groupName: string;
  tier: string | null;
  value: number;
  symbolSize: number;
  itemStyle: Record<string, unknown>;
  label: Record<string, unknown>;
}

export function salesForceOption(input: SalesForceOptionInput): EChartsCoreOption {
  const { groups, valueFormat = DEFAULT_FORMAT, emptyMessage = 'No data yet.' } = input;

  if (!groups.length || !groups.some((g) => g.children.length)) {
    return {
      animation: false,
      graphic: [
        {
          type: 'text',
          left: 'center',
          top: 'middle',
          silent: true,
          style: {
            text: emptyMessage,
            textAlign: 'center',
            font: `12px ${CHART_FONT}`,
            fill: CHART_FG3,
          },
        },
      ],
      series: [],
    };
  }

  const maxCustomer = Math.max(
    1,
    ...groups.flatMap((g) => g.children.map((c) => Number(c.value) || 0)),
  );

  const nodes: ForceNode[] = [];
  // Links reference nodes by their INDEX in `nodes` (not name) — two reps can
  // both sponsor "Digi-Key", so names are not unique.
  const links: Array<{ source: number; target: number; lineStyle: Record<string, unknown> }> = [];

  groups.forEach((g) => {
    const hubColor = safeHexColor(g.color) ?? CHART_NEUTRAL;
    const hubIndex = nodes.length;
    nodes.push({
      name: `n${hubIndex}`,
      displayName: g.name,
      kind: 'hub',
      groupName: g.name,
      tier: null,
      value: Number(g.total) || 0,
      symbolSize: HUB_NODE,
      // The rep "name bubble" is a glossy 3D sphere in the rep's own colour,
      // with a white label for contrast on the solid fill.
      itemStyle: {
        color: sphereFill(hubColor),
        borderColor: CHART_CARD,
        borderWidth: 1,
        shadowBlur: 13,
        shadowColor: withAlpha(hubColor, 0.42),
        shadowOffsetY: 4,
      },
      label: {
        show: true,
        position: 'inside',
        formatter: g.name,
        fontFamily: CHART_FONT,
        fontSize: 13,
        fontWeight: 800,
        color: '#ffffff',
      },
    });

    g.children.forEach((c) => {
      const set = tierColorSet(c.tier);
      const leafIndex = nodes.length;
      nodes.push({
        name: `n${leafIndex}`,
        displayName: c.label,
        kind: 'leaf',
        groupName: g.name,
        tier: c.tier ?? null,
        value: Number(c.value) || 0,
        symbolSize: nodeSize(Number(c.value) || 0, maxCustomer),
        // Glossy 3D bead: an off-centre radial highlight -> base -> deep, plus a
        // soft tier-dark drop shadow, so the bubble reads as a lit sphere.
        itemStyle: {
          color: tierRadial(c.tier),
          borderColor: CHART_CARD,
          borderWidth: 1,
          shadowBlur: 9,
          shadowColor: withAlpha(set.deep, 0.42),
          shadowOffsetX: 1,
          shadowOffsetY: 3,
        },
        label: {
          show: true,
          position: 'bottom',
          distance: 4,
          formatter: truncate(c.label),
          fontFamily: CHART_FONT,
          fontSize: 11,
          fontWeight: 600,
          color: CHART_FG1,
          // Card-coloured halo so a caption stays legible over a neighbouring
          // bubble — CHART_CARD (not literal white) so it stays correct in dark
          // mode, where a white halo would smear near-white text into a blob.
          textBorderColor: CHART_CARD,
          textBorderWidth: 3,
        },
      });
      links.push({
        source: hubIndex,
        target: leafIndex,
        lineStyle: { color: withAlpha(hubColor, 0.3), width: 1, curveness: 0 },
      });
    });
  });

  return {
    animation: true,
    tooltip: {
      trigger: 'item',
      confine: true,
      formatter: (raw: unknown) => {
        const [item] = tooltipItems(raw);
        const d = item?.data as ForceNode | undefined;
        if (!d) return '';
        if (d.kind === 'hub') {
          return tooltipCard(String(d.displayName ?? ''), [
            tooltipRow(CHART_NEUTRAL, 'Book', valueFormat(Number(d.value) || 0)),
          ]);
        }
        const head = d.tier ? `${d.groupName} · ${d.tier}` : d.groupName;
        return tooltipCard(head, [
          tooltipRow(tierColor(d.tier), String(d.displayName ?? ''), valueFormat(Number(d.value) || 0)),
        ]);
      },
    },
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        draggable: true,
        // Gentle physics: enough repulsion to unstack the nodes, a light pull
        // to centre, and layoutAnimation so it visibly settles (the "jiggle").
        force: {
          repulsion: 135,
          gravity: 0.09,
          edgeLength: [36, 108],
          friction: 0.16,
          layoutAnimation: true,
        },
        emphasis: { focus: 'adjacency', scale: true },
        scaleLimit: { min: 0.6, max: 2.4 },
        data: nodes,
        links,
      },
    ],
  };
}
