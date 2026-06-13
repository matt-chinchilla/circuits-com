import { useState, type FormEvent } from 'react';
import axios from 'axios';
import { useAuth } from '@admin/contexts/AuthContext';
import Field from '../components/Field';
import { I, Svg } from '../components/icons';
import type { Screen } from './types';

const PWD_DOTS = '•'.repeat(8); // placeholder ••••••••

export default function SignIn({ go }: { go: (s: Screen) => void }) {
  const { login } = useAuth();
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [remember, setR] = useState(true); // design default: checked
  const [show, setShow] = useState(false);
  const [errs, setErrs] = useState<{ username?: string; password?: string }>({});
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: { username?: string; password?: string } = {};
    if (!username.trim()) next.username = 'Enter your username.';
    if (!password) next.password = 'Enter your password.';
    setErrs(next);
    setBanner('');
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      // On success AuthContext flips isAuthenticated → LoginPage redirects to
      // /admin, unmounting this screen (no need to reset busy).
      await login(username.trim(), password, remember);
    } catch (err) {
      setBusy(false);
      // A 401 means bad credentials; no response at all means the server is
      // unreachable — don't tell the user their password is wrong in that case.
      if (axios.isAxiosError(err) && !err.response) {
        setBanner('Couldn’t reach the server. Check your connection and try again.');
      } else {
        setBanner('Incorrect username or password. Please try again.');
      }
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
        Sign in to your Circuits.com account to search the catalog, track parts and manage
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
          id="username"
          label="Username"
          icon={I.user}
          value={username}
          onChange={setU}
          placeholder="demo"
          autoComplete="username"
          autoFocus
          error={errs.username}
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
        <button className="btn" type="submit" disabled={busy}>
          {busy ? (
            <>
              <span className="spinner" />
              Verifying&hellip;
            </>
          ) : (
            <>
              Sign in
              <Svg d={I.arrow} w={16} className="arrow" />
            </>
          )}
        </button>
      </form>
      <div className="form-meta">
        <p className="recover-line">
          Can&rsquo;t remember your username?{' '}
          <button onClick={() => go('forgot-username')}>Recover it</button>
        </p>
        <p className="demo-hint">
          <b>Demo access</b> &mdash; username <b>demo</b> &middot; password <b>demo</b>
        </p>
      </div>
    </div>
  );
}
