// Shared formatting + EST calendar helpers for the dashboard widgets.
//
// Every "today" / "current month" the dashboard shows must agree with the
// server, which buckets in America/New_York (zoneinfo). A UTC-derived day
// (`new Date().toISOString().slice(0,10)`) is AHEAD of ET for the last five
// hours of every day, which would slide the month-to-date cutoff onto a day the
// API reports as empty. Everything below goes through the explicit timeZone.

import { CHART_NEUTRAL, CHART_SERIES } from '@admin/components/charts/chartTheme';

export const EST_TZ = 'America/New_York';

const USD_CENTS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const USD_WHOLE = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/** `$1,234.56` — the canonical money readout for a headline number. */
export function usd(value: number): string {
  return USD_CENTS.format(Number.isFinite(value) ? value : 0);
}

/** Axis / tooltip money: whole dollars, then K, then M. Axis ticks are read at
 *  a glance, so `$12K` beats `$12,431.00`. */
export function usdCompact(value: number): string {
  const n = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `$${Math.round(n / 1000)}K`;
  return USD_WHOLE.format(n);
}

/** Thousands-separated integer. */
export function count(value: number): string {
  return (Number.isFinite(value) ? Math.round(value) : 0).toLocaleString();
}

const YMD_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: EST_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `YYYY-MM-DD` for an instant, in ET. en-CA is the ISO-shaped locale. */
export function estYmd(at: Date = new Date()): string {
  return YMD_FMT.format(at);
}

export interface EstDate {
  year: number;
  month: number;
  day: number;
}

/** Today's ET calendar date, split. `month` is 1-based. */
export function estToday(at: Date = new Date()): EstDate {
  const [year, month, day] = estYmd(at).split('-').map(Number);
  return { year, month, day };
}

/**
 * The same `days`-long ET day axis the `/dashboard/trends` contract returns,
 * ending today. Used only when a series is unavailable (demo mode, or a failed
 * fetch) — when the API answers, its own `day` values are authoritative.
 */
export function estDayWindow(days: number, at: Date = new Date()): string[] {
  const out: string[] = [];
  const now = at.getTime();
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(estYmd(new Date(now - i * 86_400_000)));
  }
  return out;
}

/** Days in a 1-based (year, month). Day 0 of the NEXT month is the last of this
 *  one; built in UTC so a local-tz offset can never roll it back a day. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `2026-07` -> `July`. Falls back to the raw key for anything unparseable. */
export function monthLabel(key: string): string {
  const [year, month] = key.split('-').map(Number);
  if (!year || !month) return key;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'long',
  });
}

/** `2026-07-30` -> `Jul 30`. Parsed as UTC field-by-field: `new Date(ymd)` is
 *  parsed as midnight UTC and then RENDERED in the local zone, which prints the
 *  previous day for anyone west of Greenwich. */
export function shortDay(ymd: string): string {
  const [year, month, day] = ymd.split('-').map(Number);
  if (!year || !month || !day) return ymd;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  });
}

// ── Accent tones ───────────────────────────────────────────────────────────
// A widget needs the SAME accent twice: as a CSS token for DOM chrome (the
// stat-card rail, a legend swatch) and as a literal hex for the canvas, which
// cannot resolve `var(...)` — a var() string handed to a canvas fillStyle
// paints black. `Tone` keeps the pair from drifting: the SCSS `.tone*` classes
// map to `var(--a-grad-*)` and TONE_HEX maps to the chartTheme mirror of the
// same value.

export type Tone = 'green' | 'blue' | 'gold' | 'purple' | 'slate';

export const TONE_HEX: Record<Tone, string> = {
  green: CHART_SERIES[0],
  blue: CHART_SERIES[1],
  // Brand/tier gold (public board ENIG) — mirrors --a-grad-gold, decoupled from
  // the darker CHART_SERIES slot-3 line colour so the Monthly Revenue tone
  // matches the public Gold board.
  gold: '#e8c252',
  purple: CHART_SERIES[3],
  slate: CHART_NEUTRAL,
};
