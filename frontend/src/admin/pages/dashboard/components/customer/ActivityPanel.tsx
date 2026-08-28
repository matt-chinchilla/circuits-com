// ActivityPanel (customer) — the things they are adding.
//
// `activity_events` is already per-supplier, so this is the staff panel's list
// scoped by the server. It is a twin rather than a reuse because the staff
// component carries a hand-written demo strip behind a `demoMode` prop, and
// this board must be unable to render invented rows at all — not "renders them
// only when a flag is false".
//
// The server sends `label` already composed, so the row prints it. Deriving a
// sentence here from `kind` would be a second, drifting copy of wording the
// backend already owns.

import type { AccountActivityEvent } from '@admin/types/account';
import { relativeTime } from '@admin/pages/leads/time';
import styles from '../../DashboardPage.module.scss';

interface ActivityPanelProps {
  events: AccountActivityEvent[];
  loading: boolean;
}

/** Glyphs, not colour, carry the kind — the three activity tones are decorative
 *  and the same for every row here, so the mark is the only signal and it is
 *  text. Anything unrecognized gets the neutral dot rather than no mark. */
const KIND_GLYPH: Record<string, string> = {
  part_imported: '+',
  part_synced: '↻',
  listing_added: '+',
  import_started: '◷',
  import_finished: '✓',
};

export default function ActivityPanel({ events, loading }: ActivityPanelProps) {
  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Recent activity</h3>
          <p className={styles.panelSub}>Changes to your catalog</p>
        </div>
      </div>
      <div className={styles.activity}>
        {events.length === 0 ? (
          <div className={styles.empty}>
            {loading ? 'Loading activity…' : 'Nothing has changed in your catalog yet.'}
          </div>
        ) : (
          events.map((event) => (
            <div key={event.id} className={styles.activityRow}>
              <div className={`${styles.activityIcon} ${styles.info}`}>
                {KIND_GLYPH[event.kind] ?? '·'}
              </div>
              <div className={styles.activityBody}>
                <div className={styles.activityText}>{event.label}</div>
              </div>
              <div className={styles.activityTime}>{relativeTime(event.created_at) ?? ''}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
