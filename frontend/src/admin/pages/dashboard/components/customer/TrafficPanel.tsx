// TrafficPanel (customer) — the daily shape of the same referrals the monthly
// panel totals.
//
// v1 is deliberately ONE honest thing: the clicks we route to their own site.
// The staff panel of this name shows first-party page views, and a customer's
// equivalent — their own Circuit Center company page — does not exist yet, so
// the footer says that rather than the panel implying a number is missing.
//
// The line itself is the SHARED `sparklineOption`, the same builder behind the
// staff traffic panel and every stat-card spark, so the two boards' small
// multiples are drawn by one piece of code.

import { useMemo } from 'react';
import EChart from '@admin/components/charts/EChart';
import { sparklineOption } from '@admin/components/charts/options';
import type { AccountReferralClicks } from '@admin/types/account';
import { count, shortDay, TONE_HEX } from '../format';
import { dailyPoints } from './series';
import styles from '../../DashboardPage.module.scss';

interface TrafficPanelProps {
  data: AccountReferralClicks | null;
  loading: boolean;
}

export default function TrafficPanel({ data, loading }: TrafficPanelProps) {
  const points = useMemo(() => dailyPoints(data?.daily ?? []), [data]);
  const option = useMemo(
    () =>
      sparklineOption({
        data: points.map((p) => ({ day: shortDay(p.day), value: p.value })),
        color: TONE_HEX.purple,
        valueFormat: count,
      }),
    [points],
  );

  const total = points.reduce((sum, p) => sum + p.value, 0);
  const busiest = points.reduce<{ day: string; value: number } | null>(
    (best, p) => (best == null || p.value > best.value ? p : best),
    null,
  );

  return (
    <div className={`${styles.panel} ${styles.panelFill}`}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Site traffic</h3>
          <p className={styles.panelSub}>
            Referrals to your site &middot; last {points.length || 30} days
          </p>
        </div>
      </div>
      <div className={`${styles.panelBody} ${styles.panelBodyFill}`}>
        {points.length < 2 ? (
          <div className={styles.emptyChart}>
            {loading ? 'Loading traffic…' : 'No referral traffic recorded yet.'}
          </div>
        ) : (
          <>
            <div className={styles.trafficHead}>
              <span className={styles.trafficValue}>{count(total)}</span>
              <span className={styles.trafficHint}>
                {busiest && busiest.value > 0
                  ? `Busiest day ${shortDay(busiest.day)} · ${count(busiest.value)}`
                  : ''}
              </span>
            </div>
            <EChart
              option={option}
              style={{ flex: '1 1 auto', minHeight: 120, height: 'auto' }}
            />
          </>
        )}
      </div>
      <p className={styles.panelNote}>
        These are visits we send to your own website. Your company page on Circuit Center
        is not built yet &mdash; when it is, its page views appear here too.
      </p>
    </div>
  );
}
