/**
 * BadgesPanel — the badge a company holds, on the supplier's own page.
 *
 * ONE component serves both consoles because the row is the same fact in
 * both: staff see the whole holding (grant it, enable it, revoke it) and the
 * customer sees the one they were given. Splitting it would put the badge's
 * appearance in two files that have to agree, which is exactly the drift the
 * shared `<FounderBadge>` exists to prevent.
 *
 * It does NOT own the editor. `onEdit(row)` hands the row up to the page,
 * which mounts `<BadgeEditorOverlay>` — the overlay is full-viewport and would
 * be trapped inside this panel's stacking context if it were mounted here.
 *
 * Re-reading after a write: `useCachedQuery` has no `refresh()`, and it does
 * not need one — both axios clients drop the WHOLE query cache on any
 * successful non-GET, so the only thing missing is a reason for the hook's
 * effect to run again. A reload counter in the KEY is that reason, and it
 * costs nothing: the entry it would have reused was just dropped.
 */
import { useCallback, useState } from 'react';

import { adminApi } from '@admin/services/adminApi';
import { accountApi } from '@admin/services/accountApi';
import { apiErrorDetail } from '@admin/services/apiError';
import { useCachedQuery } from '@admin/services/queryCache';
import type { BadgeDef, SupplierBadge } from '@admin/types/admin';
import FounderBadge from '@shared/components/FounderBadge/FounderBadge';

import styles from './BadgesPanel.module.scss';

export interface BadgesPanelProps {
  mode: 'staff' | 'account';
  /** Staff: required — the supplier whose holdings these are. */
  supplierId?: string;
  onEdit: (row: SupplierBadge) => void;
  /** Bumped by the page when the EDITOR saved: the overlay's write happened
   *  outside this component, so the panel needs telling that its row moved. */
  reloadKey?: number;
}

const BADGE_SCOPES = ['badges'] as const;

export default function BadgesPanel({ mode, supplierId, onEdit, reloadKey = 0 }: BadgesPanelProps) {
  const staff = mode === 'staff';
  const [reload, setReload] = useState(0);
  // The page's saves and this panel's own writes share one counter.
  const turn = reload + reloadKey;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two-click revoke rather than the browser's native confirmation dialog: a
  // native dialog blocks the whole tab, and this one is undone by clicking
  // anything else.
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setConfirming(null);
    setReload((n) => n + 1);
  }, []);

  const rowsKey = staff
    ? supplierId
      ? `badges:panel:${supplierId}:${turn}`
      : null
    : `badges:panel:mine:${turn}`;

  const rowsQ = useCachedQuery<SupplierBadge[]>(
    rowsKey,
    () => (staff ? adminApi.getSupplierBadges(supplierId as string) : accountApi.getMyBadges()),
    { scopes: BADGE_SCOPES },
  );

  // The catalogue is a staff door only — a customer has no `GET /api/badges`.
  const catalogueQ = useCachedQuery<BadgeDef[]>(
    staff ? `badges:panel-catalogue:${turn}` : null,
    () => adminApi.getBadgeCatalogue(),
    { scopes: BADGE_SCOPES },
  );

  const rows = rowsQ.data ?? [];
  const held = new Set(rows.map((r) => r.family));
  const grantable = (catalogueQ.data ?? []).filter((b) => !held.has(b.family));

  /** Run a write, then re-read. One place so no control forgets either half. */
  const run = useCallback(
    (work: () => Promise<unknown>, fallback: string) => {
      setBusy(true);
      setError(null);
      work()
        .then(refresh)
        .catch((err: unknown) => setError(apiErrorDetail(err) ?? fallback))
        .finally(() => setBusy(false));
    },
    [refresh],
  );

  const grant = (key: string) => {
    if (!key || !supplierId) return;
    run(() => adminApi.grantSupplierBadge(supplierId, key), 'Could not grant that badge.');
  };

  const setEnabled = (row: SupplierBadge, enabled: boolean) => {
    if (!supplierId) return;
    run(
      () => adminApi.updateSupplierBadge(supplierId, row.family, { enabled }),
      'Could not change that badge.',
    );
  };

  const revoke = (row: SupplierBadge) => {
    if (!supplierId) return;
    if (confirming !== row.family) {
      setConfirming(row.family);
      return;
    }
    run(() => adminApi.revokeSupplierBadge(supplierId, row.family), 'Could not revoke that badge.');
  };

  return (
    <div className={staff ? styles.panel : `${styles.panel} ${styles.panelNarrow}`}>
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>Badges</h3>
        {rowsQ.refreshing && <span className={styles.note}>Refreshing&hellip;</span>}
      </div>

      <div className={styles.body}>
        {rowsQ.loading && <div className={styles.note}>Loading badges&hellip;</div>}

        {!rowsQ.loading && rowsQ.error != null && (
          <div className={styles.error}>Could not load badges.</div>
        )}

        {!rowsQ.loading &&
          rows.map((row) => (
            <div className={styles.row} key={row.id}>
              <span className={styles.mark}>
                <FounderBadge look={row} size={32} />
              </span>
              <span className={styles.rowText}>
                <span className={styles.rowLabel}>{row.label}</span>
                <span className={styles.rowKey}>{row.key}</span>
              </span>
              <span className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => {
                    setConfirming(null);
                    onEdit(row);
                  }}
                >
                  Edit
                </button>
                {staff && (
                  <>
                    <label className={styles.toggle}>
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        disabled={busy}
                        onChange={(e) => setEnabled(row, e.target.checked)}
                      />
                      <span>Enabled</span>
                    </label>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnDanger}`}
                      disabled={busy}
                      onClick={() => revoke(row)}
                    >
                      {confirming === row.family ? 'Really revoke?' : 'Revoke'}
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}

        {!rowsQ.loading && rows.length === 0 && !staff && (
          <div className={styles.note}>Your badge will appear here once it is granted.</div>
        )}

        {staff && (
          <div className={styles.grant}>
            <label className={styles.grantLabel} htmlFor="badge-grant">
              Grant&hellip;
            </label>
            <select
              id="badge-grant"
              className={styles.select}
              value=""
              disabled={busy || grantable.length === 0}
              onChange={(e) => grant(e.target.value)}
            >
              <option value="">
                {grantable.length === 0 ? 'Nothing left to grant' : 'Choose a badge…'}
              </option>
              {grantable.map((b) => (
                <option key={b.id} value={b.key} disabled={!b.available}>
                  {b.available ? b.label : `${b.label} (coming soon)`}
                </option>
              ))}
            </select>
          </div>
        )}

        {error && <div className={styles.error}>{error}</div>}
      </div>
    </div>
  );
}
