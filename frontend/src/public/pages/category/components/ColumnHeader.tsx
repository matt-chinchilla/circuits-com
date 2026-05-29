import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import styles from './ColumnHeader.module.scss';

export interface SortState {
  col: string;
  dir: 'asc' | 'desc';
}

interface ColumnHeaderProps {
  label: string;
  sortKey: string;
  numeric?: boolean;
  hideClass?: string;
  sort: SortState;
  setSort: (s: SortState) => void;
  hasSearch?: boolean;
  search?: string;
  setSearch?: (v: string) => void;
  filterValues?: string[];
  filterSelected?: Set<string>;
  setFilterSelected?: (v: Set<string>) => void;
}

export default function ColumnHeader({
  label, sortKey, numeric, hideClass,
  sort, setSort,
  hasSearch, search, setSearch,
  filterValues, filterSelected, setFilterSelected,
}: ColumnHeaderProps) {
  const [open, setOpen] = useState(false);
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

  const isActive = sort.col === sortKey;
  const sortDir = isActive ? sort.dir : null;
  const hasFilter = filterValues && filterSelected && filterSelected.size < filterValues.length;
  const hasActiveSearch = hasSearch && search && search.trim().length > 0;

  const ariaSort: 'ascending' | 'descending' | 'none' =
    sortDir === 'asc' ? 'ascending' : sortDir === 'desc' ? 'descending' : 'none';

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
        onClick={() => setOpen(o => !o)}
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
            <div className={styles.sectionLabel}>Sort</div>
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
                placeholder={`Search ${label.toLowerCase()}…`}
                value={search ?? ''}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          )}

          {filterValues && filterValues.length > 0 && filterSelected && setFilterSelected && (
            <div className={styles.section}>
              <div className={styles.sectionHead}>
                <span className={styles.sectionLabel}>Filter</span>
                <button type="button" className={styles.link} onClick={() => setFilterSelected(new Set(filterValues))}>All</button>
                <button type="button" className={styles.link} onClick={() => setFilterSelected(new Set())}>None</button>
              </div>
              <div className={styles.filterList}>
                {filterValues.map(v => (
                  <label key={v} className={styles.filterRow}>
                    <input
                      type="checkbox"
                      checked={filterSelected.has(v)}
                      onChange={e => {
                        const next = new Set(filterSelected);
                        if (e.target.checked) next.add(v); else next.delete(v);
                        setFilterSelected(next);
                      }}
                    />
                    <span className={styles.filterLabel}>{v}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>,
        document.body
      )}
    </th>
  );
}
