// salesForceOption — the "book of business" as a radial cluster graph.
//
// Each sales rep is a labelled HUB; their sponsored customers are leaf nodes
// linked to it, sized by monthly value (AREA ∝ value → radius ∝ √value) and
// coloured by sponsor TIER (the public-board materials). Children are divided
// EVENLY around their hub — 360°/n steps starting at 12 o'clock, so 3 kids
// read as a tripod (| top, / \ below) and 4 kids as a cross — with the ring
// radius grown just enough that adjacent siblings clear each other. Clusters
// pack left→right on one baseline, centred on the origin.
//
// layout: 'none' (computed geometry), NOT 'force': a force simulation can only
// approximate even angular division, and ECharts' force+fixed-node combination
// mis-fits the viewport (the 2026-07-30 lane-anchor clipping). Node dragging
// is force-only in ECharts, so it went with the physics — zoom (roam:'scale')
// remains. (File keeps its historical name to avoid import churn.)

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
  /** Render the whole group as ONE summary sphere (no leaves) instead of a hub
   *  + its customers — used to tame the big not-real "Demo" bucket. */
  collapsed?: boolean;
  /** Account count shown on a collapsed summary sphere. Defaults to children.length. */
  accounts?: number;
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
// A collapsed group's single summary sphere is larger (it stands for many).
const SUMMARY_NODE = 78;

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
  kind: 'hub' | 'leaf' | 'summary';
  groupName: string;
  tier: string | null;
  value: number;
  accounts?: number;
  symbolSize: number;
  itemStyle: Record<string, unknown>;
  label: Record<string, unknown>;
  x: number;
  y: number;
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

  // ── Radial geometry ───────────────────────────────────────────────────────
  const LEAF_GAP = 14; // min clearance between adjacent siblings on the ring
  const SPOKE_MIN = 30; // min clear spoke (hub edge → leaf edge)
  const CLUSTER_GAP = 56; // breathing room between neighbouring clusters
  const LABEL_PAD = 26; // room under a leaf for its caption

  const geoms = groups.map((g) => {
    const hubSize = g.collapsed ? SUMMARY_NODE : HUB_NODE;
    if (g.collapsed || !g.children.length) {
      return { ringR: 0, clusterR: hubSize / 2 + 8, sizes: [] as number[], hubSize };
    }
    const sizes = g.children.map((c) => nodeSize(Number(c.value) || 0, maxCustomer));
    const maxLeaf = Math.max(...sizes);
    const n = sizes.length;
    // Two constraints: the spoke must clear the hub, and the CHORD between
    // adjacent siblings (2r·sin(π/n)) must clear two half-leaves + a gap.
    const spokeR = hubSize / 2 + SPOKE_MIN + maxLeaf / 2;
    const chordR = n >= 2 ? (maxLeaf + LEAF_GAP) / (2 * Math.sin(Math.PI / n)) : 0;
    const ringR = Math.max(spokeR, chordR);
    return { ringR, clusterR: ringR + maxLeaf / 2 + LABEL_PAD, sizes, hubSize };
  });

  // Pack clusters left→right on one baseline, then centre the row on x=0.
  const centers: number[] = [];
  let cursor = 0;
  geoms.forEach((geo, i) => {
    centers[i] = cursor + geo.clusterR;
    cursor = centers[i] + geo.clusterR + CLUSTER_GAP;
  });
  const shift = (cursor - CLUSTER_GAP) / 2;

  groups.forEach((g, gi) => {
    const hubColor = safeHexColor(g.color) ?? CHART_NEUTRAL;
    const geo = geoms[gi];
    const cx = centers[gi] - shift;

    // A collapsed group is ONE summary sphere — no hub, no leaves — so the big
    // not-real "Demo" bucket stops swamping the rep clusters.
    if (g.collapsed) {
      const accounts = g.accounts ?? g.children.length;
      nodes.push({
        name: `n${nodes.length}`,
        displayName: g.name,
        kind: 'summary',
        groupName: g.name,
        tier: null,
        value: Number(g.total) || 0,
        accounts,
        symbolSize: SUMMARY_NODE,
        itemStyle: {
          color: sphereFill(hubColor),
          borderColor: CHART_CARD,
          borderWidth: 1,
          shadowBlur: 14,
          shadowColor: withAlpha(hubColor, 0.4),
          shadowOffsetY: 4,
        },
        label: {
          show: true,
          position: 'inside',
          formatter: `${g.name}\n${accounts} accts`,
          fontFamily: CHART_FONT,
          fontSize: 12,
          fontWeight: 800,
          lineHeight: 15,
          color: '#ffffff',
        },
        x: cx,
        y: 0,
      });
      return;
    }

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
      x: cx,
      y: 0,
    });

    // Ring order interleaves big/small (sorted halves zipped) so consecutive
    // high-value accounts don't clump visual mass on one arc — every large
    // sphere gets small neighbours. Angles stay an exact even division.
    const bySize = g.children.map((_, i) => i).sort((a, b) => geo.sizes[b] - geo.sizes[a]);
    const half = Math.ceil(bySize.length / 2);
    const ringOrder: number[] = [];
    for (let i = 0; i < half; i++) {
      ringOrder.push(bySize[i]);
      if (i + half < bySize.length) ringOrder.push(bySize[i + half]);
    }

    ringOrder.forEach((childIdx, k) => {
      const c = g.children[childIdx];
      const set = tierColorSet(c.tier);
      const leafIndex = nodes.length;
      // Even angular division, starting at 12 o'clock (screen y grows down,
      // so -π/2 is straight up): 3 kids → tripod, 4 kids → cross.
      const angle = -Math.PI / 2 + (2 * Math.PI * k) / g.children.length;
      nodes.push({
        name: `n${leafIndex}`,
        displayName: c.label,
        kind: 'leaf',
        groupName: g.name,
        tier: c.tier ?? null,
        value: Number(c.value) || 0,
        symbolSize: geo.sizes[k],
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
        x: cx + geo.ringR * Math.cos(angle),
        y: geo.ringR * Math.sin(angle),
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
        if (d.kind === 'summary') {
          return tooltipCard(String(d.displayName ?? ''), [
            tooltipRow(
              CHART_NEUTRAL,
              `${d.accounts ?? 0} accounts · click to expand`,
              valueFormat(Number(d.value) || 0),
            ),
          ]);
        }
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
        // Computed radial geometry — see the header comment. Zoom only: no
        // panning, so the graph can never leave its bordered arena.
        layout: 'none',
        roam: 'scale',
        // Demo expand/collapse morphs the clusters smoothly between layouts.
        animationDurationUpdate: 500,
        emphasis: { focus: 'adjacency', scale: true },
        scaleLimit: { min: 0.6, max: 2.4 },
        data: nodes,
        links,
      },
    ],
  };
}
