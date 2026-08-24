import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { safeHttpUrl } from '@shared/utils/url';
import TierBannerRibbon, {
  SPONSOR_TIER_ELEMENT,
  type SponsorTierId,
} from '@public/components/widgets/TierBannerRibbon';
import { priceAt } from '../lib/priceBreaks';
import { priceSourceNote, priceSourceTone } from '../lib/priceSource';
import { formatUnit } from '../lib/format';
import type { BomOffer } from '../lib/types';
import styles from './AlternatesDropdown.module.scss';

/**
 * Every distributor that stocks this line, cheapest first — and the lever that
 * overrides our recommendation.
 *
 * The recommendation is a rule (`recommend()`, sponsor band +20%), not a
 * verdict: a buyer with an account at exactly one distributor wants THAT one's
 * price in the total, whatever the rule says. Pinning is purely client-side —
 * nothing about the choice is sent anywhere, and the row hands itself back to
 * `recommend()` the moment the pin is cleared.
 *
 * The popover MECHANICS are ported from the public category
 * `ColumnHeader.tsx`: portaled to <body> so the horizontally-scrolling table
 * cannot clip it, positioned `fixed` off the trigger rect, clamped to the
 * viewport, flipped above when there is no room below, and closed on
 * scroll/resize/outside-click/Escape. The mechanics are copied rather than
 * shared because the CONTENT has nothing in common with a sort-and-filter
 * pane — prop-bloating ColumnHeader to serve both would make one component
 * answer two unrelated questions.
 */

interface AlternatesDropdownProps {
  offers: BomOffer[];
  /** bom_qty x build_qty — every price in the list is read at this quantity. */
  lineQty: number;
  /** The offer the row is priced at right now (the pin, or the recommendation). */
  chosenSupplierId: string | null;
  /** What `recommend()` picked, so the list can say which row that is. */
  recommendedSupplierId: string | null;
  /** Pin a supplier for this row, or null to restore the recommendation. */
  onPick: (supplierId: string | null) => void;
  /** Part identity — the popover's accessible name. */
  partLabel: string;
}

export default function AlternatesDropdown({
  offers,
  lineQty,
  chosenSupplierId,
  recommendedSupplierId,
  onPick,
  partLabel,
}: AlternatesDropdownProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number }>({
    top: -9999,
    left: -9999,
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Outside-click / Escape close. The popover is portaled to <body>, so it is
  // NOT a DOM descendant of the trigger — both refs have to be checked, and
  // `contains()` throws on a non-Node argument, so guard the target first.
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

  // Position from the trigger rect, clamp to the viewport, flip above when
  // there is no room below. Right-aligned: the trigger lives in the table's
  // last column, so growing leftward is what keeps it on screen.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const pop = popoverRef.current;
      if (!trigger) return;
      const t = trigger.getBoundingClientRect();
      const pw = pop?.offsetWidth ?? 320;
      const ph = pop?.offsetHeight ?? 240;
      let left = t.right - pw;
      left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
      let top = t.bottom + 4;
      if (top + ph > window.innerHeight - 8 && t.top - ph - 4 > 8) {
        top = t.top - ph - 4;
      }
      // Still on screen when it fits neither below nor above (short window,
      // long offer list) — .list scrolls internally in that case.
      top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
      setCoords({ top, left });
    };
    place();
    // preventScroll: the popover is briefly offscreen at its placeholder
    // coords, and scrolling it into view would immediately fire onClose.
    popoverRef.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });

    const onClose = (e: Event) => {
      // e.target is `window` for window-level scrolls — not a Node — so the
      // instanceof guard has to come before contains().
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

  if (offers.length === 0) return null;

  // Cheapest first at the REAL line quantity — the ladder can reorder
  // suppliers between qty 1 and qty 1,000, and this list has to agree with the
  // price the row is showing. Deeper stock breaks a price tie.
  const ranked = [...offers].sort(
    (a, b) => priceAt(a, lineQty) - priceAt(b, lineQty) || b.stock_quantity - a.stock_quantity,
  );
  const pinned = chosenSupplierId != null && chosenSupplierId !== recommendedSupplierId;

  const pick = (supplierId: string | null) => {
    onPick(supplierId);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${pinned ? styles.triggerPinned : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.triggerCount}>{offers.length.toLocaleString('en-US')}</span>
        <span className={styles.triggerWord}>{offers.length === 1 ? 'offer' : 'offers'}</span>
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
            aria-label={`Distributor offers for ${partLabel}`}
            style={{ position: 'fixed', top: coords.top, left: coords.left }}
          >
            <div className={styles.head}>
              <span className={styles.headLabel}>
                Offers at {lineQty.toLocaleString('en-US')}
              </span>
              {pinned && (
                <button type="button" className={styles.reset} onClick={() => pick(null)}>
                  Use recommended
                </button>
              )}
            </div>

            <ul className={styles.list}>
              {ranked.map((offer) => {
                // A stored `website` is admin/feed input, so it goes through
                // safeHttpUrl — a javascript: value must become plain text,
                // never an href. Paid placement means rel="sponsored".
                const href = safeHttpUrl(offer.supplier_website);
                const isChosen = offer.supplier_id === chosenSupplierId;
                const isRecommended = offer.supplier_id === recommendedSupplierId;
                // Null when the wire carried no source (an old share link).
                const sourceNote = priceSourceNote(offer);
                return (
                  <li key={offer.supplier_id} className={styles.row}>
                    <button
                      type="button"
                      className={`${styles.option} ${isChosen ? styles.optionOn : ''}`}
                      aria-pressed={isChosen}
                      onClick={() => pick(offer.supplier_id)}
                    >
                      <span className={styles.optionTop}>
                        <span className={styles.name}>{offer.supplier_name}</span>
                        {(offer.tier === 'platinum' ||
                          offer.tier === 'gold' ||
                          offer.tier === 'silver') && (
                          <TierBannerRibbon
                            tier={offer.tier as SponsorTierId}
                            el={SPONSOR_TIER_ELEMENT[offer.tier as SponsorTierId]}
                            label={offer.tier}
                          />
                        )}
                        {isRecommended && <span className={styles.rec}>recommended</span>}
                      </span>
                      <span className={styles.optionBottom}>
                        <span className={styles.price}>{formatUnit(priceAt(offer, lineQty))}</span>
                        <span className={styles.stock}>
                          {offer.stock_quantity > 0
                            ? `${offer.stock_quantity.toLocaleString('en-US')} in stock`
                            : 'out of stock'}
                        </span>
                        {/* Same three-way as the table row, from the same
                            single home. The tone comes from priceSourceTone,
                            never from an inline `offer.price_source ===
                            'static'`: that comparison is false for undefined,
                            which is how the else-arm ends up printed against a
                            live distributor on a replayed share. */}
                        {sourceNote != null && (
                          <span
                            className={styles.priceSource}
                            data-source={priceSourceTone(offer)}
                          >
                            {sourceNote}
                          </span>
                        )}
                      </span>
                    </button>
                    {href != null ? (
                      <a
                        className={styles.visit}
                        href={href}
                        target="_blank"
                        rel="sponsored noopener noreferrer"
                      >
                        Visit&#8202;&#8599;
                      </a>
                    ) : (
                      <span className={styles.visitNone} aria-hidden="true">
                        &#8212;
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}
