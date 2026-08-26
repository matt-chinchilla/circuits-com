// EngagementPanel — social / ad-platform reach. STUB, deliberately.
//
// `adminApi.getEngagement()` resolves `[]` today: there is no backend model or
// endpoint yet, only the wire contract in `@admin/types/engagement` (which also
// documents the OAuth upstream behind each of the seven platforms). The panel
// is built against the FINAL shape — a platform present in the response is
// connected, one missing from it renders a "Connect" slot — so the cutover is a
// one-line change inside adminApi and zero change here.
//
// PLATFORM_META is the single source of identity + iteration order: label,
// brand hex and Phosphor glyph. Its colours are compile-time constants, not DB
// values, so they do not need `safeHexColor`.

import { Link } from 'react-router-dom';
import { useConsolePath } from '@admin/services/consolePath';
import Icon from '@shared/components/Icon';
import { PLATFORM_META, SOCIAL_PLATFORMS } from '@admin/types/engagement';
import type { PlatformEngagementSeries } from '@admin/types/engagement';
import styles from '../DashboardPage.module.scss';

interface EngagementPanelProps {
  series: PlatformEngagementSeries[];
  loading: boolean;
}

export default function EngagementPanel({ series, loading }: EngagementPanelProps) {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const connected = new Set(series.map((s) => s.platform));

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Social &amp; ad engagement</h3>
          <p className={styles.panelSub}>
            Impressions, reach, clicks and spend across seven platforms
          </p>
        </div>
        <span className={styles.panelBadge}>Not connected</span>
      </div>
      <div className={styles.panelBody}>
        <ul className={styles.platformGrid}>
          {SOCIAL_PLATFORMS.map((platform) => {
            const meta = PLATFORM_META[platform];
            const isOn = connected.has(platform);
            return (
              <li
                key={platform}
                className={`${styles.platformTile} ${isOn ? styles.platformOn : ''}`}
              >
                <span className={styles.platformIcon} style={{ color: meta.color }}>
                  <Icon name={meta.icon} />
                </span>
                <span className={styles.platformName}>{meta.label}</span>
                <span className={styles.platformState}>{isOn ? 'Connected' : 'Not linked'}</span>
              </li>
            );
          })}
        </ul>
        <div className={styles.connectCta}>
          <div>
            <strong className={styles.connectTitle}>Connect your accounts</strong>
            <p className={styles.connectBody}>
              {loading
                ? 'Checking for linked accounts…'
                : 'Each platform authorizes once via OAuth, then daily metrics land here automatically. Nothing is pulled until an account is linked.'}
            </p>
          </div>
          <Link to={consolePath('/admin/settings')} className={`${styles.btn} ${styles.btnGhost}`}>
            Set up integrations
          </Link>
        </div>
      </div>
    </div>
  );
}
