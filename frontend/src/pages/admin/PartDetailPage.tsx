import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import Breadcrumbs from '../../components/admin/Breadcrumbs';
import ConfirmDialog from '../../components/admin/ConfirmDialog';
import { adminApi } from '../../services/adminApi';
import type { PartDetail } from '../../types/admin';
import styles from './PartDetailPage.module.scss';

function stockClass(qty: number): string {
  if (qty >= 100) return styles.stockGood;
  if (qty > 0) return styles.stockLow;
  return styles.stockOut;
}

export default function PartDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [part, setPart] = useState<PartDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!id) return;
    adminApi
      .getPart(id)
      .then(setPart)
      .catch(() => setError('Failed to load part details.'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  async function handleDelete() {
    if (!id) return;
    setDeleting(true);
    try {
      await adminApi.deletePart(id);
      setToast('Part deleted successfully.');
      setTimeout(() => navigate('/admin/parts'), 1000);
    } catch {
      setToast('Failed to delete part.');
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (loading) {
    return <div className={styles.loading}>Loading part details...</div>;
  }

  if (error || !part) {
    return (
      <div className={styles.page}>
        <Breadcrumbs items={[{ label: 'Dashboard', href: '/admin' }, { label: 'Parts', href: '/admin/parts' }, { label: 'Error' }]} />
        <div className={styles.error}>{error || 'Part not found.'}</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <Breadcrumbs
        items={[
          { label: 'Dashboard', href: '/admin' },
          { label: 'Parts', href: '/admin/parts' },
          { label: part.mpn },
        ]}
      />

      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>{part.mpn}</h1>
        </div>
        <div className={styles.headerActions}>
          <Link to={`/admin/parts/${id}/edit`} className={styles.editBtn}>
            Edit Part
          </Link>
          <button className={styles.deleteBtn} onClick={() => setConfirmDelete(true)} disabled={deleting}>
            Delete
          </button>
        </div>
      </div>

      <div className={styles.infoCard}>
        <div className={styles.infoGrid}>
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Manufacturer</span>
            <span className={styles.infoValue}>{part.manufacturer_name}</span>
          </div>
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Lifecycle Status</span>
            <span className={styles.infoValue}>{part.lifecycle_status}</span>
          </div>
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Datasheet</span>
            <span className={styles.infoValue}>
              {part.datasheet_url ? (
                <a href={part.datasheet_url} target="_blank" rel="noopener noreferrer">View Datasheet</a>
              ) : '\u2014'}
            </span>
          </div>
          <div className={styles.infoItem}>
            <span className={styles.infoLabel}>Category ID</span>
            <span className={styles.infoValue}>{part.category_id ?? '\u2014'}</span>
          </div>
          {part.description && (
            <div className={`${styles.infoItem} ${styles.fullWidth}`}>
              <span className={styles.infoLabel}>Description</span>
              <span className={styles.infoValue}>{part.description}</span>
            </div>
          )}
        </div>
      </div>

      <div className={styles.listingsSection}>
        <h2 className={styles.sectionTitle}>Distributor Listings ({part.listings.length})</h2>
        {part.listings.length === 0 ? (
          <p>No distributor listings for this part.</p>
        ) : (
          part.listings.map((listing) => (
            <div key={listing.id} className={styles.infoCard}>
              <div className={styles.infoGrid}>
                <div className={styles.infoItem}>
                  <span className={styles.infoLabel}>Supplier</span>
                  <span className={styles.infoValue}>{listing.supplier_name ?? '\u2014'}</span>
                </div>
                <div className={styles.infoItem}>
                  <span className={styles.infoLabel}>SKU</span>
                  <span className={styles.infoValue}>{listing.sku ?? '\u2014'}</span>
                </div>
                <div className={styles.infoItem}>
                  <span className={styles.infoLabel}>Unit Price</span>
                  <span className={styles.infoValue}>
                    ${listing.unit_price.toFixed(2)} {listing.currency}
                  </span>
                </div>
                <div className={styles.infoItem}>
                  <span className={styles.infoLabel}>Stock</span>
                  <span className={`${styles.infoValue} ${stockClass(listing.stock_quantity)}`}>
                    {listing.stock_quantity.toLocaleString()}
                  </span>
                </div>
                <div className={styles.infoItem}>
                  <span className={styles.infoLabel}>Lead Time</span>
                  <span className={styles.infoValue}>
                    {listing.lead_time_days != null ? `${listing.lead_time_days} days` : '\u2014'}
                  </span>
                </div>
              </div>
              {listing.price_breaks.length > 0 && (
                <div className={styles.priceBreaks}>
                  <p className={styles.priceBreakTitle}>Price Breaks</p>
                  <div className={styles.priceBreakList}>
                    {listing.price_breaks.map((pb) => (
                      <span key={pb.id} className={styles.priceBreakItem}>
                        {pb.min_quantity}+ @ ${pb.unit_price.toFixed(4)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete Part"
        message={`Are you sure you want to delete "${part.mpn}"? This action cannot be undone and will also remove all associated listings.`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
        danger
      />

      {toast && <div className={styles.toast}>{toast}</div>}
    </div>
  );
}
