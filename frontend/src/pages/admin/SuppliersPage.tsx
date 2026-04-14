import { useState, useEffect, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import Breadcrumbs from '../../components/admin/Breadcrumbs';
import DataTable from '../../components/admin/DataTable';
import { adminApi } from '../../services/adminApi';
import type { AdminSupplier } from '../../types/admin';
import styles from './SuppliersPage.module.scss';

type SupplierRow = AdminSupplier & Record<string, unknown>;

const COLUMNS = [
  { key: 'name', label: 'Name', sortable: true },
  { key: 'contact_name', label: 'Contact', sortable: true, render: (row: SupplierRow) => (row.contact_name as string) || '\u2014' },
  { key: 'email', label: 'Email', sortable: true },
  { key: 'phone', label: 'Phone' },
  {
    key: 'website',
    label: 'Website',
    render: (row: SupplierRow) =>
      row.website ? (
        <a href={row.website as string} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          {row.website as string}
        </a>
      ) : (
        '\u2014'
      ),
  },
];

export default function SuppliersPage() {
  const navigate = useNavigate();
  const [suppliers, setSuppliers] = useState<AdminSupplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    adminApi
      .getSuppliers()
      .then(setSuppliers)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return suppliers;
    const q = search.toLowerCase();
    return suppliers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.email && s.email.toLowerCase().includes(q)) ||
        (s.phone && s.phone.toLowerCase().includes(q)) ||
        (s.contact_name && s.contact_name.toLowerCase().includes(q))
    );
  }, [suppliers, search]);

  const rows: SupplierRow[] = filtered as SupplierRow[];

  return (
    <div className={styles.page}>
      <Breadcrumbs items={[{ label: 'Dashboard', href: '/admin' }, { label: 'Suppliers' }]} />

      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>Suppliers</h1>
        </div>
        <Link to="/admin/suppliers/new" className={styles.addBtn}>
          + Add Supplier
        </Link>
      </div>

      <div className={styles.searchBar}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search suppliers by name, contact, email, or phone..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <DataTable
        columns={COLUMNS}
        data={rows}
        loading={loading}
        emptyMessage="No suppliers found."
        onRowClick={(row) => navigate(`/admin/suppliers/${row.id}`)}
      />
    </div>
  );
}
