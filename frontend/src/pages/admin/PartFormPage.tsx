import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Check, Trash2 } from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type { AdminCategory } from '../../types/admin';
import styles from './PartFormPage.module.scss';

// ─── Form shape ────────────────────────────────────────────────────────────

interface FormData {
  sku: string;
  manufacturer_name: string;
  description: string;
  category_id: string;
  datasheet_url: string;
  lifecycle_status: string;
}

interface FormErrors {
  sku?: string;
  manufacturer_name?: string;
}

const LIFECYCLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'nrnd', label: 'NRND (Not Recommended for New Designs)' },
  { value: 'obsolete', label: 'Obsolete' },
];

function emptyForm(): FormData {
  return {
    sku: '',
    manufacturer_name: '',
    description: '',
    category_id: '',
    datasheet_url: '',
    lifecycle_status: 'active',
  };
}

// ─── Select caret SVG (matches bundle <Select>) ────────────────────────────

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

export default function PartFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const [form, setForm] = useState<FormData>(emptyForm());
  const [errors, setErrors] = useState<FormErrors>({});
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(isEdit);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  // Load category options
  useEffect(() => {
    adminApi
      .getCategories()
      .then(setCategories)
      .catch(() => {});
  }, []);

  // Load existing part on edit
  useEffect(() => {
    if (!id) return;
    adminApi
      .getPart(id)
      .then((p) => {
        setForm({
          sku: p.sku,
          manufacturer_name: p.manufacturer_name,
          description: p.description ?? '',
          category_id: p.category_id ?? '',
          datasheet_url: p.datasheet_url ?? '',
          lifecycle_status: p.lifecycle_status,
        });
      })
      .catch(() => setToast({ type: 'error', msg: 'Failed to load part.' }))
      .finally(() => setLoadingExisting(false));
  }, [id]);

  // Auto-clear toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Flatten category tree for select options
  const categoryOptions = useMemo(() => {
    const opts: Array<{ id: string; label: string }> = [];
    for (const cat of categories) {
      opts.push({ id: cat.id, label: `${cat.icon ?? ''} ${cat.name}`.trim() });
      for (const child of cat.children ?? []) {
        opts.push({
          id: child.id,
          label: `  ${child.icon ?? ''} ${cat.name} › ${child.name}`.trim(),
        });
      }
    }
    return opts;
  }, [categories]);

  function set<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): boolean {
    const e: FormErrors = {};
    if (!form.sku.trim()) e.sku = 'SKU is required.';
    if (!form.manufacturer_name.trim()) e.manufacturer_name = 'Manufacturer is required.';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit() {
    if (!validate()) return;
    setSaving(true);
    try {
      const payload = {
        sku: form.sku.trim(),
        manufacturer_name: form.manufacturer_name.trim(),
        description: form.description.trim() || null,
        category_id: form.category_id || null,
        datasheet_url: form.datasheet_url.trim() || null,
        lifecycle_status: form.lifecycle_status,
      };
      if (isEdit && id) {
        await adminApi.updatePart(id, payload);
        setToast({ type: 'success', msg: 'Part updated successfully.' });
        setTimeout(() => navigate(`/admin/parts/${id}`), 900);
      } else {
        const created = await adminApi.createPart(payload);
        setToast({ type: 'success', msg: 'Part created successfully.' });
        setTimeout(() => navigate(`/admin/parts/${created.id}`), 900);
      }
    } catch {
      setToast({ type: 'error', msg: 'Failed to save part. Please try again.' });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!id) return;
    setDeleting(true);
    try {
      await adminApi.deletePart(id);
      setToast({ type: 'success', msg: `Deleted ${form.sku}` });
      setTimeout(() => navigate('/admin/parts'), 700);
    } catch {
      setToast({ type: 'error', msg: 'Failed to delete part.' });
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (loadingExisting) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading part...</div>
      </div>
    );
  }

  const backHref = isEdit ? `/admin/parts/${id}` : '/admin/parts';

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <Link to={backHref} className={styles.backLink}>
            <ArrowLeft />
            {isEdit ? 'Back to part' : 'Parts'}
          </Link>
          <h1 className={styles.title}>{isEdit ? `Edit ${form.sku || 'part'}` : 'New part'}</h1>
          <p className={styles.subtitle}>
            {isEdit
              ? 'Update part information and lifecycle status.'
              : 'Add an individual SKU to the catalog.'}
          </p>
        </div>
      </div>

      <div className={styles.formGrid}>
        {/* Panel 1: Identity */}
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Part identity</h3>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.formBody}>
              <div className={styles.formRow2}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>
                    SKU / Part number
                    <span className={styles.fieldReq}>*</span>
                  </label>
                  <input
                    type="text"
                    className={`${styles.input} ${styles.inputMono} ${errors.sku ? styles.inputError : ''}`}
                    value={form.sku}
                    onChange={(e) => set('sku', e.target.value)}
                    placeholder="STM32F407VGT6"
                    disabled={isEdit}
                  />
                  {errors.sku ? (
                    <div className={styles.fieldError}>{errors.sku}</div>
                  ) : (
                    <div className={styles.fieldHint}>
                      Manufacturer part number, e.g. STM32F407VGT6
                    </div>
                  )}
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>
                    Manufacturer
                    <span className={styles.fieldReq}>*</span>
                  </label>
                  <input
                    type="text"
                    className={`${styles.input} ${errors.manufacturer_name ? styles.inputError : ''}`}
                    value={form.manufacturer_name}
                    onChange={(e) => set('manufacturer_name', e.target.value)}
                    placeholder="STMicroelectronics"
                  />
                  {errors.manufacturer_name && (
                    <div className={styles.fieldError}>{errors.manufacturer_name}</div>
                  )}
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.fieldLabel}>Description</label>
                <textarea
                  className={styles.textarea}
                  value={form.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder="ARM Cortex-M4 168MHz MCU, 1MB Flash, 192KB RAM"
                  rows={3}
                />
                <div className={styles.fieldHint}>
                  Engineer-readable spec string in BOM order.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Panel 2: Classification */}
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Classification</h3>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.formBody}>
              <div className={styles.formRow2}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Category</label>
                  <div className={styles.selectWrap}>
                    <select
                      className={styles.select}
                      value={form.category_id}
                      onChange={(e) => set('category_id', e.target.value)}
                    >
                      <option value="">No category</option>
                      {categoryOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <SelectCaret />
                  </div>
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>
                    Lifecycle status
                    <span className={styles.fieldReq}>*</span>
                  </label>
                  <div className={styles.selectWrap}>
                    <select
                      className={styles.select}
                      value={form.lifecycle_status}
                      onChange={(e) => set('lifecycle_status', e.target.value)}
                    >
                      {LIFECYCLE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <SelectCaret />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Panel 3: Resources */}
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Resources</h3>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.formBody}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Datasheet URL</label>
                <input
                  type="url"
                  className={styles.input}
                  value={form.datasheet_url}
                  onChange={(e) => set('datasheet_url', e.target.value)}
                  placeholder="https://example.com/datasheet.pdf"
                />
                <div className={styles.fieldHint}>
                  Public PDF link — engineers click through from the part detail page.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Form actions */}
        <div className={styles.formActions}>
          {isEdit && (
            <div className={styles.formActionsLeft}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnDangerGhost}`}
                onClick={() => setConfirmDelete(true)}
                disabled={saving || deleting}
              >
                <Trash2 />
                Delete
              </button>
            </div>
          )}
          <Link to={backHref} className={`${styles.btn} ${styles.btnGhost}`}>
            Cancel
          </Link>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={handleSubmit}
            disabled={saving || deleting}
          >
            <Check />
            {saving ? 'Saving...' : isEdit ? 'Save changes' : 'Create part'}
          </button>
        </div>
      </div>

      {confirmDelete && (
        <div className={styles.modalBackdrop} onClick={() => setConfirmDelete(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Delete {form.sku}?</h3>
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
        <div className={`${styles.toast} ${toast.type === 'success' ? styles.toastSuccess : styles.toastError}`}>
          {toast.type === 'success' && <Check />}
          {toast.msg}
        </div>
      )}
    </div>
  );
}
