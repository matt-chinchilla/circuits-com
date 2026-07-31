// Forced "Set a new password" screen — the way OUT of the server's
// must_change_password gate (403 password_change_required on every admin
// route). It is routed to from three places, all of which funnel through
// passwordGate: the login response, GET /auth/me on a reloaded tab, and the
// adminApi 403 interceptor.
//
// Visually it reuses the login AuthShell + Field so it belongs to the same auth
// system as the recovery screens.
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '@admin/contexts/AuthContext';
import { apiErrorDetail } from '@admin/services/apiError';
import {
  PASSWORD_HELP,
  PASSWORD_RULES,
  unmetKeysFromDetail,
  validatePassword,
  type PasswordRuleKey,
} from '@admin/services/passwordPolicy';
import AuthShell from '@admin/pages/login/components/AuthShell';
import Field from '@admin/pages/login/components/Field';
import SubmitButton from '@admin/pages/login/components/SubmitButton';
import { I, Svg } from '@admin/pages/login/components/icons';
import { PWD_DOTS } from '@admin/pages/login/lib/recovery';

export default function ChangePasswordPage() {
  const { isAuthenticated, loading, mustChangePassword, changePassword, logout, user } = useAuth();
  const navigate = useNavigate();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [errs, setErrs] = useState<{ current?: string; next?: string; confirm?: string }>({});
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  // Rule keys the SERVER rejected. Client and server run the same four rules,
  // so this is normally empty — but if they ever diverge, the server wins and
  // the checklist says so instead of insisting the password is fine.
  const [serverUnmet, setServerUnmet] = useState<PasswordRuleKey[]>([]);

  const clientUnmet = validatePassword(next);
  const failed = new Set<PasswordRuleKey>([...clientUnmet, ...serverUnmet]);
  const pristine = next.length === 0;

  const onNextChange = (v: string) => {
    setNext(v);
    // The server's verdict was about the OLD text; drop it as soon as the user
    // edits, so the checklist goes back to the live client rules.
    if (serverUnmet.length) setServerUnmet([]);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const nextErrs: { current?: string; next?: string; confirm?: string } = {};
    if (!current) nextErrs.current = 'Enter your current password.';
    if (clientUnmet.length) nextErrs.next = 'This password doesn’t meet the requirements yet.';
    if (confirm !== next) nextErrs.confirm = 'Passwords don’t match.';
    setErrs(nextErrs);
    setBanner('');
    if (Object.keys(nextErrs).length) return;

    setBusy(true);
    try {
      // Adopts the fresh token the server mints (the change retires the old
      // one) and lowers the gate, so the console is reachable immediately.
      await changePassword(current, next);
      // Explicit, rather than leaning on the guard below: clearing the gate
      // re-renders this page through an external store, and the navigation
      // must not depend on which of the two lands first.
      navigate('/admin', { replace: true });
    } catch (err) {
      setBusy(false);
      if (axios.isAxiosError(err) && !err.response) {
        setBanner('Couldn’t reach the server. Check your connection and try again.');
        return;
      }
      const detail = axios.isAxiosError(err)
        ? (err.response?.data as { detail?: unknown } | undefined)?.detail
        : undefined;
      const keys = unmetKeysFromDetail(detail);
      if (keys.length) {
        // Structured 422 from the policy — tick the checklist off the server's
        // own answer. apiErrorDetail deliberately can't read this shape.
        setServerUnmet(keys);
        setBanner(PASSWORD_HELP);
        return;
      }
      // 400 = wrong current password, or "must differ from your current one".
      setBanner(apiErrorDetail(err) || 'Couldn’t update your password. Please try again.');
    }
  };

  if (loading) {
    return (
      <AuthShell>
        <div className="screen" aria-busy="true" />
      </AuthShell>
    );
  }

  // No session at all → this screen has nothing to change.
  if (!isAuthenticated) {
    return <Navigate to="/admin/login" replace />;
  }

  // Not flagged → nothing to change here. Also the landing pad for the instant
  // after a successful change, when the gate has already cleared.
  if (!mustChangePassword) {
    return <Navigate to="/admin" replace />;
  }

  return (
    <AuthShell>
      <div className="screen">
        <p className="eyebrow">
          <span className="dot" />
          Account Security
        </p>
        <h2>Set a new password</h2>
        <p className="lede">
          Your account{user?.username ? ` (${user.username})` : ''} needs a new password before
          you can continue. Choose one that meets all four requirements below.
        </p>
        <form onSubmit={submit} noValidate>
          {banner && (
            <div className="banner">
              <Svg d={I.alert} w={16} />
              <span>{banner}</span>
            </div>
          )}
          <Field
            id="current-password"
            label="Current password"
            icon={I.lock}
            value={current}
            onChange={setCurrent}
            placeholder={PWD_DOTS}
            type={show ? 'text' : 'password'}
            autoComplete="current-password"
            autoFocus
            error={errs.current}
          />
          <Field
            id="new-password"
            label="New password"
            icon={I.lock}
            value={next}
            onChange={onNextChange}
            placeholder={PWD_DOTS}
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            reveal
            revealed={show}
            onReveal={() => setShow((s) => !s)}
            error={errs.next}
          />
          <ul className="rules">
            {PASSWORD_RULES.map((rule) => {
              const met = !failed.has(rule.key);
              return (
                <li
                  key={rule.key}
                  className={`rule ${pristine ? 'rule-idle' : met ? 'rule-ok' : 'rule-no'}`}
                >
                  <span className="rule-mark" aria-hidden="true">
                    {!pristine && met ? <Svg d={I.check} w={11} /> : null}
                  </span>
                  <span>{rule.label}</span>
                  <span className="rule-state">{met ? ' (met)' : ' (not met yet)'}</span>
                </li>
              );
            })}
          </ul>
          <Field
            id="confirm-password"
            label="Confirm new password"
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
        <div className="form-meta">
          <p className="recover-line">
            Not your account? <button onClick={logout}>Sign out</button>
          </p>
        </div>
      </div>
    </AuthShell>
  );
}
