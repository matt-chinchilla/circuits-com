import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Plus, Upload, Download, Search } from 'lucide-react';
import { useDemo } from '@admin/contexts/DemoContext';
import { adminApi } from '@admin/services/adminApi';
import Icon from '@shared/components/Icon';
import type { Part, PaginatedResponse } from '@admin/types/admin';
import styles from './PartsPage.module.scss';

// ─── Lifecycle filter chips ────────────────────────────────────────────────

const FILTERS: Array<{ key: 'all' | 'active' | 'nrnd' | 'obsolete'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'nrnd', label: 'NRND' },
  { key: 'obsolete', label: 'Obsolete' },
];

type SortDir = 'asc' | 'desc' | null;
type SortKey = 'sku' | 'description' | 'manufacturer' | 'category' | 'best' | 'stock' | 'status';

type BestBucket = 'any' | 'lt1' | '1to10' | '10to100' | 'gte100';
type StockBucket = 'any' | '1to9' | '10to99' | '100to999' | '1kto9k' | 'gte10k';

const BEST_BUCKETS: Array<{ key: BestBucket; label: string }> = [
  { key: 'any', label: 'Any price' },
  { key: 'lt1', label: '< $1' },
  { key: '1to10', label: '$1 – $10' },
  { key: '10to100', label: '$10 – $100' },
  { key: 'gte100', label: '$100+' },
];

const STOCK_BUCKETS: Array<{ key: StockBucket; label: string }> = [
  { key: 'any', label: 'Any stock' },
  { key: '1to9', label: '1 – 9' },
  { key: '10to99', label: '10 – 99' },
  { key: '100to999', label: '100 – 999' },
  { key: '1kto9k', label: '1,000 – 9,999' },
  { key: 'gte10k', label: '10,000+' },
];

// ─── Lifecycle status badge ────────────────────────────────────────────────

function lifecycleBadge(status: string) {
  const lower = status.toLowerCase();
  let cls = styles.statusActive;
  if (lower === 'nrnd') cls = styles.statusNrnd;
  else if (lower === 'obsolete') cls = styles.statusObsolete;
  return <span className={`${styles.statusBadge} ${cls}`}>{status}</span>;
}

function partCategoryLabel(p: Part): string {
  return p.parent_category_name ?? p.category_name ?? '';
}

function bestPriceOf(p: Part): number | null {
  return p.best_price;
}

function totalStockOf(p: Part): number | null {
  return p.total_stock;
}

function inBestBucket(price: number | null, bucket: BestBucket): boolean {
  if (bucket === 'any') return true;
  if (price == null) return false;
  if (bucket === 'lt1') return price < 1;
  if (bucket === '1to10') return price >= 1 && price < 10;
  if (bucket === '10to100') return price >= 10 && price < 100;
  return price >= 100;
}

function inStockBucket(stock: number | null, bucket: StockBucket): boolean {
  if (bucket === 'any') return true;
  if (stock == null) return false;
  if (bucket === '1to9') return stock >= 1 && stock < 10;
  if (bucket === '10to99') return stock >= 10 && stock < 100;
  if (bucket === '100to999') return stock >= 100 && stock < 1000;
  if (bucket === '1kto9k') return stock >= 1000 && stock < 10_000;
  return stock >= 10_000;
}

// Nulls-last comparator helper for numeric columns.
function cmpNumberNullsLast(a: number | null, b: number | null, dir: 'asc' | 'desc'): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return dir === 'asc' ? a - b : b - a;
}

function cmpText(a: string, b: string, dir: 'asc' | 'desc'): number {
  const r = a.localeCompare(b, undefined, { sensitivity: 'base' });
  return dir === 'asc' ? r : -r;
}

// ─── Column header: unified sort + filter dropdown (Excel pattern) ─────────
//
// Each column owns its own sort + filter contract. Clicking the header opens
// a panel with: (1) Sort section — A→Z / Z→A buttons + Clear, (2) Filter
// section — checkbox list (text-multi) or radio list (bucket-numeric), or
// nothing (sort-only). The TH itself is the trigger; the panel is positioned
// absolutely below it.

interface SortLabels {
  asc: string;
  desc: string;
}

interface ColumnHeaderBase {
  label: string;
  colKey: SortKey;
  activeKey: SortKey | null;
  dir: SortDir;
  onSort: (key: SortKey, dir: SortDir) => void;
  sortLabels: SortLabels;
  className?: string;
  numeric?: boolean;
}

type ColumnHeaderProps =
  | (ColumnHeaderBase & { kind: 'sort-only' })
  | (ColumnHeaderBase & {
      kind: 'text-multi';
      options: string[];
      selected: string[];
      onSelectedChange: Dispatch<SetStateAction<string[]>>;
    })
  | (ColumnHeaderBase & {
      kind: 'bucket-numeric';
      buckets: ReadonlyArray<{ key: string; label: string }>;
      bucketValue: string;
      onBucketChange: (next: string) => void;
    });

function ColumnHeader(props: ColumnHeaderProps) {
  const [open, setOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const containerRef = useRef<HTMLTableCellElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
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
  const hasFilter =
    (props.kind === 'text-multi' && props.selected.length > 0) ||
    (props.kind === 'bucket-numeric' && props.bucketValue !== 'any');

  const opts: readonly string[] = props.kind === 'text-multi' ? props.options : [];
  const filterQ = filterQuery.trim().toLowerCase();
  const filteredOpts = filterQ
    ? opts.filter((o) => o.toLowerCase().includes(filterQ))
    : opts;

  const cls = [
    styles.columnHeader,
    props.className ?? '',
    isSortActive || hasFilter ? styles.columnHeaderActive : '',
    props.numeric ? styles.thNumeric : '',
  ]
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
          {hasFilter && <span className={styles.filterDot}>●</span>}
          <span
            className={`${styles.sortIndicator} ${isSortActive ? styles.sortIndicatorActive : ''}`}
          >
            {sortGlyph}
          </span>
        </span>
      </button>

      {open && (
        <div className={styles.columnPanel} role="dialog">
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
              <span className={styles.panelBtnGlyph}>↑</span>
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
              <span className={styles.panelBtnGlyph}>↓</span>
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
                <span className={styles.panelBtnGlyph}>×</span>
                <span>Clear sort</span>
              </button>
            )}
          </div>

          {props.kind === 'text-multi' && (
            <>
              <div className={styles.sectionDivider} />
              <div className={styles.panelSection}>
                <div className={styles.sectionLabel}>Filter</div>
                <div className={styles.multiSearch}>
                  <Search />
                  <input
                    type="text"
                    placeholder={`Search ${props.label.toLowerCase()}...`}
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                  />
                </div>
                <div className={styles.multiActions}>
                  <button
                    type="button"
                    onClick={() => props.onSelectedChange(filteredOpts.slice())}
                    disabled={filteredOpts.length === 0}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={() => props.onSelectedChange([])}
                    disabled={props.selected.length === 0}
                  >
                    Clear
                  </button>
                </div>
                <ul className={styles.multiList}>
                  {filteredOpts.length === 0 && (
                    <li className={styles.multiEmpty}>No matches</li>
                  )}
                  {filteredOpts.map((opt) => {
                    const checked = props.selected.includes(opt);
                    return (
                      <li key={opt}>
                        <label className={styles.multiOption}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              props.onSelectedChange((prev) =>
                                prev.includes(opt)
                                  ? prev.filter((o) => o !== opt)
                                  : [...prev, opt],
                              )
                            }
                          />
                          <span>{opt}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </>
          )}

          {props.kind === 'bucket-numeric' && (
            <>
              <div className={styles.sectionDivider} />
              <div className={styles.panelSection}>
                <div className={styles.sectionLabel}>Filter</div>
                <ul className={styles.multiList}>
                  {props.buckets.map((b) => (
                    <li key={b.key}>
                      <button
                        type="button"
                        className={`${styles.singleOption} ${b.key === props.bucketValue ? styles.singleOptionActive : ''}`}
                        onClick={() => {
                          props.onBucketChange(b.key);
                          setOpen(false);
                        }}
                      >
                        {b.label}
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

export default function PartsPage() {
  const navigate = useNavigate();
  const { demoMode } = useDemo();
  const [data, setData] = useState<PaginatedResponse<Part> | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'nrnd' | 'obsolete'>('all');
  const [page, setPage] = useState(1);

  const [sortKey, setSortKey] = useState<SortKey | null>('sku');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [mfrFilter, setMfrFilter] = useState<string[]>([]);
  const [catFilter, setCatFilter] = useState<string[]>([]);
  const [bestBucket, setBestBucket] = useState<BestBucket>('any');
  const [stockBucket, setStockBucket] = useState<StockBucket>('any');

  // Preserve real adminApi.getParts signature (server-side search + pagination)
  const fetchParts = useCallback(() => {
    setLoading(true);
    adminApi
      .getParts({ page, search: search.trim() || undefined })
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, search]);

  useEffect(() => {
    const timer = setTimeout(fetchParts, 300);
    return () => clearTimeout(timer);
  }, [fetchParts]);

  // Option pools — derived from the full current page (data.items), NOT from
  // the post-filter rows. Filtering should never shrink its own option set.
  const mfrOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of data?.items ?? []) {
      if (p.manufacturer_name) set.add(p.manufacturer_name);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const catOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of data?.items ?? []) {
      const c = partCategoryLabel(p);
      if (c) set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [data]);

  // Filter → sort pipeline. Both derive from data.items.
  const visibleRows = useMemo(() => {
    const items = data?.items ?? [];
    const filtered = items.filter((p) => {
      if (filter !== 'all' && p.lifecycle_status?.toLowerCase() !== filter) return false;
      if (mfrFilter.length > 0 && !mfrFilter.includes(p.manufacturer_name)) return false;
      if (catFilter.length > 0 && !catFilter.includes(partCategoryLabel(p))) return false;
      if (!inBestBucket(bestPriceOf(p), bestBucket)) return false;
      if (!inStockBucket(totalStockOf(p), stockBucket)) return false;
      return true;
    });

    if (sortKey == null || sortDir == null) return filtered;

    const dir = sortDir;
    const sorted = filtered.slice().sort((a, b) => {
      switch (sortKey) {
        case 'sku':
          return cmpText(a.sku, b.sku, dir);
        case 'description':
          return cmpText(a.description ?? '', b.description ?? '', dir);
        case 'manufacturer':
          return cmpText(a.manufacturer_name, b.manufacturer_name, dir);
        case 'category':
          return cmpText(partCategoryLabel(a), partCategoryLabel(b), dir);
        case 'best':
          return cmpNumberNullsLast(bestPriceOf(a), bestPriceOf(b), dir);
        case 'stock':
          return cmpNumberNullsLast(totalStockOf(a), totalStockOf(b), dir);
        case 'status':
          return cmpText(a.lifecycle_status ?? '', b.lifecycle_status ?? '', dir);
        default:
          return 0;
      }
    });
    return sorted;
  }, [data, filter, mfrFilter, catFilter, bestBucket, stockBucket, sortKey, sortDir]);

  const totalCount = data?.total ?? 0;

  // Explicit sort setter — used by the per-column dropdown's Sort buttons.
  // dir=null clears the sort entirely; otherwise sets the active column + dir.
  const handleSort = (k: SortKey, dir: SortDir) => {
    if (dir === null) {
      setSortKey(null);
      setSortDir(null);
      return;
    }
    setSortKey(k);
    setSortDir(dir);
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1>Parts</h1>
          <p>{totalCount} SKU{totalCount === 1 ? '' : 's'} in catalog{demoMode ? ' (demo data)' : ''}</p>
        </div>
        <div className={styles.pageHeadActions}>
          <Link to="/admin/import" className={`${styles.btn} ${styles.btnGhost}`}>
            <Upload />
            Import CSV
          </Link>
          <button type="button" className={`${styles.btn} ${styles.btnGhost}`}>
            <Download />
            Export
          </button>
          <Link
            to="/admin/parts/new"
            data-tour="add-part"
            className={`${styles.btn} ${styles.btnPrimary}`}
          >
            <Plus />
            Add Part
          </Link>
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.toolbar}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`${styles.filterChip} ${filter === f.key ? styles.filterChipActive : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
          <div className={styles.toolbarSpacer} />
          <div className={styles.inlineSearch}>
            <Search />
            <input
              type="text"
              placeholder="Search SKU or description..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <span className={styles.toolbarCount}>
            {visibleRows.length} of {totalCount}
          </span>
        </div>

        <table className={styles.table}>
          <thead>
            <tr>
              <ColumnHeader
                kind="sort-only"
                label="SKU"
                colKey="sku"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
                sortLabels={{ asc: 'A → Z', desc: 'Z → A' }}
              />
              <ColumnHeader
                kind="sort-only"
                label="Description"
                colKey="description"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
                sortLabels={{ asc: 'A → Z', desc: 'Z → A' }}
                className={styles.thMobileHide}
              />
              <ColumnHeader
                kind="text-multi"
                label="Manufacturer"
                colKey="manufacturer"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
                sortLabels={{ asc: 'A → Z', desc: 'Z → A' }}
                options={mfrOptions}
                selected={mfrFilter}
                onSelectedChange={setMfrFilter}
              />
              <ColumnHeader
                kind="text-multi"
                label="Category"
                colKey="category"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
                sortLabels={{ asc: 'A → Z', desc: 'Z → A' }}
                options={catOptions}
                selected={catFilter}
                onSelectedChange={setCatFilter}
              />
              <ColumnHeader
                kind="bucket-numeric"
                label="Best"
                colKey="best"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
                sortLabels={{ asc: 'Low → High', desc: 'High → Low' }}
                buckets={BEST_BUCKETS}
                bucketValue={bestBucket}
                onBucketChange={(v) => setBestBucket(v as BestBucket)}
                className={styles.thMobileHide}
                numeric
              />
              <ColumnHeader
                kind="bucket-numeric"
                label="Stock"
                colKey="stock"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
                sortLabels={{ asc: 'Low → High', desc: 'High → Low' }}
                buckets={STOCK_BUCKETS}
                bucketValue={stockBucket}
                onBucketChange={(v) => setStockBucket(v as StockBucket)}
                className={styles.thMobileHide}
                numeric
              />
              <ColumnHeader
                kind="sort-only"
                label="Status"
                colKey="status"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
                sortLabels={{ asc: 'A → Z', desc: 'Z → A' }}
              />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr className={styles.emptyRow}>
                <td colSpan={7}>Loading parts...</td>
              </tr>
            )}
            {!loading && visibleRows.length === 0 && (
              <tr className={styles.emptyRow}>
                <td colSpan={7}>No parts found.</td>
              </tr>
            )}
            {!loading &&
              visibleRows.map((row) => {
                const best = bestPriceOf(row);
                const stock = totalStockOf(row);
                return (
                  <tr key={row.id} onClick={() => navigate(`/admin/parts/${row.id}`)}>
                    <td>
                      <span className={styles.mono}>{row.sku}</span>
                    </td>
                    <td className={styles.tdMobileHide}>{row.description ?? '—'}</td>
                    <td>{row.manufacturer_name}</td>
                    <td>
                      <span className={styles.catCell}>
                        <Icon name={row.parent_category_icon ?? row.category_icon} />
                        <span>
                          {row.parent_category_name ?? row.category_name ?? '—'}
                          {row.parent_category_name && row.category_name && (
                            <span className={styles.catCellSub}> ({row.category_name})</span>
                          )}
                        </span>
                      </span>
                    </td>
                    <td className={`${styles.tdMobileHide} ${styles.tdNumeric}`}>
                      {best == null ? '—' : <span className={styles.mono}>{`$${best.toFixed(2)}`}</span>}
                    </td>
                    <td className={`${styles.tdMobileHide} ${styles.tdNumeric}`}>
                      {stock == null ? '—' : stock.toLocaleString()}
                    </td>
                    <td>{lifecycleBadge(row.lifecycle_status)}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {data && data.pages > 1 && (
        <div className={styles.pagination}>
          <button
            type="button"
            className={styles.pageBtn}
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span className={styles.pageInfo}>
            Page {data.page} of {data.pages}
          </span>
          <button
            type="button"
            className={styles.pageBtn}
            disabled={page >= data.pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
