// Shared submit button for the auth screens — the busy spinner / arrow-CTA
// pattern that was repeated verbatim across all four forms (sign-in, the two
// recovery screens, reset-password). Labels stay per-screen via props so each
// flow keeps its own copy; the rendered markup is identical to the inline form.
import type { ReactNode } from 'react';
import { I, Svg } from './icons';

export default function SubmitButton({
  busy,
  label,
  busyLabel,
}: {
  busy: boolean;
  label: ReactNode;
  busyLabel: ReactNode;
}) {
  return (
    <button className="btn" type="submit" disabled={busy}>
      {busy ? (
        <>
          <span className="spinner" />
          {busyLabel}
        </>
      ) : (
        <>
          {label}
          <Svg d={I.arrow} w={16} className="arrow" />
        </>
      )}
    </button>
  );
}
