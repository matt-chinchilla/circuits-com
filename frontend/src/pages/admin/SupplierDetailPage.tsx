import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import Breadcrumbs from '../../components/admin/Breadcrumbs';
import StatCard from '../../components/admin/StatCard';
import DataTable from '../../components/admin/DataTable';
import { adminApi } from '../../services/adminApi';
import type { AdminSupplier, Part, PaginatedResponse } from '../../types/admin';
import styles from './SupplierDetailPage.module.scss';

type PartRow = Part & Record<string, unknown>;

const PART_COLUMNS = [
  { key: 'sku', label: 'SKU', sortable: true },
  { key: 'manufacturer_name', label: 'Manufacturer', sortable: true },
  { key: 'description', label: 'Description' },
  { key: 'lifecycle_status', label: 'Status' },
];

export default function SupplierDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [supplier, setSupplier] = useState<AdminSupplier | null>(null);
  const [parts, setParts] = useState<PaginatedResponse<Part> | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([adminApi.getSupplier(id), adminApi.getSupplierParts(id, { page })])
      .then(([s, p]) => {
        setSupplier(s);
        setParts(p);
      })
      .catch(() => setError('Failed to load supplier details.'))
      .finally(() => setLoading(false));
  }, [id, page]);

  if (loading) {
    return <div className={styles.loading}>Loading supplier details...</div>;
  }

  if (error || !supplier) {
    return (
      <div className={styles.page}>
        <Breadcrumbs items={[{ label: 'Dashboard', href: '/admin' }, { label: 'Suppliers', href: '/admin/suppliers' }, { label: 'Error' }]} />
        <div className={styles.error}>{error || 'Supplier not found.'}</div>
      </div>
    );
  }

  const partRows: PartRow[] = (parts?.items ?? []) as PartRow[];

  return (
    <div className={styles.page}>
      <Breadcrumbs
        items={[
          { label: 'Dashboard', href: '/admin' },
          { label: 'Suppliers', href: '/admin/suppliers' },
          { label: supplier.name },
        ]}
      />

      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>{supplier.name}</h1>
        </div>
        <Link to={`/admin/suppliers/${id}/edit`} className={styles.editBtn}>
          Edit Supplier
        </Link>
      </div>

      <div className={styles.infoCard}>
        <div className={styles.infoGrid}>
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Email</span>
            <span className={styles.infoValue}>{supplier.email ?? '\u2014'}</span>
          </div>
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Phone</span>
            <span className={styles.infoValue}>{supplier.phone ?? '\u2014'}</span>
          </div>
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Website</span>
            <span className={styles.infoValue}>
              {supplier.website ? (
                <a href={supplier.website} target="_blank" rel="noopener noreferrer">{supplier.website}</a>
              ) : '\u2014'}
            </span>
          </div>
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Categories</span>
            <span className={styles.infoValue}>{supplier.categories?.join(', ') || '\u2014'}</span>
          </div>
          {supplier.description && (
            <div className={`${styles.infoItem} ${styles.descriptionItem}`}>
              <span className={styles.infoLabel}>Description</span>
              <span className={styles.infoValue}>{supplier.description}</span>
            </div>
          )}
        </div>
      </div>

      <div className={styles.statsRow}>
        <StatCard label="Parts Listed" value={supplier.parts_count ?? 0} icon={'\uD83E\uDDF0'} />
        <StatCard
          label="Revenue"
          value={`$${(supplier.revenue_total ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
          icon={'\uD83D\uDCB0'}
        />
        <StatCard label="Categories" value={supplier.categories?.length ?? 0} icon={'\uD83D\uDCC2'} />
      </div>

      <div className={styles.partsSection}>
        <h2 className={styles.sectionTitle}>Parts</h2>
        <DataTable
          columns={PART_COLUMNS}
          data={partRows}
          emptyMessage="No parts listed by this supplier."
          onRowClick={(row) => navigate(`/admin/parts/${row.id}`)}
        />
        {parts && parts.pages > 1 && (
          <div className={styles.pagination}>
            <button
              className={styles.pageBtn}
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <span className={styles.pageInfo}>
              Page {parts.page} of {parts.pages}
            </span>
            <button
              className={styles.pageBtn}
              disabled={page >= parts.pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
