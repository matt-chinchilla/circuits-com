// circlePackOption — 2-level bubble pack (sales rep -> their customers).
//
// Rendered with an ECharts CUSTOM series over `coordinateSystem: 'none'`, so
// the packer owns the geometry outright and ECharts only supplies the frame,
// hit-testing and the tooltip. (No `graphic` fallback was needed — the custom
// series took the layout cleanly, and unlike `graphic` it keeps per-datum
// tooltips and dataIndex mapping for free.) `renderItem` reads
// `api.getWidth()/getHeight()`, so a container resize re-packs automatically;
// the result is memoized per `WxH` so the O(n) pack runs once per size, not
// once per bubble.
//
// ── Colour, the part that is easy to get wrong ─────────────────────────────
//  - PARENT = categorical identity. A pack is an ALL-PAIRS form (any two
//    circles can end up adjacent), so groups are capped at the validated trio
//    CHART_SERIES_ALLPAIRS. #7c3aed must never appear next to #2563eb here —
//    dE 0.4 under deuteranopia. A 4th group folds to "Other" or the view
//    facets into small multiples; never a generated hue.
//  - PARENT SHELLS ARE CHROME, not marks: 10% -> 4% radial wash, 18%-alpha
//    hairline. As chrome they sit outside the 3:1 mark gate and stop competing
//    with the children for attention.
//  - CHILD = tier = BRAND material. Platinum / Gold / Silver take the sponsor
//    boards' own tier colours (lavender / ENIG-gold / steel) via `tierColor`,
//    so a customer bubble reads its tier at a glance. Only three tiers exist,
//    so this never approaches the all-pairs cap.
//
// Sizing: packHierarchy guarantees r ∝ sqrt(value), i.e. bubble AREA ∝ value.
// Radius ∝ value quadruples the perceived magnitude and is the classic bubble
// lie — every label below assumes the area encoding.

import type { EChartsCoreOption } from 'echarts/core';
import { safeHexColor } from '@shared/utils/color';
import {
  CHART_CARD,
  CHART_FG2,
  CHART_FG3,
  CHART_FONT,
  CHART_NEUTRAL,
  CHART_SERIES_ALLPAIRS,
  readableTextColor,
  tierColor,
  withAlpha,
} from '../chartTheme';
import { packHierarchy } from '../packHierarchy';
import { tooltipCard, tooltipItems, tooltipRow } from './tooltip';

export interface CirclePackChild {
  label: string;
  value: number;
  /** Sponsor tier -> board tier colour (`tierColor`). */
  tier?: string | null;
  /** Explicit override; must be a stored-safe `#rrggbb` (it is re-gated here). */
  color?: string | null;
}

export interface CirclePackGroup {
  name: string;
  children: readonly CirclePackChild[];
  /** Override the categorical slot. Capped at the all-pairs trio by default. */
  color?: string | null;
}

export interface CirclePackOptionInput {
  groups: readonly CirclePackGroup[];
  valueFormat?: (v: number) => string;
  /** Empty px kept inside the box. Default 10. */
  margin?: number;
  emptyMessage?: string;
}

const DEFAULT_FORMAT = (v: number) => v.toLocaleString();

// Label fitting: a label that does not fit is OMITTED, never truncated and
// never clipped — cropping the first/last characters is worse than no label.
// The value stays reachable through the tooltip.
const CHAR_W = 0.55; // system-sans average advance / font-size
const LABEL_FS = 11;
const VALUE_FS = 11;

function fitsLabel(r: number, label: string): boolean {
  return r >= 22 && label.length * LABEL_FS * CHAR_W <= 2 * r - 10;
}
function fitsValue(r: number): boolean {
  return r >= 30;
}

interface RenderParams {
  dataIndex: number;
}
interface RenderApi {
  getWidth: () => number;
  getHeight: () => number;
}

export function circlePackOption(input: CirclePackOptionInput): EChartsCoreOption {
  const { groups, valueFormat = DEFAULT_FORMAT, margin = 10, emptyMessage = 'No data yet.' } = input;

  if (import.meta.env.DEV && groups.length > 3) {
    console.warn(
      `[circlePackOption] ${groups.length} groups — the all-pairs colour cap is 3; fold the rest into "Other" or facet into small multiples.`,
    );
  }

  const groupColors = groups.map(
    (g, i) => safeHexColor(g.color ?? '') ?? CHART_SERIES_ALLPAIRS[i % CHART_SERIES_ALLPAIRS.length],
  );

  // Flat leaf list, aligned 1:1 with the packed structure (packHierarchy
  // returns groups AND children in INPUT order).
  const leaves = groups.flatMap((g, gi) =>
    g.children.map((c, ci) => ({
      gi,
      ci,
      groupName: g.name,
      label: c.label,
      value: Number(c.value) || 0,
      tier: c.tier ?? null,
      fill: safeHexColor(c.color ?? '') ?? tierColor(c.tier),
    })),
  );

  if (!groups.length || !leaves.length) {
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

  // One pack per box size, reused across every renderItem call for that size.
  let cacheKey = '';
  let cached: ReturnType<typeof packHierarchy>['groups'] = [];
  const packFor = (w: number, h: number) => {
    const key = `${w}x${h}`;
    if (key !== cacheKey) {
      cacheKey = key;
      cached = packHierarchy(
        groups.map((g) => ({ name: g.name, children: g.children.map((c) => ({ value: Math.max(0, Number(c.value) || 0) })) })),
        w,
        h,
        { margin },
      ).groups;
    }
    return cached;
  };

  return {
    animation: true,
    tooltip: {
      trigger: 'item',
      confine: true,
      formatter: (raw: unknown) => {
        const [item] = tooltipItems(raw);
        const datum = item?.data as
          | { groupName?: string; label?: string; value?: number; tier?: string | null; fill?: string }
          | undefined;
        if (!datum) return '';
        const color = safeHexColor(datum.fill ?? '') ?? CHART_NEUTRAL;
        // tooltipCard/tooltipRow escape every interpolated string.
        const head = datum.tier
          ? `${datum.groupName ?? ''} · ${datum.tier}`
          : (datum.groupName ?? '');
        return tooltipCard(head, [
          tooltipRow(color, datum.label ?? '', valueFormat(Number(datum.value) || 0)),
        ]);
      },
    },
    series: [
      // (1) Group shells + names. `silent` — chrome must not eat the hit test.
      {
        type: 'custom',
        coordinateSystem: 'none',
        silent: true,
        z: 1,
        data: groups.map((g, i) => ({ name: g.name, value: i })),
        renderItem: (params: RenderParams, api: RenderApi) => {
          const packed = packFor(api.getWidth(), api.getHeight());
          const g = packed[params.dataIndex];
          if (!g || !(g.r > 0)) return undefined;
          const color = groupColors[params.dataIndex];
          return {
            type: 'group',
            children: [
              {
                type: 'circle',
                shape: { cx: g.x, cy: g.y, r: g.r },
                style: {
                  fill: {
                    type: 'radial',
                    x: 0.5,
                    y: 0.42,
                    r: 0.62,
                    colorStops: [
                      { offset: 0, color: withAlpha(color, 0.1) },
                      { offset: 1, color: withAlpha(color, 0.04) },
                    ],
                  },
                  stroke: withAlpha(color, 0.18),
                  lineWidth: 1,
                },
              },
              {
                type: 'text',
                style: {
                  text: g.name,
                  x: g.x,
                  y: g.y - g.r - 8,
                  textAlign: 'center',
                  textVerticalAlign: 'bottom',
                  font: `600 12px ${CHART_FONT}`,
                  fill: CHART_FG2,
                },
              },
            ],
          };
        },
      },
      // (2) Leaves. The MARK is the hit target — no crosshair.
      {
        type: 'custom',
        coordinateSystem: 'none',
        z: 2,
        data: leaves,
        renderItem: (params: RenderParams, api: RenderApi) => {
          const leaf = leaves[params.dataIndex];
          if (!leaf) return undefined;
          const packed = packFor(api.getWidth(), api.getHeight());
          const c = packed[leaf.gi]?.children[leaf.ci];
          if (!c || !(c.r > 0)) return undefined;

          const ink = readableTextColor(leaf.fill);
          const showValue = fitsValue(c.r);
          const showLabel = fitsLabel(c.r, leaf.label);

          const children: unknown[] = [
            {
              type: 'circle',
              shape: { cx: c.x, cy: c.y, r: c.r },
              // 2px surface ring separates touching bubbles.
              style: { fill: leaf.fill, opacity: 0.92, stroke: CHART_CARD, lineWidth: 2 },
            },
            {
              // Shared dimensional sheen — one gradient, no filter, no shadow.
              type: 'circle',
              silent: true,
              shape: { cx: c.x, cy: c.y, r: c.r },
              style: {
                fill: {
                  type: 'radial',
                  x: 0.35,
                  y: 0.28,
                  r: 0.7,
                  colorStops: [
                    { offset: 0, color: 'rgba(255,255,255,0.22)' },
                    { offset: 0.7, color: 'rgba(255,255,255,0)' },
                  ],
                },
              },
            },
          ];

          if (showLabel) {
            children.push({
              type: 'text',
              silent: true,
              style: {
                text: leaf.label,
                x: c.x,
                y: c.y - (showValue ? 6 : 0),
                textAlign: 'center',
                textVerticalAlign: 'middle',
                font: `${LABEL_FS}px ${CHART_FONT}`,
                fill: ink,
              },
            });
          }
          if (showValue) {
            children.push({
              type: 'text',
              silent: true,
              style: {
                text: valueFormat(leaf.value),
                x: c.x,
                y: c.y + (showLabel ? 9 : 0),
                textAlign: 'center',
                textVerticalAlign: 'middle',
                font: `600 ${VALUE_FS}px ${CHART_FONT}`,
                fill: ink,
              },
            });
          }

          return { type: 'group', children };
        },
      },
    ],
  };
}
