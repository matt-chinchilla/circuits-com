// Admin chart kit — palette + registered ECharts theme.
//
// PURE MODULE: zero echarts imports, so the option builders (which need the
// palette) never drag the library in. `EChart.tsx` is the single place that
// calls `echarts.registerTheme(ADMIN_CHART_THEME_NAME, ADMIN_CHART_THEME)`.
//
// ── Why hard-coded hexes and not var(--a-grad-*) ───────────────────────────
// The canvas renderer cannot resolve CSS custom properties: a `var(...)` string
// handed to a canvas fillStyle silently paints black. The values below MIRROR
// the `--a-grad-*` / `--a-grid` / `--a-axis` tokens added to
// `AdminLayout.module.scss` (.admin). Change one, change both.
//
// ── Palette provenance (dataviz validator, light mode, surface #ffffff) ────
//   adjacent order green -> blue -> gold -> purple
//     [PASS] lightness band  [PASS] chroma floor  [PASS] all >= 3:1
//     worst adjacent CVD dE 25.6 (deutan), normal-vision dE 27.6
//   HARD CONSTRAINT: #2563eb (blue) and #7c3aed (purple) collapse under
//   deuteranopia (dE 0.4). They may never be adjacent slots and never coexist
//   in an all-pairs form (scatter / bubble / circle pack) — hence the separate
//   3-colour CHART_SERIES_ALLPAIRS cap.
//   $executive-blue #0a4a2e FAILS the mark gate (L .363 / C .078): it stays
//   INK (headings, --a-primary), never a series stroke or fill.
//   Series green is #0e7a49 and deliberately NOT #15803d — that value IS
//   --a-ok, the reserved status colour, and a series must never impersonate
//   status.
// Re-run before changing any hex:
//   node scripts/validate_palette.js "#0e7a49,#2563eb,#a88d2e,#7c3aed" --mode light --surface "#ffffff"
//   node scripts/validate_palette.js "#0e7a49,#2563eb,#a88d2e" --mode light --surface "#ffffff" --pairs all
//   node scripts/validate_palette.js "#5c4c18,#7f6a22,#a88d2e,#cba949" --mode light --surface "#ffffff" --ordinal

import { mixHex, safeHexColor } from '@shared/utils/color';

/** Validated adjacent-safe series order — lines, stacks, bars. */
export const CHART_SERIES = ['#0e7a49', '#2563eb', '#a88d2e', '#7c3aed'] as const;

/** All-pairs cap (scatter, bubble, circle pack). Three. Never four. */
export const CHART_SERIES_ALLPAIRS = ['#0e7a49', '#2563eb', '#a88d2e'] as const;

/** Gradient-stop lift values. NEVER a mark colour — each is below the 3:1 gate. */
export const CHART_SERIES_LIFT = ['#52b985', '#7fb2f5', '#cba949', '#b394f5'] as const;

/**
 * Sponsor-tier identity colours — matched 1:1 to the PUBLIC sponsor boards
 * (`categorySponsor.scss` per-tier `--gold` token: Platinum `.csbA`, Gold
 * OPEN-SLOT `--accent`, Silver PREFERRED-PARTNERS). CATEGORICAL, not an ordinal
 * ramp — each tier is its own material (lavender-platinum, ENIG-gold,
 * steel-silver) so the tiers read as three distinct vibrant hues instead of
 * shades of one bronze. BRAND colours: they answer to the boards, so they are
 * exempt from the series validator above.
 */
export interface TierColor {
  base: string;
  bright: string;
  deep: string;
}
export const TIER_COLORS: Record<'platinum' | 'gold' | 'silver' | 'none', TierColor> = {
  platinum: { base: '#c5bfd6', bright: '#ece8f6', deep: '#8f86ac' },
  gold: { base: '#e8c252', bright: '#f3cf5c', deep: '#b8902e' },
  silver: { base: '#9db4c6', bright: '#d4e6f2', deep: '#6f8696' },
  none: { base: '#64748b', bright: '#94a3b8', deep: '#475569' },
};

/** De-emphasis / "Other". NOT a categorical slot. */
export const CHART_NEUTRAL = '#64748b';

// Chrome — MIRRORS the --a-grid / --a-axis / --a-track / --a-card / --a-border /
// --a-fg* tokens in AdminLayout.module.scss, in BOTH light and dark. The canvas
// renderer cannot resolve var(), so the values are duplicated here; change one,
// change both. These are `let` (not const) so `applyChartChrome()` can swap them
// when the admin theme toggles — the option builders read the live binding, so a
// rebuilt chart + a re-registered theme pick up the current values.
interface ChartChrome {
  grid: string;
  axis: string;
  track: string;
  card: string;
  border: string;
  fg1: string;
  fg2: string;
  fg3: string;
  fg4: string;
}
const CHROME_LIGHT: ChartChrome = {
  grid: '#eef1f5',
  axis: '#d8dee7',
  track: '#f0f2f5',
  card: '#ffffff',
  border: '#e5e7eb',
  fg1: '#111827',
  fg2: '#4b5563',
  fg3: '#6b7280',
  fg4: '#9ca3af',
};
const CHROME_DARK: ChartChrome = {
  grid: '#232d3d',
  axis: '#38445a',
  track: '#202a39',
  card: '#171e2b',
  border: '#2a3446',
  fg1: '#f1f4f9',
  fg2: '#c3ccda',
  fg3: '#93a0b4',
  fg4: '#647080',
};

export let CHART_GRID = CHROME_LIGHT.grid;
export let CHART_AXIS = CHROME_LIGHT.axis;
export let CHART_TRACK = CHROME_LIGHT.track;
export let CHART_CARD = CHROME_LIGHT.card;
export let CHART_BORDER = CHROME_LIGHT.border;
export let CHART_FG1 = CHROME_LIGHT.fg1;
export let CHART_FG2 = CHROME_LIGHT.fg2;
export let CHART_FG3 = CHROME_LIGHT.fg3;
export let CHART_FG4 = CHROME_LIGHT.fg4;

/** Swap chart chrome to match the admin theme. AdminThemeContext calls this
 *  BEFORE the themed content remounts, so every rebuilt option + the
 *  re-registered ECharts theme read the right light/dark values. */
export function applyChartChrome(dark: boolean): void {
  const c = dark ? CHROME_DARK : CHROME_LIGHT;
  CHART_GRID = c.grid;
  CHART_AXIS = c.axis;
  CHART_TRACK = c.track;
  CHART_CARD = c.card;
  CHART_BORDER = c.border;
  CHART_FG1 = c.fg1;
  CHART_FG2 = c.fg2;
  CHART_FG3 = c.fg3;
  CHART_FG4 = c.fg4;
}

/** Body sans (mirrors $font-body). $font-mono stays for SKUs/designators. */
export const CHART_FONT =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'Inter', system-ui, sans-serif";

/** iOS ease-out: fast departure, long settle. Never an overshoot bezier. */
export const CHART_EASING = 'cubicOut';
export const CHART_DURATION = 620;

/** The tier's {base,bright,deep} set. Unknown tier -> the neutral 'none' set. */
export function tierColorSet(tier: string | null | undefined): TierColor {
  switch ((tier ?? '').trim().toLowerCase()) {
    case 'platinum':
      return TIER_COLORS.platinum;
    case 'gold':
      return TIER_COLORS.gold;
    case 'silver':
      return TIER_COLORS.silver;
    default:
      return TIER_COLORS.none;
  }
}

/** Solid tier identity hex — pie tooltip key, bubble fill, legend swatch. */
export function tierColor(tier: string | null | undefined): string {
  return tierColorSet(tier).base;
}

/** Metallic tier fill: bright -> deep vertical sweep. Reads as brushed metal
 *  and keeps a legible dark stop, so even a pale tier has presence on white. */
export function tierFill(tier: string | null | undefined) {
  const c = tierColorSet(tier);
  return verticalGradient([
    { offset: 0, color: c.bright },
    { offset: 1, color: c.deep },
  ]);
}

/** Glossy 3D bead: an OFF-CENTRE radial highlight -> base -> deep, so a canvas
 *  mark (a force-graph bubble) reads as a lit sphere. Pair with a soft
 *  tier-dark drop shadow at the render site for the full 3D effect. */
export function tierRadial(tier: string | null | undefined) {
  const c = tierColorSet(tier);
  return {
    type: 'radial' as const,
    x: 0.36,
    y: 0.3,
    r: 0.78,
    colorStops: [
      { offset: 0, color: c.bright },
      { offset: 0.5, color: c.base },
      { offset: 1, color: c.deep },
    ],
  };
}

/** Glossy 3D sphere from a SINGLE hex (lighten -> hex -> darken) — for a mark
 *  with no tier {base,bright,deep} set of its own, e.g. a sales-rep hub. */
export function sphereFill(hex: string) {
  const safe = safeHexColor(hex) ?? CHART_NEUTRAL;
  return {
    type: 'radial' as const,
    x: 0.36,
    y: 0.3,
    r: 0.82,
    colorStops: [
      { offset: 0, color: mixHex(safe, '#ffffff', 0.42) },
      { offset: 0.5, color: safe },
      { offset: 1, color: mixHex(safe, '#141821', 0.68) },
    ],
  };
}

/** DOM legend chip — a metallic 135deg gradient in the tier's own material. */
export function tierCssGradient(tier: string | null | undefined): string {
  const c = tierColorSet(tier);
  return `linear-gradient(135deg, ${c.bright}, ${c.deep})`;
}

/** Stable slot lookup — colour follows the ENTITY key, never the array index,
 *  so filtering a series out never repaints the survivors. */
export function seriesColorAt(index: number): string {
  return CHART_SERIES[index % CHART_SERIES.length];
}

/** `#rrggbb` + alpha -> `rgba(...)`. Hostile/short input degrades to neutral. */
export function withAlpha(hex: string, alpha: number): string {
  const safe = safeHexColor(hex) ?? CHART_NEUTRAL;
  const r = parseInt(safe.slice(1, 3), 16);
  const g = parseInt(safe.slice(3, 5), 16);
  const b = parseInt(safe.slice(5, 7), 16);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export interface GradientStop {
  offset: number;
  color: string;
}

/** ECharts linear-gradient literal (top -> bottom). Plain object on purpose:
 *  `echarts.graphic.LinearGradient` would make every option builder import the
 *  library. ECharts accepts this shape verbatim. */
export function verticalGradient(stops: GradientStop[]) {
  return { type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1, colorStops: stops };
}

/** The area wash under a line. Top stop 0.20 -> 0 averages well under 10% ink. */
export function areaGradient(color: string, top = 0.2) {
  return verticalGradient([
    { offset: 0, color: withAlpha(color, top) },
    { offset: 0.7, color: withAlpha(color, top * 0.25) },
    { offset: 1, color: withAlpha(color, 0) },
  ]);
}

/** Pie/bar fill: 12% white at the top falling to the VALIDATED hex at the
 *  bottom. The darkest stop is the measured colour, so slice contrast never
 *  drops below the validated value — lightening further breaks validation. */
export function fillGradient(color: string) {
  const safe = safeHexColor(color) ?? CHART_NEUTRAL;
  return verticalGradient([
    { offset: 0, color: mixHex(safe, '#ffffff', 0.88) },
    { offset: 1, color: safe },
  ]);
}

/** Relative luminance (sRGB, WCAG). Used to pick ink-vs-white text ON a fill. */
export function relLuminance(hex: string): number {
  const safe = safeHexColor(hex) ?? CHART_NEUTRAL;
  const chan = (i: number) => {
    const v = parseInt(safe.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(0) + 0.7152 * chan(1) + 0.0722 * chan(2);
}

/** Text set INSIDE a filled mark is the one sanctioned exception to "text
 *  never wears the data colour" — pick by fill luminance. */
export function readableTextColor(fill: string): string {
  return relLuminance(fill) > 0.5 ? CHART_FG1 : '#ffffff';
}

export const ADMIN_CHART_THEME_NAME = 'circuits-admin';

/**
 * The registered theme. Anything a builder does NOT set falls back to these,
 * so every chart in the console inherits the same axis weight, tooltip card,
 * legend key, easing and type stack without repeating itself.
 *
 * Deliberate choices:
 *  - gridlines HORIZONTAL, SOLID, 1px hairline (a dashed grid reads as
 *    "threshold/projection" when it is just a grid);
 *  - no axis line / no ticks on the value axis — the labels are the axis;
 *  - legend icon is a 14x3 roundRect line-key, not a filled box;
 *  - tooltip is a white card with a 6px radius and a soft shadow, never the
 *    stock dark bubble.
 */
/** Build the registered ECharts theme from the CURRENT chrome values. A
 *  function (not a const) so `EChart` can re-register it after a theme toggle
 *  and pick up the swapped light/dark chrome. */
export function buildAdminTheme() {
  return {
  color: [...CHART_SERIES],
  backgroundColor: 'transparent',
  animationEasing: CHART_EASING,
  animationDuration: CHART_DURATION,
  animationEasingUpdate: CHART_EASING,
  animationDurationUpdate: 320,
  textStyle: { fontFamily: CHART_FONT, fontSize: 12, color: CHART_FG2 },
  title: {
    textStyle: { fontFamily: CHART_FONT, fontSize: 14, fontWeight: 600, color: CHART_FG1 },
    subtextStyle: { fontFamily: CHART_FONT, fontSize: 12, color: CHART_FG3 },
  },
  line: {
    smooth: true,
    symbol: 'circle',
    symbolSize: 8,
    showSymbol: false,
    lineStyle: { width: 2, cap: 'round', join: 'round' },
    itemStyle: { borderWidth: 2, borderColor: CHART_CARD },
  },
  pie: {
    itemStyle: { borderColor: CHART_CARD, borderWidth: 2, borderRadius: 4 },
    label: { color: CHART_FG2, fontFamily: CHART_FONT, fontSize: 11 },
    labelLine: { lineStyle: { color: CHART_AXIS } },
  },
  categoryAxis: {
    axisLine: { show: true, lineStyle: { color: CHART_AXIS, width: 1 } },
    axisTick: { show: false },
    axisLabel: { show: true, color: CHART_FG3, fontSize: 11, fontFamily: CHART_FONT },
    splitLine: { show: false, lineStyle: { color: [CHART_GRID] } },
    splitArea: { show: false },
  },
  valueAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { show: true, color: CHART_FG3, fontSize: 11, fontFamily: CHART_FONT },
    splitLine: { show: true, lineStyle: { color: [CHART_GRID], width: 1, type: 'solid' } },
    splitArea: { show: false },
  },
  legend: {
    icon: 'roundRect',
    itemWidth: 14,
    itemHeight: 3,
    itemGap: 18,
    textStyle: { color: CHART_FG2, fontSize: 12, fontFamily: CHART_FONT },
    inactiveColor: CHART_FG4,
  },
  tooltip: {
    backgroundColor: CHART_CARD,
    borderColor: CHART_BORDER,
    borderWidth: 1,
    padding: [8, 11],
    extraCssText: 'border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.08);',
    textStyle: { color: CHART_FG1, fontSize: 12, fontFamily: CHART_FONT },
    axisPointer: {
      lineStyle: { color: CHART_AXIS, width: 1, type: 'solid' },
      crossStyle: { color: CHART_AXIS, width: 1, type: 'solid' },
      label: { backgroundColor: CHART_FG2, fontFamily: CHART_FONT, fontSize: 11 },
      shadowStyle: { color: 'rgba(100,116,139,0.06)' },
    },
  },
  };
}
