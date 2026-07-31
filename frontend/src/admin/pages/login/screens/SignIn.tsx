import { useState, type FormEvent } from 'react';
import axios from 'axios';
import { useAuth } from '@admin/contexts/AuthContext';
import Field from '../components/Field';
import SubmitButton from '../components/SubmitButton';
import { I, Svg } from '../components/icons';
import { isEmail, PWD_DOTS } from '../lib/recovery';
import type { Screen } from './types';

export default function SignIn({ go }: { go: (s: Screen) => void }) {
  const { login, loginAsDemo } = useAuth();
  // EMAIL is the login identifier — there is no username sign-in for any
  // account, the public demo included (which has its own no-credential button).
  const [email, setEmail] = useState('');
  const [password, setP] = useState('');
  const [remember, setR] = useState(true); // design default: checked
  const [show, setShow] = useState(false);
  const [errs, setErrs] = useState<{ email?: string; password?: string }>({});
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  // The demo can be switched off server-side (DEMO_LOGIN_ENABLED=false), which
  // answers 404. Hide the button rather than show an error for something the
  // visitor can do nothing about.
  const [demoHidden, setDemoHidden] = useState(false);

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
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      // On success AuthContext flips isAuthenticated → LoginPage redirects
      // (to /admin, or to the forced-reset screen), unmounting this screen.
      await login(email.trim(), password, remember);
    } catch (err) {
      setBusy(false);
      // A 401 means bad credentials; no response at all means the server is
      // unreachable — don't tell the user their password is wrong in that case.
      if (axios.isAxiosError(err) && !err.response) {
        setBanner('Couldn’t reach the server. Check your connection and try again.');
      } else {
        // ONE message for unknown account, wrong password and rate-limited —
        // mirrors the backend's single 401 body (anti-enumeration).
        setBanner('Incorrect email or password. Please try again.');
      }
    }
  };

  const seeDemo = async () => {
    setBanner('');
    setDemoBusy(true);
    try {
      await loginAsDemo();
    } catch (err) {
      setDemoBusy(false);
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 404 || status === 403) {
        setDemoHidden(true);
        return;
      }
      setBanner('Couldn’t open the demo just now. Please try again.');
    }
  };

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
        {!demoHidden && (
          // Deliberately secondary to Sign in — this is the prospective-customer
          // door, not the staff one. No credentials ship in the bundle: the
          // account is resolved server-side by POST /api/auth/demo.
          <div className="demo-cta">
            <button type="button" className="btn-demo" onClick={seeDemo} disabled={demoBusy}>
              {demoBusy ? (
                <>
                  <span className="spinner" />
                  Opening demo&hellip;
                </>
              ) : (
                <>See Demo &rarr;</>
              )}
            </button>
            <p className="demo-note">Explore the admin console with sample data.</p>
          </div>
        )}
      </div>
    </div>
  );
}
