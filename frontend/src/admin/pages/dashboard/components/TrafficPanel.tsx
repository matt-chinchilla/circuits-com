// TrafficPanel — first-party site traffic, the one engagement number that is
// real today.
//
// Fed by `/dashboard/trends` → `series.traffic` (daily PageView counts, ET,
// zero-filled), which is the same day axis the stat-card sparklines use, so the
// two can be read against each other without a date join.

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import EChart from '@admin/components/charts/EChart';
import { sparklineOption } from '@admin/components/charts/options';
import type { TrendPoint } from '@admin/types/admin';
import { count, shortDay, TONE_HEX } from './format';
import styles from '../DashboardPage.module.scss';

interface TrafficPanelProps {
  series: readonly TrendPoint[];
  loading: boolean;
}

export default function TrafficPanel({ series, loading }: TrafficPanelProps) {
  const option = useMemo(
    () =>
      sparklineOption({
        data: series.map((p) => ({ day: shortDay(p.day), value: Number(p.value) || 0 })),
        color: TONE_HEX.purple,
        valueFormat: count,
      }),
    [series],
  );

  const total = series.reduce((sum, p) => sum + (Number(p.value) || 0), 0);
  const busiest = series.reduce<TrendPoint | null>(
    (best, p) => (best == null || Number(p.value) > Number(best.value) ? p : best),
    null,
  );

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Site traffic</h3>
          <p className={styles.panelSub}>Page views &middot; last {series.length || 30} days</p>
        </div>
        <Link to="/admin/reports" className={styles.panelLink}>
          Reports &rarr;
        </Link>
      </div>
      <div className={styles.panelBody}>
        {series.length < 2 ? (
          <div className={styles.emptyChart}>
            {loading ? 'Loading traffic…' : 'No page views recorded yet.'}
          </div>
        ) : (
          <>
            <div className={styles.trafficHead}>
              <span className={styles.trafficValue}>{count(total)}</span>
              <span className={styles.trafficHint}>
                {busiest
                  ? `Busiest day ${shortDay(busiest.day)} · ${count(Number(busiest.value))}`
                  : ''}
              </span>
            </div>
            <EChart option={option} style={{ height: 120 }} />
          </>
        )}
      </div>
    </div>
  );
}
