// salesForceOption — the "book of business" as a radial cluster graph.
//
// Each sales rep is a labelled HUB; their sponsored customers are leaf nodes
// on concentric ELECTRON SHELLS around it, one ring per sponsor tier —
// Platinum closest, Gold second, Silver outermost (empty shells collapse).
// Bubble size is TIER-FIXED by an area law (value shows in the tooltip only):
//   A(hub) = 2·A(Platinum) = 3·A(Gold) = 4·A(Silver)
// Within a shell, leaves divide the circle EVENLY — 360°/n steps starting at
// 12 o'clock — with the ring radius grown so ring-mates clear each other
// (chord constraint). Clusters pack left→right on one baseline, centred.
//
// layout: 'none' (computed geometry), NOT 'force': a force simulation can only
// approximate even angular division, and ECharts' force+fixed-node combination
// mis-fits the viewport (the 2026-07-30 lane-anchor clipping). Interactive
// drag physics live in ./salesForcePhysics — this builder EXPORTS the rest
// geometry (`SalesForceBuild.layout`) so the spring layer never re-derives it.
// (File keeps its historical name to avoid import churn.)

import type { EChartsCoreOption } from 'echarts/core';
import { safeHexColor } from '@shared/utils/color';
import { normalizeSponsorTier } from '@admin/services/sponsorTier';
import type { SponsorTier } from '@admin/types/admin';
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

/** Rest-position descriptor for one node — consumed by salesForcePhysics so
 *  the spring layer shares this builder's geometry instead of re-deriving it. */
export interface SalesForceRestNode {
  /** The node's unique ECharts `name` (`n<index>`). */
  name: string;
  kind: 'hub' | 'leaf' | 'summary';
  rest: { x: number; y: number };
  /** Owning hub's node name for leaves; null for hubs/summaries. */
  hubName: string | null;
}

export interface SalesForceBuild {
  option: EChartsCoreOption;
  layout: SalesForceRestNode[];
}

const DEFAULT_FORMAT = (v: number) => v.toLocaleString();
// Big enough that a rep name (Anthony / Ronald / Demo) sits INSIDE the hub
// instead of spilling past its edge.
const HUB_NODE = 54;
// A collapsed group's single summary sphere is larger (it stands for many).
const SUMMARY_NODE = 78;

/** Demo expand/collapse morph duration — the physics layer restores this after
 *  its zero-duration frame updates, so keep the two in sync via this export. */
export const SALES_FORCE_MORPH_MS = 500;

// Tier-fixed bubble AREA law: A(hub) = 2·A(Pt) = 3·A(Au) = 4·A(Ag), so
// diameter = HUB_NODE / √k. Monthly value shows in the tooltip ONLY.
const TIER_NODE: Record<SponsorTier, number> = {
  Platinum: Math.round(HUB_NODE / Math.SQRT2), // 38
  Gold: Math.round(HUB_NODE / Math.sqrt(3)), // 31
  Silver: HUB_NODE / 2, // 27
};

// Electron shells, hub-outward. A null/unknown tier renders at Silver size in
// the Silver shell (normalizeSponsorTier — tier strings are free-form case).
const SHELL_ORDER: readonly SponsorTier[] = ['Platinum', 'Gold', 'Silver'];
const SHELL_CLEAR_HUB = 16; // clearance: hub edge → innermost-shell leaf edge
const SHELL_CLEAR = 14; // clearance between consecutive shells (edge → edge)
const RING_GAP = 12; // min chord clearance between ring-mates
const CLUSTER_GAP = 56; // breathing room between neighbouring clusters
const LABEL_PAD = 26; // room under a leaf for its caption

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

interface ShellGeom {
  /** Indexes into `group.children`, in input order. */
  childIdxs: number[];
  /** Leaf diameter on this shell (tier-fixed). */
  size: number;
  ringR: number;
}

export function buildSalesForce(input: SalesForceOptionInput): SalesForceBuild {
  const { groups, valueFormat = DEFAULT_FORMAT, emptyMessage = 'No data yet.' } = input;

  if (!groups.length || !groups.some((g) => g.children.length)) {
    return {
      option: {
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
      },
      layout: [],
    };
  }

  const nodes: ForceNode[] = [];
  const layout: SalesForceRestNode[] = [];
  // Links reference nodes by their INDEX in `nodes` (not name) — two reps can
  // both sponsor "Digi-Key", so names are not unique.
  const links: Array<{ source: number; target: number; lineStyle: Record<string, unknown> }> = [];

  // ── Shell geometry ────────────────────────────────────────────────────────
  const geoms = groups.map((g) => {
    const hubSize = g.collapsed ? SUMMARY_NODE : HUB_NODE;
    if (g.collapsed || !g.children.length) {
      return { hubSize, shells: [] as ShellGeom[], clusterR: hubSize / 2 + 8 };
    }
    // Bucket children by normalized tier (unknown → Silver), keeping input order.
    const buckets: Record<SponsorTier, number[]> = { Platinum: [], Gold: [], Silver: [] };
    g.children.forEach((c, i) => buckets[normalizeSponsorTier(c.tier) ?? 'Silver'].push(i));

    const shells: ShellGeom[] = [];
    for (const tier of SHELL_ORDER) {
      const childIdxs = buckets[tier];
      if (!childIdxs.length) continue; // empty shells collapse
      const size = TIER_NODE[tier];
      const prev = shells[shells.length - 1];
      // Radial constraint: clear the hub (innermost) or the previous shell.
      const clearR = prev
        ? prev.ringR + prev.size / 2 + size / 2 + SHELL_CLEAR
        : hubSize / 2 + size / 2 + SHELL_CLEAR_HUB;
      // Chord constraint: adjacent ring-mates (2R·sin(π/n) apart) never collide.
      const n = childIdxs.length;
      const chordR = n >= 2 ? (size + RING_GAP) / (2 * Math.sin(Math.PI / n)) : 0;
      shells.push({ childIdxs, size, ringR: Math.max(clearR, chordR) });
    }
    const outer = shells[shells.length - 1];
    return { hubSize, shells, clusterR: outer.ringR + outer.size / 2 + LABEL_PAD };
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
    // not-real "Demo" bucket stops swamping the rep clusters. It still counts
    // as a draggable hub for the physics layer.
    if (g.collapsed) {
      const accounts = g.accounts ?? g.children.length;
      const name = `n${nodes.length}`;
      nodes.push({
        name,
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
      layout.push({ name, kind: 'summary', rest: { x: cx, y: 0 }, hubName: null });
      return;
    }

    const hubIndex = nodes.length;
    const hubName = `n${hubIndex}`;
    nodes.push({
      name: hubName,
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
    layout.push({ name: hubName, kind: 'hub', rest: { x: cx, y: 0 }, hubName: null });

    geo.shells.forEach((shell) => {
      const n = shell.childIdxs.length;
      shell.childIdxs.forEach((childIdx, k) => {
        const c = g.children[childIdx];
        const set = tierColorSet(c.tier);
        const leafIndex = nodes.length;
        const leafName = `n${leafIndex}`;
        // Even angular division PER SHELL, starting at 12 o'clock (screen y
        // grows down, so -π/2 is straight up): 3 kids → tripod, 4 → cross.
        const angle = -Math.PI / 2 + (2 * Math.PI * k) / n;
        const x = cx + shell.ringR * Math.cos(angle);
        const y = shell.ringR * Math.sin(angle);
        nodes.push({
          name: leafName,
          displayName: c.label,
          kind: 'leaf',
          groupName: g.name,
          tier: c.tier ?? null,
          value: Number(c.value) || 0,
          symbolSize: shell.size,
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
          x,
          y,
        });
        layout.push({ name: leafName, kind: 'leaf', rest: { x, y }, hubName });
        links.push({
          source: hubIndex,
          target: leafIndex,
          lineStyle: { color: withAlpha(hubColor, 0.3), width: 1, curveness: 0 },
        });
      });
    });
  });

  const option: EChartsCoreOption = {
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
        animationDurationUpdate: SALES_FORCE_MORPH_MS,
        emphasis: { focus: 'adjacency', scale: true },
        scaleLimit: { min: 0.6, max: 2.4 },
        data: nodes,
        links,
      },
    ],
  };

  return { option, layout };
}

export function salesForceOption(input: SalesForceOptionInput): EChartsCoreOption {
  return buildSalesForce(input).option;
}
