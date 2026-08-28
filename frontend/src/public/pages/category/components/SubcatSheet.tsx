import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import Icon from '@shared/components/Icon';
import { categoryPath } from '@shared/utils/categoryPath';
import type { Subcategory } from '@public/types/category';
import styles from './SubcatSheet.module.scss';

// Mobile subcategory picker — the adaptive bottom-sheet pattern (NN/g: >15
// items need a dedicated surface; Material 3 caps chip wrap at 2 rows; the
// owner rejected both wrapping and swiping). Families with more than 6
// subcategories collapse the sticky bar to this 44px trigger; the sheet is a
// dense one-column index with part counts, "All parts in <family>" pinned
// first (Baymard). Rows stay real <Link>s — one-tap navigation preserved.
// Desktop never sees any of this (the trigger is display:none above mobile).

interface SubcatSheetProps {
  familyName: string;
  familySlug: string;
  subcategories: Subcategory[];
  /** Active child slug; null on the parent ("All") page. */
  activeSlug: string | null;
  /**
   * Per-subcategory counts from the server's facets (parent page only, and
   * narrowed by whatever filters are active); falls back to the category's own
   * `parts_count` when the map has no entry — which is every leaf page, where
   * the facets describe the leaf rather than the family.
   */
  counts?: Map<string, number>;
  /** The family's unfiltered size. NULL on a leaf, which cannot know it. */
  totalParts?: number | null;
}

export default function SubcatSheet({
  familyName,
  familySlug,
  subcategories,
  activeSlug,
  counts,
  totalParts,
}: SubcatSheetProps) {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  // The house drawer state machine: route-change auto-close, Esc while
  // open, body scroll-lock while open (mirrors Navbar/AdminLayout).
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const active = activeSlug
    ? subcategories.find((s) => s.slug === activeSlug) ?? null
    : null;
  const countFor = (s: Subcategory): number | null =>
    counts?.get(s.slug) ?? s.parts_count ?? null;

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className={styles.triggerIcon} aria-hidden="true">
          <Icon name={active?.icon ?? 'squares-four'} />
        </span>
        <span className={styles.triggerLabel}>
          {active ? active.name : `All ${familyName}`}
        </span>
        <span className={styles.triggerMeta}>
          {subcategories.length} subs <span aria-hidden="true">&#9662;</span>
        </span>
      </button>

      {open &&
        createPortal(
          <div
            className={styles.scrim}
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <div
              className={styles.sheet}
              role="dialog"
              aria-modal="true"
              aria-label={`${familyName} subcategories`}
            >
              <span className={styles.grabber} aria-hidden="true" />
              <div className={styles.sheetHead}>
                <span className={styles.sheetTitle}>
                  {familyName} &middot; {subcategories.length} subcategories
                </span>
                <button
                  type="button"
                  className={styles.close}
                  onClick={() => setOpen(false)}
                  aria-label="Close subcategory picker"
                >
                  &#10005;
                </button>
              </div>
              <nav className={styles.list} aria-label="Subcategories">
                <Link
                  to={categoryPath(familySlug)}
                  className={`${styles.row} ${styles.rowAll} ${!activeSlug ? styles.rowActive : ''}`}
                  aria-current={!activeSlug ? 'page' : undefined}
                >
                  <span className={styles.rowIcon} aria-hidden="true">
                    <Icon name="squares-four" />
                  </span>
                  <span className={styles.rowName}>All parts in {familyName}</span>
                  {totalParts != null && totalParts > 0 && (
                    <span className={styles.rowCount}>{totalParts.toLocaleString()}</span>
                  )}
                </Link>
                {subcategories.map((s) => {
                  const n = countFor(s);
                  return (
                    <Link
                      key={s.slug}
                      to={categoryPath(s.slug, familySlug)}
                      className={`${styles.row} ${s.slug === activeSlug ? styles.rowActive : ''}`}
                      aria-current={s.slug === activeSlug ? 'page' : undefined}
                    >
                      <span className={styles.rowIcon} aria-hidden="true">
                        <Icon name={s.icon} />
                      </span>
                      <span className={styles.rowName}>{s.name}</span>
                      {n != null && n > 0 && (
                        <span className={styles.rowCount}>{n.toLocaleString()}</span>
                      )}
                    </Link>
                  );
                })}
              </nav>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
