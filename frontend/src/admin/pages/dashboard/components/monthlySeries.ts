// `MonthlyCompare.months` -> comparator series, CUMULATIVE month-to-date.
//
// Shared by the Revenue and the Expenses comparators — the two endpoints have
// an identical wire shape, so they get one adapter and always read the same
// way. (`monthsToComparatorSeries` in the chart kit is the RAW per-day variant;
// the dashboard wants the running total, which is what "how are we tracking
// against last month" actually means.)
//
// Two decisions worth keeping:
//
//  1. The CURRENT month stops at TODAY. The API zero-fills the rest of the
//     month, and a cumulative line over zeros runs dead flat to day 31 — which
//     reads as "revenue stopped", not "the month isn't over".
//  2. x is the DAY-OF-MONTH on a numeric axis, never a category index.
//     February and July do not share a length; pinning them to the same
//     category index would slide the 29th onward by a day or three.

import type {
  ComparatorLineStyle,
  ComparatorSeries,
} from '@admin/components/charts/options';
import { CHART_NEUTRAL, CHART_SERIES } from '@admin/components/charts/chartTheme';
import { mixHex } from '@shared/utils/color';
import type { MonthlyCompareMonth } from '@admin/types/admin';

// Newest month first (the API's order), so slot 0 is the month in progress:
// electric blue and solid, with the area wash comparatorOption puts on
// series[0]. Prior month dashed, the one before dash-dot.
const COMPARE_COLORS = [CHART_SERIES[1], CHART_SERIES[0], CHART_SERIES[2]] as const;
const COMPARE_STYLES: ComparatorLineStyle[] = ['solid', 'dashed', 'dashDot'];

/** Months 4+ (only reachable from the 6/12-month control) fade toward the card
 *  so the three named months stay legible. Identity is still recoverable from
 *  the legend, and the fade is monotone — older is lighter. */
function trailingColor(index: number): string {
  const steps = Math.min(index - COMPARE_COLORS.length, 5);
  return mixHex(CHART_NEUTRAL, '#ffffff', 0.9 - steps * 0.12);
}

export function monthsToCumulativeSeries(
  months: readonly MonthlyCompareMonth[],
  /** Today's day-of-month in ET. Truncates the CURRENT month only. */
  todayDayOfMonth: number,
): ComparatorSeries[] {
  return months.map((month, i) => {
    const limit = i === 0 && todayDayOfMonth > 0 ? todayDayOfMonth : Number.POSITIVE_INFINITY;
    let running = 0;
    const points: { x: number; y: number }[] = [];
    for (const point of month.daily) {
      if (point.day > limit) break;
      running += Number(point.value) || 0;
      points.push({ x: point.day, y: running });
    }
    return {
      label: month.label,
      color: COMPARE_COLORS[i] ?? trailingColor(i),
      lineStyle: COMPARE_STYLES[i % COMPARE_STYLES.length],
      points,
    };
  });
}

/** Total for a month — the legend/readout figure beside each comparator line. */
export function monthTotal(month: MonthlyCompareMonth): number {
  return month.daily.reduce((sum, d) => sum + (Number(d.value) || 0), 0);
}

/** True when every month in the payload is empty — the cue for a real-mode
 *  empty state rather than a chart of flat zeros. */
export function isMonthlyEmpty(months: readonly MonthlyCompareMonth[]): boolean {
  return months.every((m) => monthTotal(m) === 0);
}
