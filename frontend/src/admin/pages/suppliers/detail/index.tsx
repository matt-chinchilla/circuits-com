import { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit, ExternalLink, Upload, Trash2 } from 'lucide-react';
import Breadcrumbs from '@admin/components/Breadcrumbs';
import { adminApi } from '@admin/services/adminApi';
import { useDemo } from '@admin/contexts/DemoContext';
import { syncSupplier, syncErrorMessage, type SyncEvent } from '@admin/services/syncStream';
import type { AdminSupplier, Part, PaginatedResponse } from '@admin/types/admin';
import QuickActionsPanel from './QuickActionsPanel';
import SyncConsole from './SyncConsole';
import {
  buildSponsorshipBySupplier,
  supplierSponsorship,
  type SupplierSponsorship,
} from '../sponsorship';
import { lettermark } from '@shared/utils/lettermark';
import { safeImageUrl } from '@shared/utils/url';
import styles from './SupplierDetailPage.module.scss';

const SPONSORSHIP_CLASS: Record<SupplierSponsorship, string> = {
  Platinum: styles.tierPlatinum,
  Gold: styles.tierGold,
  Silver: styles.tierSilver,
  None: styles.tierNone,
};

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
  // The live inventory-sync run. Owned HERE, not in QuickActionsPanel, so the
  // console's feed survives every re-render of the strip that starts it.
  const [syncState, setSyncState] = useState<{
    running: boolean;
    events: SyncEvent[];
    error: string | null;
  }>({ running: false, events: [], error: null });
  // Bumped when a run ends so the load effect refetches — the supplier's real
  // counts and the parts table both move underneath us during a sync.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Separate from the load-error sentinel so a failed delete shows a
  // dismissible inline message in the modal instead of replacing the
  // whole supplier view with the "supplier not found" fallback.
  const [deleteError, setDeleteError] = useState('');

  // The page is alive across an async sync, so state written after an unmount
  // (or after the operator has navigated to another supplier) has to be
  // dropped. Effects use their own cancel flag; this covers the sync handler,
  // which is not an effect and outlives any single render.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Raised by a finishing sync so the refetch it triggers stays SILENT. The
  // loading curtain replaces the whole page, console included, so a noisy
  // refetch would erase the feed the operator just watched — at the exact
  // moment its summary line appears. Consumed by the next effect run.
  const quietRefetchRef = useRef(false);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const quiet = quietRefetchRef.current;
    quietRefetchRef.current = false;
    if (!quiet) setLoading(true);
    Promise.all([adminApi.getSupplier(id), adminApi.getSupplierParts(id, { page })])
      .then(([s, p]) => {
        if (cancelled) return;
        setSupplier(s);
        setParts(p);
      })
      .catch(() => {
        if (cancelled) return;
        // A failed quiet refetch leaves the (now slightly stale) counts and the
        // run's own summary standing; only a failed FIRST load is fatal.
        if (!quiet) setError('Failed to load supplier details.');
      })
      .finally(() => {
        if (!cancelled && !quiet) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, page, refreshNonce]);

  // Badge = this supplier's actual active sponsorship (highest tier) or 'None'.
  // AdminSupplier has no sponsorship field, so cross-reference the sponsor rows.
  const [sponsorship, setSponsorship] = useState<SupplierSponsorship>('None');
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    adminApi
      .getSponsors()
      .then((spons) => {
        if (cancelled) return;
        setSponsorship(supplierSponsorship(id, buildSponsorshipBySupplier(spons)));
      })
      .catch((e) => {
        console.warn('[SupplierDetailPage] getSponsors failed; badge defaults to None', e);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // A run belongs to the supplier it was started for, and this route reuses ONE
  // component instance across `:id` changes — so navigating to another supplier
  // mid-sync would otherwise leave the still-open stream appending someone
  // else's parts under the new supplier's name. The ref is also what the
  // in-flight run checks before writing state.
  const syncOwnerRef = useRef(id);
  useEffect(() => {
    if (syncOwnerRef.current === id) return;
    syncOwnerRef.current = id;
    setSyncState({ running: false, events: [], error: null });
  }, [id]);

  const handleSync = () => {
    if (!id || syncState.running) return;
    setSyncState({ running: true, events: [], error: null });
    // Tracked out here rather than read off state: a run that dies mid-stream
    // still committed everything it reported (the importer commits per part),
    // so a refetch is owed whenever ANY event arrived — success or not. A run
    // that never started (no feed key, wrong supplier) owes nothing.
    let receivedAny = false;
    const isCurrentRun = () => mountedRef.current && syncOwnerRef.current === id;
    syncSupplier(id, (event) => {
      receivedAny = true;
      if (!isCurrentRun()) return;
      setSyncState((prev) => ({ ...prev, events: [...prev.events, event] }));
    })
      .then(() => {
        if (!isCurrentRun()) return;
        setSyncState((prev) => ({ ...prev, running: false }));
        quietRefetchRef.current = true;
        setRefreshNonce((n) => n + 1);
      })
      .catch((err) => {
        if (!isCurrentRun()) return;
        setSyncState((prev) => ({ ...prev, running: false, error: syncErrorMessage(err) }));
        if (receivedAny) {
          quietRefetchRef.current = true;
          setRefreshNonce((n) => n + 1);
        }
      });
  };

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
  const logoSrc = safeImageUrl(supplier.logo_url);

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
          <div className={styles.titleRow}>
            <div className={styles.avatar}>
              {logoSrc ? (
                <img className={styles.avatarImg} src={logoSrc} alt="" />
              ) : (
                <span>{lettermark(supplier.name)}</span>
              )}
            </div>
            <h1 className={styles.title}>{supplier.name}</h1>
          </div>
          <div className={styles.subtitle}>
            <span className={`${styles.supTier} ${SPONSORSHIP_CLASS[sponsorship]}`}>
              {sponsorship}
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
        onSync={handleSync}
        syncing={syncState.running}
      />

      {/* The run itself, live. Mounts on the first click and stays up
          afterwards so the summary is still readable. */}
      {(syncState.running || syncState.events.length > 0 || syncState.error) && (
        <SyncConsole
          supplierName={supplier.name}
          running={syncState.running}
          events={syncState.events}
          error={syncState.error}
        />
      )}

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
              {demoMode ? (supplier.parts_count ?? 0).toLocaleString() : partsTotal.toLocaleString()}
            </div>
            <div className={styles.miniStatHint}>
              {demoMode
                ? 'Last sync 6h ago'
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
