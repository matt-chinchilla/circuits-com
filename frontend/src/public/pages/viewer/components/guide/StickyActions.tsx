// The drop card's two buttons — "Choose files" and "Try the example project" —
// kept on screen at every scroll position (owner: they "need to ALWAYS be
// visible on the screen").
//
// There is ONE pair, never a copy. While the buttons' place on the card is in
// view they sit there; the moment any of that place leaves the viewport (or
// slides under the sticky navbar) the SAME row docks to the bottom of the
// screen, and its place on the card keeps its height so nothing below moves.
// One element means one tab stop per button, the same handlers, the busy state
// for free, focus that survives the dock, and a reading order that never
// changes for a screen reader.
//
// Docked, the row is a torn-off corner of the sheet — white, the PCB grid, the
// crop marks — and it is still INSIDE the drop zone's DOM, so a file dragged
// onto it lands in the same react-dropzone root (desktop says so; a phone,
// which has no drag and drop, shows only the buttons, full width, clear of the
// home indicator). A spacer at the end of the document gives the page back the
// height the bar covers, so the footer's last line can still scroll clear, and
// the root's scroll-padding-bottom reserves the same strip, so a control Tab
// scrolls into view lands above the bar, never under it (WCAG 2.4.11).
//
// The workspace replaces the whole intake when a project opens, so the bar is
// unmounted with it and can never show over the workspace.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '@shared/components/Icon';
import pageStyles from '../../ViewerPage.module.scss';
import styles from './StickyActions.module.scss';

interface Props {
  /** The slot's class on the card (its margins and its order in each layout). */
  className: string;
  busy: boolean;
  /** A drag is over the drop zone: the docked bar lights the way the sheet does. */
  dragActive: boolean;
  onChoose: () => void;
  onExample: () => void;
}

/** "Fully in view" — a sub-pixel short of 1 still counts. */
export const FULLY_IN_VIEW = 0.99;

/** The sticky navbar's bottom edge: a row under it is covered, not visible. */
export function stickyTopInset(): number {
  if (typeof document === 'undefined') return 0;
  for (const el of document.querySelectorAll('header')) {
    const pos = getComputedStyle(el).position;
    if (pos === 'sticky' || pos === 'fixed') return Math.max(0, Math.round(el.getBoundingClientRect().bottom));
  }
  return 0;
}

/**
 * How much of the viewport's bottom the docked row covers: its height plus its
 * `bottom` inset — both LAYOUT values. The row's box is not: for the dock's
 * first 0.2s the dockIn animation holds it translateY(10px) low, and a box read
 * then came out 10px short for the whole dock.
 */
export function barCover(row: HTMLElement): number {
  const bottom = Number.parseFloat(getComputedStyle(row).bottom);
  return Math.max(0, Math.ceil(row.offsetHeight + (Number.isFinite(bottom) ? bottom : 0)));
}

/** Room left above the bar for a focused control's outline. */
export const FOCUS_CLEARANCE = 8;

/**
 * The height the row would have back in the flow at the slot's CURRENT width —
 * read off a hidden, undocked copy laid out inside the slot, so the real row
 * never leaves the dock (which would replay its entrance) to be measured.
 */
function inFlowHeight(slot: HTMLElement, row: HTMLElement): number {
  const probe = row.cloneNode(true) as HTMLElement;
  probe.removeAttribute('data-docked');
  probe.removeAttribute('data-drag');
  probe.setAttribute('aria-hidden', 'true');
  probe.setAttribute('inert', '');
  // The slot's own width: its positioned ancestor is the whole sheet.
  probe.style.cssText = `position:absolute;width:${slot.clientWidth}px;visibility:hidden;pointer-events:none;`;
  slot.append(probe);
  const height = probe.offsetHeight;
  probe.remove();
  return height;
}

export default function StickyActions({ className, busy, dragActive, onChoose, onExample }: Props) {
  const slotRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState(false);
  const dockedRef = useRef(false);
  const [spacer, setSpacer] = useState(0);

  useEffect(() => {
    const slot = slotRef.current;
    if (slot == null || typeof IntersectionObserver === 'undefined') return;
    let io: IntersectionObserver | null = null;
    let inset = -1;

    const dock = (next: boolean) => {
      if (next === dockedRef.current) return;
      const row = rowRef.current;
      // Hold the row's place BEFORE it leaves the flow: the slot must not
      // collapse, or the card would shift and the observer would flip back.
      if (next && row != null) slot.style.height = `${row.offsetHeight}px`;
      if (!next) slot.style.height = '';
      dockedRef.current = next;
      setDocked(next);
    };

    const observe = () => {
      const top = stickyTopInset();
      if (top === inset) return;
      inset = top;
      io?.disconnect();
      io = new IntersectionObserver(
        (entries) => {
          // One callback can carry several frames' records for the slot, oldest
          // first: only the LAST says where it is now (reading the first left
          // the bar docked over a card whose buttons were back in view).
          const entry = entries[entries.length - 1];
          dock(!(entry.isIntersecting && entry.intersectionRatio >= FULLY_IN_VIEW));
        },
        { rootMargin: `-${top}px 0px 0px 0px`, threshold: [0, FULLY_IN_VIEW, 1] },
      );
      io.observe(slot);
    };

    // The navbar is taller on a phone, and a width change (a rotation, a
    // resized window) re-wraps the buttons: while docked, the place held on the
    // card follows the height the row WOULD have there now, or the card would
    // shift when it undocks (and a stale, shorter place could undock a row
    // that no longer fits, which then docks again).
    const onResize = () => {
      observe();
      const row = rowRef.current;
      if (dockedRef.current && row != null) slot.style.height = `${inFlowHeight(slot, row)}px`;
    };

    observe();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      io?.disconnect();
      slot.style.height = '';
    };
  }, []);

  // While docked, the page reserves the strip the bar covers: the document
  // grows by exactly that much (the spacer), and the root's scroll padding
  // keeps whatever the browser scrolls into view — a Tab, a find-in-page —
  // above the bar. Both go when it undocks or the intake unmounts.
  useLayoutEffect(() => {
    if (!docked) {
      setSpacer(0);
      return;
    }
    const root = document.documentElement;
    const measure = () => {
      const row = rowRef.current;
      if (row == null) return;
      const cover = barCover(row);
      setSpacer(cover);
      root.style.scrollPaddingBottom = `${cover + FOCUS_CLEARANCE}px`;
    };
    measure();
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      root.style.scrollPaddingBottom = '';
    };
  }, [docked]);

  return (
    <div ref={slotRef} className={className}>
      <div
        ref={rowRef}
        className={styles.row}
        data-docked={docked ? 'true' : undefined}
        data-drag={docked && dragActive ? 'true' : undefined}
      >
        <span className={`${styles.crop} ${styles.cropTl}`} aria-hidden="true" />
        <span className={`${styles.crop} ${styles.cropTr}`} aria-hidden="true" />
        <span className={`${styles.crop} ${styles.cropBl}`} aria-hidden="true" />
        <span className={`${styles.crop} ${styles.cropBr}`} aria-hidden="true" />
        <span className={styles.lead} aria-hidden="true">
          <Icon name="tray-arrow-down" className={styles.leadGlyph} />
          {dragActive ? 'Drop the project here' : 'Drop your KiCad project here, or'}
        </span>
        <button type="button" className={`${pageStyles.dropBtn} ${styles.btn}`} onClick={onChoose} disabled={busy}>
          {busy ? 'Reading…' : 'Choose files'}
        </button>
        <button
          type="button"
          className={`${pageStyles.exampleBtn} ${styles.btn} ${styles.example}`}
          onClick={onExample}
          disabled={busy}
        >
          {/* One flex item: a flex row would trim the space before "project". */}
          <span>
            Try the example<span className={styles.tail}> project</span>
          </span>
        </button>
      </div>
      {spacer > 0 &&
        createPortal(<div className={styles.spacer} style={{ height: spacer }} aria-hidden="true" />, document.body)}
    </div>
  );
}
