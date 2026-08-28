import { useEffect, useState } from 'react';
import { useAuth } from '@admin/contexts/AuthContext';
import { accountApi } from '@admin/services/accountApi';
import { normalizeSponsorTier } from '@admin/services/sponsorTier';
import type { AccountSponsorship } from '@admin/types/account';
import {
  formatDate,
  formatMonthly,
  placementLabel,
  statusTone,
  type StatusTone,
} from '../customerSponsorship';
import styles from './SponsorsPage.module.scss';

/**
 * The customer's own placements — GET /api/account/sponsors, read-only.
 *
 * Read-only is the product, not a shortcut: Platinum and Gold are single-slot
 * tiers with partial unique indexes behind them, so a self-service edit would
 * either race another buyer or fail at the constraint. Placements are sold and
 * changed by the desk, and this page is the customer's copy of the record.
 *
 * Live AND lapsed, because the expired one is usually why they opened it.
 */

// Legacy rows store a lowercase tier and the account route normalizes it that
// way; the badge wants TitleCase. One normalizer, the same one every other
// read site uses.
function tierClass(tier: string): string {
  switch (normalizeSponsorTier(tier)) {
    case 'Platinum':
      return styles.tierPlatinum;
    case 'Gold':
      return styles.tierGold;
    case 'Silver':
      return styles.tierSilver;
    default:
      return '';
  }
}

function statusClass(tone: StatusTone): string {
  switch (tone) {
    case 'active':
      return styles.statusActive;
    case 'paused':
      return styles.statusPaused;
    case 'expired':
      return styles.statusExpired;
    default:
      return '';
  }
}

export default function CustomerSponsorsPage() {
  const { account } = useAuth();
  const [sponsorships, setSponsorships] = useState<AccountSponsorship[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    accountApi
      .getAccountSponsors()
      .then((rows) => {
        if (cancelled) return;
        setSponsorships(rows);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeCount = sponsorships.filter((s) => s.is_active).length;
  const subtitle =
    sponsorships.length > 0
      ? `Your paid placements on Circuit Center \u00b7 ${activeCount} active`
      : 'Your paid placements on Circuit Center.';

  // `sponsors.supplier_id` is NOT NULL, so only a supplier-linked account can
  // hold a placement — an empty list means two different things and the copy
  // has to say which one it is.
  const emptyCopy =
    account?.is_supplier === true
      ? 'No sponsorships yet. Talk to the Circuit Center team about a category banner or a keyword placement.'
      : 'No sponsorships yet. Placements are held by a distributor account, and yours is not linked to one.';

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1 className={styles.title}>Sponsorships</h1>
          <p className={styles.subtitle}>{subtitle}</p>
        </div>
      </header>

      <div className={styles.panel}>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Placement</th>
                <th>Tier</th>
                <th>Status</th>
                <th>Window</th>
                <th>Monthly</th>
              </tr>
            </thead>
            <tbody>
              {sponsorships.map((s) => {
                const tone = statusTone(s);
                return (
                  <tr key={s.id}>
                    <td>
                      {s.placement_type === 'keyword' ? (
                        <span className={styles.placementKeyword}>
                          <span className={styles.placementLabel}>keyword:</span>
                          <span className={styles.mono}>{s.placement}</span>
                        </span>
                      ) : (
                        <span className={styles.placementCategory}>
                          <strong>{placementLabel(s)}</strong>
                        </span>
                      )}
                      {s.description && (
                        <div className={styles.rowNote}>{s.description}</div>
                      )}
                    </td>
                    <td>
                      <span className={`${styles.tierBadge} ${tierClass(s.tier)}`}>
                        {normalizeSponsorTier(s.tier) ?? s.tier}
                      </span>
                    </td>
                    <td>
                      <span className={`${styles.statusBadge} ${statusClass(tone)}`}>
                        {s.status}
                      </span>
                    </td>
                    <td>
                      <span className={styles.windowText}>
                        {formatDate(s.start_date)}{' '}
                        <span className={styles.windowArrow}>&rarr;</span>{' '}
                        {formatDate(s.end_date)}
                      </span>
                    </td>
                    <td>
                      <span className={styles.amountText}>{formatMonthly(s.amount)}</span>
                    </td>
                  </tr>
                );
              })}
              {sponsorships.length === 0 && (
                <tr>
                  <td colSpan={5} className={styles.emptyRow}>
                    {loading
                      ? 'Loading your sponsorships\u2026'
                      : failed
                        ? 'Your sponsorships could not be loaded just now.'
                        : emptyCopy}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
