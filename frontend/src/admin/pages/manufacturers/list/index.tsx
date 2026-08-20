// Manufacturers — the directory list.
//
// Table pattern (the admin Sponsors list), NOT the Suppliers card grid: this
// is a 1,800-row roster an admin scans and sorts, not a dozen partner cards.
//
// One structural difference from Sponsors, and it drives everything here:
// filtering, sorting and paging are all SERVER-side (`GET /admin/manufacturers/`
// takes page/per_page/q/source/linked/sort/desc). The client never holds the
// full row set, so a client-side comparator or a multi-select "all values"
// checkbox list would be lying about data it hasn't seen. Every control below
// maps to a query parameter.
//
// The page number lives in the URL (`?p=N`) so a row opened from page 7 comes
// back to page 7 — the same contract the public category page uses.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Search, X } from 'lucide-react';

import { adminApi } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import type { AdminManufacturer, ManufacturerListResponse } from '@admin/types/manufacturers';
import { safeHttpUrl } from '@shared/utils/url';

import CatalogSwitch from '../CatalogSwitch';
import ColumnHeader, { type SortDir } from '../ColumnHeader';
import { coverageLabel } from '../supplierLink';
import styles from './ManufacturersPage.module.scss';

const PER_PAGE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const SKELETON_ROWS = 8;

// Server sort keys — `_SORTS` in routes/admin_manufacturers.py. Anything else
// silently falls back to name on the server, so the union is the contract.
type SortKey = 'name' | 'source' | 'catalog' | 'external';

type SourceFilter = 'any' | 'csv' | 'catalog' | 'manual';
type LinkedFilter = 'any' | 'linked' | 'unlinked';

const SOURCE_CHOICES: ReadonlyArray<{ key: SourceFilter; label: string }> = [
  { key: 'any', label: 'Any source' },
  { key: 'csv', label: 'CSV roster' },
  { key: 'catalog', label: 'Catalog' },
  { key: 'manual', label: 'Manual' },
];

const LINKED_CHOICES: ReadonlyArray<{ key: LinkedFilter; label: string }> = [
  { key: 'any', label: 'All' },
  { key: 'linked', label: 'Linked' },
  { key: 'unlinked', label: 'Unlinked' },
];

const SOURCE_CLASS: Record<string, string> = {
  csv: styles.sourceCsv,
  catalog: styles.sourceCatalog,
  manual: styles.sourceManual,
};

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

export default function ManufacturersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const pageParam = Number(searchParams.get('p') ?? '1');
  const page = Number.isFinite(pageParam) && pageParam >= 1 ? Math.floor(pageParam) : 1;

  const [data, setData] = useState<ManufacturerListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // The input the admin types into vs. the value that reaches the server. One
  // request per keystroke over an 1,800-row table is a self-inflicted DoS.
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [source, setSource] = useState<SourceFilter>('any');
  const [linked, setLinked] = useState<LinkedFilter>('any');
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);

  // Fetch. Cancel-flagged so a slow response for page 2 can't overwrite the
  // page-3 rows the admin has already moved on to (the canonical admin
  // state-dep-effect pattern).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params: Record<string, string | number | boolean> = {
      page,
      per_page: PER_PAGE,
      sort: sortKey ?? 'name',
      desc: sortDir === 'desc',
    };
    if (q) params.q = q;
    if (source !== 'any') params.source = source;
    if (linked !== 'any') params.linked = linked === 'linked';

    adminApi
      .getManufacturers(params)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setError('');
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[ManufacturersPage] load failed', err);
        setError(apiErrorDetail(err) ?? 'Failed to load manufacturers.');
        setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, q, source, linked, sortKey, sortDir]);

  // Changing what the list CONTAINS invalidates the page number — page 7 of a
  // filtered set is usually empty. Deliberately NOT depending on
  // `setSearchParams` (its identity changes on every URL change, so an effect
  // that "resets ?p on filter change" would also fire on page change and pin
  // the list to page 1 forever); the functional form needs no setter dep.
  // The first run is skipped so a deep link like `?p=4` survives mount.
  const filtersKey = `${q}|${source}|${linked}|${sortKey}|${sortDir}`;
  const firstFiltersRun = useRef(true);
  useEffect(() => {
    if (firstFiltersRun.current) {
      firstFiltersRun.current = false;
      return;
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('p');
        return next;
      },
      { replace: true },
    );
  }, [filtersKey]);

  const goToPage = (next: number) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next <= 1) params.delete('p');
      else params.set('p', String(next));
      return params;
    });
    window.scrollTo({ top: 0, left: 0 });
  };

  const rows: AdminManufacturer[] = data?.manufacturers ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const rangeStart = total === 0 ? 0 : (page - 1) * PER_PAGE + 1;
  const rangeEnd = Math.min(page * PER_PAGE, total);

  const handleSort = (key: SortKey, dir: SortDir) => {
    if (dir === null) {
      setSortKey(null);
      setSortDir(null);
      return;
    }
    setSortKey(key);
    setSortDir(dir);
  };

  const skeletonRows = useMemo(
    () => Array.from({ length: SKELETON_ROWS }, (_, i) => i),
    [],
  );

  return (
    <div className={styles.page}>
      {/* position:relative + a minimum height so CatalogSwitch's absolutely
          centered pill sits on the title row rather than pushing it around
          (navbar pinned-edge pattern: a third flex child is NOT centered when
          the side tracks differ in width). */}
      <header className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1 className={styles.title}>Manufacturers</h1>
          <p className={styles.subtitle}>
            Every company whose parts we list &mdash; the sales roster behind the catalog.
          </p>
        </div>
        <CatalogSwitch />
        <div className={styles.pageHeadActions}>
          <Link to="/admin/manufacturers/new" className={`${styles.btn} ${styles.btnPrimary}`}>
            <Plus size={15} strokeWidth={2} />
            New Manufacturer
          </Link>
        </div>
      </header>

      <div className={styles.panel}>
        <div className={styles.toolbar}>
          <div className={styles.chipGroup} role="group" aria-label="Filter by source">
            {SOURCE_CHOICES.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`${styles.filterChip} ${source === c.key ? styles.filterChipActive : ''}`}
                aria-pressed={source === c.key}
                onClick={() => setSource(c.key)}
              >
                {c.key === 'any' ? 'All sources' : c.label}
              </button>
            ))}
          </div>
          <div className={styles.chipGroup} role="group" aria-label="Filter by supplier link">
            {LINKED_CHOICES.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`${styles.filterChip} ${linked === c.key ? styles.filterChipActive : ''}`}
                aria-pressed={linked === c.key}
                onClick={() => setLinked(c.key)}
              >
                {c.key === 'any' ? 'Any link' : c.label}
              </button>
            ))}
          </div>
          <div className={styles.toolbarSpacer} />
          <div className={styles.inlineSearch}>
            <Search size={14} strokeWidth={2} />
            <input
              type="text"
              placeholder="Search name or website..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              aria-label="Search manufacturers"
            />
            {searchInput && (
              <button
                type="button"
                className={styles.searchClear}
                onClick={() => setSearchInput('')}
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
                  kind="sort-only"
                  label="Name"
                  colKey="name"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  sortLabels={{ asc: 'A → Z', desc: 'Z → A' }}
                />
                <ColumnHeader
                  kind="single-choice"
                  label="Source"
                  colKey="source"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  sortLabels={{ asc: 'A → Z', desc: 'Z → A' }}
                  choices={SOURCE_CHOICES}
                  neutralKey="any"
                  value={source}
                  onChange={(next) => setSource(next as SourceFilter)}
                />
                <ColumnHeader
                  kind="sort-only"
                  label="Catalog parts"
                  colKey="catalog"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  sortLabels={{ asc: 'Fewest first', desc: 'Most first' }}
                />
                <ColumnHeader
                  kind="sort-only"
                  label="External coverage"
                  colKey="external"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                  sortLabels={{ asc: 'Fewest first', desc: 'Most first' }}
                />
                <th>Supplier</th>
                <th>Website</th>
              </tr>
            </thead>
            <tbody>
              {loading &&
                skeletonRows.map((i) => (
                  <tr key={`skel-${i}`} className={styles.skelRow} aria-hidden="true">
                    <td>
                      <span className={`${styles.skel} ${styles.skelWide}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelChip}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelNum}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelMed}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelMed}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelMed}`} />
                    </td>
                  </tr>
                ))}

              {!loading &&
                rows.map((m) => {
                  const site = m.website ? safeHttpUrl(m.website) : null;
                  return (
                    <tr key={m.id}>
                      <td>
                        <Link to={`/admin/manufacturers/${m.id}`} className={styles.nameLink}>
                          {m.name}
                        </Link>
                      </td>
                      <td>
                        <span className={`${styles.sourceChip} ${SOURCE_CLASS[m.source] ?? ''}`}>
                          {m.source}
                        </span>
                      </td>
                      <td className={styles.numCell}>
                        {m.catalog_part_count.toLocaleString('en-US')}
                      </td>
                      <td className={styles.coverageCell}>
                        {coverageLabel(m.catalog_part_count, m.external_part_count)}
                      </td>
                      <td>
                        {m.linked_supplier_id ? (
                          <Link
                            to={`/admin/suppliers/${m.linked_supplier_id}`}
                            className={styles.supplierLink}
                          >
                            {m.linked_supplier_name ?? 'Linked supplier'}
                          </Link>
                        ) : (
                          <span className={styles.muted}>&mdash;</span>
                        )}
                      </td>
                      <td className={styles.siteCell}>
                        {m.website ? (
                          site ? (
                            <a
                              href={site}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={styles.siteLink}
                            >
                              {stripScheme(m.website)}
                            </a>
                          ) : (
                            // safeHttpUrl rejected it (javascript:, data:, …) —
                            // show the stored text, never make it clickable.
                            <span className={styles.muted}>{stripScheme(m.website)}</span>
                          )
                        ) : (
                          <span className={styles.muted}>&mdash;</span>
                        )}
                      </td>
                    </tr>
                  );
                })}

              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className={styles.emptyRow}>
                    {error
                      ? error
                      : q || source !== 'any' || linked !== 'any'
                        ? 'No manufacturers match the current filters.'
                        : 'No manufacturers yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className={styles.pagination}>
          <span className={styles.pageInfo}>
            {total === 0
              ? 'No rows'
              : `${rangeStart.toLocaleString('en-US')}–${rangeEnd.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`}
          </span>
          <div className={styles.pageControls}>
            <button
              type="button"
              className={styles.pageBtn}
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1 || loading}
            >
              &larr; Previous
            </button>
            <span className={styles.pageOf}>
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              className={styles.pageBtn}
              onClick={() => goToPage(page + 1)}
              disabled={page >= totalPages || loading}
            >
              Next &rarr;
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
