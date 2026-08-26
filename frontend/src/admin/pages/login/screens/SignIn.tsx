import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { adminApi } from '@admin/services/adminApi';
import { useAuth } from '@admin/contexts/AuthContext';
import Field from '../components/Field';
import SubmitButton from '../components/SubmitButton';
import { I, Svg } from '../components/icons';
import { classifyLoginError } from '../lib/loginError';
import { isEmail, PWD_DOTS } from '../lib/recovery';
import type { Screen } from './types';

/** Same pause the sign-up screen puts between resends. */
const RESEND_COOLDOWN_SECONDS = 30;

export default function SignIn({ go }: { go: (s: Screen) => void }) {
  const { login } = useAuth();
  // EMAIL is the login identifier — there is no username sign-in for any account.
  const [email, setEmail] = useState('');
  const [password, setP] = useState('');
  const [remember, setR] = useState(true); // design default: checked
  const [show, setShow] = useState(false);
  const [errs, setErrs] = useState<{ email?: string; password?: string }>({});
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  // The address whose account exists but was never confirmed. Non-empty IS the
  // "confirm your email" state — see the 403 branch in submit().
  const [unverified, setUnverified] = useState('');
  const [sentAgain, setSentAgain] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // The verify screen lands here with ?welcome=1 once an address is confirmed.
  // A confirmed account is signed in the ordinary way — verification mints no
  // session — so all this does is explain why they were sent back to a form.
  const [params] = useSearchParams();
  const welcome = params.get('welcome') === '1';

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );
  const startCooldown = () => {
    setCooldown(RESEND_COOLDOWN_SECONDS);
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

  // /auth/resend-verification is anti-enumeration — it answers the same generic
  // OK for a live address, an already-verified one and one that has no account
  // — so a failure here tells the user nothing useful. Swallow it and let the
  // cooldown be the feedback, exactly as the sign-up screen does.
  const resend = async () => {
    setSentAgain(true);
    startCooldown();
    await adminApi.resendVerification(unverified.toLowerCase()).catch(() => {});
  };

  // `type="text"` + inputMode="email", never type="email": an HTML5-invalid
  // value silently kills form submit (see the CLAUDE.md gotcha). Validation is
  // ours, in JS, on a noValidate form.
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: { email?: string; password?: string } = {};
    if (!email.trim()) next.email = 'Enter your email address.';
    else if (!isEmail(email)) next.email = 'Enter a valid email address.';
    if (!password) next.password = 'Enter your password.';
    setErrs(next);
    setBanner('');
    setUnverified('');
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      // On success AuthContext flips isAuthenticated → LoginPage redirects
      // (to /admin, or to the forced-reset screen), unmounting this screen.
      await login(email.trim(), password, remember);
    } catch (err) {
      setBusy(false);
      switch (classifyLoginError(err)) {
        case 'unverified':
          // The password was RIGHT. Saying "incorrect email or password" here
          // was the dead end: /signup answers `email_taken` and sends them back
          // to this screen, and forgot-password skips unverified accounts (D14)
          // and mails nothing. This state is the only remaining door.
          setUnverified(email.trim());
          setSentAgain(false);
          setCooldown(0);
          break;
        case 'unreachable':
          // No response at all — don't tell the user their password is wrong.
          setBanner('Couldn’t reach the server. Check your connection and try again.');
          break;
        default:
          // ONE message for unknown account, wrong password and rate-limited —
          // mirrors the backend's single 401 body (anti-enumeration).
          setBanner('Incorrect email or password. Please try again.');
      }
    }
  };

  // Its own state rather than a banner over the form: there is nothing to
  // retype here — the credentials were correct — so leaving the fields up would
  // invite exactly the retry that cannot work. Same shape as the sign-up
  // screen's "check your email", which is the screen they last saw.
  if (unverified)
    return (
      <div className="success">
        <div className="success-mark">
          <Svg d={I.mail} w={26} />
        </div>
        <h2>Confirm your email</h2>
        <p className="lede">
          Your password was right &mdash; <b>{unverified}</b> just hasn&rsquo;t been confirmed
          yet. Open the link we sent, or have a fresh one emailed to you.
        </p>
        {sentAgain && (
          <div className="banner-ok" role="status">
            <Svg d={I.check} w={16} />
            <span>New link sent. It works for 24 hours.</span>
          </div>
        )}
        <div className="success-actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setUnverified('');
              setSentAgain(false);
            }}
          >
            <Svg d={I.back} w={15} />
            Back to sign in
          </button>
          <button type="button" className="resend" disabled={cooldown > 0} onClick={resend}>
            {cooldown > 0
              ? `Another link can be sent in ${cooldown}s`
              : sentAgain
                ? 'Send it again'
                : 'Email me a new confirmation link'}
          </button>
        </div>
      </div>
    );

  return (
    <div className="screen">
      <p className="eyebrow">
        <span className="dot" />
        Account Access
      </p>
      <h2>Sign in</h2>
      <p className="lede">
        Sign in to your Circuit Center account to search the catalog, track parts and manage
        your orders.
      </p>
      {welcome && (
        <div className="banner-ok" role="status">
          <Svg d={I.check} w={16} />
          <span>Email confirmed. Sign in below.</span>
        </div>
      )}
      <form onSubmit={submit} noValidate>
        {banner && (
          <div className="banner">
            <Svg d={I.alert} w={16} />
            <span>{banner}</span>
          </div>
        )}
        <Field
          id="email"
          label="Email"
          icon={I.mail}
          value={email}
          onChange={setEmail}
          placeholder="you@circuitcenter.ai"
          inputMode="email"
          autoComplete="username"
          autoFocus
          error={errs.email}
        />
        <Field
          id="password"
          label="Password"
          icon={I.lock}
          value={password}
          onChange={setP}
          placeholder={PWD_DOTS}
          type={show ? 'text' : 'password'}
          autoComplete="current-password"
          reveal
          revealed={show}
          onReveal={() => setShow((s) => !s)}
          error={errs.password}
          right={
            <button type="button" className="field-link" onClick={() => go('forgot-password')}>
              Forgot password?
            </button>
          }
        />
        <label className="remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setR(e.target.checked)}
          />
          <span className="cbox">
            <Svg d={I.check} w={12} />
          </span>
          <span>Keep me signed in for 30 days</span>
        </label>
        <SubmitButton busy={busy} label="Sign in" busyLabel={<>Verifying&hellip;</>} />
      </form>
      <div className="form-meta">
        <p className="recover-line">
          Can&rsquo;t sign in?{' '}
          <button onClick={() => go('forgot-password')}>Reset your password</button>
        </p>
        {/* Two doors to the same screen on purpose: the button below is what a
            scanner's eye lands on, this line is what a reader finds. */}
        <p className="recover-line">
          New here?{' '}
          <button type="button" onClick={() => go('signup')}>
            Create an account
          </button>
        </p>
        {/* Deliberately secondary to Sign in — this is the prospective-customer
            door, not the staff one. It replaced the retired "See Demo" button
            (alembic 044): registration is how prospects get in now. */}
        <div className="demo-cta">
          <button type="button" className="btn-demo" onClick={() => go('signup')}>
            Sign Up &rarr;
          </button>
          <p className="demo-note">Create an account to get started.</p>
        </div>
      </div>
    </div>
  );
}
