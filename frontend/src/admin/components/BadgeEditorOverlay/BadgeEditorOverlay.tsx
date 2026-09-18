/**
 * BadgeEditorOverlay — the full-viewport editor for one badge holding.
 *
 * It is mounted by the PAGE, never by `BadgesPanel`: `position: fixed` is
 * still trapped by any ancestor that creates a containing block, and the
 * panel carries a `backdrop-filter` (the admin glass pane), which does exactly
 * that. Mounting it inside the panel would clip a "full-viewport" editor to a
 * card.
 *
 * What it shows is the DECISION, not a size ladder: the owner asked to see
 * the mark against the three boards it actually lands on — Platinum, Gold and
 * Silver, side by side — because a badge that reads on one and vanishes on
 * another is the only thing worth looking at. The board swatches carry the
 * real board inks and type sizes, so the preview is the answer, not a hint.
 *
 * Every preview is the SAME `<FounderBadge>` the public boards render, so
 * there is nothing here that can drift from what ships.
 *
 * Saving sends only the fields that CHANGED. That is a correctness rule, not
 * tidiness: the customer body is `extra="forbid"` server-side, so a patch
 * carrying `enabled` (or any untouched staff field) would be refused outright.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { adminApi } from '@admin/services/adminApi';
import { accountApi } from '@admin/services/accountApi';
import { apiErrorDetail } from '@admin/services/apiError';
import type { BadgeDef, BadgeLookPatch, SupplierBadge } from '@admin/types/admin';
import FounderBadge from '@shared/components/FounderBadge/FounderBadge';
import { BADGE_RANGES, BADGE_SCHEMES, type BadgeScheme } from '@shared/types/badge';

import styles from './BadgeEditorOverlay.module.scss';

export interface BadgeEditorOverlayProps {
  mode: 'staff' | 'account';
  /** Staff: required — whose holding this is. */
  supplierId?: string;
  row: SupplierBadge;
  /** The artwork the family offers. Empty in the customer console, which has
   *  no catalogue door: the editor then offers the key already held. */
  catalogue: BadgeDef[];
  /** The company's real name — the board previews are about THIS company. */
  supplierName: string;
  onClose: () => void;
  onSaved: (row: SupplierBadge) => void;
}

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
  enabled: boolean;
}

function draftOf(row: SupplierBadge): Draft {
  return {
    key: row.key,
    scheme: row.scheme,
    intensity: row.intensity,
    opacity: row.opacity,
    sparks: row.sparks,
    enabled: row.enabled,
  };
}

export default function BadgeEditorOverlay({
  mode,
  supplierId,
  row,
  catalogue,
  supplierName,
  onClose,
  onSaved,
}: BadgeEditorOverlayProps) {
  const staff = mode === 'staff';
  const [draft, setDraft] = useState<Draft>(() => draftOf(row));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const firstRef = useRef<HTMLSelectElement>(null);

  // Focus in, focus back out, and no page scrolling underneath while open.
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    firstRef.current?.focus();
    const root = document.documentElement;
    const priorBody = document.body.style.overflow;
    const priorRoot = root.style.overflow;
    document.body.style.overflow = 'hidden';
    root.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = priorBody;
      root.style.overflow = priorRoot;
      returnTo?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** The artwork this family offers. With no catalogue (the customer console)
   *  the held key is the honest single option — never an empty select. */
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

  const look = { key: draft.key, scheme: draft.scheme, intensity: draft.intensity, opacity: draft.opacity, sparks: draft.sparks };

  /** Only what moved. `enabled` is staff-only and never reaches a customer
   *  patch, which the server would refuse. */
  const diff: BadgeLookPatch & { enabled?: boolean } = {};
  if (draft.key !== row.key) diff.key = draft.key;
  if (draft.scheme !== row.scheme) diff.scheme = draft.scheme;
  if (draft.intensity !== row.intensity) diff.intensity = draft.intensity;
  if (draft.opacity !== row.opacity) diff.opacity = draft.opacity;
  if (draft.sparks !== row.sparks) diff.sparks = draft.sparks;
  if (staff && draft.enabled !== row.enabled) diff.enabled = draft.enabled;
  const dirty = Object.keys(diff).length > 0;

  const set = useCallback(<K extends keyof Draft>(k: K, v: Draft[K]) => {
    setConfirming(false);
    setDraft((d) => ({ ...d, [k]: v }));
  }, []);

  const save = () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    const work = staff
      ? adminApi.updateSupplierBadge(supplierId as string, row.family, diff)
      : accountApi.updateMyBadge(row.family, diff);
    work
      .then((saved) => {
        onSaved(saved);
        onClose();
      })
      .catch((err: unknown) => setError(apiErrorDetail(err) ?? 'Could not save the badge.'))
      .finally(() => setSaving(false));
  };

  const revoke = () => {
    if (!staff || !supplierId) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setSaving(true);
    setError(null);
    adminApi
      .revokeSupplierBadge(supplierId, row.family)
      .then(() => {
        onSaved(row);
        onClose();
      })
      .catch((err: unknown) => setError(apiErrorDetail(err) ?? 'Could not revoke the badge.'))
      .finally(() => setSaving(false));
  };

  return (
    <div
      className={styles.scrim}
      // mousedown, not click: a drag that STARTS inside the sheet and ends on
      // the scrim must not be read as "clicked outside".
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby="badge-editor-title">
        <div className={styles.bar}>
          <h2 className={styles.title} id="badge-editor-title">
            Founding distributor badge
          </h2>

          <label className={styles.control}>
            <span className={styles.controlLabel}>Appearance</span>
            <select
              ref={firstRef}
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

          <label className={styles.control}>
            <span className={styles.controlLabel}>Scheme</span>
            <select
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

          <span className={styles.barActions}>
            <button type="button" className={styles.btn} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={!dirty || saving}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {staff && (
              <>
                <label className={styles.control}>
                  <span className={styles.controlLabel}>Enabled</span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={draft.enabled}
                    onChange={(e) => set('enabled', e.target.checked)}
                  />
                </label>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnDanger}`}
                  disabled={saving}
                  onClick={revoke}
                >
                  {confirming ? 'Really revoke?' : 'Revoke'}
                </button>
              </>
            )}
          </span>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Color schemes</h3>
          <div className={styles.schemes}>
            {BADGE_SCHEMES.map((scheme) => (
              <button
                key={scheme}
                type="button"
                className={styles.swatch}
                aria-pressed={draft.scheme === scheme}
                onClick={() => set('scheme', scheme)}
              >
                <FounderBadge look={{ ...look, scheme }} size={64} />
                <span className={styles.swatchName}>{scheme}</span>
              </button>
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>On the boards</h3>
          <div className={styles.boards}>
            {BOARDS.map((b) => (
              <div key={b.id} className={`${styles.board} ${b.cls}`}>
                <span className={styles.boardName}>
                  {supplierName}
                  <FounderBadge look={look} size={b.pin} />
                </span>
                <span className={styles.boardTier}>{b.label}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
