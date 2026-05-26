import { useState, useEffect, useRef } from 'react';
import styles from './ColumnHeader.module.scss';

export interface SortState {
  col: string;
  dir: 'asc' | 'desc';
}

interface ColumnHeaderProps {
  label: string;
  sortKey: string;
  numeric?: boolean;
  mobileHide?: boolean;
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
  label, sortKey, numeric, mobileHide,
  sort, setSort,
  hasSearch, search, setSearch,
  filterValues, filterSelected, setFilterSelected,
}: ColumnHeaderProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLTableCellElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isActive = sort.col === sortKey;
  const sortDir = isActive ? sort.dir : null;
  const hasFilter = filterValues && filterSelected && filterSelected.size < filterValues.length;
  const hasActiveSearch = hasSearch && search && search.trim().length > 0;

  const ariaSort: 'ascending' | 'descending' | 'none' =
    sortDir === 'asc' ? 'ascending' : sortDir === 'desc' ? 'descending' : 'none';

  return (
    <th
      ref={ref}
      className={`${styles.colHead} ${isActive ? styles.colHeadActive : ''} ${mobileHide ? styles.mobileHide : ''} ${numeric ? styles.numeric : ''}`}
      aria-sort={ariaSort}
    >
      <button
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
      {open && (
        <div className={`${styles.popover} ${numeric ? styles.popoverRight : ''}`} role="dialog" aria-label={`${label} sort and filter`}>
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
                autoFocus
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
        </div>
      )}
    </th>
  );
}
