// ImportQueuePanel (customer) — the state of their distributor feed, READ ONLY.
//
// The auto-import switch is a real control on the staff supplier page, and it
// spends a rate-limited daily call budget shared across the whole platform. So
// this panel renders its STATE and offers nothing to click: a customer-visible
// toggle would be a second, unpoliced door onto that budget. The payload backs
// that up — `/api/account/import-queue` carries the flag and the timestamp and
// never the provider, the credential or the cursor.
//
// `feed: null` is the ordinary case, not a failure: most accounts have no feed
// at all, and every manufacturer-linked one does by definition.

import type { AccountFeedState } from '@admin/types/account';
import { relativeTime } from '@admin/pages/leads/time';
import styles from '../../DashboardPage.module.scss';
import own from './CustomerPanels.module.scss';

interface ImportQueuePanelProps {
  feed: AccountFeedState | null;
  loading: boolean;
}

export default function ImportQueuePanel({ feed, loading }: ImportQueuePanelProps) {
  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Import queue</h3>
          <p className={styles.panelSub}>Your distributor feed</p>
        </div>
      </div>
      {feed === null ? (
        <div className={styles.empty}>
          {loading
            ? 'Checking your feed…'
            : 'No feed connected — your catalog is maintained by hand.'}
        </div>
      ) : (
        <div className={styles.queue}>
          <div className={own.factRow}>
            <span className={own.factLabel}>Automatic import</span>
            <span
              className={`${own.statePill} ${
                feed.auto_import_enabled ? own.statePillOn : own.statePillOff
              }`}
            >
              {feed.auto_import_enabled ? 'On' : 'Off'}
            </span>
          </div>
          <div className={own.factRow}>
            <span className={own.factLabel}>Last sync</span>
            {/* `relativeTime` answers null for a null or unparseable stamp,
                which is the same sentence to a reader: it has not run. */}
            <span className={own.factValue}>
              {relativeTime(feed.last_synced_at) ?? 'Never run'}
            </span>
          </div>
        </div>
      )}
      <p className={styles.panelNote}>
        Feed settings are managed by Circuit Center &mdash; contact your account manager to
        change them.
      </p>
    </div>
  );
}
