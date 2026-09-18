/**
 * BadgesPanel — the badge a company holds, and the editor for it, on the
 * supplier's own page.
 *
 * ONE component serves both consoles because the row is the same fact in
 * both: staff see the whole holding (grant it, enable it, revoke it) and the
 * customer sees the one they were given. Splitting it would put the badge's
 * appearance in two files that have to agree, which is exactly the drift the
 * shared `<FounderBadge>` exists to prevent.
 *
 * The editor is INLINE and always open (owner, 2026-09-18: "built into the
 * panel, not a separate page"). It used to be a full-viewport overlay mounted
 * by the page, for one CSS reason — `position: fixed` is still trapped by any
 * ancestor that creates a containing block, and this panel carries the admin
 * glass pane's `backdrop-filter`. Nothing here is fixed any more, so that
 * reason is gone along with the scrim, the scroll lock and the focus return.
 *
 * What the editor shows is the DECISION, not a size ladder: the owner asked to
 * see the mark against the three boards it actually lands on — Platinum, Gold
 * and Silver, side by side — because a badge that reads on one and vanishes on
 * another is the only thing worth looking at. Every preview is the SAME
 * `<FounderBadge>` the public boards render, so nothing here can drift from
 * what ships.
 *
 * The nine scheme swatches sit on a dark "bench" strip because the fire
 * composites with `lighter`: on the console's pale surface the flames vanish
 * and nine schemes look like nine identical pins. The panel itself stays the
 * console's own surface — only the bench and the board previews go dark.
 *
 * Saving sends only the fields that CHANGED. That is a correctness rule, not
 * tidiness: the customer body is `extra="forbid"` server-side, so a patch
 * carrying an untouched staff field would be refused outright. `enabled` is
 * never in that patch at all — it is a staff switch that writes immediately.
 *
 * Re-reading after a write: `useCachedQuery` has no `refresh()`, and it does
 * not need one — both axios clients drop the WHOLE query cache on any
 * successful non-GET, so the only thing missing is a reason for the hook's
 * effect to run again. A reload counter in the KEY is that reason, and it
 * costs nothing: the entry it would have reused was just dropped.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { adminApi } from '@admin/services/adminApi';
import { accountApi } from '@admin/services/accountApi';
import { apiErrorDetail } from '@admin/services/apiError';
import { useCachedQuery } from '@admin/services/queryCache';
import type { BadgeDef, BadgeLookPatch, SupplierBadge } from '@admin/types/admin';
import FounderBadge from '@shared/components/FounderBadge/FounderBadge';
import { BADGE_RANGES, BADGE_SCHEMES, type BadgeScheme } from '@shared/types/badge';

import styles from './BadgesPanel.module.scss';

export interface BadgesPanelProps {
  mode: 'staff' | 'account';
  /** Staff: required — the supplier whose holdings these are. */
  supplierId?: string;
  /** The company's real name — the board previews are about THIS company. */
  supplierName?: string;
}

const BADGE_SCOPES = ['badges'] as const;

/** The three boards a founder badge lands on, with their real inks. */
const BOARDS = [
  { id: 'platinum', label: 'Platinum', cls: styles.boardPlatinum, pin: 22 },
  { id: 'gold', label: 'Gold', cls: styles.boardGold, pin: 18 },
  { id: 'silver', label: 'Silver', cls: styles.boardSilver, pin: 15 },
] as const;

interface Draft {
  key: string;
  scheme: BadgeScheme;
  intensity: number;
  opacity: number;
  sparks: boolean;
}

function draftOf(row: SupplierBadge): Draft {
  return {
    key: row.key,
    scheme: row.scheme,
    intensity: row.intensity,
    opacity: row.opacity,
    sparks: row.sparks,
  };
}

export default function BadgesPanel({ mode, supplierId, supplierName }: BadgesPanelProps) {
  const staff = mode === 'staff';
  const [reload, setReload] = useState(0);
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
      ? `badges:panel:${supplierId}:${reload}`
      : null
    : `badges:panel:mine:${reload}`;

  const rowsQ = useCachedQuery<SupplierBadge[]>(
    rowsKey,
    () => (staff ? adminApi.getSupplierBadges(supplierId as string) : accountApi.getMyBadges()),
    { scopes: BADGE_SCOPES },
  );

  // The catalogue is a staff door only — a customer has no `GET /api/badges`.
  const catalogueQ = useCachedQuery<BadgeDef[]>(
    staff ? `badges:panel-catalogue:${reload}` : null,
    () => adminApi.getBadgeCatalogue(),
    { scopes: BADGE_SCOPES },
  );

  const rows = rowsQ.data ?? [];
  const catalogue = catalogueQ.data ?? [];
  const held = new Set(rows.map((r) => r.family));
  const grantable = catalogue.filter((b) => !held.has(b.family));

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
            <BadgeBlock
              key={row.id}
              row={row}
              staff={staff}
              supplierId={supplierId}
              supplierName={supplierName}
              catalogue={catalogue}
              busy={busy}
              confirming={confirming === row.family}
              onEnabled={(v) => setEnabled(row, v)}
              onRevoke={() => revoke(row)}
              onSaved={refresh}
              onTouch={() => setConfirming(null)}
            />
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

interface BadgeBlockProps {
  row: SupplierBadge;
  staff: boolean;
  supplierId?: string;
  supplierName?: string;
  catalogue: BadgeDef[];
  busy: boolean;
  confirming: boolean;
  onEnabled: (enabled: boolean) => void;
  onRevoke: () => void;
  onSaved: () => void;
  onTouch: () => void;
}

/**
 * One holding: its identity row, the look controls, the scheme bench and the
 * three board previews. A separate component because the DRAFT belongs to the
 * row — a panel-level draft would have to be keyed by family by hand.
 */
function BadgeBlock({
  row,
  staff,
  supplierId,
  supplierName,
  catalogue,
  busy,
  confirming,
  onEnabled,
  onRevoke,
  onSaved,
  onTouch,
}: BadgeBlockProps) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(row));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A re-read only follows a write, so the saved row IS the draft by then;
  // this is what keeps the controls honest after someone else's change lands.
  useEffect(() => {
    setDraft(draftOf(row));
  }, [row.key, row.scheme, row.intensity, row.opacity, row.sparks]);

  /** The artwork this family offers. With no catalogue (the customer console
   *  has no catalogue door) the held key is the honest single option — never
   *  an empty select. */
  const options: BadgeDef[] = useMemo(() => {
    const family = catalogue.filter((b) => b.family === row.family);
    if (family.length > 0) return family;
    return [
      {
        id: row.id,
        key: row.key,
        family: row.family,
        label: row.label,
        available: row.available,
        sort_order: 0,
      },
    ];
  }, [catalogue, row]);

  const look = draft;

  /** Only what moved. `enabled` is a staff switch that writes immediately, so
   *  it is never in this patch and never reaches a customer's body. */
  const diff: BadgeLookPatch = {};
  if (draft.key !== row.key) diff.key = draft.key;
  if (draft.scheme !== row.scheme) diff.scheme = draft.scheme;
  if (draft.intensity !== row.intensity) diff.intensity = draft.intensity;
  if (draft.opacity !== row.opacity) diff.opacity = draft.opacity;
  if (draft.sparks !== row.sparks) diff.sparks = draft.sparks;
  const dirty = Object.keys(diff).length > 0;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    onTouch();
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const save = () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    const work = staff
      ? adminApi.updateSupplierBadge(supplierId as string, row.family, diff)
      : accountApi.updateMyBadge(row.family, diff);
    work
      .then(onSaved)
      .catch((err: unknown) => setError(apiErrorDetail(err) ?? 'Could not save the badge.'))
      .finally(() => setSaving(false));
  };

  const ids = `badge-${row.family}`;

  return (
    <div className={styles.block}>
      <div className={styles.row}>
        <span className={styles.mark}>
          <FounderBadge look={row} size={32} />
        </span>
        <span className={styles.rowText}>
          <span className={styles.rowLabel}>{row.label}</span>
          <span className={styles.rowKey}>{row.key}</span>
        </span>
        {staff && (
          <span className={styles.rowActions}>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={row.enabled}
                disabled={busy}
                onChange={(e) => onEnabled(e.target.checked)}
              />
              <span>Enabled</span>
            </label>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnDanger}`}
              disabled={busy}
              onClick={onRevoke}
            >
              {confirming ? 'Really revoke?' : 'Revoke'}
            </button>
          </span>
        )}
      </div>

      <div className={styles.controls}>
        <label className={styles.control} htmlFor={`${ids}-key`}>
          <span className={styles.controlLabel}>Appearance</span>
          <select
            id={`${ids}-key`}
            className={styles.select}
            value={draft.key}
            onChange={(e) => set('key', e.target.value)}
          >
            {options.map((b) => (
              <option key={b.id} value={b.key} disabled={!b.available && b.key !== row.key}>
                {b.available ? b.label : `${b.label} (coming soon)`}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.control} htmlFor={`${ids}-scheme`}>
          <span className={styles.controlLabel}>Scheme</span>
          <select
            id={`${ids}-scheme`}
            className={styles.select}
            value={draft.scheme}
            onChange={(e) => set('scheme', e.target.value as BadgeScheme)}
          >
            {BADGE_SCHEMES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.control}>
          <span className={styles.controlLabel}>Intensity</span>
          <span className={styles.sliderRow}>
            <input
              type="range"
              className={styles.slider}
              min={BADGE_RANGES.intensity.min}
              max={BADGE_RANGES.intensity.max}
              step={BADGE_RANGES.intensity.step}
              value={draft.intensity}
              onChange={(e) => set('intensity', Number(e.target.value))}
            />
            <span className={styles.value}>{draft.intensity.toFixed(1)}</span>
          </span>
        </label>

        <label className={styles.control}>
          <span className={styles.controlLabel}>Opacity</span>
          <span className={styles.sliderRow}>
            <input
              type="range"
              className={styles.slider}
              min={BADGE_RANGES.opacity.min}
              max={BADGE_RANGES.opacity.max}
              step={BADGE_RANGES.opacity.step}
              value={draft.opacity}
              onChange={(e) => set('opacity', Number(e.target.value))}
            />
            <span className={styles.value}>{draft.opacity.toFixed(2)}</span>
          </span>
        </label>

        <label className={styles.control}>
          <span className={styles.controlLabel}>Sparks</span>
          <input
            type="checkbox"
            role="switch"
            checked={draft.sparks}
            onChange={(e) => set('sparks', e.target.checked)}
          />
        </label>

        <span className={styles.controlActions}>
          <button
            type="button"
            className={styles.btn}
            disabled={!dirty || saving}
            onClick={() => setDraft(draftOf(row))}
          >
            Discard changes
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </span>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.bench}>
        {BADGE_SCHEMES.map((scheme) => (
          <button
            key={scheme}
            type="button"
            className={styles.swatch}
            aria-pressed={draft.scheme === scheme}
            onClick={() => set('scheme', scheme)}
          >
            <FounderBadge look={{ ...look, scheme }} size={56} />
            <span className={styles.swatchName}>{scheme}</span>
          </button>
        ))}
      </div>

      <div className={styles.boards}>
        {BOARDS.map((b) => (
          <div key={b.id} className={`${styles.board} ${b.cls}`}>
            <span className={styles.boardName}>
              {supplierName?.trim() || 'Your company'}
              <FounderBadge look={look} size={b.pin} />
            </span>
            <span className={styles.boardTier}>{b.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
