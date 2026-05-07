import { Archive, Eye, Inbox, Send } from 'lucide-react';
import type { ComponentType } from 'react';
import type { Message } from '@admin/types/messages';
import { fullStamp } from './messageHelpers';
import styles from './ActivityLog.module.scss';

// Compact event timeline for a single message — Arrived / Read / Replied /
// Archived. Each line shows a Lucide icon + JetBrains Mono timestamp.
interface Event {
  Icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  text: string;
}

export default function ActivityLog({ m }: { m: Message }) {
  const events: Event[] = [];
  events.push({ Icon: Inbox, text: `Arrived ${fullStamp(m.created_at)}` });
  if (m.read_at) {
    events.push({
      Icon: Eye,
      text: `Read by ${m.assigned_to ?? 'admin'} · ${fullStamp(m.read_at)}`,
    });
  }
  if (m.responded_at) {
    events.push({
      Icon: Send,
      text: `Replied by ${m.assigned_to ?? 'admin'} · ${fullStamp(m.responded_at)}`,
    });
  }
  if (m.status === 'archived') {
    events.push({ Icon: Archive, text: 'Archived' });
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>Activity</h3>
      </div>
      <div className={styles.activityLog}>
        {events.map((e, i) => (
          <div key={i} className={styles.alogRow}>
            <span className={styles.alogIcon}>
              <e.Icon size={11} strokeWidth={2.2} />
            </span>
            <span className={styles.alogText}>{e.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
