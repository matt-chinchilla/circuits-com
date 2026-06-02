// TODO: Candidate for @shared/components/ when admin gets clipboard surfaces.
// ≥2-consumer rule not yet met (only public consumer today).
import { useEffect, useRef, useState } from 'react';
import styles from './CopyAffordance.module.scss';

interface CopyAffordanceProps {
  text: string;
  tone?: 'dark' | 'light';
  // compact: icon-only pill used by v15 Preferred Partners rows. Drops the
  // "Copy"/"Copied" text label, tightens padding, switches to a round chip.
  compact?: boolean;
}

export default function CopyAffordance({ text, tone = 'dark', compact = false }: CopyAffordanceProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  const copy = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // navigator.clipboard.writeText returns a Promise — a non-async try/catch
    // does NOT trap the rejection (insecure context, denied permission,
    // unfocused document, Safari user-gesture rules). Await the promise so
    // we only flip the UI to "Copied ✓" on actual success; on failure the
    // chip stays at its rest state instead of lying to the user.
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 1500);
  };

  const cls = [
    styles.copy,
    tone === 'light' ? styles.copyLight : styles.copyDark,
    compact ? styles.copyCompact : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={cls}
      data-copied={copied ? '1' : '0'}
      aria-label={`Copy ${text}`}
      title="Copy"
      onClick={copy}
    >
      <span className={styles.copyIco} aria-hidden="true">{copied ? '✓' : '⧉'}</span>
      {!compact && (
        <span className={styles.copyTxt}>{copied ? 'Copied' : 'Copy'}</span>
      )}
    </button>
  );
}
