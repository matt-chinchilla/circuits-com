import { describe, expect, it } from 'vitest';
import type { MonthlyCompareMonth } from '@admin/types/admin';
import { isMonthlyEmpty, monthsToCumulativeSeries, monthTotal } from './monthlySeries';

function month(key: string, label: string, values: number[]): MonthlyCompareMonth {
  return { key, label, daily: values.map((value, i) => ({ day: i + 1, value })) };
}

describe('monthsToCumulativeSeries', () => {
  it('accumulates each month independently', () => {
    const series = monthsToCumulativeSeries([month('2026-07', 'July', [10, 5, 2])], 31);
    expect(series[0].points).toEqual([
      { x: 1, y: 10 },
      { x: 2, y: 15 },
      { x: 3, y: 17 },
    ]);
  });

  it('truncates the CURRENT month at today, so the line does not flatline to day 31', () => {
    // The API zero-fills future days; a cumulative line over those zeros reads
    // as "revenue stopped", not "the month is not over".
    const series = monthsToCumulativeSeries([month('2026-07', 'July', [10, 5, 0, 0, 0])], 2);
    expect(series[0].points).toEqual([
      { x: 1, y: 10 },
      { x: 2, y: 15 },
    ]);
  });

  it('leaves PRIOR months whole — only slot 0 is in progress', () => {
    const series = monthsToCumulativeSeries(
      [month('2026-07', 'July', [1, 1]), month('2026-06', 'June', [1, 1, 1, 1])],
      1,
    );
    expect(series[0].points).toHaveLength(1);
    expect(series[1].points).toHaveLength(4);
  });

  it('assigns solid/dashed/dashDot to the three named months', () => {
    const series = monthsToCumulativeSeries(
      [month('2026-07', 'July', [1]), month('2026-06', 'June', [1]), month('2026-05', 'May', [1])],
      31,
    );
    expect(series.map((s) => s.lineStyle)).toEqual(['solid', 'dashed', 'dashDot']);
    // Slot 0 is the electric blue the brief pins the current month to.
    expect(series[0].color).toBe('#2563eb');
    // Distinct hues, so the overlay never renders two identical lines.
    expect(new Set(series.map((s) => s.color)).size).toBe(3);
  });

  it('fades months past the third instead of wrapping the palette', () => {
    const months = Array.from({ length: 6 }, (_, i) => month(`2026-0${i + 1}`, `M${i}`, [1]));
    const series = monthsToCumulativeSeries(months, 31);
    const colors = series.map((s) => s.color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('coerces a NUMERIC string value rather than string-concatenating it', () => {
    const raw: MonthlyCompareMonth = {
      key: '2026-07',
      label: 'July',
      // Typed `number`, but a Postgres NUMERIC arrives as a JSON string.
      daily: [{ day: 1, value: '10.50' as unknown as number }, { day: 2, value: 4 }],
    };
    expect(monthsToCumulativeSeries([raw], 31)[0].points).toEqual([
      { x: 1, y: 10.5 },
      { x: 2, y: 14.5 },
    ]);
  });
});

describe('monthTotal / isMonthlyEmpty', () => {
  it('sums a month', () => {
    expect(monthTotal(month('2026-07', 'July', [1, 2, 3]))).toBe(6);
  });

  it('reports empty only when every month is zero', () => {
    expect(isMonthlyEmpty([month('2026-07', 'July', [0, 0])])).toBe(true);
    expect(isMonthlyEmpty([month('2026-07', 'July', [0]), month('2026-06', 'June', [1])])).toBe(
      false,
    );
    // A payload with no months at all is vacuously empty — the panels also
    // check `months.length === 0`, so both paths land on the empty state.
    expect(isMonthlyEmpty([])).toBe(true);
  });
});
