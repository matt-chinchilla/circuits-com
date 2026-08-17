// ActivityPanel — recent catalog events.
//
// Demo mode ships a hand-written strip that reads like a busy distributor
// console; live mode renders `/dashboard/activity` rows verbatim.

import type { ReactNode } from 'react';
import PartThumb from '@admin/components/PartThumb';
import type { ActivityItem } from '@admin/types/admin';
import styles from '../DashboardPage.module.scss';

type ActivityKind = 'ok' | 'info' | 'warn';

export interface ActivityRow {
  kind: ActivityKind;
  glyph: string;
  text: ReactNode;
  when: string;
  // Sync rows only: a distributor-CDN part-photo URL (`image_url` off the
  // sync feed), passed RAW — PartThumb owns the safeImageUrl guard and the
  // broken-image fallback, same as the sync console's rows.
  thumb?: string | null;
}

const DEMO_ACTIVITY: ActivityRow[] = [
  {
    kind: 'ok',
    glyph: '✓',
    text: (
      <>
        Approved <b>Digi-Key</b> price update for{' '}
        <span className="mono">STM32F407VGT6</span>
      </>
    ),
    when: '4m ago',
  },
  {
    kind: 'info',
    glyph: '↻',
    text: (
      <>
        Mouser imported <b>3,421</b> new parts in category <b>Analog ICs</b>
      </>
    ),
    when: '22m ago',
  },
  {
    kind: 'warn',
    glyph: '!',
    text: <>MX25L12833FM2I-10G flagged <b>Obsolete</b> by Macronix</>,
    when: '1h ago',
  },
  {
    kind: 'ok',
    glyph: '+',
    text: <>New supplier onboarded: <b>Future Electronics</b></>,
    when: '3h ago',
  },
  {
    kind: 'info',
    glyph: '◷',
    text: <>Weekly stock sync completed &middot; <b>186</b> distributors</>,
    when: '6h ago',
  },
];

const KIND_CLASS: Record<ActivityKind, string> = {
  ok: styles.ok,
  info: styles.info,
  warn: styles.warn,
};

interface ActivityPanelProps {
  activity: ActivityItem[];
  demoMode: boolean;
}

export default function ActivityPanel({ activity, demoMode }: ActivityPanelProps) {
  const rows: ActivityRow[] = demoMode
    ? DEMO_ACTIVITY
    : activity.map((a) => ({
        kind: 'info' as const,
        glyph: '·',
        text: a.description,
        when: a.created_at ? new Date(a.created_at).toLocaleDateString() : '',
        thumb: a.image_url,
      }));

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>Recent Activity</h3>
      </div>
      <div className={styles.activity}>
        {rows.length === 0 ? (
          <div className={styles.empty}>No recent activity.</div>
        ) : (
          rows.map((row, idx) => (
            <div key={idx} className={styles.activityRow}>
              <div className={`${styles.activityIcon} ${KIND_CLASS[row.kind]}`}>{row.glyph}</div>
              <div className={styles.activityBody}>
                {row.thumb && <PartThumb src={row.thumb} className={styles.activityThumb} />}
                <div className={styles.activityText}>{row.text}</div>
              </div>
              <div className={styles.activityTime}>{row.when}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
