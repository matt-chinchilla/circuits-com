// EngagementPanel (customer) — the panel that is honest about being empty.
//
// A twin of the staff panel rather than a reuse, for one reason that matters:
// there is no per-company engagement data anywhere in this system, and the
// staff panel's copy invites the reader to connect accounts in Settings — a
// screen the customer console does not offer. Rendering it here would promise
// a setup flow that does not exist, and passing it the staff series would
// eventually show a customer the WHOLE PLATFORM's numbers as if they were
// their own. Neither the demo fixtures nor `/api/dashboard/*` is reachable
// from this file, by construction.
//
// The platform grid itself is the shared chrome, so when a per-company source
// does exist this panel changes copy, not layout.

import Icon from '@shared/components/Icon';
import { PLATFORM_META, SOCIAL_PLATFORMS } from '@admin/types/engagement';
import styles from '../../DashboardPage.module.scss';

export default function EngagementPanel() {
  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Social &amp; ad engagement</h3>
          <p className={styles.panelSub}>
            Impressions, reach, clicks and spend across your channels
          </p>
        </div>
        <span className={styles.panelBadge}>Nothing connected</span>
      </div>
      <div className={styles.panelBody}>
        <ul className={styles.platformGrid}>
          {SOCIAL_PLATFORMS.map((platform) => {
            const meta = PLATFORM_META[platform];
            return (
              <li key={platform} className={styles.platformTile}>
                <span className={styles.platformIcon} style={{ color: meta.color }}>
                  <Icon name={meta.icon} />
                </span>
                <span className={styles.platformName}>{meta.label}</span>
                <span className={styles.platformState}>Not linked</span>
              </li>
            );
          })}
        </ul>
        <div className={styles.connectCta}>
          <div>
            <strong className={styles.connectTitle}>No campaign data yet</strong>
            <p className={styles.connectBody}>
              Circuit Center does not collect ad or social metrics for your company, and
              nothing on this panel is estimated or borrowed from elsewhere. When account
              linking ships, your own numbers land here &mdash; until then it stays empty
              on purpose.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
