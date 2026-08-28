import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { SortDir, SortKey } from '@public/services/categoryQuery';
import styles from './ColumnHeader.module.scss';

export interface SortState {
  /**
   * `null` = the SERVER's default ordering for this scope (leaf → sku asc,
   * parent → popular desc). No header paints an active arrow in that state,
   * because the page would otherwise be claiming an order it isn't asking for.
   */
  col: SortKey | null;
  dir: SortDir;
}

/**
 * One filter checkbox. `value` is what travels in the URL (a manufacturer NAME
 * or a subcategory SLUG); `label` is what the reader sees. `count` comes from
 * the server's facets — computed with every filter applied except this
 * column's own, so the list never collapses to the current selection.
 */
export interface FilterOption {
  value: string;
  label: string;
  count?: number | null;
}

interface ColumnHeaderProps {
  label: string;
  sortKey: SortKey;
  numeric?: boolean;
  hideClass?: string;
  sort: SortState;
  setSort: (s: SortState) => void;
  hasSearch?: boolean;
  search?: string;
  setSearch?: (v: string) => void;
  filterOptions?: FilterOption[];
  filterSelected?: Set<string>;
  setFilterSelected?: (v: Set<string>) => void;
}

// The option list is now the COMPLETE server-side facet list, not the
// manufacturers that happened to be in 500 loaded rows — on a big category
// that is hundreds of entries. Above this many we offer a type-to-narrow box
// (and render at most VISIBLE_CAP rows, so opening the popover can't stall).
const SEARCHABLE_FROM = 12;
const VISIBLE_CAP = 150;

export default function ColumnHeader({
  label, sortKey, numeric, hideClass,
  sort, setSort,
  hasSearch, search, setSearch,
  filterOptions, filterSelected, setFilterSelected,
}: ColumnHeaderProps) {
  const [open, setOpen] = useState(false);
  const [optionQuery, setOptionQuery] = useState('');
  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });
  const thRef = useRef<HTMLTableCellElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Outside-click / Escape close. The popover is portaled to <body>, so it is
  // NOT a DOM descendant of the th — check both refs before closing.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (thRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
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

  // Position the portaled popover from the trigger rect, clamped to the
  // viewport, flipping above if there is no room below. Close on scroll/resize
  // rather than tracking — the table itself scrolls horizontally, so a moving
  // anchor would otherwise drift.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const pop = popoverRef.current;
      if (!trigger) return;
      const t = trigger.getBoundingClientRect();
      const pw = pop?.offsetWidth ?? 280;
      const ph = pop?.offsetHeight ?? 200;
      let left = numeric ? t.right - pw : t.left;
      left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
      let top = t.bottom + 4;
      if (top + ph > window.innerHeight - 8 && t.top - ph - 4 > 8) {
        top = t.top - ph - 4;
      }
      // Keep the popover on-screen even when it fits neither below nor above
      // (short window / tall filter list); .popover scrolls internally then.
      top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
      setCoords({ top, left });
    };
    place();
    // Move focus into the dialog. preventScroll stops the browser scrolling the
    // (briefly offscreen) popover into view, which would otherwise fire onClose.
    popoverRef.current?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });

    // Close on page/table scroll or resize so the fixed popover can't drift from
    // its anchor — but ignore scrolls inside the popover's own filter list.
    const onClose = (e: Event) => {
      // e.target is `window` for window-level scrolls — not a Node, so guard
      // before contains() (which throws on non-Node args).
      if (e.type === 'scroll' && e.target instanceof Node && popoverRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [open, numeric]);

  const options = filterOptions ?? [];
  const hasOptions = options.length > 0 && filterSelected != null && setFilterSelected != null;

  const shownOptions = useMemo(() => {
    const needle = optionQuery.trim().toLowerCase();
    const matches = needle
      ? options.filter(o => o.label.toLowerCase().includes(needle))
      : options;
    return { rows: matches.slice(0, VISIBLE_CAP), hidden: Math.max(0, matches.length - VISIBLE_CAP) };
  }, [options, optionQuery]);

  const isActive = sort.col === sortKey;
  const sortDir = isActive ? sort.dir : null;
  // A checked box IS the filter: nothing checked means no param and every row.
  // (The page used to pre-check every option, back when the options were
  // whatever the 500 loaded rows contained. This list is the complete server
  // facet now — see the note beside `mfgSelected` in the page.)
  const hasFilter = hasOptions && filterSelected.size > 0;
  const hasActiveSearch = hasSearch && search != null && search.trim().length > 0;

  const ariaSort: 'ascending' | 'descending' | 'none' =
    sortDir === 'asc' ? 'ascending' : sortDir === 'desc' ? 'descending' : 'none';

  const toggleOpen = () => {
    setOpen(o => {
      if (!o) setOptionQuery('');
      return !o;
    });
  };

  return (
    <th
      ref={thRef}
      className={`${styles.colHead} ${isActive ? styles.colHeadActive : ''} ${hideClass ?? ''} ${numeric ? styles.numeric : ''}`}
      aria-sort={ariaSort}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        <span className={styles.label}>{label}</span>
        <span className={styles.indicators} aria-hidden="true">
          {(hasFilter || hasActiveSearch) && <span className={styles.dot} title="Filter active" />}
          <span className={`${styles.sortIcon} ${isActive ? styles.sortIconActive : ''}`}>
            {sortDir === 'desc' ? '▼' : '▲'}
          </span>
        </span>
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          className={styles.popover}
          role="dialog"
          aria-label={`${label} sort and filter`}
          style={{ position: 'fixed', top: coords.top, left: coords.left }}
        >
          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>Sort</span>
              {isActive && (
                // The only way back to the server's own ordering — which on a
                // parent page is the popularity rollup, not sku asc.
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => { setSort({ col: null, dir: 'asc' }); setOpen(false); }}
                >
                  Default order
                </button>
              )}
            </div>
            <div className={styles.sortRow}>
              <button
                type="button"
                className={`${styles.sortBtn} ${sortDir === 'asc' ? styles.sortBtnOn : ''}`}
                onClick={() => { setSort({ col: sortKey, dir: 'asc' }); setOpen(false); }}
              >
                <span className={styles.sortArrow}>{'▲'}</span>
                {numeric ? 'Lowest first' : 'A → Z'}
              </button>
              <button
                type="button"
                className={`${styles.sortBtn} ${sortDir === 'desc' ? styles.sortBtnOn : ''}`}
                onClick={() => { setSort({ col: sortKey, dir: 'desc' }); setOpen(false); }}
              >
                <span className={styles.sortArrow}>{'▼'}</span>
                {numeric ? 'Highest first' : 'Z → A'}
              </button>
            </div>
          </div>

          {hasSearch && setSearch && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>Search</div>
              <input
                type="search"
                className={styles.searchInput}
                placeholder={`Search ${label.toLowerCase()} or description…`}
                value={search ?? ''}
                // The server 422s q past 120 chars; the writer clamps too, but
                // the input should not let a pasted description overrun it.
                maxLength={120}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          )}

          {hasOptions && (
            <div className={styles.section}>
              <div className={styles.sectionHead}>
                <span className={styles.sectionLabel}>Filter</span>
                {/* One link, not the old All/None pair — "all checked" and
                    "none checked" now mean the same thing on the wire (an
                    absent param), so Clear is the only distinct action.
                    Narrowing a long list is what the box below is for. */}
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => setFilterSelected(new Set())}
                  disabled={!hasFilter}
                >
                  Clear
                </button>
              </div>
              {options.length > SEARCHABLE_FROM && (
                <input
                  type="search"
                  className={`${styles.searchInput} ${styles.optionSearch}`}
                  placeholder={`Find ${label.toLowerCase()}…`}
                  value={optionQuery}
                  onChange={e => setOptionQuery(e.target.value)}
                  aria-label={`Narrow the ${label.toLowerCase()} list`}
                />
              )}
              <div className={styles.filterList}>
                {shownOptions.rows.map(option => (
                  <label key={option.value} className={styles.filterRow}>
                    <input
                      type="checkbox"
                      checked={filterSelected.has(option.value)}
                      onChange={e => {
                        const next = new Set(filterSelected);
                        if (e.target.checked) next.add(option.value);
                        else next.delete(option.value);
                        setFilterSelected(next);
                      }}
                    />
                    <span className={styles.filterLabel}>{option.label}</span>
                    {option.count != null && (
                      <span className={styles.filterCount}>{option.count.toLocaleString()}</span>
                    )}
                  </label>
                ))}
                {shownOptions.rows.length === 0 && (
                  <p className={styles.filterNote}>No match.</p>
                )}
              </div>
              {shownOptions.hidden > 0 && (
                <p className={styles.filterNote}>
                  {shownOptions.hidden.toLocaleString()} more &mdash; keep typing to narrow.
                </p>
              )}
            </div>
          )}
        </div>,
        document.body
      )}
    </th>
  );
}
