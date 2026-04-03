import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Breadcrumbs from '../../components/admin/Breadcrumbs';
import { adminApi } from '../../services/adminApi';
import styles from './SupplierFormPage.module.scss';

interface FormData {
  name: string;
  email: string;
  phone: string;
  description: string;
  website: string;
}

interface FormErrors {
  name?: string;
}

const STEPS = ['Company Info', 'Online Presence', 'Review'];

function emptyForm(): FormData {
  return { name: '', email: '', phone: '', description: '', website: '' };
}

export default function SupplierFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormData>(emptyForm());
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(isEdit);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  useEffect(() => {
    if (!id) return;
    adminApi
      .getSupplier(id)
      .then((s) => {
        setForm({
          name: s.name,
          email: s.email ?? '',
          phone: s.phone ?? '',
          description: s.description ?? '',
          website: s.website ?? '',
        });
      })
      .catch(() => setToast({ type: 'error', msg: 'Failed to load supplier.' }))
      .finally(() => setLoadingExisting(false));
  }, [id]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function validate(): boolean {
    const e: FormErrors = {};
    if (!form.name.trim()) e.name = 'Company name is required.';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function handleNext() {
    if (step === 0 && !validate()) return;
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function handleBack() {
    setStep((s) => Math.max(s - 1, 0));
  }

  async function handleSubmit() {
    if (!validate()) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        description: form.description.trim() || null,
        website: form.website.trim() || null,
      };
      if (isEdit && id) {
        await adminApi.updateSupplier(id, payload);
        setToast({ type: 'success', msg: 'Supplier updated successfully.' });
        setTimeout(() => navigate(`/admin/suppliers/${id}`), 1200);
      } else {
        const created = await adminApi.createSupplier(payload);
        setToast({ type: 'success', msg: 'Supplier created successfully.' });
        setTimeout(() => navigate(`/admin/suppliers/${created.id}`), 1200);
      }
    } catch {
      setToast({ type: 'error', msg: 'Failed to save supplier. Please try again.' });
    } finally {
      setSaving(false);
    }
  }

  if (loadingExisting) {
    return <div className={styles.loading}>Loading supplier...</div>;
  }

  const breadcrumbs = isEdit
    ? [
        { label: 'Dashboard', href: '/admin' },
        { label: 'Suppliers', href: '/admin/suppliers' },
        { label: form.name || 'Edit', href: `/admin/suppliers/${id}` },
        { label: 'Edit' },
      ]
    : [
        { label: 'Dashboard', href: '/admin' },
        { label: 'Suppliers', href: '/admin/suppliers' },
        { label: 'New Supplier' },
      ];

  return (
    <div className={styles.page}>
      <Breadcrumbs items={breadcrumbs} />

      <h1 className={styles.title}>{isEdit ? 'Edit Supplier' : 'Add New Supplier'}</h1>
      <p className={styles.subtitle}>
        {isEdit ? 'Update supplier information.' : 'Fill out the details to register a new supplier.'}
      </p>

      <div className={styles.steps}>
        {STEPS.map((label, i) => (
          <div
            key={label}
            className={`${styles.step} ${i === step ? styles.stepActive : ''} ${i < step ? styles.stepDone : ''}`}
          >
            <span className={styles.stepNumber}>{i < step ? '\u2713' : i + 1}</span>
            {label}
          </div>
        ))}
      </div>

      <div className={styles.formCard}>
        {step === 0 && (
          <>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>
                Company Name <span className={styles.required}>*</span>
              </label>
              <input
                className={`${styles.input} ${errors.name ? styles.inputError : ''}`}
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Acme Electronics"
              />
              {errors.name && <div className={styles.errorMsg}>{errors.name}</div>}
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>Email</label>
              <input
                className={styles.input}
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="contact@example.com"
              />
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>Phone</label>
              <input
                className={styles.input}
                type="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="+1 (555) 123-4567"
              />
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>Description</label>
              <textarea
                className={styles.textarea}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Brief description of the company..."
              />
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>Website</label>
              <input
                className={styles.input}
                type="url"
                value={form.website}
                onChange={(e) => setForm({ ...form, website: e.target.value })}
                placeholder="https://www.example.com"
              />
            </div>
          </>
        )}

        {step === 2 && (
          <div className={styles.reviewGrid}>
            <div className={styles.reviewItem}>
              <span className={styles.reviewLabel}>Company Name</span>
              <span className={styles.reviewValue}>{form.name || '\u2014'}</span>
            </div>
            <div className={styles.reviewItem}>
              <span className={styles.reviewLabel}>Email</span>
              <span className={styles.reviewValue}>{form.email || '\u2014'}</span>
            </div>
            <div className={styles.reviewItem}>
              <span className={styles.reviewLabel}>Phone</span>
              <span className={styles.reviewValue}>{form.phone || '\u2014'}</span>
            </div>
            <div className={styles.reviewItem}>
              <span className={styles.reviewLabel}>Website</span>
              <span className={styles.reviewValue}>{form.website || '\u2014'}</span>
            </div>
            <div className={`${styles.reviewItem} ${styles.reviewFull}`}>
              <span className={styles.reviewLabel}>Description</span>
              <span className={styles.reviewValue}>{form.description || '\u2014'}</span>
            </div>
          </div>
        )}
      </div>

      <div className={styles.actions}>
        {step > 0 ? (
          <button className={styles.backBtn} onClick={handleBack}>
            Back
          </button>
        ) : (
          <div />
        )}
        {step < STEPS.length - 1 ? (
          <button className={styles.nextBtn} onClick={handleNext}>
            Next
          </button>
        ) : (
          <button className={styles.nextBtn} onClick={handleSubmit} disabled={saving}>
            {saving ? 'Saving...' : isEdit ? 'Update Supplier' : 'Create Supplier'}
          </button>
        )}
      </div>

      {toast && (
        <div className={`${styles.toast} ${toast.type === 'success' ? styles.toastSuccess : styles.toastError}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
