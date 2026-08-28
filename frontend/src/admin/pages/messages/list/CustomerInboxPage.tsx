import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useConsolePath } from '@admin/services/consolePath';
import { MessageTypeChip, StatusDot } from '@admin/components/messages/MessageChips';
import { dayBucket, relTime } from '@admin/components/messages/messageHelpers';
import { accountApi } from '@admin/services/accountApi';
import type { AccountMessage } from '@admin/types/account';
import { humanLabel, inboxSubject, isStyledType, unreadCount } from '../customerInbox';
import styles from './MessagesListPage.module.scss';

/**
 * The customer's own inbox — GET /api/account/messages, and nothing else.
 *
 * None of the staff mailbox is here, and that is the point rather than a
 * simplification: `messageStore` is an optimistic cache over the staff routes,
 * the MSG-#### designator is a GLOBAL counter the account API deliberately
 * withholds, and archive / assign / spam / bulk-delete are a triage workflow
 * that PATCH fields the account API refuses with a 422. A customer sees the
 * two facts that are theirs — what arrived, and whether they have read it.
 *
 * The row material IS the staff table's (dot, type chip, subject, time), so
 * the console reads as one product; only the columns that mean nothing to a
 * recipient are gone.
 */

type Grouped =
  | { kind: 'header'; label: string }
  | { kind: 'row'; m: AccountMessage };

export default function CustomerInboxPage() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<AccountMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // Bumped by "Try again" so the fetch effect re-runs.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    accountApi
      .getAccountMessages()
      .then((rows) => {
        if (cancelled) return;
        setMessages(rows);
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
  }, [attempt]);

  // Day-bucket cluster headers, exactly as the staff table groups. The server
  // already sorts newest first, so no re-sort here — a client-side one could
  // only disagree with the order the next page of the API would send.
  const grouped = useMemo<Grouped[]>(() => {
    const out: Grouped[] = [];
    let last: string | null = null;
    for (const m of messages) {
      const bucket = dayBucket(m.created_at);
      if (bucket !== last) {
        out.push({ kind: 'header', label: bucket });
        last = bucket;
      }
      out.push({ kind: 'row', m });
    }
    return out;
  }, [messages]);

  const unread = unreadCount(messages);
  const subtitle =
    unread > 0
      ? `Updates from the Circuit Center team \u00b7 ${unread} unread`
      : 'Updates from the Circuit Center team';

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >
      <div className={styles.pageHead}>
        <div className={styles.pageHeadMain}>
          <h1 className={styles.title}>Messages</h1>
          <p className={styles.subtitle}>{subtitle}</p>
        </div>
      </div>

      <div className={styles.panel}>
        {loading ? (
          <div className={styles.emptyState}>
            <span>Loading your messages&hellip;</span>
          </div>
        ) : failed ? (
          <div className={styles.emptyState}>
            <span>Your messages could not be loaded just now.</span>
            <button
              type="button"
              className={styles.clearBtn}
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </button>
          </div>
        ) : messages.length === 0 ? (
          <div className={styles.emptyState}>
            <span>No messages yet.</span>
            <span className={styles.emptyNote}>
              Account updates and billing confirmations from Circuit Center arrive here.
            </span>
          </div>
        ) : (
          <table className={`${styles.table} ${styles.inboxTable}`}>
            <colgroup>
              <col style={{ width: 26 }} />
              <col style={{ width: 96 }} />
              <col style={{ width: '100%' }} />
              <col style={{ width: 80 }} />
            </colgroup>
            <tbody>
              {grouped.map((g, i) =>
                g.kind === 'header' ? (
                  <tr key={`h-${i}`} className={styles.cluster}>
                    <td colSpan={4}>{g.label}</td>
                  </tr>
                ) : (
                  <tr
                    key={g.m.id}
                    className={`${styles.row} ${g.m.read ? '' : styles.isNew}`}
                    onClick={() => navigate(consolePath(`/admin/messages/${g.m.id}`))}
                  >
                    <td className={styles.cDot}>
                      {/* The staff dot, fed the only two states a recipient
                          has. `isFresh` is a triage pulse and stays off. */}
                      <StatusDot status={g.m.read ? 'read' : 'new'} />
                    </td>
                    <td>
                      {isStyledType(g.m.type) ? (
                        <MessageTypeChip type={g.m.type} />
                      ) : (
                        <span className={styles.typePlain}>{humanLabel(g.m.type)}</span>
                      )}
                    </td>
                    <td className={styles.cSubject}>
                      <div className={styles.subject}>{inboxSubject(g.m)}</div>
                    </td>
                    <td className={styles.cTime}>{relTime(g.m.created_at)}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </div>
    </motion.div>
  );
}
