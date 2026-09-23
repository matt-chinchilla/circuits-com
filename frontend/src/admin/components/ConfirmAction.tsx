import { useEffect, useRef, useState, type ReactNode } from 'react';
import { newIdempotencyKey } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import styles from './ConfirmAction.module.scss';

// The confirm step in front of every money action in the console (billing
// panel, Needs attention). Two rules from spec §9 live here so no caller can
// forget them:
//
//  1. The dialog STATES THE CONSEQUENCE in its title ("Refund $2,100.00 to
//     Acme?") — the caller writes that sentence; this only frames it.
//  2. It mints the Idempotency-Key when it OPENS and reuses it for every
//     retry, so a double click or a retry after a timeout reaches Stripe as
//     the same request. `keyScope` is the request's parameters: Stripe
//     refuses one key with two different bodies, so a rep who edits the
//     refund amount after a failure gets a fresh key for the new request —
//     and the OLD amount keeps its old key if they switch back.
//
// Mounted only while open (the caller renders it conditionally) and rendered
// IN PLACE, never portaled: the --a-* tokens live on AdminLayout's .admin
// root, and a node portaled to <body> would lose every one of them (the
// sponsor form's own modals are inline for the same reason).

interface Props {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  tone?: 'primary' | 'danger';
  /** False disables the confirm button (an input is incomplete). */
  canConfirm?: boolean;
  /** The way out. Never "Cancel" by default: beside "Cancel at period end" it reads as the action. */
  dismissLabel?: string;
  /** The request's parameters; a new scope gets a new key. */
  keyScope?: string;
  children?: ReactNode;
  onConfirm: (idempotencyKey: string) => Promise<void>;
  onClose: () => void;
}

export default function ConfirmAction({
  title,
  body,
  confirmLabel,
  busyLabel = 'Working…',
  tone = 'primary',
  canConfirm = true,
  dismissLabel = 'Go back',
  keyScope = '',
  children,
  onConfirm,
  onClose,
}: Props) {
  const keys = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pressedOnScrim = useRef(false);

  const keyFor = (scope: string): string => {
    let key = keys.current.get(scope);
    if (!key) {
      key = newIdempotencyKey();
      keys.current.set(scope, key);
    }
    return key;
  };
  // Mint the opening request's key now, not at the first click.
  if (keys.current.size === 0) keyFor(keyScope);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(keyFor(keyScope));
    } catch (err) {
      setError(
        apiErrorDetail(err) ??
          'That did not go through. Trying again is safe — it cannot act twice.',
      );
      setBusy(false);
    }
  };

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(e) => {
        pressedOnScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedOnScrim.current && e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="confirm-action-title">
        <h3 id="confirm-action-title" className={styles.title}>
          {title}
        </h3>
        {body && <div className={styles.body}>{body}</div>}
        {children && <div className={styles.fields}>{children}</div>}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            disabled={busy}
            onClick={onClose}
            autoFocus={tone === 'danger'}
          >
            {dismissLabel}
          </button>
          <button
            type="button"
            className={`${styles.btn} ${tone === 'danger' ? styles.btnDanger : styles.btnPrimary}`}
            disabled={busy || !canConfirm}
            onClick={confirm}
            autoFocus={tone !== 'danger'}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
