// Demo-mode fixtures for the dashboard.
//
// `DemoContext.demoMode` is ON by default: the console is shown to prospects
// long before the live catalog carries a believable P&L, so every widget has a
// demo branch. The rule the widgets follow is that demo mode fakes the VALUES
// and never the SHAPE — the day axis, month keys and month lengths below are
// derived from the real ET calendar, so a demo chart lines up tick-for-tick
// with the same chart in live mode.
//
// Everything here is deterministic (a seeded LCG, not Math.random) so a
// re-render never reshuffles a curve, and two widgets asking for the same seed
// get the same numbers.

import type {
  ExpensesBreakdown,
  MonthlyCompareMonth,
  SalesRep,
  SponsorTier,
  TrendPoint,
} from '@admin/types/admin';
import { daysInMonth, estToday, monthLabel } from './format';

/** Numerical Recipes LCG — 4 lines, no dep, identical output every run. */
function lcg(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * A believable ramp from `from` to `to` across the supplied ET day axis, with
 * a small deterministic wobble so it reads as measured rather than drawn.
 */
export function demoTrend(
  days: readonly string[],
  from: number,
  to: number,
  seed: number,
  wobble = 0.05,
): TrendPoint[] {
  const rand = lcg(seed);
  const span = Math.max(days.length - 1, 1);
  return days.map((day, i) => {
    const base = from + (to - from) * (i / span);
    const jitter = 1 + (rand() - 0.5) * 2 * wobble;
    return { day, value: Math.max(0, base * jitter) };
  });
}

/**
 * `MonthlyCompare.months` in the wire shape the API uses — NEWEST FIRST, one
 * entry per day of that real month, 0 for days that have not happened yet.
 * `dailyBase` is the average day's take in the newest month; `decay` shrinks
 * each older month so the overlay shows growth.
 */
export function demoMonthlyCompare(
  months: number,
  dailyBase: number,
  seed: number,
  decay = 0.86,
): MonthlyCompareMonth[] {
  const today = estToday();
  const out: MonthlyCompareMonth[] = [];
  for (let back = 0; back < months; back += 1) {
    // Month arithmetic on a 1-based month, normalized by hand (Date rollover
    // would need a UTC round-trip for the same result).
    const monthIndex = today.month - 1 - back;
    const year = today.year + Math.floor(monthIndex / 12);
    const month = ((monthIndex % 12) + 12) % 12 + 1;
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const length = daysInMonth(year, month);
    const rand = lcg(seed + back * 977);
    const scale = dailyBase * Math.pow(decay, back);
    const daily = [];
    for (let day = 1; day <= length; day += 1) {
      // The current month stops at today — future days are absent server-side.
      const future = back === 0 && day > today.day;
      // Weekends run light; a mid-month invoice batch spikes.
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      const weekend = weekday === 0 || weekday === 6 ? 0.35 : 1;
      const spike = day === 15 ? 3.4 : 1;
      daily.push({
        day,
        value: future ? 0 : Math.round(scale * weekend * spike * (0.6 + rand() * 0.8) * 100) / 100,
      });
    }
    out.push({ key, label: monthLabel(key), daily });
  }
  return out;
}

/** Three reps with a believable book of business — the shape
 *  `/dashboard/sales-reps` returns once sponsorships carry `sold_by`. */
export const DEMO_SALES_REPS: SalesRep[] = [
  {
    name: 'Anthony',
    total: 11_400,
    customers: [
      { company: 'Digi-Key', tier: 'Platinum', amount: 4800 },
      { company: 'Murata', tier: 'Gold', amount: 2600 },
      { company: 'Bourns', tier: 'Gold', amount: 2200 },
      { company: 'Littelfuse', tier: 'Silver', amount: 1800 },
    ],
  },
  {
    name: 'Daniel',
    total: 8_650,
    customers: [
      { company: 'Mouser', tier: 'Platinum', amount: 4200 },
      { company: 'Vishay', tier: 'Gold', amount: 2450 },
      { company: 'TDK', tier: 'Silver', amount: 2000 },
    ],
  },
  {
    name: 'Ronald',
    total: 5_900,
    customers: [
      { company: 'Arrow', tier: 'Gold', amount: 2700 },
      { company: 'Nexperia', tier: 'Silver', amount: 1800 },
      { company: 'Diodes Inc.', tier: 'Silver', amount: 1400 },
    ],
  },
];

/** Active sponsorships by tier — the demo mix the ring used to show. */
export const DEMO_TIER_COUNTS: Record<SponsorTier, number> = {
  Platinum: 34,
  Gold: 58,
  Silver: 82,
};

/**
 * Current-month operating costs. Mirrors the real
 * `/dashboard/expenses/breakdown` payload, including the `infrastructure`
 * row being a list-price ESTIMATE rather than an invoiced actual.
 */
export function demoExpensesBreakdown(): ExpensesBreakdown {
  const today = estToday();
  const categories = [
    { category: 'infrastructure', label: 'Infrastructure', amount: 21.23, vendor: 'AWS' },
    { category: 'ai', label: 'AI / LLM', amount: 180.0, vendor: 'Anthropic' },
    { category: 'payment', label: 'Payment processing', amount: 46.8, vendor: 'Stripe' },
    { category: 'email', label: 'Email / SMTP', amount: 5.99, vendor: 'Hover' },
    { category: 'domain', label: 'Domain', amount: 2.42, vendor: 'Hover' },
  ];
  return {
    month: `${today.year}-${String(today.month).padStart(2, '0')}`,
    total: categories.reduce((sum, c) => sum + c.amount, 0),
    categories,
  };
}

/** Headline stat values for demo mode (live mode reads `/dashboard/stats`). */
export const DEMO_STATS = {
  parts: 2_487_302,
  suppliers: 186,
  sponsors: 174,
} as const;
