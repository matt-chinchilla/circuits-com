import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Check } from 'lucide-react';
import Breadcrumbs from '../../components/admin/Breadcrumbs';
import { adminApi } from '../../services/adminApi';
import styles from './SupplierFormPage.module.scss';

// Single-page form (Identity + Contact + Description panels) — port of
// bundle's SupplierForm. Validation mirrors the bundle: name required,
// website optional, email syntactic check.

interface FormData {
  name: string;
  description: string;
  website: string;
  email: string;
  phone: string;
  contact_name: string;
}

interface FormErrors {
  name?: string;
  email?: string;
}

function emptyForm(): FormData {
  return {
    name: '',
    description: '',
    website: '',
    email: '',
    phone: '',
    contact_name: '',
  };
}

export default function SupplierFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const [form, setForm] = useState<FormData>(emptyForm());
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(isEdit);
  const [existingName, setExistingName] = useState('');
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  useEffect(() => {
    if (!id) return;
    adminApi
      .getSupplier(id)
      .then((s) => {
        setExistingName(s.name);
        setForm({
          name: s.name,
          description: s.description ?? '',
          website: s.website ?? '',
          email: s.email ?? '',
          phone: s.phone ?? '',
          contact_name: s.contact_name ?? '',
        });
      })
      .catch(() => setToast({ type: 'error', msg: 'Failed to load supplier.' }))
      .finally(() => setLoadingExisting(false));
  }, [id]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  function set<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): boolean {
    const e: FormErrors = {};
    if (!form.name.trim()) e.name = 'Required';
    if (form.email.trim() && !form.email.includes('@')) e.email = 'Invalid email';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit() {
    if (!validate()) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        website: form.website.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        contact_name: form.contact_name.trim() || null,
      };
      if (isEdit && id) {
        await adminApi.updateSupplier(id, payload);
        setToast({ type: 'success', msg: 'Supplier updated successfully.' });
        setTimeout(() => navigate(`/admin/suppliers/${id}`), 900);
      } else {
        const created = await adminApi.createSupplier(payload);
        setToast({ type: 'success', msg: `Created ${created.name}.` });
        setTimeout(() => navigate(`/admin/suppliers/${created.id}`), 900);
      }
    } catch {
      setToast({ type: 'error', msg: 'Failed to save supplier. Please try again.' });
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    if (isEdit && id) navigate(`/admin/suppliers/${id}`);
    else navigate('/admin/suppliers');
  }

  if (loadingExisting) {
    return <div className={styles.loading}>Loading supplier&hellip;</div>;
  }

  const breadcrumbs = isEdit
    ? [
        { label: 'Dashboard', href: '/admin' },
        { label: 'Suppliers', href: '/admin/suppliers' },
        { label: existingName || 'Edit', href: `/admin/suppliers/${id}` },
        { label: 'Edit' },
      ]
    : [
        { label: 'Dashboard', href: '/admin' },
        { label: 'Suppliers', href: '/admin/suppliers' },
        { label: 'New Supplier' },
      ];

  const pageTitle = isEdit ? `Edit ${existingName || 'Supplier'}` : 'New Supplier';
  const pageSub = isEdit
    ? 'Update the directory entry for this distributor.'
    : 'Add a distributor or manufacturer to the directory.';
  const submitLabel = isEdit ? 'Save changes' : 'Create supplier';
  const backLabel = isEdit ? 'Back to supplier' : 'Suppliers';

  return (
    <div className={styles.page}>
      <Breadcrumbs items={breadcrumbs} />

      <div className={styles.pageHead}>
        <button type="button" className={styles.backLink} onClick={handleCancel}>
          <ArrowLeft size={14} strokeWidth={2} />
          {backLabel}
        </button>
        <h1 className={styles.title}>{pageTitle}</h1>
        <p className={styles.subtitle}>{pageSub}</p>
      </div>

      <form
        className={styles.formGrid}
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Identity</h3>
          </header>
          <div className={styles.panelBody}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="sup-name">
                Company name <span className={styles.fieldReq}>*</span>
              </label>
              <input
                id="sup-name"
                type="text"
                className={`${styles.input} ${errors.name ? styles.inputError : ''}`}
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="e.g. Mouser Electronics"
              />
              {errors.name && <div className={styles.fieldError}>{errors.name}</div>}
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="sup-desc">
                Description
              </label>
              <textarea
                id="sup-desc"
                className={styles.textarea}
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="Global authorized distributor with same-day shipping…"
                rows={3}
              />
              <div className={styles.fieldHint}>One sentence shown in supplier cards.</div>
            </div>
          </div>
        </section>

        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Contact</h3>
          </header>
          <div className={styles.panelBody}>
            <div className={styles.formRow2}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="sup-website">
                  Website
                </label>
                <input
                  id="sup-website"
                  type="url"
                  className={`${styles.input} ${styles.inputMono}`}
                  value={form.website}
                  onChange={(e) => set('website', e.target.value)}
                  placeholder="example.com"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="sup-phone">
                  Phone
                </label>
                <input
                  id="sup-phone"
                  type="tel"
                  className={`${styles.input} ${styles.inputMono}`}
                  value={form.phone}
                  onChange={(e) => set('phone', e.target.value)}
                  placeholder="800-000-0000"
                />
              </div>
            </div>

            <div className={styles.formRow2}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="sup-email">
                  Email
                </label>
                <input
                  id="sup-email"
                  type="email"
                  className={`${styles.input} ${styles.inputMono} ${
                    errors.email ? styles.inputError : ''
                  }`}
                  value={form.email}
                  onChange={(e) => set('email', e.target.value)}
                  placeholder="sales@example.com"
                />
                {errors.email && <div className={styles.fieldError}>{errors.email}</div>}
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="sup-contact">
                  Contact (sales rep)
                </label>
                <input
                  id="sup-contact"
                  type="text"
                  className={styles.input}
                  value={form.contact_name}
                  onChange={(e) => set('contact_name', e.target.value)}
                  placeholder="e.g. Jane Doe"
                />
              </div>
            </div>
          </div>
        </section>

        <div className={styles.formActions}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={handleCancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={saving}
          >
            <Check size={14} strokeWidth={2} />
            {saving ? 'Saving…' : submitLabel}
          </button>
        </div>
      </form>

      {toast && (
        <div
          className={`${styles.toast} ${
            toast.type === 'success' ? styles.toastSuccess : styles.toastError
          }`}
          role="status"
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
