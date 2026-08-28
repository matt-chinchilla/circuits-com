// RevenuePanel (customer) — their own revenue rows, twelve months of them.
//
// The staff Revenue panel overlays cumulative month-to-date curves because it
// is comparing months against each other across the whole business. One
// company's own history is a TREND, so it runs along the year instead — same
// materials (solid electric line, the area wash, the total in the footer),
// different question.
//
// A twin rather than a reuse: the staff panel is bound to
// `MonthlyCompareMonth[]` (per-day arrays) and owns the 3/6/12 comparison
// window, and `/api/account/revenue` sends neither.

import { useMemo } from 'react';
import EChart from '@admin/components/charts/EChart';
import { CHART_SERIES } from '@admin/components/charts/chartTheme';
import type { AccountRevenue } from '@admin/types/account';
import { usd, usdCompact } from '../format';
import { monthlyLineOption } from './chartOptions';
import { isFlat, revenuePoints } from './series';
import styles from '../../DashboardPage.module.scss';

interface RevenuePanelProps {
  data: AccountRevenue | null;
  loading: boolean;
}

export default function RevenuePanel({ data, loading }: RevenuePanelProps) {
  const points = useMemo(() => revenuePoints(data?.months ?? []), [data]);
  const option = useMemo(
    () =>
      monthlyLineOption({
        points,
        color: CHART_SERIES[1],
        valueFormat: usd,
        axisFormat: usdCompact,
      }),
    [points],
  );

  const empty = points.length === 0 || isFlat(points);

  return (
    <div className={`${styles.panel} ${styles.panelFill}`}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Revenue</h3>
          <p className={styles.panelSub}>Booked to your company &middot; last 12 months</p>
        </div>
      </div>
      <div className={`${styles.panelBody} ${styles.panelBodyFill}`}>
        {empty ? (
          <div className={styles.emptyChart}>
            {loading ? (
              'Loading revenue…'
            ) : (
              <>
                <strong>No revenue booked yet.</strong>
                <span>
                  Orders attributed to your company report here the month they settle.
                </span>
              </>
            )}
          </div>
        ) : (
          <>
            <EChart
              option={option}
              style={{ flex: '1 1 auto', minHeight: 190, height: 'auto' }}
            />
            <div className={styles.chartFoot}>
              <span className={styles.chartFootLabel}>Last 12 months</span>
              <span className={styles.chartFootValue}>{usd(Number(data?.total) || 0)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
