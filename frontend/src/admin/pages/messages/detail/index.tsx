import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Archive, Eye } from 'lucide-react';
import {
  Designator,
  MessageStatusBadge,
  MessageTypeChip,
  SpamScoreWarning,
} from '@admin/components/messages/MessageChips';
import { relTime } from '@admin/components/messages/messageHelpers';
import DatasheetFrame from '@admin/components/messages/DatasheetFrame';
import {
  ContactBody,
  JoinBody,
  KeywordBody,
} from '@admin/components/messages/MessageDetailBodies';
import MessageReplyPanel from '@admin/components/messages/MessageReplyPanel';
import ActivityLog from '@admin/components/messages/ActivityLog';
import {
  archive as archiveMsg,
  findMessage,
  loadMessages,
  markRead,
  recordReply,
  refreshMessages,
  toggleRead,
} from '@admin/services/messageStore';
import type { Message } from '@admin/types/messages';
import styles from './MessageDetailPage.module.scss';

export default function MessageDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [tick, setTick] = useState(0); // forces re-read after store mutations
  const [traceFire, setTraceFire] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const m: Message | undefined = findMessage(id);

  // Pull fresh messages from the API on mount + after the id changes (deep
  // link case where the cache hasn't loaded yet). tick++ forces the
  // findMessage() above to re-read the cache after the API resolves.
  useEffect(() => {
    let cancelled = false;
    refreshMessages().then(() => {
      if (cancelled) return;
      setTick((t) => t + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Mark-on-open: 'new' messages flip to 'read' the moment the page mounts
  // (and any time the id changes). The list page picks this up via its own
  // refresh on mount.
  useEffect(() => {
    if (m?.status === 'new') {
      markRead(id);
      setTick((t) => t + 1);
    }
  }, [id, m?.status]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  // Re-read store on tick to surface action results.
  // (loadMessages is the source of truth — findMessage above re-runs on tick.)
  useEffect(() => {
    loadMessages();
  }, [tick]);

  if (!m) {
    return (
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.15, ease: 'easeInOut' as const }}
      >
        <div className={styles.notFoundPanel}>
          <h2>Message not found</h2>
          <p>That message ID couldn&rsquo;t be found.</p>
          <Link to="/admin/messages" className={styles.backLink}>
            <ArrowLeft size={14} strokeWidth={2} />
            Back to Messages
          </Link>
        </div>
      </motion.div>
    );
  }

  function onAction(kind: 'toggle_read' | 'archive') {
    if (kind === 'archive') {
      archiveMsg(m!.id);
      setToast('Archived');
    } else {
      toggleRead(m!.id);
      setToast(m!.status === 'new' ? 'Marked read' : 'Marked unread');
    }
    setTick((t) => t + 1);
  }

  function onSend(body: string) {
    recordReply(m!.id, body);
    setToast('Reply sent · status → Responded');
    setTick((t) => t + 1);
    // Reply-trace easter egg: pulses the panel border green for 800ms.
    setTraceFire(true);
    setTimeout(() => setTraceFire(false), 800);
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >
      <DatasheetFrame className={styles.detailHead}>
        <Link to="/admin/messages" className={styles.backLink}>
          <ArrowLeft size={14} strokeWidth={2} />
          Messages
        </Link>

        <div className={styles.metaRow}>
          <Designator seq={m.seq} />
          <MessageTypeChip type={m.type} />
          <SpamScoreWarning score={m.spam_score} />
          <span className={styles.arrived}>arrived {relTime(m.created_at)}</span>
        </div>

        <h1 className={styles.subject}>
          {m.type === 'contact' && m.payload.subject}
          {m.type === 'join' && `wants to list — ${m.payload.company_name}`}
          {m.type === 'keyword' && m.payload.keyword}
          {m.type === 'reply' && '(reply)'}
        </h1>

        <div className={styles.actions}>
          <MessageStatusBadge status={m.status} />
          <div className={styles.actionsSpacer} />
          <button
            type="button"
            className={styles.btnGhost}
            onClick={() => onAction('toggle_read')}
          >
            <Eye size={14} strokeWidth={2} />
            Mark {m.status === 'new' ? 'read' : 'unread'}
          </button>
          <button
            type="button"
            className={styles.btnGhost}
            onClick={() => onAction('archive')}
          >
            <Archive size={14} strokeWidth={2} />
            {m.status === 'archived' ? 'Archived' : 'Archive'}
          </button>
        </div>
      </DatasheetFrame>

      <div className={styles.detailGrid}>
        <div className={styles.detailMain}>
          <div className={styles.bodyPanel}>
            {m.type === 'contact' && <ContactBody m={m} />}
            {m.type === 'join' && <JoinBody m={m} />}
            {m.type === 'keyword' && <KeywordBody m={m} />}
          </div>
          <div className={traceFire ? styles.replyTraceFire : ''}>
            <MessageReplyPanel m={m} onSend={onSend} />
          </div>
        </div>

        <aside className={styles.detailSide}>
          <div className={styles.statusPanel}>
            <div className={styles.statusPanelHead}>
              <h3 className={styles.statusPanelTitle}>Status</h3>
            </div>
            <div className={styles.statusPanelBody}>
              <KvMini label="Designator">
                <Designator seq={m.seq} />
              </KvMini>
              <KvMini label="Type">
                <MessageTypeChip type={m.type} />
              </KvMini>
              <KvMini label="Status">
                <MessageStatusBadge status={m.status} />
              </KvMini>
              <KvMini label="Assigned">
                <span className={styles.kvMono}>
                  {m.assigned_to === 'john'
                    ? 'John (U1)'
                    : m.assigned_to === 'mike'
                      ? 'Mike (U2)'
                      : '—'}
                </span>
              </KvMini>
              {m.spam_score != null && (
                <KvMini label="Spam score">
                  <span
                    className={styles.kvMono}
                    style={{ color: m.spam_score > 0.6 ? '#c0392b' : undefined }}
                  >
                    {m.spam_score.toFixed(2)}
                  </span>
                </KvMini>
              )}
            </div>
          </div>

          <ActivityLog m={m} />
        </aside>
      </div>

      {toast && <div className={styles.toast}>{toast}</div>}
    </motion.div>
  );
}

function KvMini({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.kvMini}>
      <span className={styles.kvLabel}>{label}</span>
      {children}
    </div>
  );
}
