import { useState, useRef, useEffect, type FormEvent } from 'react';
import { adminApi } from '@admin/services/adminApi';
import Field from '../components/Field';
import SubmitButton from '../components/SubmitButton';
import { I, Svg } from '../components/icons';
import { mask } from '../lib/recovery';
import type { Screen } from './types';

export default function ForgotPassword({ go }: { go: (s: Screen) => void }) {
  const [val, setVal] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

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

  // The backend is anti-enumeration (always 200), so we show the same success
  // whether or not an account matched — and even if the request itself errors,
  // we don't reveal that distinction to the user.
  const request = () => adminApi.forgotPassword(val.trim()).catch(() => {});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!val.trim()) {
      setErr('Enter the email or username on your account.');
      return;
    }
    setErr('');
    setBusy(true);
    await request();
    setBusy(false);
    setSent(true);
    startCooldown();
  };

  if (sent)
    return (
      <div className="success">
        <div className="success-mark">
          <Svg d={I.mail} w={26} />
        </div>
        <h2>Check your inbox</h2>
        <p className="lede">
          If an account matches <b>{mask(val)}</b>, we&rsquo;ve sent a secure reset link. It
          expires in 30 minutes for your protection.
        </p>
        <div className="success-actions">
          <button className="btn-ghost" onClick={() => go('signin')}>
            <Svg d={I.back} w={15} />
            Back to sign in
          </button>
          <button
            className="resend"
            disabled={cooldown > 0}
            onClick={async () => {
              await request();
              startCooldown();
            }}
          >
            {cooldown > 0 ? `Resend available in ${cooldown}s` : 'Didn’t get it? Resend link'}
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
      <h2>Reset your password</h2>
      <p className="lede">
        Enter the email or username on your account and we&rsquo;ll send a secure link to set a
        new password.
      </p>
      <form onSubmit={submit} noValidate>
        <Field
          id="recover-id"
          label="Email or username"
          icon={I.id}
          value={val}
          onChange={setVal}
          placeholder="you@circuits.com"
          autoComplete="username"
          autoFocus
          error={err}
        />
        <SubmitButton busy={busy} label="Send reset link" busyLabel={<>Sending&hellip;</>} />
      </form>
    </div>
  );
}
