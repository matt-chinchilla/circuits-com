import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import Breadcrumbs from '../../components/admin/Breadcrumbs';
import DataTable from '../../components/admin/DataTable';
import { adminApi } from '../../services/adminApi';
import type { Part, PaginatedResponse } from '../../types/admin';
import styles from './PartsPage.module.scss';

type PartRow = Part & Record<string, unknown>;

function lifecycleBadge(status: string) {
  let cls = styles.lifecycleActive;
  if (status === 'nrnd') cls = styles.lifecycleNrnd;
  if (status === 'obsolete') cls = styles.lifecycleObsolete;
  return <span className={`${styles.lifecycleBadge} ${cls}`}>{status}</span>;
}

const COLUMNS = [
  { key: 'mpn', label: 'MPN', sortable: true },
  { key: 'manufacturer_name', label: 'Manufacturer', sortable: true },
  { key: 'description', label: 'Description' },
  {
    key: 'lifecycle_status',
    label: 'Status',
    sortable: true,
    render: (row: PartRow) => lifecycleBadge(row.lifecycle_status as string),
  },
];

export default function PartsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<PaginatedResponse<Part> | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

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

  const rows: PartRow[] = (data?.items ?? []) as PartRow[];

  return (
    <div className={styles.page}>
      <Breadcrumbs items={[{ label: 'Dashboard', href: '/admin' }, { label: 'Parts' }]} />

      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>Parts</h1>
        </div>
        <div className={styles.headerActions}>
          <Link to="/admin/parts/new" className={styles.addBtn}>
            + Add Part
          </Link>
          <Link to="/admin/import" className={styles.importBtn}>
            Import CSV
          </Link>
        </div>
      </div>

      <div className={styles.filters}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search by MPN or description..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>

      <DataTable
        columns={COLUMNS}
        data={rows}
        loading={loading}
        emptyMessage="No parts found."
        onRowClick={(row) => navigate(`/admin/parts/${row.id}`)}
      />

      {data && data.pages > 1 && (
        <div className={styles.pagination}>
          <button
            className={styles.pageBtn}
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span className={styles.pageInfo}>
            Page {data.page} of {data.pages} ({data.total} total)
          </span>
          <button
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
