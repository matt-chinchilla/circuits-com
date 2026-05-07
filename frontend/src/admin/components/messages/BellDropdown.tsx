import { CheckCircle2 } from 'lucide-react';
import type { Message } from '@admin/types/messages';
import { TypeIcon } from './MessageChips';
import { relTime, senderName, subjectFor } from './messageHelpers';
import styles from './BellDropdown.module.scss';

interface Props {
  messages: Message[];
  unreadCount: number;
  onClose: () => void;
  onOpenAll: () => void;
  onOpen: (id: string) => void;
}

const PREVIEW_LIMIT = 5;

// Topbar bell dropdown — last 5 unread messages with type icon, sender name,
// preview, and relative time. "View all" footer routes to /admin/messages.
// Empty state shows the standard "all caught up" check.
export default function BellDropdown({
  messages,
  unreadCount,
  onClose,
  onOpenAll,
  onOpen,
}: Props) {
  const unread = messages.filter((m) => m.status === 'new').slice(0, PREVIEW_LIMIT);

  return (
    <>
      <div className={styles.menuBackdrop} onClick={onClose} />
      <div className={styles.bellDrop} role="dialog" aria-label="Notifications">
        <div className={styles.bellHead}>
          <span className={styles.bellTitle}>Notifications</span>
          <span className={styles.bellCount}>{unreadCount} unread</span>
        </div>

        <div className={styles.bellBody}>
          {unread.length === 0 ? (
            <div className={styles.bellEmpty}>
              <CheckCircle2 size={28} strokeWidth={2} />
              <span>You&rsquo;re all caught up.</span>
            </div>
          ) : (
            unread.map((m) => (
              <button
                key={m.id}
                type="button"
                className={styles.bellRow}
                onClick={() => onOpen(m.id)}
              >
                <TypeIcon type={m.type} size={32} />
                <div className={styles.bellRowMid}>
                  <div className={styles.bellRowTop}>
                    <span className={styles.bellName}>{senderName(m)}</span>
                    <span className={styles.bellTime}>{relTime(m.created_at)}</span>
                  </div>
                  <div className={styles.bellPreview}>
                    {subjectFor(m).slice(0, 60)}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        <button type="button" className={styles.bellFoot} onClick={onOpenAll}>
          View all messages →
        </button>
      </div>
    </>
  );
}
