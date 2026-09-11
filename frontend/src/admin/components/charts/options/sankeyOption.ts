// sankeyOption — flow diagrams for the Reports page (traffic sources → what
// visitors did; category → subcategory → part; optionally → distributor).
//
// The server sends nodes as `{ id, label, column }` with ids of the form
// `<column>:<label>`, because ECharts keys a Sankey's nodes by NAME and the
// same label legitimately appears in two columns ("Category page" as a
// landing page and as a next step). The id is the ECharts name; the label is
// what a person reads — never format a label off the id.
//
// Layout is taken from DATA ORDER (`layoutIterations: 0`): the server already
// sorted each column largest-first, so the eye reads top-down by volume and a
// refresh that reorders nothing redraws nothing.

import type { EChartsCoreOption } from 'echarts/core';
import { CHART_DURATION, CHART_EASING, CHART_FONT, CHART_SERIES, withAlpha } from '../chartTheme';
import { tooltipCard, tooltipRow } from './tooltip';

export interface SankeyNode {
  id: string;
  label: string;
  column: number;
  /** A second line for the tooltip (a part's manufacturer). */
  hint?: string | null;
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
}

export interface SankeyOptionInput {
  nodes: readonly SankeyNode[];
  links: readonly SankeyLink[];
  /** The unit every value is counted in — "sessions", "views", "clicks". */
  unit: string;
  /** What 100% means for a link's share: the flow's total. */
  total: number;
  /** Horizontal for a wide host; vertical stacks the columns top-to-bottom
   *  for a phone. */
  orient?: 'horizontal' | 'vertical';
  /** Per-column node colors; defaults to the admin series palette. */
  colors?: readonly string[];
}

/** One color per column, cycling the palette past its end. */
export function columnColor(column: number, colors: readonly string[] = CHART_SERIES): string {
  return colors[((column % colors.length) + colors.length) % colors.length] ?? CHART_SERIES[0];
}

/** Pixels reserved right of the last column for its labels (horizontal). */
export const LAST_COLUMN_LABEL_ROOM = 132;

const pct = (value: number, total: number): string =>
  total > 0 ? `${((100 * value) / total).toFixed(value / total < 0.01 ? 2 : 1)}%` : '—';

export function sankeyOption(input: SankeyOptionInput): EChartsCoreOption {
  const { nodes, links, unit, total, orient = 'horizontal', colors = CHART_SERIES } = input;
  const labelOf = new Map<string, string>();
  const hintOf = new Map<string, string>();
  const colorOf = new Map<string, string>();
  const known = new Set<string>();
  for (const n of nodes) {
    labelOf.set(n.id, n.label);
    if (n.hint) hintOf.set(n.id, n.hint);
    colorOf.set(n.id, columnColor(n.column, colors));
    known.add(n.id);
  }
  // A link to a node the server did not send would make ECharts invent one
  // (and label it with the raw id) — drop it instead.
  const safeLinks = links.filter(
    (l) => known.has(l.source) && known.has(l.target) && l.value > 0 && l.source !== l.target,
  );
  const vertical = orient === 'vertical';
  const fmt = (v: number) => v.toLocaleString();
  const colorFor = (id: string) => colorOf.get(id) ?? CHART_SERIES[0];

  return {
    animationDuration: CHART_DURATION,
    animationEasing: CHART_EASING,
    tooltip: {
      trigger: 'item',
      triggerOn: 'mousemove',
      formatter: (raw: unknown) => {
        const p = (raw ?? {}) as {
          dataType?: string;
          name?: string;
          value?: number;
          data?: { source?: string; target?: string; value?: number };
        };
        // tooltipCard escapes its title itself — pre-escaping here turned
        // "Microcontrollers & Processors" into "&amp;amp;" on hover.
        if (p.dataType === 'edge' && p.data) {
          const from = labelOf.get(p.data.source ?? '') ?? '';
          const to = labelOf.get(p.data.target ?? '') ?? '';
          const v = Number(p.data.value) || 0;
          return tooltipCard(`${from} → ${to}`, [
            tooltipRow(colorFor(p.data.source ?? ''), unit, `${fmt(v)} · ${pct(v, total)}`),
          ]);
        }
        const id = p.name ?? '';
        const v = Number(p.value) || 0;
        const label = labelOf.get(id) ?? id;
        const hint = hintOf.get(id);
        return tooltipCard(hint ? `${label} · ${hint}` : label, [
          tooltipRow(colorFor(id), unit, `${fmt(v)} · ${pct(v, total)}`),
        ]);
      },
    },
    // Column headings are DOM, not canvas: the host lays them over the
    // columns' true x positions (FlowsPanel), which a canvas text at a
    // percentage cannot know once margins are involved.
    series: [
      {
        type: 'sankey',
        orient,
        // Labels sit to the RIGHT of a node (top, when vertical), outside the
        // layout, so the last column needs its own margin or its labels are
        // painted off the canvas — the first cut lost the whole third column.
        left: 4,
        right: vertical ? 4 : LAST_COLUMN_LABEL_ROOM,
        top: vertical ? 26 : 6,
        bottom: 6,
        nodeWidth: vertical ? 12 : 14,
        nodeGap: vertical ? 8 : 10,
        nodeAlign: 'justify',
        layoutIterations: 0,
        draggable: false,
        emphasis: { focus: 'adjacency' },
        lineStyle: { color: 'gradient', opacity: 0.32, curveness: 0.5 },
        // Tiny tail nodes (a two-session source) would stack their labels on
        // top of each other; the server folds most of them, and this hides
        // whatever still collides rather than printing an unreadable smear.
        labelLayout: { hideOverlap: true },
        label: {
          position: vertical ? 'top' : 'right',
          fontFamily: CHART_FONT,
          fontSize: 11,
          // The Reports card is dark in both admin themes (#131c33), so the
          // label ink is fixed to the card's own title tone rather than the
          // theme's muted default, which read as grey-on-navy over ribbons.
          color: '#dfe6f5',
          // A hairline halo so a label stays legible over a ribbon.
          textBorderColor: 'rgba(15, 21, 38, 0.85)',
          textBorderWidth: 2,
          formatter: (raw: unknown) => {
            const name = (raw as { name?: string }).name ?? '';
            return labelOf.get(name) ?? name;
          },
        },
        // `depth` pins each node to the server's column. Without it ECharts
        // moves every node with no OUTGOING link to the LAST column
        // (moveSinksRight), so once the distributor column exists a brand
        // nobody clicked out of would be drawn under "Distributor".
        data: nodes.map((n) => ({
          name: n.id,
          depth: n.column,
          itemStyle: { color: colorFor(n.id), borderColor: withAlpha(colorFor(n.id), 0.5) },
        })),
        links: safeLinks.map((l) => ({ source: l.source, target: l.target, value: l.value })),
      },
    ],
  };
}
