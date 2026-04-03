import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import Breadcrumbs from '../../components/admin/Breadcrumbs';
import { adminApi } from '../../services/adminApi';
import type { AdminCategory } from '../../types/admin';
import styles from './PartFormPage.module.scss';

interface FormData {
  mpn: string;
  manufacturer_name: string;
  description: string;
  category_id: string;
  datasheet_url: string;
  lifecycle_status: string;
}

interface FormErrors {
  mpn?: string;
  manufacturer_name?: string;
}

function emptyForm(): FormData {
  return {
    mpn: '',
    manufacturer_name: '',
    description: '',
    category_id: '',
    datasheet_url: '',
    lifecycle_status: 'active',
  };
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
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  useEffect(() => {
    adminApi.getCategories().then(setCategories).catch(() => {});
  }, []);

  useEffect(() => {
    if (!id) return;
    adminApi
      .getPart(id)
      .then((p) => {
        setForm({
          mpn: p.mpn,
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

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function validate(): boolean {
    const e: FormErrors = {};
    if (!form.mpn.trim()) e.mpn = 'MPN is required.';
    if (!form.manufacturer_name.trim()) e.manufacturer_name = 'Manufacturer is required.';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit() {
    if (!validate()) return;
    setSaving(true);
    try {
      const payload = {
        mpn: form.mpn.trim(),
        manufacturer_name: form.manufacturer_name.trim(),
        description: form.description.trim() || null,
        category_id: form.category_id || null,
        datasheet_url: form.datasheet_url.trim() || null,
        lifecycle_status: form.lifecycle_status,
      };
      if (isEdit && id) {
        await adminApi.updatePart(id, payload);
        setToast({ type: 'success', msg: 'Part updated successfully.' });
        setTimeout(() => navigate(`/admin/parts/${id}`), 1200);
      } else {
        const created = await adminApi.createPart(payload);
        setToast({ type: 'success', msg: 'Part created successfully.' });
        setTimeout(() => navigate(`/admin/parts/${created.id}`), 1200);
      }
    } catch {
      setToast({ type: 'error', msg: 'Failed to save part. Please try again.' });
    } finally {
      setSaving(false);
    }
  }

  if (loadingExisting) {
    return <div className={styles.loading}>Loading part...</div>;
  }

  const breadcrumbs = isEdit
    ? [
        { label: 'Dashboard', href: '/admin' },
        { label: 'Parts', href: '/admin/parts' },
        { label: form.mpn || 'Edit', href: `/admin/parts/${id}` },
        { label: 'Edit' },
      ]
    : [
        { label: 'Dashboard', href: '/admin' },
        { label: 'Parts', href: '/admin/parts' },
        { label: 'New Part' },
      ];

  // Build flat category options from tree
  const categoryOptions: Array<{ id: string; label: string }> = [];
  for (const cat of categories) {
    categoryOptions.push({ id: cat.id, label: cat.name });
    for (const child of cat.children) {
      categoryOptions.push({ id: child.id, label: `${cat.name} > ${child.name}` });
    }
  }

  return (
    <div className={styles.page}>
      <Breadcrumbs items={breadcrumbs} />

      <h1 className={styles.title}>{isEdit ? 'Edit Part' : 'Add New Part'}</h1>
      <p className={styles.subtitle}>
        {isEdit ? 'Update part information.' : 'Enter the details for a new electronic component.'}
      </p>

      <div className={styles.formCard}>
        <h2 className={styles.sectionTitle}>Part Information</h2>

        <div className={styles.fieldRow}>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>
              MPN <span className={styles.required}>*</span>
            </label>
            <input
              className={`${styles.input} ${errors.mpn ? styles.inputError : ''}`}
              type="text"
              value={form.mpn}
              onChange={(e) => setForm({ ...form, mpn: e.target.value })}
              placeholder="e.g. ATmega328P-PU"
            />
            {errors.mpn && <div className={styles.errorMsg}>{errors.mpn}</div>}
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>
              Manufacturer <span className={styles.required}>*</span>
            </label>
            <input
              className={`${styles.input} ${errors.manufacturer_name ? styles.inputError : ''}`}
              type="text"
              value={form.manufacturer_name}
              onChange={(e) => setForm({ ...form, manufacturer_name: e.target.value })}
              placeholder="e.g. Microchip Technology"
            />
            {errors.manufacturer_name && <div className={styles.errorMsg}>{errors.manufacturer_name}</div>}
          </div>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>Description</label>
          <textarea
            className={styles.textarea}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Brief description of the component..."
          />
        </div>

        <div className={styles.fieldRow}>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>Category</label>
            <select
              className={styles.select}
              value={form.category_id}
              onChange={(e) => setForm({ ...form, category_id: e.target.value })}
            >
              <option value="">No category</option>
              {categoryOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>Lifecycle Status</label>
            <select
              className={styles.select}
              value={form.lifecycle_status}
              onChange={(e) => setForm({ ...form, lifecycle_status: e.target.value })}
            >
              <option value="active">Active</option>
              <option value="nrnd">NRND</option>
              <option value="obsolete">Obsolete</option>
            </select>
          </div>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>Datasheet URL</label>
          <input
            className={styles.input}
            type="url"
            value={form.datasheet_url}
            onChange={(e) => setForm({ ...form, datasheet_url: e.target.value })}
            placeholder="https://example.com/datasheet.pdf"
          />
        </div>
      </div>

      <div className={styles.actions}>
        <Link to={isEdit ? `/admin/parts/${id}` : '/admin/parts'} className={styles.cancelBtn}>
          Cancel
        </Link>
        <button className={styles.submitBtn} onClick={handleSubmit} disabled={saving}>
          {saving ? 'Saving...' : isEdit ? 'Update Part' : 'Create Part'}
        </button>
      </div>

      {toast && (
        <div className={`${styles.toast} ${toast.type === 'success' ? styles.toastSuccess : styles.toastError}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
