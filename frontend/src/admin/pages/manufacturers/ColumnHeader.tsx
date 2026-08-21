// Column header: sort + filter in one dropdown (the admin "Excel" pattern).
//
// COPIED, deliberately, from pages/sponsors/list/index.tsx — the var(--a-*)
// token variant, not the PartsPage one that reads local $a-* SCSS vars. Not
// extracted into a shared component: the sponsors page is a single-writer file
// this lane may not touch, and the two pages already differ where it matters
// (sponsors filters CLIENT-side over a fully-loaded row set; this list is
// SERVER-paginated, so a checkbox multi-select over "all values" is not even
// representable — the server takes one `source` and one `linked`). The kinds
// kept here are exactly the two this list can honour:
//
//   sort-only      — sort asc/desc/clear, no filter section
//   single-choice  — sort + a radio-ish list, one value at a time
//
// The panel PORTALS to document.body with fixed positioning (review findings
// R3/R4 follow-through): the in-flow absolute panel forced the whole overflow
// strategy — the wrapper couldn't scroll without clipping it, which left the
// 821–1100px band with NO scroll container and made ≤820px clip the panel
// inside the scrolling table. Portaled, `.tableWrap { overflow-x: auto }` is
// safe at EVERY width. Mechanics ported from the public category ColumnHeader
// (porting is allowed; importing across the eslint boundary is not).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import styles from './ColumnHeader.module.scss';

export type SortDir = 'asc' | 'desc' | null;

export interface ChoiceOption {
  key: string;
  label: string;
}

interface ColumnHeaderBase<K extends string> {
  label: string;
  colKey: K;
  activeKey: K | null;
  dir: SortDir;
  onSort: (key: K, dir: SortDir) => void;
  sortLabels: { asc: string; desc: string };
}

export type ColumnHeaderProps<K extends string> =
  | (ColumnHeaderBase<K> & { kind: 'sort-only' })
  | (ColumnHeaderBase<K> & {
      kind: 'single-choice';
      choices: readonly ChoiceOption[];
      /** The key that means "no filter" — drives the filtered dot. */
      neutralKey: string;
      value: string;
      onChange: (next: string) => void;
    });

const PANEL_WIDTH = 240;
const PANEL_MARGIN = 8;

export default function ColumnHeader<K extends string>(props: ColumnHeaderProps<K>) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLTableCellElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);

  // Fixed-position the portal from the trigger rect: clamp to the viewport,
  // flip above when there's no room below.
  useLayoutEffect(() => {
    if (!open || !containerRef.current) return;
    const r = containerRef.current.getBoundingClientRect();
    const left = Math.max(
      PANEL_MARGIN,
      Math.min(r.left, window.innerWidth - PANEL_WIDTH - PANEL_MARGIN),
    );
    const panelH = panelRef.current?.offsetHeight ?? 280;
    const up = r.bottom + panelH + PANEL_MARGIN > window.innerHeight && r.top > panelH;
    setPos({ top: up ? r.top - 4 : r.bottom + 4, left, up });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      // `e.target instanceof Node` BEFORE .contains(): Node.contains(window)
      // throws, and a click landing on a non-Node target is not impossible.
      // The portaled panel counts as inside.
      if (
        e.target instanceof Node &&
        containerRef.current &&
        !containerRef.current.contains(e.target) &&
        !(panelRef.current && panelRef.current.contains(e.target))
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // Close on any scroll/resize EXCEPT scrolls inside the panel itself —
    // a fixed panel would detach from its column, so it goes away instead.
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const isSortActive = props.activeKey === props.colKey && props.dir !== null;
  const hasFilter = props.kind === 'single-choice' && props.value !== props.neutralKey;

  const cls = [styles.columnHeader, isSortActive || hasFilter ? styles.columnHeaderActive : '']
    .filter(Boolean)
    .join(' ');

  const sortGlyph = isSortActive ? (props.dir === 'asc' ? '▲' : '▼') : '▾';

  return (
    <th
      ref={containerRef}
      className={cls}
      aria-sort={isSortActive ? (props.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className={styles.columnTrigger}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className={styles.columnLabel}>{props.label}</span>
        <span className={styles.columnIndicators} aria-hidden="true">
          {hasFilter && <span className={styles.filterDot}>&#9679;</span>}
          <span
            className={`${styles.sortIndicator} ${isSortActive ? styles.sortIndicatorActive : ''}`}
          >
            {sortGlyph}
          </span>
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            className={styles.columnPanel}
            role="dialog"
            aria-label={`${props.label} options`}
            style={{
              top: pos && !pos.up ? pos.top : undefined,
              bottom: pos?.up ? window.innerHeight - pos.top : undefined,
              left: pos?.left ?? -9999,
            }}
          >
          <div className={styles.panelSection}>
            <div className={styles.sectionLabel}>Sort</div>
            <button
              type="button"
              className={`${styles.panelBtn} ${isSortActive && props.dir === 'asc' ? styles.panelBtnActive : ''}`}
              onClick={() => {
                props.onSort(props.colKey, 'asc');
                setOpen(false);
              }}
            >
              <span className={styles.panelBtnGlyph}>&#8593;</span>
              <span>{props.sortLabels.asc}</span>
            </button>
            <button
              type="button"
              className={`${styles.panelBtn} ${isSortActive && props.dir === 'desc' ? styles.panelBtnActive : ''}`}
              onClick={() => {
                props.onSort(props.colKey, 'desc');
                setOpen(false);
              }}
            >
              <span className={styles.panelBtnGlyph}>&#8595;</span>
              <span>{props.sortLabels.desc}</span>
            </button>
            {isSortActive && (
              <button
                type="button"
                className={`${styles.panelBtn} ${styles.panelBtnClear}`}
                onClick={() => {
                  props.onSort(props.colKey, null);
                  setOpen(false);
                }}
              >
                <span className={styles.panelBtnGlyph}>&#215;</span>
                <span>Clear sort</span>
              </button>
            )}
          </div>

          {props.kind === 'single-choice' && (
            <>
              <div className={styles.sectionDivider} />
              <div className={styles.panelSection}>
                <div className={styles.sectionLabel}>Filter</div>
                <ul className={styles.choiceList}>
                  {props.choices.map((c) => (
                    <li key={c.key}>
                      <button
                        type="button"
                        className={`${styles.choiceOption} ${c.key === props.value ? styles.choiceOptionActive : ''}`}
                        onClick={() => {
                          props.onChange(c.key);
                          setOpen(false);
                        }}
                      >
                        {c.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
          </div>,
          document.body,
        )}
    </th>
  );
}
