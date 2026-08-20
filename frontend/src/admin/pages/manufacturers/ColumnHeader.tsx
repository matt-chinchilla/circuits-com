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
// The TH itself is the trigger AND the positioning container; the panel is
// absolutely positioned below it, which is why the page's `.panel` /
// `.tableWrap` must not clip (see ManufacturersPage.module.scss).

import { useEffect, useRef, useState } from 'react';

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

export default function ColumnHeader<K extends string>(props: ColumnHeaderProps<K>) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLTableCellElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      // `e.target instanceof Node` BEFORE .contains(): Node.contains(window)
      // throws, and a click landing on a non-Node target is not impossible.
      if (
        e.target instanceof Node &&
        containerRef.current &&
        !containerRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
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

      {open && (
        <div className={styles.columnPanel} role="dialog" aria-label={`${props.label} options`}>
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
        </div>
      )}
    </th>
  );
}
