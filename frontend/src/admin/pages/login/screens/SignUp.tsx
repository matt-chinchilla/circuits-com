// Sign Up — the customer front door, and the screen that replaced the retired
// one-click demo (alembic 044).
//
// It ends in a "check your email" state, never in a session: POST /auth/signup
// answers 202 with no token, because staff are notified when an address is
// VERIFIED and never when a form is submitted.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import axios from 'axios';
import { adminApi } from '@admin/services/adminApi';
import {
  PASSWORD_HELP,
  PASSWORD_RULES,
  unmetKeysFromDetail,
  validatePassword,
  type PasswordRuleKey,
} from '@admin/services/passwordPolicy';
import Field from '../components/Field';
import SubmitButton from '../components/SubmitButton';
import { I, Svg } from '../components/icons';
import { PWD_DOTS } from '../lib/recovery';
import { signupFieldErrors } from './signupForm';
import type { Screen } from './types';

export default function SignUp({ go }: { go: (s: Screen) => void }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState('');
  const [sent, setSent] = useState(false);
  // Rule keys the SERVER rejected. Client and server run the same four rules,
  // so this is normally empty — but if they ever diverge, the server wins.
  const [serverUnmet, setServerUnmet] = useState<PasswordRuleKey[]>([]);
  // Field errors stay hidden until the first submit attempt: a form that opens
  // red is a form that has already annoyed you. After that they update live, so
  // a fix clears its own error as it is typed.
  const [attempted, setAttempted] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  const errors = signupFieldErrors({ firstName, lastName, email, password, confirm });
  const failed = new Set<PasswordRuleKey>([...validatePassword(password), ...serverUnmet]);
  const pristine = password.length === 0;
  // The validator stays quiet about an UNTOUCHED confirm box. Once they have
  // tried to submit, an empty one is the thing standing in the way, so name it
  // rather than highlighting nothing under a "check the fields" banner.
  const confirmErr =
    errors.confirm ??
    (attempted && confirm !== password ? 'Re-enter your password to confirm.' : undefined);

  const onPasswordChange = (v: string) => {
    setPassword(v);
    // The server's verdict was about the OLD text; drop it as soon as the user
    // edits, so the checklist goes back to the live client rules.
    if (serverUnmet.length) setServerUnmet([]);
  };

  const startCooldown = () => {
    setCooldown(30);
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(
      () =>
        setCooldown((c) => {
          if (c <= 1) {
            if (timer.current) clearInterval(timer.current);
            return 0;
          }
          return c - 1;
        }),
      1000,
    );
  };

  // Anti-enumeration server-side (always a generic ok), so a failure here tells
  // the user nothing useful — swallow it and let the cooldown be the feedback.
  const resend = () => adminApi.resendVerification(email.trim().toLowerCase()).catch(() => {});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    setBanner('');
    setServerUnmet([]);
    // `confirm !== password` is checked separately: the validator deliberately
    // lets an empty confirm box through so the form doesn't open red.
    if (Object.keys(errors).length > 0 || confirm !== password) {
      setBanner('Check the highlighted fields and try again.');
      return;
    }
    setBusy(true);
    try {
      // extra="forbid" server-side — confirm is a CLIENT-side check only and
      // must never be sent.
      await adminApi.signup(firstName.trim(), lastName.trim(), email.trim(), password);
      setSent(true);
      startCooldown();
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
      // Matched against the RAW detail, not apiErrorDetail's output: that
      // helper passes an unmapped code straight through, so leaning on it here
      // would print "email_taken" at the user the day somebody adds a mapping
      // for a different code. Every string detail this route can return is a
      // machine code, so there is no prose to surface — anything unrecognised
      // falls through to the generic sentence below.
      const code = typeof detail === 'string' ? detail : '';
      if (code === 'email_taken') {
        // An explicit carve-out from the anti-enumeration rule (design D5) —
        // the server says so on purpose, so say it plainly and point at the
        // door they actually want.
        setBanner('An account already uses this address. Sign in instead.');
        return;
      }
      if (code === 'too_many_requests') {
        setBanner('Too many attempts from this connection. Try again in a little while.');
        return;
      }
      setBanner('Couldn’t create your account. Please try again.');
    }
  };

  if (sent)
    return (
      <div className="success">
        <div className="success-mark">
          <Svg d={I.mail} w={26} />
        </div>
        <h2>Check your email</h2>
        <p className="lede">
          We&rsquo;ve sent a confirmation link to <b>{email.trim()}</b>. It works for 24 hours
          &mdash; open it and your account is ready.
        </p>
        <div className="success-actions">
          <button type="button" className="btn-ghost" onClick={() => go('signin')}>
            <Svg d={I.back} w={15} />
            Back to sign in
          </button>
          <button
            type="button"
            className="resend"
            disabled={cooldown > 0}
            onClick={async () => {
              await resend();
              startCooldown();
            }}
          >
            {cooldown > 0 ? `Resend available in ${cooldown}s` : 'Nothing arrived? Send it again'}
          </button>
        </div>
      </div>
    );

  return (
    <div className="screen">
      <button type="button" className="back-link" onClick={() => go('signin')}>
        <Svg d={I.back} w={15} />
        Back to sign in
      </button>
      <p className="eyebrow">
        <span className="dot" />
        Create an account
      </p>
      <h2>Get started</h2>
      <p className="lede">
        Set up your Circuit Center account to search the catalog, track parts and price a
        bill of materials. It takes a minute.
      </p>
      <form onSubmit={submit} noValidate>
        {banner && (
          <div className="banner" role="alert">
            <Svg d={I.alert} w={16} />
            <span>{banner}</span>
          </div>
        )}
        <Field
          id="signup-first-name"
          label="First name"
          icon={I.user}
          value={firstName}
          onChange={setFirstName}
          placeholder="James"
          autoComplete="given-name"
          autoFocus
          error={attempted ? errors.firstName : undefined}
        />
        <Field
          id="signup-last-name"
          label="Last name"
          icon={I.user}
          value={lastName}
          onChange={setLastName}
          placeholder="Chirichella"
          autoComplete="family-name"
          error={attempted ? errors.lastName : undefined}
        />
        <Field
          id="signup-email"
          label="Work email"
          icon={I.mail}
          value={email}
          onChange={setEmail}
          placeholder="you@company.com"
          inputMode="email"
          autoComplete="email"
          error={attempted ? errors.email : undefined}
        />
        <Field
          id="signup-password"
          label="Password"
          icon={I.lock}
          value={password}
          onChange={onPasswordChange}
          placeholder={PWD_DOTS}
          type={show ? 'text' : 'password'}
          // "new-password" on BOTH boxes, deliberately: it is what stops a
          // password manager filling the confirm box with the saved password
          // for this site, which would silently defeat the match check.
          autoComplete="new-password"
          reveal
          revealed={show}
          onReveal={() => setShow((s) => !s)}
          error={attempted ? errors.password : undefined}
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
          id="signup-confirm-password"
          label="Confirm password"
          icon={I.lock}
          value={confirm}
          onChange={setConfirm}
          placeholder={PWD_DOTS}
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          error={confirmErr}
        />
        <SubmitButton busy={busy} label="Create account" busyLabel={<>Creating&hellip;</>} />
      </form>
      <div className="form-meta">
        <p className="recover-line">
          Already have an account?{' '}
          <button type="button" onClick={() => go('signin')}>
            Sign in
          </button>
        </p>
      </div>
    </div>
  );
}
