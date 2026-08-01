import { useEffect, useState, useSyncExternalStore } from 'react';
import { Eye, X } from 'lucide-react';
import {
  DEMO_READ_ONLY_MESSAGE,
  demoReadOnlyNotice,
} from '@admin/services/demoReadOnly';
import styles from './DemoReadOnlyNotice.module.scss';

/** How long the notice stays up before fading itself out. */
const AUTO_HIDE_MS = 7000;

/**
 * The friendly answer to the server's `403 demo_account_read_only`.
 *
 * A prospect who clicked "See Demo" and then tried to save something gets one
 * calm sentence in the admin chrome, not a red error toast full of an API code.
 * The 403 is caught in the adminApi interceptor (a module, not a component), so
 * this reads it out of the `demoReadOnlyNotice` external store.
 *
 * The store's snapshot is a COUNTER, not a boolean: after the notice auto-hides,
 * a second refused edit has to be able to raise it again — which a boolean that
 * is already `true` could not do.
 */
export default function DemoReadOnlyNotice() {
  const sequence = useSyncExternalStore(
    demoReadOnlyNotice.subscribe,
    demoReadOnlyNotice.getSequence,
    // Server snapshot: nothing has been refused during SSR/hydration.
    () => 0,
  );
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (sequence === 0) return undefined;
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [sequence]);

  if (!visible) return null;

  return (
    <div className={styles.notice} role="status" aria-live="polite">
      <Eye size={15} strokeWidth={2} className={styles.icon} aria-hidden="true" />
      <span className={styles.text}>
        {DEMO_READ_ONLY_MESSAGE} Browse anything you like &mdash; nothing you do here
        changes the live site.
      </span>
      <button
        type="button"
        className={styles.dismiss}
        onClick={() => setVisible(false)}
        aria-label="Dismiss"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
