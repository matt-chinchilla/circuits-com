import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Trash2 } from 'lucide-react';
import Breadcrumbs from '@admin/components/Breadcrumbs';
import { adminApi } from '@admin/services/adminApi';
import { prependScheme } from '@shared/utils/url';
import ImageUploadField from '@admin/components/ImageUploadField';
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
  contact_role: string;
  coverage_hours: string;
  logo_url: string;
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
    contact_role: '',
    coverage_hours: '',
    logo_url: '',
  };
}

// ─── Website + phone input helpers ──────────────────────────────────────────
// Website: the form shows `https://` as a fixed prefix adornment so the user
// types just `example.com`. stripScheme strips on hydrate; prependScheme
// (shared in @shared/utils/url) prepends on submit so the API always stores
// with scheme. Bare and prefixed forms are both accepted by the backend
// (test_create_supplier_accepts_bare_domain_website) so legacy rows without
// scheme don't 422 on edit.
function stripScheme(s: string): string {
  return s.replace(/^https?:\/\//i, '');
}

// Phone: shows live as `(123) 456-7890` while the user types. Strips the
// US country-code "1" when input is 11 digits starting with "1" — so paste
// from "+1 (800) 555-0000" / "1-800-555-0000" snaps to the right area code
// instead of mangling to "(180) 055-5000". After the country-code strip,
// anything beyond 10 digits is dropped (a true international number won't
// fit US format anyway — defer non-US shapes to a follow-up).
function formatPhoneInput(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }
  digits = digits.slice(0, 10);
  if (digits.length === 0) return '';
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export default function SupplierFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const [form, setForm] = useState<FormData>(emptyForm());
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
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
          // Strip scheme so it doesn't double-display in the prefixed input.
          website: stripScheme(s.website ?? ''),
          email: s.email ?? '',
          // Normalize any incoming phone shape ("800-555-0000", "+1800555…")
          // into the live (xxx) xxx-xxxx display the formatter expects.
          phone: formatPhoneInput(s.phone ?? ''),
          contact_name: s.contact_name ?? '',
          contact_role: s.contact_role ?? '',
          coverage_hours: s.coverage_hours ?? '',
          logo_url: s.logo_url ?? '',
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
        // Re-prepend the scheme on the way out so the API stores a full URL.
        // Empty input → null (skipped) per the existing contract.
        website: prependScheme(form.website) || null,
        email: form.email.trim() || null,
        // Phone is already formatted (xxx) xxx-xxxx by the input handler.
        phone: form.phone.trim() || null,
        contact_name: form.contact_name.trim() || null,
        contact_role: form.contact_role.trim() || null,
        coverage_hours: form.coverage_hours.trim() || null,
        logo_url: form.logo_url.trim() || null,
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
    } catch (err) {
      console.error('[admin/supplier save]', err);
      setToast({ type: 'error', msg: 'Failed to save supplier. Please try again.' });
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    if (isEdit && id) navigate(`/admin/suppliers/${id}`);
    else navigate('/admin/suppliers');
  }

  async function handleDelete() {
    if (!id) return;
    setDeleting(true);
    try {
      await adminApi.deleteSupplier(id);
      setToast({ type: 'success', msg: `Deleted ${existingName || 'supplier'}.` });
      setShowDeleteConfirm(false);
      setTimeout(() => navigate('/admin/suppliers'), 800);
    } catch (err) {
      // Surface the upstream axios failure for prod debugging — toast stays
      // generic to avoid leaking 500-body internals to the user.
      console.error('[admin/supplier delete]', err);
      setToast({ type: 'error', msg: 'Failed to delete supplier. Please try again.' });
      setShowDeleteConfirm(false);
    } finally {
      setDeleting(false);
    }
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
            <div className={styles.field} data-field="name">
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

            <div className={styles.field} data-field="description">
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
            <div className={styles.field} data-field="logo_url">
              <ImageUploadField
                id="sup-logo"
                label="Logo / photo"
                value={form.logo_url}
                onChange={(v) => set('logo_url', v)}
                hint="Shown on supplier cards and as the company logo on sponsor boards."
              />
            </div>
          </div>
        </section>

        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Contact</h3>
          </header>
          <div className={styles.panelBody}>
            <div className={styles.formRow2}>
              <div className={styles.field} data-field="website">
                <label className={styles.fieldLabel} htmlFor="sup-website">
                  Website
                </label>
                {/* `https://` lives as a fixed-prefix adornment so the
                    user types just the host. Input is plain text — the
                    HTML5 URL input type would silently kill form submit
                    for bare-domain strings (see the 2026-05-24 supplier
                    create-bug). prependScheme() adds the scheme back on
                    submit. Backend accepts both shapes. */}
                <div className={styles.prefixedInput}>
                  <span className={styles.inputPrefix}>https://</span>
                  <input
                    id="sup-website"
                    type="text"
                    className={`${styles.input} ${styles.inputMono} ${styles.inputWithPrefix}`}
                    // State invariant: `form.website` is always already
                    // stripped (hydrate + onChange both strip on the way
                    // in), so we render the bare value directly.
                    value={form.website}
                    onChange={(e) => set('website', stripScheme(e.target.value))}
                    placeholder="example.com"
                    inputMode="url"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
              </div>
              <div className={styles.field} data-field="phone">
                <label className={styles.fieldLabel} htmlFor="sup-phone">
                  Phone
                </label>
                <input
                  id="sup-phone"
                  type="text"
                  className={`${styles.input} ${styles.inputMono}`}
                  value={form.phone}
                  onChange={(e) => set('phone', formatPhoneInput(e.target.value))}
                  placeholder="(800) 000-0000"
                  inputMode="tel"
                  autoComplete="tel"
                />
              </div>
            </div>

            <div className={styles.formRow2}>
              <div className={styles.field} data-field="email">
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
              <div className={styles.field} data-field="contact_name">
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

            <div className={styles.formRow2}>
              <div className={styles.field} data-field="contact_role">
                <label className={styles.fieldLabel} htmlFor="sup-role">
                  Job title
                </label>
                <input
                  id="sup-role"
                  type="text"
                  className={styles.input}
                  value={form.contact_role}
                  onChange={(e) => set('contact_role', e.target.value)}
                  placeholder="e.g. Field Sales Engineer"
                />
                <div className={styles.fieldHint}>Shown under the contact on sponsor boards.</div>
              </div>
              <div className={styles.field} data-field="coverage_hours">
                <label className={styles.fieldLabel} htmlFor="sup-hours">
                  Working hours
                </label>
                <input
                  id="sup-hours"
                  type="text"
                  className={styles.input}
                  value={form.coverage_hours}
                  onChange={(e) => set('coverage_hours', e.target.value)}
                  placeholder="e.g. Mon–Fri 8am–6pm ET"
                />
                <div className={styles.fieldHint}>Shown under the phone on sponsor boards.</div>
              </div>
            </div>
          </div>
        </section>

        <div className={styles.formActions}>
          {isEdit && (
            <>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnDanger}`}
                onClick={() => setShowDeleteConfirm(true)}
                disabled={saving || deleting}
              >
                <Trash2 size={14} strokeWidth={2} />
                Delete
              </button>
              <div className={styles.formActionsSpacer} />
            </>
          )}
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={handleCancel}
            disabled={saving || deleting}
          >
            Cancel
          </button>
          <button
            type="submit"
            data-tour="submit-supplier"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={saving || deleting}
          >
            <Check size={14} strokeWidth={2} />
            {saving ? 'Saving…' : submitLabel}
          </button>
        </div>
      </form>

      {showDeleteConfirm && (
        <div
          className={styles.modalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-labelledby="sup-delete-title"
        >
          <div className={styles.modal}>
            <h3 className={styles.modalTitle} id="sup-delete-title">
              Delete {existingName || 'this supplier'}?
            </h3>
            <p className={styles.modalBody}>
              This permanently removes the supplier, every part listing and
              price break, sponsorships, category links, and revenue records.
              Linked admin users will be unlinked, not deleted. This action
              cannot be undone.
            </p>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                onClick={() => setShowDeleteConfirm(false)}
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
                <Trash2 size={14} strokeWidth={2} />
                {deleting ? 'Deleting…' : 'Delete supplier'}
              </button>
            </div>
          </div>
        </div>
      )}

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
