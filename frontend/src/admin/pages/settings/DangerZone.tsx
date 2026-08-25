import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { useAuth } from '@admin/contexts/AuthContext';
import { adminApi } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import styles from './SettingsPage.module.scss';

/**
 * The customer's Danger Zone: delete your own sign-in.
 *
 * Two locks, because the delete is irreversible and the console is shared:
 * the CURRENT PASSWORD (the server re-authenticates — a stolen session must
 * not be able to destroy an account) and the typed word DELETE (which arms the
 * button; a password field alone is one autofill away from a mis-click).
 *
 * What survives is stated in the copy rather than left to be discovered: the
 * server deliberately touches neither the linked Supplier, nor a Sponsor, nor
 * anything in Stripe. A live placement is paid inventory on a public board, so
 * closing a login must not cancel it — and somebody who expected it to would
 * otherwise find out from an invoice.
 */

/** The word that arms the button. Compared case-SENSITIVELY, on purpose. */
const CONFIRM_WORD = 'DELETE';

/** routes/account.py 403 — an unactivated customer is refused every /account route. */
const NOT_ACTIVATED_DETAIL = 'account_not_activated';

/**
 * Seconds off a `Retry-After`, or null when there isn't a usable one.
 *
 * The account-delete limiter is the login ladder in its own namespace (5
 * failures, 60s doubling to 15 minutes) and a LOCKED reply is byte-identical
 * to a wrong-password reply apart from this header. Without it the screen
 * would keep saying "that password is not right" to somebody typing the right
 * one.
 */
function retryAfterSeconds(headers: unknown): number | null {
  const raw = (headers as Record<string, unknown> | undefined)?.['retry-after'];
  const seconds = typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

/** Turn a failed delete into one sentence a person can act on. */
function describeFailure(err: unknown): string {
  if (axios.isAxiosError(err) && err.response) {
    const { status, headers, data } = err.response;
    if (status === 401) {
      const wait = retryAfterSeconds(headers);
      return wait
        ? `Too many attempts. Try again in ${wait} seconds.`
        : 'That password is not right.';
    }
    if (status === 403 && (data as { detail?: unknown } | undefined)?.detail === NOT_ACTIVATED_DETAIL) {
      return 'This account is still waiting to be approved. Contact us and we will close it for you.';
    }
  }
  return apiErrorDetail(err) ?? 'We could not delete the account just now. Please try again.';
}

export default function DangerZone() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmWord, setConfirmWord] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Self-gated as well as gated by the caller. Settings is ONE screen mounted
  // under both /admin and /account, and this panel is only ever the customer's
  // — a staff account deleting itself from here would be a different decision
  // with different consequences, so it is simply not offered.
  if (user?.role !== 'user') return null;

  const armed = password.length > 0 && confirmWord === CONFIRM_WORD && !busy;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.deleteMyAccount(password);
      // The account is gone, so the token in localStorage now authenticates
      // nothing. Clear the session BEFORE navigating: ProtectedRoute reads
      // AuthContext, not storage, and would otherwise keep rendering a console
      // for a user that no longer exists.
      logout();
      navigate('/admin/login', { replace: true });
    } catch (err) {
      setBusy(false);
      setPassword('');
      setError(describeFailure(err));
    }
  }

  return (
    <div className={`${styles.panel} ${styles.dangerPanel}`}>
      <div className={styles.panelHead}>
        <h3 className={`${styles.panelTitle} ${styles.dangerTitle}`}>
          <AlertTriangle size={16} strokeWidth={2} /> Delete your account
        </h3>
        <p className={styles.panelHint}>This cannot be undone.</p>
      </div>

      <form className={styles.panelBody} onSubmit={handleSubmit} noValidate>
        <p className={styles.dangerRowSub}>
          Deleting your account removes your sign-in and your messages.{' '}
          <strong>
            Your company's listings and any active sponsorship keep running and keep billing
          </strong>{' '}
          &mdash; contact us if you want those changed.
        </p>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="danger-password">
            Your password
          </label>
          <input
            id="danger-password"
            className={styles.textInput}
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className={styles.fieldHint}>
            We ask for it again so that a session left open on a shared machine can&rsquo;t close
            your account.
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="danger-confirm">
            Type {CONFIRM_WORD} to confirm
          </label>
          <input
            id="danger-confirm"
            className={`${styles.textInput} ${styles.textInputMono}`}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={confirmWord}
            disabled={busy}
            onChange={(e) => setConfirmWord(e.target.value)}
          />
        </div>

        {error && (
          <div className={styles.fieldError} role="alert">
            {error}
          </div>
        )}

        <div className={styles.actionsRow}>
          <button
            type="submit"
            className={`${styles.btn} ${styles.btnDanger}`}
            disabled={!armed}
          >
            <Trash2 size={15} strokeWidth={2} />
            {busy ? 'Deleting…' : 'Delete my account'}
          </button>
        </div>
      </form>
    </div>
  );
}
