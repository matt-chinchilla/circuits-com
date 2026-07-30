import {
  useState,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Plus, Search, Pencil, X } from 'lucide-react';
import { loadSponsors } from '@admin/services/sponsorStore';
import { adminApi } from '@admin/services/adminApi';
import Icon from '@shared/components/Icon';
import type { AdminSponsor, SponsorTier, SponsorStatus } from '@admin/types/admin';
import { normalizeSponsorTier, SPONSOR_TIER_RANK } from '@admin/services/sponsorTier';
import { buildCategoryIndex, placementPath, type CategoryPathEntry } from '../placementPath';
import styles from './SponsorsPage.module.scss';

// Phase A6 — list page ported from 2026-04-25 Claude Design bundle
// (project/ui_kits/admin/pages.jsx → SponsorsListPage).
//
// Persistence routed through @admin/services/sponsorStore, which is now
// API-backed (`/api/admin/sponsors/`). Mirrors the Messages list: fetch on
// mount via useEffect + state, with a cancel flag so a late response can't
// stomp an unmounted component. The backend returns supplier_name /
// category_name / category_icon directly, so no client-side id→name mapping
// is needed anymore.
//
// 2026-07-29 — two additions:
//   1. Per-column sort/filter dropdowns (the admin Parts-list ColumnHeader
//      pattern), composed with the pre-existing tier chips + search box.
//   2. The supplier-name cell links to the LIVE placement page (public
//      /category/* or /keyword/*) via the shared placementPath contract; the
//      category index behind it is fetched best-effort so a failure only
//      costs the links, never the table.

const TIERS: SponsorTier[] = ['Platinum', 'Gold', 'Silver'];

type TierFilter = 'All' | SponsorTier;

const TIER_FILTERS: TierFilter[] = ['All', ...TIERS];

// ─── Column sort/filter contracts ──────────────────────────────────────────

type SortDir = 'asc' | 'desc' | null;
type SortKey = 'supplier' | 'tier' | 'placement' | 'window' | 'amount' | 'status';

type AmountBucket = 'any' | 'lt100' | '100to500' | '500to1000' | 'gte1000';

const AMOUNT_BUCKETS: Array<{ key: AmountBucket; label: string }> = [
  { key: 'any', label: 'Any amount' },
  { key: 'lt100', label: '< $100' },
  { key: '100to500', label: '$100 – $499' },
  { key: '500to1000', label: '$500 – $999' },
  { key: 'gte1000', label: '$1,000+' },
];

// Canonical status ordering for the Status filter list (not alphabetical —
// lifecycle order reads better), with anything unknown appended after.
const STATUS_ORDER = ['Active', 'Paused', 'Expired'];

// ─── Cell labels — one helper per column, shared by render + filter + sort ──
//
// The option pools, the filter predicates and the comparators all read the
// SAME label a row renders, so a filter chip can never fail to match the text
// the admin is looking at.

function tierLabel(s: AdminSponsor): string {
  // Mirror the badge: normalized TitleCase, falling back to the raw string for
  // a tier outside the live union (e.g. a pre-013 'Featured' row).
  return normalizeSponsorTier(s.tier) ?? s.tier;
}

function placementLabel(s: AdminSponsor): string {
  if (s.category_id) return s.category_name ?? s.category_id;
  return `keyword: ${s.keyword ?? ''}`;
}

// Legacy seed rows omit status (NULL reads as Active per CLAUDE.md) and the
// badge renders blank for them, so group those under an em dash rather than
// inventing a status the cell doesn't show.
function statusLabel(s: AdminSponsor): string {
  return s.status ?? '—';
}

function tierRankOf(s: AdminSponsor): number {
  const t = normalizeSponsorTier(s.tier);
  return t ? SPONSOR_TIER_RANK[t] : 0;
}

// `amount` is TYPED `number | null` but arrives as a decimal STRING ("99.00")
// — Postgres NUMERIC serializes as a JSON string. Coerce once, here, so the
// bucket predicate and the comparator don't lean on implicit string coercion
// (and a non-numeric value sinks with the nulls instead of poisoning the sort
// with NaN).
function amountOf(s: AdminSponsor): number | null {
  if (s.amount == null) return null;
  const n = Number(s.amount);
  return Number.isFinite(n) ? n : null;
}

function inAmountBucket(amount: number | null, bucket: AmountBucket): boolean {
  if (bucket === 'any') return true;
  if (amount == null) return false;
  if (bucket === 'lt100') return amount < 100;
  if (bucket === '100to500') return amount >= 100 && amount < 500;
  if (bucket === '500to1000') return amount >= 500 && amount < 1000;
  return amount >= 1000;
}

function cmpText(a: string, b: string, dir: 'asc' | 'desc'): number {
  const r = a.localeCompare(b, undefined, { sensitivity: 'base' });
  return dir === 'asc' ? r : -r;
}

function cmpNumberNullsLast(a: number | null, b: number | null, dir: 'asc' | 'desc'): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return dir === 'asc' ? a - b : b - a;
}

// ISO dates ('YYYY-MM-DD…') sort lexically, so no Date parsing is needed.
// Unset windows sink to the bottom in both directions.
function cmpDateNullsLast(a: string | null, b: string | null, dir: 'asc' | 'desc'): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const r = a < b ? -1 : a > b ? 1 : 0;
  return dir === 'asc' ? r : -r;
}

function tierClass(tier: string): string {
  // Normalize first — legacy seed rows store lowercase 'platinum'.
  switch (normalizeSponsorTier(tier)) {
    case 'Platinum':
      return styles.tierPlatinum;
    case 'Gold':
      return styles.tierGold;
    case 'Silver':
      return styles.tierSilver;
    default:
      return '';
  }
}

function statusClass(status: SponsorStatus | null): string {
  switch (status) {
    case 'Active':
      return styles.statusActive;
    case 'Paused':
      return styles.statusPaused;
    case 'Expired':
      return styles.statusExpired;
    default:
      return '';
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return iso;
}

function formatAmount(n: number | null): string {
  if (n == null) return '—';
  return `$${n.toLocaleString()}`;
}

// ─── Column header: unified sort + filter dropdown (Excel pattern) ─────────
//
// Ported from @admin/pages/parts/list. Each column owns its own sort + filter
// contract: (1) Sort section — asc/desc + Clear, (2) Filter section — checkbox
// list (text-multi) or single-choice list (bucket-numeric), or nothing
// (sort-only). The TH itself is the trigger AND the positioning container; the
// panel is absolutely positioned below it (which is why `.panel` /
// `.tableWrap` must not clip — see SponsorsPage.module.scss).

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
  const filteredOpts = filterQ ? opts.filter((o) => o.toLowerCase().includes(filterQ)) : opts;

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
                  <Search size={14} strokeWidth={2} />
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
                  {filteredOpts.length === 0 && <li className={styles.multiEmpty}>No matches</li>}
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

export default function SponsorsPage() {
  const navigate = useNavigate();
  const [sponsors, setSponsors] = useState<AdminSponsor[]>([]);
  const [loading, setLoading] = useState(true);
  const [tierFilter, setTierFilter] = useState<TierFilter>('All');
  const [search, setSearch] = useState('');

  // Category id → {slug, parentSlug} for the supplier-name → live-page link.
  const [categoryIndex, setCategoryIndex] = useState<Map<string, CategoryPathEntry>>(
    () => new Map(),
  );

  // Per-column sort + filter state.
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [supplierColFilter, setSupplierColFilter] = useState<string[]>([]);
  const [tierColFilter, setTierColFilter] = useState<string[]>([]);
  const [placementColFilter, setPlacementColFilter] = useState<string[]>([]);
  const [statusColFilter, setStatusColFilter] = useState<string[]>([]);
  const [amountBucket, setAmountBucket] = useState<AmountBucket>('any');

  // Fetch sponsors from the API on mount. Cancel flag guards against a late
  // response resolving after unmount (CLAUDE.md state-dep-effect pattern).
  useEffect(() => {
    let cancelled = false;
    loadSponsors()
      .then((rows) => {
        if (cancelled) return;
        setSponsors(rows);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[SponsorsPage] load failed', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Categories only enrich the supplier-name link (the sponsor payload carries
  // category_name but no slug/parent lineage). Best-effort + cancel-flagged:
  // a failure leaves the names as plain text, it never blanks the table.
  useEffect(() => {
    let cancelled = false;
    adminApi
      .getCategories()
      .then((cats) => {
        if (cancelled) return;
        setCategoryIndex(buildCategoryIndex(cats));
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[SponsorsPage] getCategories failed; placement links disabled', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Option pools ────────────────────────────────────────────────────────
  // Derived from the FULL row set, never from the post-filter rows — a filter
  // must not shrink its own option list.

  const supplierOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of sponsors) if (s.supplier_name) set.add(s.supplier_name);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [sponsors]);

  const tierOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of sponsors) {
      const t = tierLabel(s);
      if (t) set.add(t);
    }
    // Tier order is a hierarchy, not an alphabet: Platinum → Gold → Silver,
    // with any off-union tier (rank 0) trailing.
    return Array.from(set).sort((a, b) => {
      const ta = normalizeSponsorTier(a);
      const tb = normalizeSponsorTier(b);
      const rankA = ta ? SPONSOR_TIER_RANK[ta] : 0;
      const rankB = tb ? SPONSOR_TIER_RANK[tb] : 0;
      return rankB - rankA || a.localeCompare(b);
    });
  }, [sponsors]);

  const placementOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of sponsors) {
      const p = placementLabel(s);
      if (p) set.add(p);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [sponsors]);

  const statusOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of sponsors) set.add(statusLabel(s));
    const rank = (v: string) => {
      const i = STATUS_ORDER.indexOf(v);
      return i === -1 ? STATUS_ORDER.length : i;
    };
    return Array.from(set).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [sponsors]);

  // ─── One filter → sort pipeline ──────────────────────────────────────────
  // Composes the toolbar tier chips + free-text search with the per-column
  // checkbox/bucket filters; the active column sort runs last.
  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = sponsors.filter((s) => {
      if (tierFilter !== 'All' && normalizeSponsorTier(s.tier) !== tierFilter) return false;
      if (supplierColFilter.length > 0 && !supplierColFilter.includes(s.supplier_name)) return false;
      if (tierColFilter.length > 0 && !tierColFilter.includes(tierLabel(s))) return false;
      if (placementColFilter.length > 0 && !placementColFilter.includes(placementLabel(s)))
        return false;
      if (statusColFilter.length > 0 && !statusColFilter.includes(statusLabel(s))) return false;
      if (!inAmountBucket(amountOf(s), amountBucket)) return false;
      if (!q) return true;
      const haystack = [s.supplier_name, s.category_name ?? '', s.keyword ?? '', s.tier, s.status]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });

    if (sortKey == null || sortDir == null) return rows;

    const dir = sortDir;
    return rows.slice().sort((a, b) => {
      switch (sortKey) {
        case 'supplier':
          return cmpText(a.supplier_name, b.supplier_name, dir);
        case 'tier': {
          // Rank order (Platinum > Gold > Silver), NOT alphabetical; equal
          // tiers fall back to supplier name so the order is deterministic.
          const r = tierRankOf(a) - tierRankOf(b);
          if (r !== 0) return dir === 'asc' ? r : -r;
          return cmpText(a.supplier_name, b.supplier_name, 'asc');
        }
        case 'placement':
          return cmpText(placementLabel(a), placementLabel(b), dir);
        case 'window':
          return cmpDateNullsLast(a.start_date, b.start_date, dir);
        case 'amount':
          return cmpNumberNullsLast(amountOf(a), amountOf(b), dir);
        case 'status':
          return cmpText(statusLabel(a), statusLabel(b), dir);
        default:
          return 0;
      }
    });
  }, [
    sponsors,
    tierFilter,
    search,
    supplierColFilter,
    tierColFilter,
    placementColFilter,
    statusColFilter,
    amountBucket,
    sortKey,
    sortDir,
  ]);

  const tierCounts = useMemo(() => {
    const map: Record<TierFilter, number> = {
      All: sponsors.length,
      Platinum: 0,
      Gold: 0,
      Silver: 0,
    };
    // Normalize casing (legacy seed stores lowercase 'platinum') and skip any
    // tier outside the live union (e.g. a dropped pre-013 'Featured', which
    // normalizes to null) so it can't NaN the running count.
    for (const s of sponsors) {
      const t = normalizeSponsorTier(s.tier);
      if (t) map[t]++;
    }
    return map;
  }, [sponsors]);

  // Explicit sort setter — dir=null clears the sort entirely.
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
      <header className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1 className={styles.title}>Sponsors</h1>
          <p className={styles.subtitle}>
            Paid placements: category banners, keyword takeovers, featured supplier slots.
          </p>
        </div>
        <div className={styles.pageHeadActions}>
          <Link to="/admin/sponsors/new" className={`${styles.btn} ${styles.btnPrimary}`}>
            <Plus size={15} strokeWidth={2} />
            New Sponsor
          </Link>
        </div>
      </header>

      <div className={styles.panel}>
        <div className={styles.toolbar}>
          {TIER_FILTERS.map((t) => (
            <button
              key={t}
              type="button"
              className={`${styles.filterChip} ${tierFilter === t ? styles.filterChipActive : ''}`}
              onClick={() => setTierFilter(t)}
            >
              {t}
              <span className={styles.chipCount}>{tierCounts[t]}</span>
            </button>
          ))}
          <div className={styles.toolbarSpacer} />
          <div className={styles.inlineSearch}>
            <Search size={14} strokeWidth={2} />
            <input
              type="text"
              placeholder="Search sponsors, keywords, categories..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className={styles.searchClear}
                onClick={() => setSearch('')}
                aria-label="Clear search"
              >
                <X size={12} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <ColumnHeader
                  kind="text-multi"
                  label="Supplier"
                  colKey="supplier"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  sortLabels={{ asc: 'A → Z', desc: 'Z → A' }}
                  options={supplierOptions}
                  selected={supplierColFilter}
                  onSelectedChange={setSupplierColFilter}
                />
                <ColumnHeader
                  kind="text-multi"
                  label="Tier"
                  colKey="tier"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  sortLabels={{ asc: 'Silver → Platinum', desc: 'Platinum → Silver' }}
                  options={tierOptions}
                  selected={tierColFilter}
                  onSelectedChange={setTierColFilter}
                />
                <ColumnHeader
                  kind="text-multi"
                  label="Placement"
                  colKey="placement"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  sortLabels={{ asc: 'A → Z', desc: 'Z → A' }}
                  options={placementOptions}
                  selected={placementColFilter}
                  onSelectedChange={setPlacementColFilter}
                />
                <ColumnHeader
                  kind="sort-only"
                  label="Window"
                  colKey="window"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  sortLabels={{ asc: 'Oldest start', desc: 'Newest start' }}
                />
                <ColumnHeader
                  kind="bucket-numeric"
                  label="Monthly"
                  colKey="amount"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  sortLabels={{ asc: 'Low → High', desc: 'High → Low' }}
                  buckets={AMOUNT_BUCKETS}
                  bucketValue={amountBucket}
                  onBucketChange={(v) => setAmountBucket(v as AmountBucket)}
                />
                <ColumnHeader
                  kind="text-multi"
                  label="Status"
                  colKey="status"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  sortLabels={{ asc: 'A → Z', desc: 'Z → A' }}
                  options={statusOptions}
                  selected={statusColFilter}
                  onSelectedChange={setStatusColFilter}
                />
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((s) => {
                // Live placement page: /category/<parent>/<child> for a
                // category sponsorship, /keyword/<kw> for a keyword one, null
                // when the category id isn't in the (best-effort) index yet.
                const livePath = placementPath(s, categoryIndex);
                return (
                  <tr key={s.id}>
                    <td>
                      {livePath ? (
                        <Link
                          to={livePath}
                          className={styles.placementLink}
                          title={`Open the live ${placementLabel(s)} page`}
                        >
                          <strong>{s.supplier_name}</strong>
                        </Link>
                      ) : (
                        <strong>{s.supplier_name}</strong>
                      )}
                    </td>
                    <td>
                      <span className={`${styles.tierBadge} ${tierClass(s.tier)}`}>
                        {tierLabel(s)}
                      </span>
                    </td>
                    <td>
                      {s.category_id ? (
                        <span className={styles.placementCategory}>
                          <Icon name={s.category_icon} />
                          <span>{s.category_name ?? s.category_id}</span>
                        </span>
                      ) : (
                        <span className={styles.placementKeyword}>
                          <span className={styles.placementLabel}>keyword:</span>
                          <span className={styles.mono}>{s.keyword}</span>
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={styles.windowText}>
                        {formatDate(s.start_date)} <span className={styles.windowArrow}>&rarr;</span>{' '}
                        {formatDate(s.end_date)}
                      </span>
                    </td>
                    <td>
                      <span className={styles.amountText}>{formatAmount(s.amount)}</span>
                    </td>
                    <td>
                      <span className={`${styles.statusBadge} ${statusClass(s.status)}`}>
                        {s.status}
                      </span>
                    </td>
                    <td className={styles.rowActionsCell}>
                      <button
                        type="button"
                        className={styles.rowAction}
                        onClick={() => navigate(`/admin/sponsors/${s.id}/edit`)}
                        aria-label={`Edit sponsor ${s.supplier_name}`}
                      >
                        <Pencil size={14} strokeWidth={2} />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={7} className={styles.emptyRow}>
                    {loading
                      ? 'Loading sponsors…'
                      : sponsors.length === 0
                        ? 'No active sponsorships. Click + New Sponsor to add one.'
                        : 'No sponsors match the current filters.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
