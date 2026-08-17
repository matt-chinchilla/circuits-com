import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit, Trash2, ExternalLink, Check, Plus } from 'lucide-react';
import { adminApi } from '@admin/services/adminApi';
import Icon from '@shared/components/Icon';
import { lettermark } from '@shared/utils/lettermark';
import { safeHttpUrl, safeImageUrl } from '@shared/utils/url';
import type { PartDetail, PartListing } from '@admin/types/admin';
import styles from './PartDetailPage.module.scss';
import rowStyles from './ListingRowActions.module.scss';

// ─── Confirm-modal target ──────────────────────────────────────────────────
// One modal serves both destructive actions on this page. Keeping a single
// element also keeps the wizard's [data-modal="confirm-delete"] /
// [data-modal-confirm="true"] anchors unique in the DOM.

type PendingDelete =
  | { kind: 'part' }
  | { kind: 'listing'; listing: PartListing };

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

export default function PartDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [part, setPart] = useState<PartDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PendingDelete | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState('');

  // Mounted flag. Every setState on this page happens after an await, and
  // both destructive actions chain a second request — a fast Back-nav out of
  // the page must not write into an unmounted tree. Set on mount (NOT just
  // at declaration) because StrictMode runs setup → cleanup → setup on the
  // same instance, which would otherwise leave the flag permanently false.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    adminApi
      .getPart(id)
      .then((fresh) => {
        if (cancelled || !alive.current) return;
        setPart(fresh);
      })
      .catch(() => {
        if (cancelled || !alive.current) return;
        setError('Failed to load part details.');
      })
      .finally(() => {
        if (cancelled || !alive.current) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
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

  async function deleteThePart() {
    if (!id) return;
    try {
      await adminApi.deletePart(id);
      if (!alive.current) return;
      setToast(`Deleted ${part?.sku ?? 'part'}`);
      setTimeout(() => {
        if (alive.current) navigate('/admin/parts');
      }, 800);
    } catch {
      if (!alive.current) return;
      setToast('Failed to delete part.');
    }
  }

  // Listing-scoped: the part stays in the catalog, only this distributor's
  // listing (and its price breaks) go. Re-fetch so the row disappears and the
  // Distribution mini-stats re-derive from the remaining listings.
  async function deleteTheListing(listing: PartListing) {
    if (!id) return;
    try {
      await adminApi.deletePartListing(id, listing.id);
      const fresh = await adminApi.getPart(id);
      if (!alive.current) return;
      setPart(fresh);
      setToast(`Removed ${listing.supplier_name ?? 'distributor'}`);
    } catch {
      if (!alive.current) return;
      setToast('Failed to remove listing.');
    }
  }

  async function handleConfirmDelete() {
    if (!pending) return;
    setDeleting(true);
    try {
      if (pending.kind === 'part') await deleteThePart();
      else await deleteTheListing(pending.listing);
    } finally {
      if (alive.current) {
        setDeleting(false);
        setPending(null);
      }
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

  // One sanitizing parse per render, referenced twice in the JSX below —
  // mirrors the public PartPage's partImage/datasheetHref locals.
  const datasheetHref = safeHttpUrl(part.datasheet_url);
  const productImageHref = safeImageUrl(part.image_url);

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
            {(part.parent_category_name || part.category_name) && (
              <>
                {' · '}
                <Icon name={part.parent_category_icon ?? part.category_icon} />{' '}
                {part.parent_category_name ?? part.category_name}
                {part.parent_category_name && part.category_name && ` (${part.category_name})`}
              </>
            )}
          </p>
        </div>
        <div className={styles.pageHeadActions}>
          <button
            type="button"
            data-tour="delete-part"
            // Page identity for the wizard's cleanup step: it spotlights this
            // button ONLY when the id matches the demo part its own tour
            // created — every other part is real catalog data. See flows.tsx.
            data-entity-id={id}
            className={`${styles.btn} ${styles.btnDangerGhost}`}
            onClick={() => setPending({ kind: 'part' })}
            disabled={deleting}
          >
            <Trash2 />
            Delete
          </button>
          <Link
            to={`/admin/parts/${id}/listings/new`}
            data-tour="add-listing"
            className={`${styles.btn} ${styles.btnGhost}`}
          >
            <Plus />
            Add distributor
          </Link>
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
                {part.parent_category_name || part.category_name ? (
                  <span className={styles.catCell}>
                    <Icon name={part.parent_category_icon ?? part.category_icon} />
                    <span>
                      {part.parent_category_name ?? part.category_name}
                      {part.parent_category_name && part.category_name && (
                        <span className={styles.catCellSub}> ({part.category_name})</span>
                      )}
                    </span>
                  </span>
                ) : (
                  '—'
                )}
              </dd>
            </div>
            <div>
              <dt>Lifecycle</dt>
              <dd>{lifecycleBadge(part.lifecycle_status)}</dd>
            </div>
            <div>
              <dt>Datasheet</dt>
              <dd>
                {datasheetHref ? (
                  <a
                    href={datasheetHref}
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
            <div>
              <dt>Product image</dt>
              <dd>
                {productImageHref ? (
                  <a
                    href={productImageHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.datasheetLink}
                  >
                    View image
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
                  <div className={`${styles.listingLead} ${rowStyles.leadCell}`}>
                    <span>
                      {listing.lead_time_days != null ? `${listing.lead_time_days}d lead` : '—'}
                    </span>
                    <button
                      type="button"
                      data-tour="delete-listing"
                      // Row identity for the wizard's detach step: it must
                      // spotlight the ONE demo listing it created and never
                      // guess at a real distributor row. See flows.tsx.
                      data-listing-id={listing.id}
                      // Marker for the wizard's defense-in-depth check: the
                      // detach step also verifies this bears the DEMO- SKU
                      // before spotlighting, so a real row can never be it.
                      data-listing-sku={listing.sku ?? undefined}
                      className={rowStyles.removeBtn}
                      onClick={() => setPending({ kind: 'listing', listing })}
                      disabled={deleting}
                      aria-label={`Remove ${listing.supplier_name ?? 'distributor'} listing`}
                    >
                      <Trash2 />
                      Remove
                    </button>
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

      {pending && (
        <div
          className={styles.modalBackdrop}
          data-modal="confirm-delete"
          // ⚠ DATA SAFETY. One modal serves both destructive actions, so
          // "a confirm-delete modal is open" alone tells the wizard nothing
          // about WHICH row it targets. Stamping the pending target lets the
          // detach tour prove the open dialog belongs to the demo listing it
          // created before it tells the user to go through with it — every
          // other row here is real catalog data. See flows.tsx.
          data-modal-kind={pending.kind}
          data-modal-listing-id={pending.kind === 'listing' ? pending.listing.id : undefined}
          data-modal-listing-sku={
            pending.kind === 'listing' ? (pending.listing.sku ?? undefined) : undefined
          }
          onClick={() => setPending(null)}
        >
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>
              {pending.kind === 'part'
                ? `Delete ${part.sku}?`
                : `Remove ${pending.listing.supplier_name ?? 'this distributor'}?`}
            </h3>
            <p className={styles.modalBody}>
              {pending.kind === 'part'
                ? 'This removes the part and all its distributor listings. This action cannot be undone.'
                : `This removes the ${pending.listing.supplier_name ?? 'distributor'} listing and its price breaks. ${part.sku} stays in the catalog.`}
            </p>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                onClick={() => setPending(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                data-modal-confirm="true"
                className={`${styles.btn} ${styles.btnDanger}`}
                onClick={handleConfirmDelete}
                disabled={deleting}
              >
                <Trash2 />
                {pending.kind === 'part'
                  ? deleting
                    ? 'Deleting...'
                    : 'Delete part'
                  : deleting
                    ? 'Removing...'
                    : 'Remove listing'}
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
