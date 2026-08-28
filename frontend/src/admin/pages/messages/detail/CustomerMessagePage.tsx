import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Eye } from 'lucide-react';
import { useConsolePath } from '@admin/services/consolePath';
import {
  MessageStatusBadge,
  MessageTypeChip,
} from '@admin/components/messages/MessageChips';
import { fullStamp, relTime } from '@admin/components/messages/messageHelpers';
import DatasheetFrame from '@admin/components/messages/DatasheetFrame';
import { accountApi } from '@admin/services/accountApi';
import type { AccountMessage } from '@admin/types/account';
import {
  httpStatusOf,
  humanLabel,
  inboxSubject,
  isStyledType,
} from '../customerInbox';
import CustomerWelcomeBody from './CustomerWelcomeBody';
import styles from './MessageDetailPage.module.scss';

/**
 * One of the customer's own messages — GET /api/account/messages/{id}.
 *
 * Nothing on this page is the staff workflow: no archive, no assign, no spam
 * score, no reply panel (a welcome row was written TO them and has no sender
 * to answer), and no activity log. The recipient's whole verb is read/unread,
 * which is exactly what the endpoint accepts — its body is `{read}` alone and
 * naming a staff field is a 422, not a silently dropped key.
 *
 * A message that is not theirs and a message that never existed both answer
 * 404, byte for byte, so the missing state below says the one thing that is
 * true of both without turning the page into an existence oracle.
 */

// Payload keys whose value is prose rather than a field, rendered as
// paragraphs instead of a key/value row.
const PROSE_KEYS = ['message', 'body', 'note'];

type Scalar = string | number | boolean;

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Any message that is not the welcome row.
 *
 * The inbox is specified to carry receipts and payment confirmations that do
 * not exist yet, so this renders what actually arrived rather than a shape it
 * assumes: every scalar field, labelled by its own key. Nested objects are
 * skipped — a stringified one is noise, not information.
 */
function GenericBody({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload).filter(([, value]) => isScalar(value));
  const prose = entries.filter(([key]) => PROSE_KEYS.includes(key));
  const fields = entries.filter(([key]) => !PROSE_KEYS.includes(key));

  if (entries.length === 0) {
    return (
      <div className={styles.genericBody}>
        <p className={styles.genericEmpty}>This message carries no further detail.</p>
      </div>
    );
  }

  return (
    <div className={styles.genericBody}>
      {fields.length > 0 && (
        <dl className={styles.genericList}>
          {fields.map(([key, value]) => (
            <div key={key}>
              <dt className={styles.genericTerm}>{humanLabel(key)}</dt>
              <dd className={styles.genericValue}>{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {prose.map(([key, value]) => (
        <p key={key} className={styles.genericText}>
          {String(value)}
        </p>
      ))}
    </div>
  );
}

export default function CustomerMessagePage() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const { id = '' } = useParams<{ id: string }>();
  const [message, setMessage] = useState<AccountMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Fetch, then mark read. Opening IS the read, so the PATCH follows the row
  // rather than racing it — and it carries its own catch, because a message
  // that is on screen must stay on screen when only the flag failed.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMissing(false);
    accountApi
      .getAccountMessage(id)
      .then((row) => {
        if (cancelled) return;
        setMessage(row);
        if (row.read) return;
        accountApi
          .setAccountMessageRead(row.id, true)
          .then((updated) => {
            if (!cancelled) setMessage(updated);
          })
          .catch(() => {
            if (!cancelled) setToast('Could not mark it read');
          });
      })
      .catch((err) => {
        if (cancelled) return;
        // 404 is "not yours" and "no such row" alike — the same state, and the
        // only one this page can report about an id it cannot resolve.
        setMissing(httpStatusOf(err) === 404);
        setMessage(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  function onToggleRead() {
    if (!message || busy) return;
    const next = !message.read;
    setBusy(true);
    accountApi
      .setAccountMessageRead(message.id, next)
      .then((updated) => {
        setMessage(updated);
        setToast(next ? 'Marked read' : 'Marked unread');
      })
      .catch(() => setToast('That did not save. Try again.'))
      .finally(() => setBusy(false));
  }

  if (loading || !message) {
    return (
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.15, ease: 'easeInOut' as const }}
      >
        {/* The same centred card serves all three: still loading, not found,
            and could-not-load. Only the sentence differs. */}
        <div className={styles.notFoundPanel}>
          <h2>
            {loading ? 'Opening\u2026' : missing ? 'Message not found' : 'Message unavailable'}
          </h2>
          {!loading && (
            <p>
              {missing
                ? 'That message is not in your inbox.'
                : 'It could not be loaded just now.'}
            </p>
          )}
          <Link to={consolePath('/admin/messages')} className={styles.backLink}>
            <ArrowLeft size={14} strokeWidth={2} />
            Back to Messages
          </Link>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >
      <DatasheetFrame className={styles.detailHead}>
        <Link to={consolePath('/admin/messages')} className={styles.backLink}>
          <ArrowLeft size={14} strokeWidth={2} />
          Messages
        </Link>

        <div className={styles.metaRow}>
          {isStyledType(message.type) && <MessageTypeChip type={message.type} />}
          <span className={styles.arrived}>arrived {relTime(message.created_at)}</span>
        </div>

        <h1 className={styles.subject}>{inboxSubject(message)}</h1>

        <div className={styles.actions}>
          <MessageStatusBadge status={message.read ? 'read' : 'new'} />
          <div className={styles.actionsSpacer} />
          <button
            type="button"
            className={styles.btnGhost}
            onClick={onToggleRead}
            disabled={busy}
          >
            <Eye size={14} strokeWidth={2} />
            Mark {message.read ? 'unread' : 'read'}
          </button>
        </div>
      </DatasheetFrame>

      <div className={styles.detailGrid}>
        <div className={styles.detailMain}>
          <div className={styles.bodyPanel}>
            {message.type === 'welcome' ? (
              <CustomerWelcomeBody payload={message.payload} />
            ) : (
              <GenericBody payload={message.payload} />
            )}
          </div>
        </div>

        <aside className={styles.detailSide}>
          <div className={styles.statusPanel}>
            <div className={styles.statusPanelHead}>
              <h3 className={styles.statusPanelTitle}>Details</h3>
            </div>
            <div className={styles.statusPanelBody}>
              <div className={styles.kvMini}>
                <span className={styles.kvLabel}>Type</span>
                <span className={styles.kvMono}>{humanLabel(message.type)}</span>
              </div>
              <div className={styles.kvMini}>
                <span className={styles.kvLabel}>Received</span>
                <span className={styles.kvMono}>{fullStamp(message.created_at)}</span>
              </div>
              <div className={styles.kvMini}>
                <span className={styles.kvLabel}>Status</span>
                <MessageStatusBadge status={message.read ? 'read' : 'new'} />
              </div>
            </div>
          </div>
        </aside>
      </div>

      {toast && <div className={styles.toast}>{toast}</div>}
    </motion.div>
  );
}
