// Distributor feeds — the Settings card that stores the API keys the supplier
// sync runs on (GET/PUT/DELETE /api/admin/feed-credentials).
//
// Before this, a key could only be set in the host `.env` and taken up by a
// container recreate. Now it is pasted here, and the stored key WINS over the
// environment (`part_feed.registry.get_feed_key`).
//
// The server never sends a stored key back — the status row carries
// configured/source/last4/updated_at and nothing else — so this component has
// nothing to render it INTO, by construction. It follows the same rule with the
// value the operator just typed: the input is cleared on success and never
// re-seeded from a response, so a saved key does not sit in the DOM behind a
// password mask waiting for a screen share.
//
// `source` is the useful part of the status line: "environment" means a sync
// would use the server's own variable, which this screen can neither show nor
// rotate — hence no Remove button on that state, since there is no row to
// remove.

import { useCallback, useEffect, useState } from 'react';
import { Check, KeyRound, Trash2 } from 'lucide-react';
import { adminApi } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import type { FeedCredentialStatus } from '@admin/types/admin';
import styles from './SettingsPage.module.scss';

interface Props {
  /** Raise the page's toast — the card owns no chrome of its own. */
  onToast: (message: string) => void;
}

function statusLine(row: FeedCredentialStatus): string {
  if (row.source === 'database') {
    const when = row.updated_at ? new Date(row.updated_at) : null;
    const stamp = when && !Number.isNaN(when.getTime()) ? when.toLocaleDateString() : null;
    // The mask is four dots, not a slice of the key: last4 is all the server
    // will say, and a longer mask would imply it said more.
    const masked = row.last4 ? `····${row.last4}` : 'stored';
    return stamp ? `Configured — ${masked} · updated ${stamp}` : `Configured — ${masked}`;
  }
  if (row.configured) return 'Configured via server environment';
  return 'Not configured';
}

export default function FeedCredentialsCard({ onToast }: Props) {
  const [rows, setRows] = useState<FeedCredentialStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // One draft per provider slug, so a second feed's input is not clobbered by
  // saving the first.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Cancel flag: an admin who leaves the tab mid-request must not have state
    // set on an unmounted card.
    let cancelled = false;
    adminApi
      .getFeedCredentials()
      .then((providers) => {
        if (cancelled) return;
        setRows(providers);
        setLoadError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError('Could not load feed credentials.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(
    async (provider: string, action: () => Promise<FeedCredentialStatus[]>, done: string) => {
      setBusy(provider);
      setError(null);
      try {
        setRows(await action());
        // Whatever was typed is now on the server and has no business staying
        // in the field.
        setDrafts((prev) => ({ ...prev, [provider]: '' }));
        onToast(done);
      } catch (err) {
        setError(apiErrorDetail(err) ?? 'Could not save that key. Try again.');
      } finally {
        setBusy(null);
      }
    },
    [onToast]
  );

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>
          <KeyRound size={16} strokeWidth={2} /> Distributor feeds
        </h3>
        <p className={styles.panelHint}>
          API keys for the live inventory sync. Stored keys override the server environment
          and are never shown again after saving.
        </p>
      </div>

      {loading && <div className={styles.emptyHint}>Loading…</div>}
      {!loading && loadError && <div className={styles.emptyHint}>{loadError}</div>}

      {!loading && !loadError && (
        <div className={styles.panelBody}>
          {error && <div className={styles.fieldError}>{error}</div>}
          {rows.map((row) => {
            const draft = drafts[row.provider] ?? '';
            const saving = busy === row.provider;
            return (
              <div key={row.provider} className={styles.feedRow}>
                <div className={styles.feedMeta}>
                  <div className={styles.keyLabel}>{row.label}</div>
                  <div className={styles.keyValue}>{statusLine(row)}</div>
                </div>
                <div className={styles.feedControls}>
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    className={styles.textInput}
                    placeholder="Paste API key"
                    aria-label={`${row.label} API key`}
                    value={draft}
                    disabled={saving}
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [row.provider]: e.target.value }))
                    }
                  />
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    disabled={!draft.trim() || saving}
                    onClick={() =>
                      run(
                        row.provider,
                        () => adminApi.putFeedCredential(row.provider, draft.trim()),
                        `${row.label} key saved`
                      )
                    }
                  >
                    <Check size={15} strokeWidth={2} />
                    Save
                  </button>
                  {/* Only a DATABASE key has a row to remove. On "environment"
                      there is nothing here to delete, and a button that quietly
                      did nothing would read as a broken one. */}
                  {row.source === 'database' && (
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnGhost}`}
                      disabled={saving}
                      onClick={() =>
                        run(
                          row.provider,
                          () => adminApi.deleteFeedCredential(row.provider),
                          `${row.label} key removed`
                        )
                      }
                    >
                      <Trash2 size={15} strokeWidth={2} />
                      Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {rows.length === 0 && <div className={styles.emptyHint}>No distributor feeds.</div>}
        </div>
      )}
    </div>
  );
}
