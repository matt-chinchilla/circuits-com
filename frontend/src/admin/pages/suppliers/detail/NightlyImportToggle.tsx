// The per-supplier AUTO-IMPORT switch. The filename is historical: it shipped
// as the nightly-only toggle, and the control is named "Auto-import" now that
// the same stored flag drives a second effect. Renaming the file would edit
// the detail page's import for nothing.
//
// ONE FLAG, ONE MEANING: "keep importing from this supplier's feed until the
// well is dry." It reaches two places, and the copy has to be honest about
// both or the switch is a half-truth:
//   * the nightly `feed-import` job runs this supplier — on its own even slice
//     of the shared daily quota, which is that meaning's unattended fairness
//     cap; and
//   * an Import click runs CONTINUOUS: sweep after sweep, re-deriving the
//     thinnest categories each pass, until the feed is exhausted or its quota
//     is reached. OFF, one click is one batch — at most one page per
//     subcategory, which is why a shelf used to need a click per page.
//
// The interactive half is decided SERVER-SIDE from this stored flag. There is
// no query parameter for it, so this switch is the only thing that can ask for
// an unbounded spend — which is also why enabling it is gated on a real
// provider and a real key (the 409 below).
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
//     would trap the operator in standing orders they cannot cancel.
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
// Both effects, in the order the operator meets them: the click they are
// about to make, and the run they will not be watching. Naming only the
// overnight half would leave the continuous Import — the bigger spend of the
// two — undisclosed on the control that switches it on.
const ON_HINT =
  'Runs overnight — and an Import click keeps going, batch after batch, until this ' +
  'supplier’s feed is exhausted or its daily quota is reached.';
const OFF_HINT = 'Off — Import new parts runs one batch, and nothing imports overnight.';
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
        ? ON_HINT
        : OFF_HINT;

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
        <div className={styles.title}>Auto-import</div>
        <div className={`${styles.hint} ${error ? styles.hintError : ''}`}>{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Auto-import"
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
