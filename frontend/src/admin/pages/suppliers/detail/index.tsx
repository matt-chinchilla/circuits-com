import { useState, useEffect, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit, ExternalLink, Upload, Trash2 } from 'lucide-react';
import Breadcrumbs from '@admin/components/Breadcrumbs';
import { adminApi } from '@admin/services/adminApi';
import { useDemo } from '@admin/contexts/DemoContext';
import type { AdminSupplier, Part, PaginatedResponse } from '@admin/types/admin';
import QuickActionsPanel from './QuickActionsPanel';
import styles from './SupplierDetailPage.module.scss';

type Tier = 'featured' | 'platinum' | 'gold' | 'silver';

const TIER_CLASS: Record<Tier, string> = {
  featured: styles.tierFeatured,
  platinum: styles.tierPlatinum,
  gold: styles.tierGold,
  silver: styles.tierSilver,
};

function deriveTier(s: AdminSupplier): Tier {
  const n = s.parts_count ?? 0;
  if (n >= 200) return 'featured';
  if (n >= 100) return 'platinum';
  if (n >= 25) return 'gold';
  return 'silver';
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

function externalHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export default function SupplierDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { demoMode } = useDemo();
  const [supplier, setSupplier] = useState<AdminSupplier | null>(null);
  const [parts, setParts] = useState<PaginatedResponse<Part> | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Sync action stamps a fake "Last sync just now" hint after the simulated
  // delta lands. Stays local until a real /sync endpoint exists.
  const [lastSyncStamp, setLastSyncStamp] = useState<string | null>(null);
  const [syncDelta, setSyncDelta] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Separate from the load-error sentinel so a failed delete shows a
  // dismissible inline message in the modal instead of replacing the
  // whole supplier view with the "supplier not found" fallback.
  const [deleteError, setDeleteError] = useState('');

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

  const tier = useMemo(() => (supplier ? deriveTier(supplier) : null), [supplier]);

  const handleDelete = async () => {
    if (!supplier) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await adminApi.deleteSupplier(supplier.id);
      navigate('/admin/suppliers');
    } catch (err) {
      // Surface in the modal — don't replace the whole detail view with
      // the load-error fallback. User stays on the page and can retry.
      console.warn('[SupplierDetailPage] deleteSupplier failed', err);
      setDeleteError('Failed to delete supplier. Please try again.');
    } finally {
      setDeleting(false);
    }
  };

  const closeDeleteModal = () => {
    setConfirmDelete(false);
    setDeleteError('');
  };

  if (loading) {
    return <div className={styles.loading}>Loading supplier details&hellip;</div>;
  }

  if (error || !supplier) {
    return (
      <div className={styles.page}>
        <Breadcrumbs
          items={[
            { label: 'Dashboard', href: '/admin' },
            { label: 'Suppliers', href: '/admin/suppliers' },
            { label: 'Error' },
          ]}
        />
        <div className={styles.errorPanel}>{error || 'Supplier not found.'}</div>
      </div>
    );
  }

  const partRows = parts?.items ?? [];
  const partsTotal = parts?.total ?? 0;
  const websiteHost = supplier.website ? stripScheme(supplier.website) : null;

  return (
    <div className={styles.page}>
      <Breadcrumbs
        items={[
          { label: 'Dashboard', href: '/admin' },
          { label: 'Suppliers', href: '/admin/suppliers' },
          { label: supplier.name },
        ]}
      />

      <div className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <button type="button" className={styles.backLink} onClick={() => navigate('/admin/suppliers')}>
            <ArrowLeft size={14} strokeWidth={2} />
            All suppliers
          </button>
          <h1 className={styles.title}>{supplier.name}</h1>
          {tier && (
            <div className={styles.subtitle}>
              <span className={`${styles.supTier} ${TIER_CLASS[tier]}`}>
                {tier.charAt(0).toUpperCase() + tier.slice(1)}
              </span>
              {websiteHost && (
                <>
                  <span>&middot;</span>
                  <a
                    href={externalHref(supplier.website as string)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.extLink}
                  >
                    {websiteHost}
                    <ExternalLink size={11} strokeWidth={2} />
                  </a>
                </>
              )}
            </div>
          )}
        </div>
        <div className={styles.pageHeadActions}>
          <button
            type="button"
            data-tour="delete-supplier"
            className={`${styles.btn} ${styles.btnDangerGhost}`}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={14} strokeWidth={2} />
            Delete
          </button>
          <Link to={`/admin/suppliers/${supplier.id}/edit`} className={`${styles.btn} ${styles.btnGhost}`}>
            <Edit size={14} strokeWidth={2} />
            Edit
          </Link>
        </div>
      </div>

      {/* Hero quick-actions strip — full-width row of 4 prominent cards.
          Sits where supplier-detail spends its most-clicked time. The
          first card (Add part) replaces the prior header "Add Part"
          button so the page CTA is the strip itself. */}
      <QuickActionsPanel
        supplier={supplier}
        partRows={partRows}
        onAfterSync={(delta) => {
          setSyncDelta(delta);
          setLastSyncStamp('just now');
        }}
      />

      <div className={styles.detailGrid}>
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Company</h3>
          </div>
          <dl className={styles.kvList}>
            <div>
              <dt>Contact</dt>
              <dd>{supplier.contact_name || '—'}</dd>
            </div>
            <div>
              <dt>Phone</dt>
              <dd className={styles.mono}>{supplier.phone || '—'}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd className={styles.mono}>{supplier.email || '—'}</dd>
            </div>
            <div>
              <dt>Website</dt>
              <dd className={styles.mono}>{websiteHost || '—'}</dd>
            </div>
            <div>
              <dt>Categories</dt>
              <dd>
                {supplier.categories && supplier.categories.length > 0
                  ? supplier.categories.join(', ')
                  : '—'}
              </dd>
            </div>
          </dl>
          {supplier.description && (
            <div className={styles.panelBody}>
              <h4 className={styles.panelSubtitle}>Description</h4>
              <p className={styles.panelText}>{supplier.description}</p>
            </div>
          )}
        </div>

        <div className={styles.sidebarStack}>
          <div className={`${styles.panel} ${styles.miniStat}`}>
            <div className={styles.miniStatLabel}>Parts in catalog</div>
            <div className={styles.miniStatValue}>
              {demoMode
                ? ((supplier.parts_count ?? 0) + (syncDelta ?? 0)).toLocaleString()
                : partsTotal.toLocaleString()}
            </div>
            <div className={styles.miniStatHint}>
              {demoMode
                ? `Last sync ${lastSyncStamp ?? '6h ago'}`
                : partsTotal > 0
                  ? `${partsTotal} live SKU${partsTotal === 1 ? '' : 's'}`
                  : 'No live listings yet'}
            </div>
          </div>
          <div className={`${styles.panel} ${styles.miniStat}`}>
            <div className={styles.miniStatLabel}>Revenue</div>
            <div className={styles.miniStatValue}>
              ${(supplier.revenue_total ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </div>
            <div className={styles.miniStatHint}>Lifetime, all sources</div>
          </div>
          <div className={`${styles.panel} ${styles.miniStat}`}>
            <div className={styles.miniStatLabel}>Categories</div>
            <div className={styles.miniStatValue}>{supplier.categories?.length ?? 0}</div>
            <div className={styles.miniStatHint}>
              {supplier.categories && supplier.categories.length > 0
                ? supplier.categories.slice(0, 2).join(', ')
                : 'None linked yet'}
            </div>
          </div>
        </div>
      </div>

      <div className={`${styles.panel} ${styles.partsPanel}`}>
        <div className={styles.panelHead}>
          <h3 className={styles.panelTitle}>Listed Parts ({partsTotal})</h3>
          <Link to="/admin/parts" className={styles.panelLink}>
            All parts &rarr;
          </Link>
        </div>
        {partRows.length === 0 ? (
          <div className={styles.partsEmpty}>
            No parts uploaded yet &mdash; supplier is live but their inventory is empty.
            <div>
              <Link to="/admin/import" className={`${styles.btn} ${styles.btnGhost}`}>
                <Upload size={14} strokeWidth={2} />
                Upload parts CSV
              </Link>
            </div>
          </div>
        ) : (
          <>
            <table className={styles.partsTable}>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Manufacturer</th>
                  <th>Description</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {partRows.map((p) => (
                  <tr key={p.id} onClick={() => navigate(`/admin/parts/${p.id}`)}>
                    <td className={styles.mono}>{p.sku}</td>
                    <td>{p.manufacturer_name}</td>
                    <td>{p.description || '—'}</td>
                    <td>
                      <span className={styles.statusPill}>{p.lifecycle_status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parts && parts.pages > 1 && (
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
                  Page {parts.page} of {parts.pages}
                </span>
                <button
                  type="button"
                  className={styles.pageBtn}
                  disabled={page >= parts.pages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {confirmDelete && (
        <div
          className={styles.modalBackdrop}
          data-modal="confirm-delete"
          onClick={closeDeleteModal}
        >
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Delete {supplier.name}?</h3>
            <p className={styles.modalBody}>
              This removes the supplier from the directory, unlinks them from
              any parts (PartListings), and deletes their sponsorships. This
              action cannot be undone.
            </p>
            {deleteError && <div className={styles.modalError}>{deleteError}</div>}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                onClick={closeDeleteModal}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                data-modal-confirm="true"
                className={`${styles.btn} ${styles.btnDanger}`}
                onClick={handleDelete}
                disabled={deleting}
              >
                <Trash2 size={14} strokeWidth={2} />
                {deleting ? 'Deleting…' : 'Delete supplier'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
