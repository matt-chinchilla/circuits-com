import { useState, useEffect, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit, Trash2, ExternalLink, Check } from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type { PartDetail } from '../../types/admin';
import styles from './PartDetailPage.module.scss';

// ─── Lifecycle status badge ────────────────────────────────────────────────

function lifecycleBadge(status: string) {
  const lower = status.toLowerCase();
  let cls = styles.statusActive;
  if (lower === 'nrnd') cls = styles.statusNrnd;
  else if (lower === 'obsolete') cls = styles.statusObsolete;
  return <span className={`${styles.statusBadge} ${cls}`}>{status}</span>;
}

// ─── Stock color tier ──────────────────────────────────────────────────────

function stockClass(qty: number): string {
  if (qty >= 100) return styles.stockGood;
  if (qty > 0) return styles.stockLow;
  return styles.stockOut;
}

// ─── Supplier lettermark (initials) ────────────────────────────────────────

function lettermark(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
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
    const t = setTimeout(() => setToast(''), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  // Derive sidebar mini-stats from listings
  const { distributorCount, bestPrice, totalStock } = useMemo(() => {
    const listings = part?.listings ?? [];
    const dc = listings.length;
    const bp = listings.length
      ? Math.min(...listings.map((l) => l.unit_price))
      : null;
    const ts = listings.reduce((sum, l) => sum + (l.stock_quantity || 0), 0);
    return { distributorCount: dc, bestPrice: bp, totalStock: ts };
  }, [part]);

  async function handleDelete() {
    if (!id) return;
    setDeleting(true);
    try {
      await adminApi.deletePart(id);
      setToast(`Deleted ${part?.sku ?? 'part'}`);
      setTimeout(() => navigate('/admin/parts'), 800);
    } catch {
      setToast('Failed to delete part.');
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading part details...</div>
      </div>
    );
  }

  if (error || !part) {
    return (
      <div className={styles.page}>
        <div className={styles.pageHead}>
          <div className={styles.pageHeadLeft}>
            <Link to="/admin/parts" className={styles.backLink}>
              <ArrowLeft />
              Parts
            </Link>
            <h1 className={styles.title}>Part not found</h1>
          </div>
        </div>
        <div className={styles.error}>{error || 'Part not found.'}</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <Link to="/admin/parts" className={styles.backLink}>
            <ArrowLeft />
            Parts
          </Link>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{part.sku}</h1>
            {lifecycleBadge(part.lifecycle_status)}
          </div>
          <p className={styles.subtitle}>
            {part.manufacturer_name}
            {part.category_name ? ` · ${part.category_icon ?? ''} ${part.category_name}`.trim() : ''}
          </p>
        </div>
        <div className={styles.pageHeadActions}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnDangerGhost}`}
            onClick={() => setConfirmDelete(true)}
            disabled={deleting}
          >
            <Trash2 />
            Delete
          </button>
          <Link to={`/admin/parts/${id}/edit`} className={`${styles.btn} ${styles.btnPrimary}`}>
            <Edit />
            Edit
          </Link>
        </div>
      </div>

      <div className={styles.detailGrid}>
        {/* Main: KV list of all part fields */}
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Specifications</h3>
          </div>
          <dl className={styles.kvList}>
            <div>
              <dt>SKU</dt>
              <dd className={styles.mono}>{part.sku}</dd>
            </div>
            <div>
              <dt>Manufacturer</dt>
              <dd>{part.manufacturer_name}</dd>
            </div>
            <div>
              <dt>Description</dt>
              <dd>{part.description ?? '—'}</dd>
            </div>
            <div>
              <dt>Category</dt>
              <dd>
                {part.category_name
                  ? `${part.category_icon ?? ''} ${part.category_name}`.trim()
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Lifecycle</dt>
              <dd>{lifecycleBadge(part.lifecycle_status)}</dd>
            </div>
            <div>
              <dt>Datasheet</dt>
              <dd>
                {part.datasheet_url ? (
                  <a
                    href={part.datasheet_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.datasheetLink}
                  >
                    View datasheet
                    <ExternalLink />
                  </a>
                ) : (
                  '—'
                )}
              </dd>
            </div>
          </dl>
        </div>

        {/* Sidebar: mini stats */}
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Distribution</h3>
          </div>
          <div className={styles.miniStats}>
            <div className={styles.miniStat}>
              <div className={styles.miniStatLabel}>Distributors</div>
              <div className={styles.miniStatValue}>{distributorCount}</div>
              <div className={styles.miniStatHint}>carrying this part</div>
            </div>
            <div className={styles.miniStat}>
              <div className={styles.miniStatLabel}>Best price</div>
              <div className={styles.miniStatValue}>
                {bestPrice != null ? `$${bestPrice.toFixed(2)}` : '—'}
              </div>
              <div className={styles.miniStatHint}>
                {bestPrice != null ? 'across all distributors' : 'no listings'}
              </div>
            </div>
            <div className={styles.miniStat}>
              <div className={styles.miniStatLabel}>Stock total</div>
              <div className={styles.miniStatValue}>{totalStock.toLocaleString()}</div>
              <div className={styles.miniStatHint}>units across distributors</div>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.listingsSection}>
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Distributor listings ({part.listings.length})</h3>
          </div>
          {part.listings.length === 0 ? (
            <div className={styles.emptyListings}>No distributor listings for this part.</div>
          ) : (
            part.listings.map((listing) => (
              <div key={listing.id}>
                <div className={styles.listingRow}>
                  <div className={styles.listingIcon}>
                    {lettermark(listing.supplier_name)}
                  </div>
                  <div className={styles.listingText}>
                    <b>{listing.supplier_name ?? '—'}</b>
                    <span>{listing.sku ?? '—'}</span>
                  </div>
                  <div className={styles.listingPrice}>
                    ${listing.unit_price.toFixed(2)}
                  </div>
                  <div className={`${styles.listingStock} ${stockClass(listing.stock_quantity)}`}>
                    {listing.stock_quantity.toLocaleString()}
                  </div>
                  <div className={styles.listingLead}>
                    {listing.lead_time_days != null ? `${listing.lead_time_days}d lead` : '—'}
                  </div>
                </div>
                {listing.price_breaks.length > 0 && (
                  <div className={styles.priceBreaks}>
                    <div className={styles.priceBreakLabel}>Price breaks</div>
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
      </div>

      {confirmDelete && (
        <div className={styles.modalBackdrop} onClick={() => setConfirmDelete(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Delete {part.sku}?</h3>
            <p className={styles.modalBody}>
              This removes the part and all its distributor listings. This action cannot be undone.
            </p>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnDanger}`}
                onClick={handleDelete}
                disabled={deleting}
              >
                <Trash2 />
                {deleting ? 'Deleting...' : 'Delete part'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={styles.toast}>
          <Check />
          {toast}
        </div>
      )}
    </div>
  );
}
