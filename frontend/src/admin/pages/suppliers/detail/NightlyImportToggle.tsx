// The per-supplier nightly auto-import switch, parked beside the Quick Actions
// strip because it is the standing-order version of the Import card directly
// above it: one click imports now, this one imports every night.
//
// Self-contained on purpose — it owns its own GET, its own PATCH and its own
// error line, so the detail page does not grow a fourth piece of async state
// for a control that talks to nothing else on the page.
//
// Three rules the copy depends on:
//  1. A feed that could never run renders the switch GREYED WITH A REASON.
//     `GET /feed-settings` deliberately answers for unconfigured suppliers too
//     (it does not 404 like sync/import) precisely so there is something to
//     say.
//  2. DISABLING is always sent, even from a greyed-looking state: a key can be
//     removed while the toggle is on, and an off switch that refuses to work
//     would trap the operator in a nightly run they cannot stop.
//  3. The flip is optimistic and reverts on failure. A switch that waits for
//     the round trip reads as broken; a switch that keeps a position the
//     server rejected is a lie.

import { useEffect, useState } from 'react';
import { adminApi } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import { DEMO_READ_ONLY_MESSAGE } from '@admin/services/demoReadOnly';
import type { FeedSettings } from '@admin/types/admin';
import styles from './NightlyImportToggle.module.scss';

interface Props {
  supplierId: string;
}

const NO_FEED_HINT = 'Add this supplier’s API key in Settings to enable';
const SAVE_FAILED = 'Could not change that just now — try again.';

export default function NightlyImportToggle({ supplierId }: Props) {
  const [settings, setSettings] = useState<FeedSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setError(null);
    adminApi
      .getFeedSettings(supplierId)
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((err) => {
        // Best-effort, like the sponsorship badge: a settings row that cannot
        // be read is not worth replacing the supplier page over, and a switch
        // whose state is unknown is worse than no switch at all.
        console.warn('[NightlyImportToggle] getFeedSettings failed; switch hidden', err);
      });
    return () => {
      cancelled = true;
    };
  }, [supplierId]);

  if (!settings) return null;

  // `provider` is `string | null` from the server — a bare truthiness check is
  // the intent here (an empty slug is as unrunnable as a missing one).
  const runnable = Boolean(settings.provider) && settings.key_configured;
  const enabled = settings.auto_import_enabled;
  // Rule 2: an ON switch stays clickable even when the feed went unrunnable,
  // so it can always be turned back off.
  const locked = !runnable && !enabled;

  const hint = error
    ? error
    : !runnable
      ? NO_FEED_HINT
      : enabled
        ? 'Runs overnight and adds new parts from this supplier’s feed.'
        : 'Off — new parts arrive only when you press Import new parts.';

  const handleToggle = () => {
    if (saving || locked) return;
    const next = !enabled;
    setError(null);
    setSaving(true);
    // Optimistic: flip now, and put it back exactly where it was if the server
    // refuses. `previous` is captured rather than re-derived so a revert cannot
    // adopt a state that arrived in between.
    const previous = settings;
    setSettings({ ...previous, auto_import_enabled: next });
    adminApi
      .patchFeedSettings(supplierId, next)
      .then((fresh) => setSettings(fresh))
      .catch((err) => {
        setSettings(previous);
        const detail = apiErrorDetail(err);
        // The demo's read-only 403 already raises the global notice from the
        // axios interceptor — saying it again here would say it twice.
        setError(detail === DEMO_READ_ONLY_MESSAGE ? null : (detail ?? SAVE_FAILED));
      })
      .finally(() => setSaving(false));
  };

  return (
    <section className={styles.row}>
      <div className={styles.copy}>
        <div className={styles.title}>Nightly auto-import</div>
        <div className={`${styles.hint} ${error ? styles.hintError : ''}`}>{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Nightly auto-import"
        disabled={locked || saving}
        className={`${styles.pill} ${enabled ? styles.pillOn : ''} ${
          locked ? styles.pillLocked : ''
        }`}
        onClick={handleToggle}
      >
        <span className={styles.knob} />
      </button>
    </section>
  );
}
