// Reports, as a CUSTOMER sees them.
//
// The staff Reports page is built on `/api/dashboard/*` and `/api/analytics/*`
// — every one of them `require_staff`, and every one of them about the WHOLE
// platform. A customer mounting it would get a screen of 403s wearing our
// numbers' labels, which is worse than a blank page: it would look like their
// data failed to load rather than like data that was never theirs.
//
// So this is a different page over the SAME panels. Every chart below is the
// customer dashboard's own component, imported rather than re-drawn, reading
// the same four `/api/account` endpoints, scoped server-side. What Reports
// adds is not new data — it is ROOM: the dashboard shows these panels two to a
// row between eight others, and here each one gets the width to actually be
// read.
//
// Nothing on this page invents a number. The one thing a customer will look
// for and not find — how their own public company page performs — is stated in
// its own panel rather than left as a gap, because a missing panel reads as a
// broken one.

import { useEffect, useState } from 'react';
import type {
  AccountOperatingCosts,
  AccountReferralClicks,
  AccountRevenue,
} from '@admin/types/account';
import { accountApi } from '@admin/services/accountApi';
import KpiPanel from '../dashboard/components/customer/KpiPanel';
import OperatingCostsPanel from '../dashboard/components/customer/OperatingCostsPanel';
import ReferralClicksPanel from '../dashboard/components/customer/ReferralClicksPanel';
import RevenuePanel from '../dashboard/components/customer/RevenuePanel';
import TrafficPanel from '../dashboard/components/customer/TrafficPanel';
import styles from '../dashboard/DashboardPage.module.scss';

export default function CustomerReportsPage() {
  const [referrals, setReferrals] = useState<AccountReferralClicks | null>(null);
  const [revenue, setRevenue] = useState<AccountRevenue | null>(null);
  const [costs, setCosts] = useState<AccountOperatingCosts | null>(null);
  const [loading, setLoading] = useState(true);

  // One effect for the page, the customer dashboard's shape: each request is
  // individually caught to a neutral null so one failing endpoint degrades a
  // single panel instead of blanking the page, and the cancel flag stops a
  // late resolve from setting state on an unmounted page.
  //
  // The KPI panel is absent from this list on purpose — it owns a WRITE whose
  // reply is the recomputed panel, so its read and its write are one piece of
  // state that belongs inside it. The costs panel takes its first month from
  // here and fetches any other month itself.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      accountApi.getAccountReferralClicks().catch(() => null),
      accountApi.getAccountRevenue().catch(() => null),
      accountApi.getAccountOperatingCosts().catch(() => null),
    ])
      .then(([clicks, rev, spend]) => {
        if (cancelled) return;
        setReferrals(clicks);
        setRevenue(rev);
        setCosts(spend);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1>Reports</h1>
          <p>Your referrals &middot; revenue &middot; costs</p>
        </div>
      </div>

      {/* Referrals at full width and at both resolutions — the twelve-month
          shape and the thirty-day one answer different questions, and on the
          dashboard they sit in different rows. */}
      <div className={styles.aOne}>
        <ReferralClicksPanel data={referrals} loading={loading} />
      </div>

      <div className={styles.aEven}>
        <TrafficPanel data={referrals} loading={loading} />
        <RevenuePanel data={revenue} loading={loading} />
      </div>

      <div className={styles.aOne}>
        <KpiPanel />
      </div>

      <div className={styles.aOne}>
        <OperatingCostsPanel costs={costs} loading={loading} />
      </div>

      <div className={styles.aOne}>
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <div className={styles.panelHeadMain}>
              <h3 className={styles.panelTitle}>Site analytics</h3>
              <p className={styles.panelSub}>Views and search terms on your own pages</p>
            </div>
            <span className={styles.panelBadge}>Not yet</span>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.emptyChart}>
              <strong>Per-company site analytics arrive with your public page.</strong>
              <span>
                Circuit Center measures traffic per URL, and your company does not
                have one of its own yet. Until it does, referral clicks above are the
                honest measure of what we send you.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
