// SponsorMixPanel — active sponsorships by tier.
//
// Replaces the hand-rolled stroke-dasharray ring with `pieOption`: a native
// `animationType: 'expansion'` sweep from 12 o'clock (slices appear IN ORDER
// rather than each popping independently) and per-slice vertical gradients
// whose DARK stop is the validated hex, so slice contrast never drops below the
// measured value.
//
// Slice colours are the sponsor-tier BRAND materials (`tierFill`/`tierColor`),
// matched to the public sponsor boards — lavender-platinum, ENIG-gold,
// steel-silver — so the mix reads as three distinct tiers, not a bronze ramp.
//
// The pie's own legend is off: the tier numbers live in the HTML list to the
// right, where they can be tabular-aligned and carry a share percentage.

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useConsolePath } from '@admin/services/consolePath';
import EChart from '@admin/components/charts/EChart';
import { pieOption } from '@admin/components/charts/options';
import { tierColor, tierFill, tierCssGradient } from '@admin/components/charts/chartTheme';
import type { SponsorTier } from '@admin/types/admin';
import { count } from './format';
import styles from '../DashboardPage.module.scss';

// Highest tier first — the ramp is ordinal, so the sweep should descend it.
const TIERS: SponsorTier[] = ['Platinum', 'Gold', 'Silver'];

interface SponsorMixPanelProps {
  counts: Record<SponsorTier, number>;
  loading: boolean;
}

export default function SponsorMixPanel({ counts, loading }: SponsorMixPanelProps) {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const total = TIERS.reduce((sum, t) => sum + (counts[t] || 0), 0);

  const option = useMemo(
    () =>
      pieOption({
        slices: TIERS.map((tier) => ({
          label: tier,
          value: counts[tier] || 0,
          color: tierColor(tier),
          fill: tierFill(tier),
        })),
        donutThickness: 22,
        centerValue: count(total),
        centerLabel: 'active',
        showLegend: false,
        valueFormat: count,
      }),
    [counts, total],
  );

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Active Sponsors</h3>
          <p className={styles.panelSub}>By tier &middot; monetization mix</p>
        </div>
        <Link to={consolePath('/admin/sponsors')} className={styles.panelLink}>
          Manage &rarr;
        </Link>
      </div>
      <div className={styles.panelBody}>
        {total === 0 ? (
          <div className={styles.emptyChart}>
            {loading ? (
              'Loading sponsors…'
            ) : (
              <>
                <strong>No active sponsorships.</strong>
                <span>Sell a placement and the tier mix appears here.</span>
              </>
            )}
          </div>
        ) : (
          <div className={styles.mixWrap}>
            <EChart option={option} className={styles.mixChart} style={{ height: 210 }} />
            <ul className={styles.mixLegend}>
              {TIERS.map((tier) => {
                const value = counts[tier] || 0;
                const share = total > 0 ? Math.round((value / total) * 100) : 0;
                return (
                  <li key={tier} className={styles.mixRow}>
                    <span
                      className={styles.mixSwatch}
                      style={{ background: tierCssGradient(tier) }}
                    />
                    <span className={styles.mixName}>{tier}</span>
                    <span className={styles.mixShare}>{share}%</span>
                    <span className={styles.mixValue}>{count(value)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
