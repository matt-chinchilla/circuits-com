// ExpensesPanel — the cost side of the P&L, mirroring RevenuePanel exactly.
//
// `/dashboard/expenses` returns the SAME wire shape as
// `/dashboard/revenue-compare`, so it is the same chart (`expensesOption` is a
// named alias of `comparatorOption`) fed through the same cumulative adapter.
// Reading them side by side only works because the two axes, the two dash
// vocabularies and the two month-to-date truncations are identical.

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useConsolePath } from '@admin/services/consolePath';
import EChart from '@admin/components/charts/EChart';
import { expensesOption } from '@admin/components/charts/options';
import type { MonthlyCompareMonth } from '@admin/types/admin';
import { usd, usdCompact } from './format';
import { isMonthlyEmpty, monthsToCumulativeSeries, monthTotal } from './monthlySeries';
import { COMPARE_RANGES, type CompareRange } from './RevenuePanel';
import styles from '../DashboardPage.module.scss';

const DAY_TOOLTIP = (axisLabel: string) => `Day ${axisLabel}`;

interface ExpensesPanelProps {
  months: MonthlyCompareMonth[];
  range: CompareRange;
  onRangeChange: (range: CompareRange) => void;
  todayDayOfMonth: number;
  loading: boolean;
}

export default function ExpensesPanel({
  months,
  range,
  onRangeChange,
  todayDayOfMonth,
  loading,
}: ExpensesPanelProps) {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const series = useMemo(
    () => monthsToCumulativeSeries(months, todayDayOfMonth),
    [months, todayDayOfMonth],
  );

  const option = useMemo(
    () => expensesOption({ series, yFormat: usdCompact, tooltipTitle: DAY_TOOLTIP }),
    [series],
  );

  const empty = months.length === 0 || isMonthlyEmpty(months);
  const currentTotal = months.length > 0 ? monthTotal(months[0]) : 0;

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Operating costs</h3>
          <p className={styles.panelSub}>
            Cumulative month-to-date &middot; last {range} months
          </p>
        </div>
        <div className={styles.panelHeadActions}>
          {/* TODO: move to Settings alongside the revenue window. */}
          <div className={styles.segControl} role="radiogroup" aria-label="Cost comparison window">
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
          <Link to={consolePath('/admin/expenses')} className={styles.panelLink}>
            Manage &rarr;
          </Link>
        </div>
      </div>
      <div className={styles.panelBody}>
        {empty ? (
          <div className={styles.emptyChart}>
            {loading ? (
              'Loading costs…'
            ) : (
              <>
                <strong>No costs logged yet.</strong>
                <span>
                  Add the monthly AWS, domain, SMTP, payment and LLM lines on the
                  Expenses page.
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
