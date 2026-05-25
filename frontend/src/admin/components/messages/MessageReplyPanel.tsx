import { useState } from 'react';
import { Reply, Send, X } from 'lucide-react';
import type { Message } from '@admin/types/messages';
import { senderEmail, senderName } from './messageHelpers';
import styles from './MessageReplyPanel.module.scss';

const TEMPLATES: ReadonlyArray<string> = [
  'Acknowledged — will follow up',
  "Thanks — let's set up a call",
  'Not currently a fit',
];

interface Props {
  m: Message;
  onSend: (body: string) => void;
}

// Inline reply panel — collapses to a thin bar by default, expands on click.
// Sends from no-reply@circuits.com (the SMTP path Phase 2 will wire). On
// send: simulated 400ms delay → onSend callback fires (caller updates store
// + triggers reply-trace animation in the parent).
export default function MessageReplyPanel({ m, onSend }: Props) {
  const [open, setOpen] = useState(m.status === 'new');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  function send() {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSending(true);
    setTimeout(() => {
      onSend(trimmed);
      setBody('');
      setSending(false);
    }, 400);
  }

  if (!open) {
    return (
      <button
        type="button"
        className={styles.replyBar}
        onClick={() => setOpen(true)}
      >
        <Reply size={16} strokeWidth={2} />
        <span>Reply to {senderName(m)}</span>
        <span className={styles.replyBarHint}>{senderEmail(m)}</span>
      </button>
    );
  }

  return (
    <div className={styles.replyPanel}>
      <div className={styles.replyHead}>
        <span className={styles.replyTo}>
          Reply to <b>{senderName(m)}</b>{' '}
          <span className={styles.mono}>&lt;{senderEmail(m)}&gt;</span>
        </span>
        <button
          type="button"
          className={styles.collapseBtn}
          onClick={() => setOpen(false)}
          aria-label="Collapse reply panel"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      <div className={styles.replyTemplates}>
        {TEMPLATES.map((t) => (
          <button
            key={t}
            type="button"
            className={styles.tmplChip}
            onClick={() => setBody((b) => b || `${t}.\n\n— Circuits.com`)}
          >
            <Reply size={11} strokeWidth={2} />
            {t}
          </button>
        ))}
      </div>

      <div data-field="reply_text">
        <textarea
          className={styles.replyText}
          data-tour="reply-text"
          rows={6}
          placeholder={`Write a reply to ${senderName(m)}…`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>

      <div className={styles.replyFoot}>
        <span className={styles.replyFrom}>From: no-reply@circuits.com</span>
        <button
          type="button"
          data-tour="reply-send"
          className={styles.sendBtn}
          onClick={send}
          disabled={sending || !body.trim()}
        >
          <Send size={14} strokeWidth={2} />
          {sending ? 'Sending…' : 'Send reply'}
        </button>
      </div>
    </div>
  );
}
