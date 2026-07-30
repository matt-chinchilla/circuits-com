// RevenuePanel — month-over-month cumulative revenue, overlaid on a shared
// day-of-month axis.
//
// Reads `/dashboard/revenue-compare?months=N` (newest month first) and plots
// the running total, so at any point on the x-axis the three lines answer "how
// much had we booked by this day of the month?". Current month solid electric
// blue with the area wash, prior dashed, the one before dash-dot — see
// ./monthlySeries for the colour/style assignment and the month-to-date
// truncation.

import { useMemo } from 'react';
import EChart from '@admin/components/charts/EChart';
import { comparatorOption } from '@admin/components/charts/options';
import type { MonthlyCompareMonth } from '@admin/types/admin';
import { usd, usdCompact } from './format';
import { isMonthlyEmpty, monthsToCumulativeSeries, monthTotal } from './monthlySeries';
import styles from '../DashboardPage.module.scss';

/** Months of history the comparator overlays. */
export type CompareRange = 3 | 6 | 12;

export const COMPARE_RANGES: CompareRange[] = [3, 6, 12];

const DAY_TOOLTIP = (axisLabel: string) => `Day ${axisLabel}`;

interface RevenuePanelProps {
  months: MonthlyCompareMonth[];
  range: CompareRange;
  onRangeChange: (range: CompareRange) => void;
  /** Today's day-of-month (ET) — truncates the in-progress month. */
  todayDayOfMonth: number;
  loading: boolean;
}

export default function RevenuePanel({
  months,
  range,
  onRangeChange,
  todayDayOfMonth,
  loading,
}: RevenuePanelProps) {
  const series = useMemo(
    () => monthsToCumulativeSeries(months, todayDayOfMonth),
    [months, todayDayOfMonth],
  );

  const option = useMemo(
    () =>
      comparatorOption({
        series,
        yFormat: usdCompact,
        tooltipTitle: DAY_TOOLTIP,
      }),
    [series],
  );

  const empty = months.length === 0 || isMonthlyEmpty(months);
  const currentTotal = months.length > 0 ? monthTotal(months[0]) : 0;

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Revenue</h3>
          <p className={styles.panelSub}>
            Cumulative month-to-date &middot; last {range} months
          </p>
        </div>
        {/* TODO: move to Settings — the compare window is a per-admin
            preference, not page state. Local for now so it ships without a
            settings migration. */}
        <div className={styles.segControl} role="radiogroup" aria-label="Comparison window">
          {COMPARE_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={range === r}
              className={`${styles.segBtn} ${range === r ? styles.segBtnOn : ''}`}
              onClick={() => onRangeChange(r)}
            >
              {r}M
            </button>
          ))}
        </div>
      </div>
      <div className={styles.panelBody}>
        {empty ? (
          <div className={styles.emptyChart}>
            {loading ? (
              'Loading revenue…'
            ) : (
              <>
                <strong>No revenue booked yet.</strong>
                <span>
                  Sponsorships start reporting here the month their first
                  invoice lands.
                </span>
              </>
            )}
          </div>
        ) : (
          <>
            <div className={styles.chartFigure}>
              <EChart option={option} style={{ height: 250 }} />
            </div>
            <div className={styles.chartFoot}>
              <span className={styles.chartFootLabel}>
                {months[0]?.label ?? 'This month'} to date
              </span>
              <span className={styles.chartFootValue}>{usd(currentTotal)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
