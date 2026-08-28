// Wire rows -> chart points.
//
// Three payloads on this board carry a `YYYY-MM` key and a number, and one
// carries a `YYYY-MM-DD`. Turning them into axis points is the kind of code
// that goes wrong in a way nobody sees for months, so it lives here with a
// test rather than inline in three panels.
//
// Month keys are parsed FIELD BY FIELD in UTC, never `new Date('2026-08')`:
// that string is parsed as midnight UTC and then RENDERED in the local zone,
// which prints July for everyone west of Greenwich (the same trap
// `format.monthLabel` and `monthPager.pagerMonthLabel` document).

import type { AccountReferralMonth, AccountRevenueMonth } from '@admin/types/account';
import type { SparklinePoint } from '@admin/components/charts/options';
import type { AccountReferralDay } from '@admin/types/account';
import type { CategoricalPoint } from './chartOptions';

/**
 * `2026-08` -> `Aug`, and `2026-01` -> `Jan '26`.
 *
 * Twelve months on one axis crosses at most one year boundary, and January is
 * where it happens — carrying the year on that tick alone marks the boundary
 * without repeating `'26` twelve times. Anything unparseable falls back to the
 * raw key, which is wrong but readable, rather than to an empty label.
 */
export function shortMonthLabel(key: string): string {
  const [year, month] = key.split('-').map(Number);
  if (!year || !month || month < 1 || month > 12) return key;
  const name = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'short',
  });
  return month === 1 ? `${name} '${String(year).slice(-2)}` : name;
}

/** Referral-click months -> axis points, order preserved (oldest first). */
export function referralPoints(
  months: readonly AccountReferralMonth[],
): CategoricalPoint[] {
  return months.map((m) => ({
    label: shortMonthLabel(m.month),
    value: Number(m.clicks) || 0,
  }));
}

/** Revenue months -> axis points, order preserved (oldest first). */
export function revenuePoints(months: readonly AccountRevenueMonth[]): CategoricalPoint[] {
  return months.map((m) => ({
    label: shortMonthLabel(m.month),
    value: Number(m.amount) || 0,
  }));
}

/** Referral-click days -> the shared sparkline's point shape, so the customer
 *  traffic line is drawn by the SAME builder as the staff one. */
export function dailyPoints(days: readonly AccountReferralDay[]): SparklinePoint[] {
  return days.map((d) => ({ day: d.date, value: Number(d.clicks) || 0 }));
}

/** True when a series carries no magnitude at all — the cue for an empty state
 *  rather than a chart of flat zeros, which reads as "we measured nothing"
 *  instead of "nothing happened". */
export function isFlat(points: readonly CategoricalPoint[]): boolean {
  return points.every((p) => p.value === 0);
}
