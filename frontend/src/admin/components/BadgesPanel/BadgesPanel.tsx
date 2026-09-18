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
 * LAYOUT (owner, 2026-09-18 14:40, superseding the plan's stacked blocks):
 * "All of those colors & the sliders can fit as a 'general' set of tools at
 * the top of the badges panel. The colors & preview can appear in the same
 * row as the badge." So — one tools bar across the top, then ONE LINE per
 * holding carrying its pin, its nine colour swatches, its board preview and
 * (for staff) Enabled/Revoke.
 *
 * That split is why the DRAFT lives up here rather than in the row: the bar
 * and the swatches edit the same draft from two places in the tree. It is a
 * map keyed by family with an `active` family the bar targets — one holding
 * today, so nothing is ever ambiguous, and a second family would not need a
 * second design.
 *
 * The swatch cluster keeps the dark bench under it because the fire composites
 * with `lighter`: on the console's pale surface the flames vanish and nine
 * schemes read as nine identical pins. The preview chip carries a real board
 * ink for the same reason. Nothing else here goes dark; this is console chrome.
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
  /** The company's real name — the board preview is about THIS company. */
  supplierName?: string;
}

const BADGE_SCOPES = ['badges'] as const;

/**
 * The three boards a founder badge lands on, with their real inks. They are
 * rendered widest-first: the row shows all three where it has the width and
 * the FIRST one alone where it has not (the stylesheet decides), so the one
 * that survives is Platinum — the largest pin, the hardest case to read.
 */
const BOARDS = [
  { id: 'platinum', label: 'Platinum', cls: styles.chipPlatinum, pin: 22 },
  { id: 'gold', label: 'Gold', cls: styles.chipGold, pin: 18 },
  { id: 'silver', label: 'Silver', cls: styles.chipSilver, pin: 15 },
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

/** Everything the draft mirrors, in one string: the re-seed trigger. */
function lookSignature(rows: SupplierBadge[]): string {
  return rows
    .map((r) => `${r.family}:${r.key}:${r.scheme}:${r.intensity}:${r.opacity}:${r.sparks}`)
    .join('|');
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
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [active, setActive] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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

  const rows = useMemo(() => rowsQ.data ?? [], [rowsQ.data]);
  const catalogue = catalogueQ.data ?? [];
  const held = new Set(rows.map((r) => r.family));
  const grantable = catalogue.filter((b) => !held.has(b.family));

  // A re-read only follows a write, so the saved rows ARE the drafts by then;
  // this is what keeps the bar honest after someone else's change lands.
  const signature = lookSignature(rows);
  useEffect(() => {
    const next: Record<string, Draft> = {};
    for (const r of rows) next[r.family] = draftOf(r);
    setDrafts(next);
    setActive((a) => (a && next[a] ? a : (rows[0]?.family ?? null)));
    // `signature` is every value `next` is built from; `rows` itself changes
    // identity on any background re-render that returns the same payload, so
    // depending on it would stamp the drafts back over an edit in progress.
  }, [signature]);

  const activeRow = rows.find((r) => r.family === active) ?? rows[0] ?? null;
  const activeDraft = activeRow ? drafts[activeRow.family] : undefined;

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

  /** Edit one field of one holding's draft, and aim the tools bar at it. */
  const set = <K extends keyof Draft>(family: string, k: K, v: Draft[K]) => {
    setConfirming(null);
    setActive(family);
    setDrafts((d) => (d[family] ? { ...d, [family]: { ...d[family], [k]: v } } : d));
  };

  /** Only what moved. `enabled` is a staff switch that writes immediately, so
   *  it is never in this patch and never reaches a customer's body. */
  const diff: BadgeLookPatch = {};
  if (activeRow && activeDraft) {
    if (activeDraft.key !== activeRow.key) diff.key = activeDraft.key;
    if (activeDraft.scheme !== activeRow.scheme) diff.scheme = activeDraft.scheme;
    if (activeDraft.intensity !== activeRow.intensity) diff.intensity = activeDraft.intensity;
    if (activeDraft.opacity !== activeRow.opacity) diff.opacity = activeDraft.opacity;
    if (activeDraft.sparks !== activeRow.sparks) diff.sparks = activeDraft.sparks;
  }
  const dirty = Object.keys(diff).length > 0;

  /** The artwork the ACTIVE holding's family offers. With no catalogue (the
   *  customer console has no catalogue door) the held key is the honest single
   *  option — never an empty select. */
  const options: BadgeDef[] = useMemo(() => {
    if (!activeRow) return [];
    const family = catalogue.filter((b) => b.family === activeRow.family);
    if (family.length > 0) return family;
    return [
      {
        id: activeRow.id,
        key: activeRow.key,
        family: activeRow.family,
        label: activeRow.label,
        available: activeRow.available,
        sort_order: 0,
      },
    ];
  }, [catalogue, activeRow]);

  const save = () => {
    if (!activeRow || !dirty || saving) return;
    setSaving(true);
    setError(null);
    const work = staff
      ? adminApi.updateSupplierBadge(supplierId as string, activeRow.family, diff)
      : accountApi.updateMyBadge(activeRow.family, diff);
    work
      .then(refresh)
      .catch((err: unknown) => setError(apiErrorDetail(err) ?? 'Could not save the badge.'))
      .finally(() => setSaving(false));
  };

  const discard = () => {
    if (!activeRow) return;
    setDrafts((d) => ({ ...d, [activeRow.family]: draftOf(activeRow) }));
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

        {/* ── The general tools, across the top ───────────────────────── */}
        {activeRow && activeDraft && (
          <div className={styles.tools}>
            <label className={styles.control} htmlFor="badge-key">
              <span className={styles.controlLabel}>Appearance</span>
              <select
                id="badge-key"
                className={styles.select}
                value={activeDraft.key}
                onChange={(e) => set(activeRow.family, 'key', e.target.value)}
              >
                {options.map((b) => (
                  <option
                    key={b.id}
                    value={b.key}
                    disabled={!b.available && b.key !== activeRow.key}
                  >
                    {b.available ? b.label : `${b.label} (coming soon)`}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.control} htmlFor="badge-scheme">
              <span className={styles.controlLabel}>Scheme</span>
              <select
                id="badge-scheme"
                className={styles.select}
                value={activeDraft.scheme}
                onChange={(e) =>
                  set(activeRow.family, 'scheme', e.target.value as BadgeScheme)
                }
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
                  value={activeDraft.intensity}
                  onChange={(e) =>
                    set(activeRow.family, 'intensity', Number(e.target.value))
                  }
                />
                <span className={styles.value}>{activeDraft.intensity.toFixed(1)}</span>
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
                  value={activeDraft.opacity}
                  onChange={(e) => set(activeRow.family, 'opacity', Number(e.target.value))}
                />
                <span className={styles.value}>{activeDraft.opacity.toFixed(2)}</span>
              </span>
            </label>

            <label className={styles.control}>
              <span className={styles.controlLabel}>Sparks</span>
              <input
                type="checkbox"
                role="switch"
                className={styles.switch}
                checked={activeDraft.sparks}
                onChange={(e) => set(activeRow.family, 'sparks', e.target.checked)}
              />
            </label>

            <span className={styles.toolActions}>
              <button
                type="button"
                className={styles.btn}
                disabled={!dirty || saving}
                onClick={discard}
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
        )}

        {error && <div className={styles.error}>{error}</div>}

        {/* ── One line per holding ────────────────────────────────────── */}
        {!rowsQ.loading &&
          rows.map((row) => {
            const look = drafts[row.family] ?? draftOf(row);
            return (
              <div className={styles.row} key={row.id}>
                <span className={styles.ident}>
                  <span className={styles.mark}>
                    <FounderBadge look={row} size={32} />
                  </span>
                  <span className={styles.rowText}>
                    <span className={styles.rowLabel}>{row.label}</span>
                    <span className={styles.rowKey}>{row.key}</span>
                  </span>
                </span>

                <span className={styles.bench}>
                  {BADGE_SCHEMES.map((scheme) => (
                    <button
                      key={scheme}
                      type="button"
                      className={styles.swatch}
                      aria-label={scheme}
                      title={scheme}
                      aria-pressed={look.scheme === scheme}
                      onClick={() => set(row.family, 'scheme', scheme)}
                    >
                      <FounderBadge look={{ ...look, scheme }} size={28} />
                    </button>
                  ))}
                </span>

                <span className={styles.previews}>
                  {BOARDS.map((b) => (
                    <span key={b.id} className={`${styles.chip} ${b.cls}`}>
                      <span className={styles.chipName}>
                        {supplierName?.trim() || 'Your company'}
                        <FounderBadge look={look} size={b.pin} />
                      </span>
                      <span className={styles.chipTier}>{b.label}</span>
                    </span>
                  ))}
                </span>

                {staff && (
                  <span className={styles.rowActions}>
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
                  </span>
                )}
              </div>
            );
          })}

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
      </div>
    </div>
  );
}
