import { useState, type FormEvent } from 'react';
import { adminApi } from '@admin/services/adminApi';
import Field from '../components/Field';
import SubmitButton from '../components/SubmitButton';
import { I, Svg } from '../components/icons';
import { isEmail, mask } from '../lib/recovery';
import type { Screen } from './types';

export default function ForgotUsername({ go }: { go: (s: Screen) => void }) {
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setErr('Enter your account email address.');
      return;
    }
    if (!isEmail(email)) {
      setErr('Enter a valid email address.');
      return;
    }
    setErr('');
    setBusy(true);
    // Anti-enumeration: same success regardless of whether the email matched.
    await adminApi.forgotUsername(email.trim()).catch(() => {});
    setBusy(false);
    setSent(true);
  };

  if (sent)
    return (
      <div className="success">
        <div className="success-mark">
          <Svg d={I.mail} w={26} />
        </div>
        <h2>Username sent</h2>
        <p className="lede">
          If <b>{mask(email)}</b> is linked to an admin account, we&rsquo;ve emailed the
          associated username. It should arrive within a minute.
        </p>
        <div className="success-actions">
          <button className="btn" onClick={() => go('signin')}>
            <Svg d={I.back} w={15} />
            Back to sign in
          </button>
        </div>
      </div>
    );

  return (
    <div className="screen">
      <button className="back-link" onClick={() => go('signin')}>
        <Svg d={I.back} w={15} />
        Back to sign in
      </button>
      <p className="eyebrow">
        <span className="dot" />
        Account Recovery
      </p>
      <h2>Recover your username</h2>
      <p className="lede">
        Enter the email address on your account and we&rsquo;ll send your username straight to
        your inbox.
      </p>
      <form onSubmit={submit} noValidate>
        <Field
          id="recover-email"
          label="Account email"
          icon={I.mail}
          value={email}
          onChange={setEmail}
          placeholder="you@circuits.com"
          inputMode="email"
          autoComplete="email"
          autoFocus
          error={err}
        />
        <SubmitButton busy={busy} label="Email my username" busyLabel={<>Sending&hellip;</>} />
      </form>
    </div>
  );
}
