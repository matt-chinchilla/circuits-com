// Shared tooltip markup for every chart in the kit.
//
// SECURITY: an ECharts tooltip `formatter` that returns a string has that
// string injected as innerHTML. Series/slice/group labels here come from the
// API and the DB (rep usernames, vendor names, supplier company names), so
// EVERY interpolated label goes through `escapeHtml`. This is the ECharts
// equivalent of the repo's "insert series labels as React children, never
// dangerouslySetInnerHTML" rule.
//
// Colors are interpolated into inline styles, so callers must pass a value
// already gated by `safeHexColor` (the builders do).

import { CHART_FG1, CHART_FG2, CHART_FG3, CHART_FONT } from '../chartTheme';

/** ECharts hands the formatter `any`; these are the fields the kit reads. */
export interface TooltipItem {
  axisValueLabel?: string;
  axisValue?: string | number;
  seriesName?: string;
  seriesIndex?: number;
  dataIndex?: number;
  color?: string;
  name?: string;
  percent?: number;
  value?: unknown;
  data?: unknown;
}

/** Axis-trigger hands an array, item-trigger a single object. */
export function tooltipItems(raw: unknown): TooltipItem[] {
  if (Array.isArray(raw)) return raw as TooltipItem[];
  return raw ? [raw as TooltipItem] : [];
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/** Numeric y out of an ECharts datum, which may be `y`, `[x, y]` or `{value}`. */
export function numericValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return numericValue(value[value.length - 1]);
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** One tooltip row: 14x2 line-key, then VALUE (leading, semibold, tabular),
 *  then the label. Value leads because the reader came for the number. */
export function tooltipRow(color: string, label: string, value: string): string {
  return (
    `<div style="display:flex;align-items:center;gap:8px;margin-top:5px;white-space:nowrap">` +
    `<span style="flex:0 0 auto;width:14px;height:2px;border-radius:1px;background:${escapeHtml(color)}"></span>` +
    `<span style="font-weight:600;font-variant-numeric:tabular-nums;color:${CHART_FG1}">${escapeHtml(value)}</span>` +
    `<span style="color:${CHART_FG2}">${escapeHtml(label)}</span>` +
    `</div>`
  );
}

/** Card wrapper. `title` is the x value / category — de-emphasized above the rows. */
export function tooltipCard(title: string | null, rows: string[]): string {
  const head = title
    ? `<div style="font-size:11px;color:${CHART_FG3};letter-spacing:.01em">${escapeHtml(title)}</div>`
    : '';
  return `<div style="font-family:${CHART_FONT};font-size:12px;line-height:1.35">${head}${rows.join('')}</div>`;
}
