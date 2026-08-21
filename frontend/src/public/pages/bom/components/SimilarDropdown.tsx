import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SimilarPart } from '../lib/types';
import styles from './SimilarDropdown.module.scss';

/**
 * The Matches column's "Similar" control (owner spec 2026-08-21): the badge
 * itself is the trigger, and the popover lists the matcher's ranked
 * runner-ups so the buyer can swap the prescribed part for a comparable one.
 *
 * Picking an option is a CLIENT decision that re-matches the line by the
 * chosen SKU — identity only travels, per D7. The popover mechanics mirror
 * AlternatesDropdown (portaled, fixed, clamped, flip-above, closed on
 * scroll/resize/outside-click/Escape) rather than sharing code with it: the
 * content has nothing in common, and this is the same copied-mechanics call
 * that component already documents.
 */

interface SimilarDropdownProps {
  options: SimilarPart[];
  /** The matched part currently standing in for the submitted one. */
  matchedSku: string | null;
  /** Why the matcher called this similar — shown under the header. */
  reason: string | null;
  /** The submitted identity — the popover's accessible name. */
  partLabel: string;
  onPick: (sku: string) => void;
}

export default function SimilarDropdown({
  options,
  matchedSku,
  reason,
  partLabel,
  onPick,
}: SimilarDropdownProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number }>({
    top: -9999,
    left: -9999,
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Outside-click / Escape. Portaled popover is not a descendant of the
  // trigger — check both refs, and guard the target before contains().
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Position off the trigger rect, clamp, flip above when there is no room.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const pop = popoverRef.current;
    if (!trigger) return;
    const t = trigger.getBoundingClientRect();
    const pw = pop?.offsetWidth ?? 300;
    const ph = pop?.offsetHeight ?? 220;
    let left = t.left;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    let top = t.bottom + 4;
    if (top + ph > window.innerHeight - 8 && t.top - ph - 4 > 8) {
      top = t.top - ph - 4;
    }
    top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
    setCoords({ top, left });
    popoverRef.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });

    const onClose = (e: Event) => {
      if (e.type === 'scroll' && e.target instanceof Node && popoverRef.current?.contains(e.target))
        return;
      setOpen(false);
    };
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [open]);

  const pick = (sku: string) => {
    onPick(sku);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={reason ?? undefined}
      onClick={() => setOpen((o) => !o)}
      >
        Similar
        <span className={styles.caret} aria-hidden="true">
          &#9662;
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className={styles.popover}
            role="dialog"
            aria-label={`Comparable options for ${partLabel}`}
            style={{ position: 'fixed', top: coords.top, left: coords.left }}
          >
            <div className={styles.head}>
              <span className={styles.headLabel}>Comparable to {partLabel}</span>
              {reason != null && <span className={styles.reason}>{reason}</span>}
            </div>
            <ul className={styles.list}>
              {options.map((opt) => (
                <li key={opt.id}>
                  <button
                    type="button"
                    className={styles.option}
                    onClick={() => pick(opt.sku)}
                  >
                    <span className={styles.optSku}>{opt.sku}</span>
                    <span className={styles.optMeta}>
                      {opt.manufacturer_name ?? 'Unknown manufacturer'}
                      {opt.package != null ? ` · ${opt.package}` : ''}
                      {/* Honesty rule: unverified never reads as Active. */}
                      {opt.lifecycle_verified
                        ? ` · ${opt.lifecycle_status ?? ''}`
                        : ' · lifecycle unverified'}
                    </span>
                    {opt.description != null && (
                      <span className={styles.optDesc}>{opt.description}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {matchedSku != null && (
              <div className={styles.foot}>
                Currently matched: <strong>{matchedSku}</strong>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
