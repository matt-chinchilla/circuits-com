// SponsorMixPanel (customer) — their placements as a flow.
//
// The staff board answers "how is the monetization mix split across tiers?"
// with a donut over three counts. One company's own placements are not a mix
// of anything — they are a small set of specific things they bought — so this
// is a Sankey: company -> tier -> the category or keyword the placement sits
// on. That is the shape the endpoint sends (name-keyed nodes and links), and
// it is rendered without regrouping.
//
// Two different empty states, and the difference matters. A distributor with
// no placements has bought nothing yet, which is an invitation. A
// MANUFACTURER-linked account cannot hold one at all — `sponsors.supplier_id`
// is NOT NULL — so telling them "no sponsorships yet" would imply a purchase
// they are able to make and a screen that is somehow failing them.

import { useMemo } from 'react';
import EChart from '@admin/components/charts/EChart';
import type { AccountSponsorMix } from '@admin/types/account';
import { count } from '../format';
import { sponsorSankeyOption } from './chartOptions';
import styles from '../../DashboardPage.module.scss';
import './echartsCustomer';

interface SponsorMixPanelProps {
  mix: AccountSponsorMix | null;
  loading: boolean;
  /** Whether this account holds a DISTRIBUTOR link — the only kind of account
   *  a sponsorship can belong to. Read from the two capability links
   *  independently; never inferred from the absence of the other one. */
  canSponsor: boolean;
}

/** The contract pins `value` as a number and names no unit, so it is printed
 *  as a plain magnitude. Formatting it as currency on the guess that it is a
 *  monthly price would print `$1` over a placement COUNT; the Operating Costs
 *  panel is where this company's money is stated, from a payload that says so.
 *
 *  Module-level, not an arrow in the render: the builder takes it as input, so
 *  a fresh identity would rebuild the option and redraw the chart every time. */
const FLOW_FORMAT = count;

export default function SponsorMixPanel({ mix, loading, canSponsor }: SponsorMixPanelProps) {
  const nodes = useMemo(() => mix?.nodes ?? [], [mix]);
  const links = useMemo(() => mix?.links ?? [], [mix]);
  const option = useMemo(
    () => sponsorSankeyOption({ nodes, links, valueFormat: FLOW_FORMAT }),
    [nodes, links],
  );

  // A Sankey needs an edge to draw: nodes alone render an empty canvas.
  const empty = links.length === 0;

  return (
    <div className={`${styles.panel} ${styles.panelFill}`}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Your sponsorships</h3>
          <p className={styles.panelSub}>Tier &middot; where each placement runs</p>
        </div>
      </div>
      <div className={`${styles.panelBody} ${styles.panelBodyFill}`}>
        {empty ? (
          <div className={styles.emptyChart}>
            {loading ? (
              'Loading placements…'
            ) : !canSponsor ? (
              <>
                <strong>Sponsorships belong to distributor accounts.</strong>
                <span>
                  Your account is linked to a manufacturer, so there is no placement to
                  show here.
                </span>
              </>
            ) : (
              <>
                <strong>No placements yet.</strong>
                <span>
                  A sponsorship you buy appears here as a flow &mdash; your company, its
                  tier, and the category or keyword it runs on.
                </span>
              </>
            )}
          </div>
        ) : (
          <EChart
            option={option}
            style={{ flex: '1 1 auto', minHeight: 210, height: 'auto' }}
          />
        )}
      </div>
    </div>
  );
}
