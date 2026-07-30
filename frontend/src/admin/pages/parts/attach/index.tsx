import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Check, AlertCircle } from 'lucide-react';
import { adminApi } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import type { AdminSupplier, PartDetail } from '@admin/types/admin';
import styles from './AttachListingPage.module.scss';

// ─── Form shape ────────────────────────────────────────────────────────────
// Every value is held as a string so the number inputs can be empty (an
// empty <input type="number"> yields '' — coercing that early would write a
// premature 0 into the form state and make the placeholder unreachable).

interface FormData {
  supplier_id: string;
  stock_quantity: string;
  unit_price: string;
  listing_sku: string;
  lead_time_days: string;
}

const emptyForm: FormData = {
  supplier_id: '',
  stock_quantity: '',
  unit_price: '',
  listing_sku: '',
  lead_time_days: '',
};

/** '' → null, garbage → null, otherwise the parsed number. */
function numOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

// ─── Select caret SVG (matches the part form) ──────────────────────────────

function SelectCaret() {
  return (
    <svg className={styles.selectCaret} viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M2 4l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function AttachListingPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [part, setPart] = useState<PartDetail | null>(null);
  const [suppliers, setSuppliers] = useState<AdminSupplier[]>([]);
  const [form, setForm] = useState<FormData>(emptyForm);
  const [supplierError, setSupplierError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  // Latches on the FIRST successful POST and never clears: the success path
  // shows a toast for 700ms before navigating away, and re-enabling the
  // button in that window let a second click fire a duplicate POST that came
  // back 409 — painting a red "already carries this part" error over a save
  // that actually worked.
  const [done, setDone] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [toast, setToast] = useState('');
  const navTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (navTimerRef.current != null) window.clearTimeout(navTimerRef.current);
    },
    [],
  );

  // Cancel-flagged so a fast back-nav can't set state on an unmounted page.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    adminApi
      .getPart(id)
      .then((p) => {
        if (cancelled) return;
        setPart(p);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError('Failed to load this part.');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    adminApi
      .getSuppliers()
      .then((rows) => {
        if (cancelled) return;
        setSuppliers(rows);
      })
      .catch(() => {
        if (cancelled) return;
        setSubmitError('Could not load the distributor list. Reload the page to try again.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  // Distributors already carrying this part. The backend rejects a duplicate
  // with a 409, so surfacing it here turns a dead-end error into a disabled
  // option the admin can see before submitting.
  const carrying = useMemo(
    () => new Set((part?.listings ?? []).map((l) => l.supplier_id)),
    [part],
  );

  const supplierOptions = useMemo(
    () =>
      [...suppliers]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => ({
          id: s.id,
          name: s.name,
          taken: carrying.has(s.id),
        })),
    [suppliers, carrying],
  );

  const selectedSupplier = supplierOptions.find((s) => s.id === form.supplier_id);

  function set<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): boolean {
    if (!form.supplier_id) {
      setSupplierError('Pick a distributor.');
      return false;
    }
    setSupplierError('');
    return true;
  }

  async function handleSubmit() {
    if (!id || saving || done) return;
    if (!validate()) return;
    setSaving(true);
    setSubmitError('');
    try {
      const listingSku = form.listing_sku.trim();
      const created = await adminApi.addPartListing(id, {
        supplier_id: form.supplier_id,
        stock_quantity: numOrNull(form.stock_quantity) ?? 0,
        unit_price: numOrNull(form.unit_price) ?? 0,
        listing_sku: listingSku || null,
        lead_time_days: numOrNull(form.lead_time_days),
      });
      // ─── Wizard id-from-response bridge ─────────────────────────────────
      // The demo tour cannot learn this id any other way: it is not in the URL
      // and not on any anchor, and inferring it from the submit-navigation
      // MISSES the create whenever the user hits Back during the toast delay
      // below — which used to leave a synthetic demo listing on a REAL catalog
      // SKU that nothing would ever clean up. Publish it synchronously, BEFORE
      // the navigate, so tracking is independent of navigation timing.
      //
      // Harmless outside a tour: the wizard only adopts a bridge for the part
      // whose attach form its own tour opened, and clears it on flow start/end.
      if (created.id) {
        window.__wizardCreatedListing = {
          partId: id,
          listingId: created.id,
          supplierId: form.supplier_id,
        };
      }
      setDone(true);
      setToast(`Added ${selectedSupplier?.name ?? 'distributor'} to ${part?.sku ?? 'part'}`);
      navTimerRef.current = window.setTimeout(
        () => navigate(`/admin/parts/${id}`),
        700,
      );
    } catch (err) {
      // A 409 ("<Supplier> already carries <SKU>") stays on screen until the
      // admin picks a different distributor — an auto-dismissing toast would
      // leave them guessing what to change.
      setSubmitError(
        apiErrorDetail(err) ??
          'Could not add the distributor. Check the values and try again.',
      );
      // Only the FAILURE path re-arms the button; on success it stays
      // disabled through the navigate delay (see `done`).
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading part...</div>
      </div>
    );
  }

  if (loadError || !part) {
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
        <div className={styles.error}>{loadError || 'Part not found.'}</div>
      </div>
    );
  }

  const backHref = `/admin/parts/${id}`;

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <Link to={backHref} className={styles.backLink}>
            <ArrowLeft />
            Back to {part.sku}
          </Link>
          <h1 className={styles.title}>Add distributor</h1>
          <p className={styles.subtitle}>
            List an existing part in one more distributor&rsquo;s catalog. The part
            itself is unchanged.
          </p>
        </div>
      </div>

      <div className={styles.formGrid}>
        {/* Panel 1: read-only part identity — the SKU is fixed on this page */}
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Part</h3>
            <span className={styles.panelNote}>Edit these on the part itself</span>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.idGrid}>
              <div className={styles.idItem}>
                <span className={styles.idLabel}>SKU</span>
                <span className={styles.idSku}>{part.sku}</span>
              </div>
              <div className={styles.idItem}>
                <span className={styles.idLabel}>Manufacturer</span>
                <span className={styles.idValue}>{part.manufacturer_name}</span>
              </div>
              <div className={`${styles.idItem} ${styles.idItemWide}`}>
                <span className={styles.idLabel}>Description</span>
                <span className={styles.idValue}>
                  {part.description ? part.description : <>&mdash;</>}
                </span>
              </div>
              <div className={`${styles.idItem} ${styles.idItemWide}`}>
                <span className={styles.idLabel}>
                  Already listed by ({part.listings.length})
                </span>
                {part.listings.length === 0 ? (
                  <span className={styles.idValue}>No distributors yet.</span>
                ) : (
                  <div className={styles.carrierList}>
                    {part.listings.map((l) => (
                      <span key={l.id} className={styles.carrierChip}>
                        {l.supplier_name ?? 'Unnamed distributor'}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Panel 2: the listing itself — mirrors the part form's Initial listing */}
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Listing</h3>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.formBody}>
              <div className={styles.field} data-field="supplier_id">
                <label className={styles.fieldLabel}>
                  Distributor
                  <span className={styles.fieldReq}>*</span>
                </label>
                <div className={styles.selectWrap}>
                  <select
                    className={`${styles.select} ${supplierError ? styles.inputError : ''}`}
                    value={form.supplier_id}
                    onChange={(e) => {
                      set('supplier_id', e.target.value);
                      setSupplierError('');
                      setSubmitError('');
                    }}
                  >
                    <option value="">Select a distributor</option>
                    {supplierOptions.map((opt) => (
                      <option key={opt.id} value={opt.id} disabled={opt.taken}>
                        {opt.taken ? `${opt.name} (already listed)` : opt.name}
                      </option>
                    ))}
                  </select>
                  <SelectCaret />
                </div>
                {supplierError ? (
                  <div className={styles.fieldError}>{supplierError}</div>
                ) : (
                  <div className={styles.fieldHint}>
                    Distributors already carrying this part are greyed out.
                  </div>
                )}
              </div>

              <div className={styles.formRow2}>
                <div className={styles.field} data-field="initial_stock_quantity">
                  <label className={styles.fieldLabel}>Stock quantity</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    className={`${styles.input} ${styles.inputMono}`}
                    value={form.stock_quantity}
                    onChange={(e) => set('stock_quantity', e.target.value)}
                    placeholder="10000"
                  />
                  <div className={styles.fieldHint}>
                    Units on hand at this distributor. Defaults to 0.
                  </div>
                </div>
                <div className={styles.field} data-field="initial_unit_price">
                  <label className={styles.fieldLabel}>Unit price (USD)</label>
                  <input
                    type="number"
                    min="0"
                    max="999999"
                    step="0.0001"
                    className={`${styles.input} ${styles.inputMono}`}
                    value={form.unit_price}
                    onChange={(e) => set('unit_price', e.target.value)}
                    placeholder="0.48"
                  />
                  <div className={styles.fieldHint}>
                    Per-unit price for single-quantity orders.
                  </div>
                </div>
              </div>

              <div className={styles.formRow2}>
                <div className={styles.field} data-field="listing_sku">
                  <label className={styles.fieldLabel}>Distributor part number</label>
                  <input
                    type="text"
                    // Mirrors the backend contract (Field(max_length=100) on
                    // PartListingCreate.listing_sku) so an over-long paste is
                    // trimmed at the keystroke instead of coming back as a 422.
                    maxLength={100}
                    className={`${styles.input} ${styles.inputMono}`}
                    value={form.listing_sku}
                    onChange={(e) => set('listing_sku', e.target.value)}
                    placeholder="AVN-LM7805CT"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <div className={styles.fieldHint}>
                    The distributor&rsquo;s own order code, if it differs from the MPN.
                  </div>
                </div>
                <div className={styles.field} data-field="lead_time_days">
                  <label className={styles.fieldLabel}>Lead time (days)</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    className={`${styles.input} ${styles.inputMono}`}
                    value={form.lead_time_days}
                    onChange={(e) => set('lead_time_days', e.target.value)}
                    placeholder="3"
                  />
                  <div className={styles.fieldHint}>
                    Days to ship when stock runs out. Leave empty if unknown.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {submitError && (
          <div className={styles.submitError} role="alert">
            <AlertCircle />
            <span>{submitError}</span>
          </div>
        )}

        <div className={styles.formActions}>
          <Link to={backHref} className={`${styles.btn} ${styles.btnGhost}`}>
            Cancel
          </Link>
          <button
            type="button"
            data-tour="submit-listing"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={handleSubmit}
            disabled={saving || done}
          >
            <Check />
            {done ? 'Added' : saving ? 'Adding...' : 'Add distributor'}
          </button>
        </div>
      </div>

      {toast && (
        <div className={styles.toast}>
          <Check />
          {toast}
        </div>
      )}
    </div>
  );
}
