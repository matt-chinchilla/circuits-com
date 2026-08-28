// ReferralClicksPanel — buyers who left a Circuit Center part page for this
// company's own site.
//
// This panel occupies the slot the design inherited from the staff board's
// Monthly Revenue card, and it is NOT that. What is counted is an outbound
// click on the distributor link of a part page; nobody knows whether it became
// an order, or for how much. So the word Revenue appears nowhere on this
// surface — not in the title, not in the caption, not in the tooltip — and the
// number is formatted as a count (spec 2026-08-25 §3). A click count captioned
// as money is a claim we cannot stand behind.

import { useMemo } from 'react';
import EChart from '@admin/components/charts/EChart';
import { CHART_SERIES } from '@admin/components/charts/chartTheme';
import type { AccountReferralClicks } from '@admin/types/account';
import { count } from '../format';
import { monthlyBarOption } from './chartOptions';
import { isFlat, referralPoints } from './series';
import styles from '../../DashboardPage.module.scss';
import './echartsCustomer';

interface ReferralClicksPanelProps {
  data: AccountReferralClicks | null;
  loading: boolean;
}

export default function ReferralClicksPanel({ data, loading }: ReferralClicksPanelProps) {
  const points = useMemo(() => referralPoints(data?.monthly ?? []), [data]);
  const option = useMemo(
    () =>
      monthlyBarOption({
        points,
        color: CHART_SERIES[2],
        valueFormat: count,
        axisFormat: count,
      }),
    [points],
  );

  const empty = points.length === 0 || isFlat(points);

  return (
    <div className={`${styles.panel} ${styles.panelFill}`}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Referral clicks</h3>
          <p className={styles.panelSub}>
            Buyers we sent to your own site &middot; last 12 months
          </p>
        </div>
      </div>
      <div className={`${styles.panelBody} ${styles.panelBodyFill}`}>
        {empty ? (
          <div className={styles.emptyChart}>
            {loading ? (
              'Loading referrals…'
            ) : (
              <>
                <strong>No referrals yet.</strong>
                <span>
                  Every time a buyer opens one of your parts and clicks through to your
                  site, it is counted here.
                </span>
              </>
            )}
          </div>
        ) : (
          <>
            <div className={styles.trafficHead}>
              <span className={styles.trafficValue}>{count(data?.total_30d ?? 0)}</span>
              <span className={styles.trafficHint}>clicks in the last 30 days</span>
            </div>
            <EChart
              option={option}
              style={{ flex: '1 1 auto', minHeight: 190, height: 'auto' }}
            />
          </>
        )}
      </div>
    </div>
  );
}
