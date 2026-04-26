import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Plus, Upload, Download, Search } from 'lucide-react';
import { useDemo } from '../../contexts/DemoContext';
import { adminApi } from '../../services/adminApi';
import type { Part, PaginatedResponse } from '../../types/admin';
import styles from './PartsPage.module.scss';

// ─── Lifecycle filter chips ────────────────────────────────────────────────

const FILTERS: Array<{ key: 'all' | 'active' | 'nrnd' | 'obsolete'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'nrnd', label: 'NRND' },
  { key: 'obsolete', label: 'Obsolete' },
];

// ─── Lifecycle status badge ────────────────────────────────────────────────

function lifecycleBadge(status: string) {
  const lower = status.toLowerCase();
  let cls = styles.statusActive;
  if (lower === 'nrnd') cls = styles.statusNrnd;
  else if (lower === 'obsolete') cls = styles.statusObsolete;
  return <span className={`${styles.statusBadge} ${cls}`}>{status}</span>;
}

export default function PartsPage() {
  const navigate = useNavigate();
  const { demoMode } = useDemo();
  const [data, setData] = useState<PaginatedResponse<Part> | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'nrnd' | 'obsolete'>('all');
  const [page, setPage] = useState(1);

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

  // Client-side lifecycle filter on the current page (server doesn't expose it).
  const visibleRows = useMemo(() => {
    const items = data?.items ?? [];
    if (filter === 'all') return items;
    return items.filter((p) => p.lifecycle_status?.toLowerCase() === filter);
  }, [data, filter]);

  const totalCount = data?.total ?? 0;

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
          <Link to="/admin/parts/new" className={`${styles.btn} ${styles.btnPrimary}`}>
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
              <th>SKU</th>
              <th>Description</th>
              <th>Manufacturer</th>
              <th>Category</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr className={styles.emptyRow}>
                <td colSpan={5}>Loading parts...</td>
              </tr>
            )}
            {!loading && visibleRows.length === 0 && (
              <tr className={styles.emptyRow}>
                <td colSpan={5}>No parts found.</td>
              </tr>
            )}
            {!loading &&
              visibleRows.map((row) => (
                <tr key={row.id} onClick={() => navigate(`/admin/parts/${row.id}`)}>
                  <td>
                    <span className={styles.mono}>{row.sku}</span>
                  </td>
                  <td>{row.description ?? '—'}</td>
                  <td>{row.manufacturer_name}</td>
                  <td>
                    <span className={styles.muted}>
                      {row.category_icon ? `${row.category_icon} ` : ''}
                      {row.category_name ?? '—'}
                    </span>
                  </td>
                  <td>{lifecycleBadge(row.lifecycle_status)}</td>
                </tr>
              ))}
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
