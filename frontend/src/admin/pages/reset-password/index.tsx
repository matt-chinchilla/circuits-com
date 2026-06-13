// Reset-password landing page — the destination of the emailed reset link
// (/admin/reset-password?token=…). Not part of the v13 prototype (whose link
// went nowhere), so it's designed within the same auth system: it reuses the
// login AuthShell + Field so it's visually identical to the recovery screens.
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { adminApi } from '@admin/services/adminApi';
import AuthShell from '@admin/pages/login/components/AuthShell';
import Field from '@admin/pages/login/components/Field';
import SubmitButton from '@admin/pages/login/components/SubmitButton';
import { I, Svg } from '@admin/pages/login/components/icons';
import { PWD_DOTS } from '@admin/pages/login/lib/recovery';

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [errs, setErrs] = useState<{ pw?: string; confirm?: string }>({});
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // No token → the link is missing/malformed; send the user back to request one.
  if (!token) {
    return (
      <AuthShell>
        <div className="screen">
          <p className="eyebrow">
            <span className="dot" />
            Account Recovery
          </p>
          <h2>Invalid reset link</h2>
          <p className="lede">
            This password-reset link is missing or malformed. Request a fresh one from the
            sign-in screen.
          </p>
          <div className="success-actions">
            <Link className="btn" to="/admin/login">
              <Svg d={I.back} w={15} />
              Back to sign in
            </Link>
          </div>
        </div>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell>
        <div className="success">
          <div className="success-mark">
            <Svg d={I.check} w={28} />
          </div>
          <h2>Password updated</h2>
          <p className="lede">
            Your password has been changed. You can now sign in with your new password.
          </p>
          <div className="success-actions">
            <Link className="btn" to="/admin/login">
              Continue to sign in
              <Svg d={I.arrow} w={16} className="arrow" />
            </Link>
          </div>
        </div>
      </AuthShell>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: { pw?: string; confirm?: string } = {};
    if (pw.length < 8) next.pw = 'Use at least 8 characters.';
    if (confirm !== pw) next.confirm = 'Passwords don’t match.';
    setErrs(next);
    setBanner('');
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      await adminApi.resetPassword(token, pw);
      setDone(true);
    } catch (err) {
      setBusy(false);
      if (axios.isAxiosError(err) && !err.response) {
        // No response → server unreachable, NOT a dead link. The token is still
        // valid; tell the user to retry rather than discard it.
        setBanner('Couldn’t reach the server. Check your connection and try again.');
        return;
      }
      // Only a string detail (the 400 messages) is safe to render; a 422 detail
      // is an array of error objects and would crash as a React child.
      const raw = axios.isAxiosError(err)
        ? (err.response?.data as { detail?: unknown } | undefined)?.detail
        : undefined;
      const detail = typeof raw === 'string' ? raw : undefined;
      setBanner(detail || 'This reset link is no longer valid. Please request a new one.');
    }
  };

  return (
    <AuthShell>
      <div className="screen">
        <Link className="back-link" to="/admin/login">
          <Svg d={I.back} w={15} />
          Back to sign in
        </Link>
        <p className="eyebrow">
          <span className="dot" />
          Account Recovery
        </p>
        <h2>Set a new password</h2>
        <p className="lede">
          Choose a new password for your Circuits.com account. Use at least 8 characters.
        </p>
        <form onSubmit={submit} noValidate>
          {banner && (
            <div className="banner">
              <Svg d={I.alert} w={16} />
              <span>{banner}</span>
            </div>
          )}
          <Field
            id="new-password"
            label="New password"
            icon={I.lock}
            value={pw}
            onChange={setPw}
            placeholder={PWD_DOTS}
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            reveal
            revealed={show}
            onReveal={() => setShow((s) => !s)}
            autoFocus
            error={errs.pw}
          />
          <Field
            id="confirm-password"
            label="Confirm password"
            icon={I.lock}
            value={confirm}
            onChange={setConfirm}
            placeholder={PWD_DOTS}
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            error={errs.confirm}
          />
          <SubmitButton busy={busy} label="Update password" busyLabel={<>Updating&hellip;</>} />
        </form>
      </div>
    </AuthShell>
  );
}
