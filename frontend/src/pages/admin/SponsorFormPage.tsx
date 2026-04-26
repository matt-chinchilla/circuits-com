import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Check, ChevronLeft, Trash2 } from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type {
  AdminSponsor,
  AdminSupplier,
  AdminCategory,
  SponsorTier,
  SponsorStatus,
} from '../../types/admin';
import styles from './SponsorFormPage.module.scss';

// Phase A6 — Sponsor New/Edit form, ported from
// design-import/circuits-com-design-system/project/ui_kits/admin/pages.jsx
// (SponsorForm + SponsorNewPage + SponsorEditPage). The XOR placement
// constraint (category_id XOR keyword) is enforced at submit time, mirroring
// the backend Sponsor.__table_args__ CheckConstraint.

const TIERS: SponsorTier[] = ['Featured', 'Platinum', 'Gold', 'Silver'];
const STATUSES: SponsorStatus[] = ['Active', 'Paused', 'Expired'];

const STORE_KEY = 'circuits.admin.sponsors';

type Placement = 'category' | 'keyword';

interface FormState {
  supplier_id: string;
  tier: SponsorTier;
  category_id: string;
  keyword: string;
  start_date: string;
  end_date: string;
  amount: string;
  status: SponsorStatus;
  description: string;
  image_url: string;
  phone: string;
  website: string;
}

interface FormErrors {
  supplier_id?: string;
  category_id?: string;
  keyword?: string;
  amount?: string;
  start_date?: string;
  end_date?: string;
}

function emptyForm(): FormState {
  return {
    supplier_id: '',
    tier: 'Gold',
    category_id: '',
    keyword: '',
    start_date: '2026-05-01',
    end_date: '2027-05-01',
    amount: '',
    status: 'Active',
    description: '',
    image_url: '',
    phone: '',
    website: '',
  };
}

function readStore(): AdminSponsor[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AdminSponsor[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    /* ignore */
  }
  return [];
}

function writeStore(rows: AdminSponsor[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(rows));
  } catch {
    /* localStorage may be unavailable or full — non-fatal for the demo */
  }
}

export default function SponsorFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const [form, setForm] = useState<FormState>(emptyForm());
  const [placement, setPlacement] = useState<Placement>('category');
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [suppliers, setSuppliers] = useState<AdminSupplier[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Hydrate suppliers + categories from live API
  useEffect(() => {
    adminApi
      .getSuppliers()
      .then(setSuppliers)
      .catch(() => setSuppliers([]));
    adminApi
      .getCategories()
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);

  // Hydrate form on edit
  useEffect(() => {
    if (!isEdit || !id) return;
    const rows = readStore();
    const existing = rows.find((r) => r.id === id);
    if (existing) {
      setForm({
        supplier_id: existing.supplier_id,
        tier: existing.tier,
        category_id: existing.category_id ?? '',
        keyword: existing.keyword ?? '',
        start_date: existing.start_date ?? '',
        end_date: existing.end_date ?? '',
        amount: String(existing.amount ?? ''),
        status: existing.status,
        description: existing.description ?? '',
        image_url: existing.image_url ?? '',
        phone: existing.phone ?? '',
        website: existing.website ?? '',
      });
      setPlacement(existing.category_id ? 'category' : 'keyword');
    }
    setLoading(false);
  }, [id, isEdit]);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  const update = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Flat list of (category, sub) options for the placement select.
  const categoryOptions = useMemo(() => {
    const out: Array<{ id: string; label: string }> = [];
    for (const c of categories) {
      out.push({ id: c.id, label: `${c.icon ?? ''} ${c.name}`.trim() });
      for (const child of c.children ?? []) {
        out.push({ id: child.id, label: `   ${child.icon ?? ''} ${child.name}`.trim() });
      }
    }
    return out;
  }, [categories]);

  function validate(): boolean {
    const e: FormErrors = {};
    if (!form.supplier_id) e.supplier_id = 'Required';

    // XOR placement validation — must satisfy backend CheckConstraint.
    if (placement === 'category' && !form.category_id) {
      e.category_id = 'Pick a category';
    }
    if (placement === 'keyword' && !form.keyword.trim()) {
      e.keyword = 'Enter a keyword';
    }

    const amt = Number(form.amount);
    if (!form.amount || Number.isNaN(amt) || amt < 0) e.amount = 'Required (USD)';
    if (!form.start_date) e.start_date = 'Required';
    if (!form.end_date) e.end_date = 'Required';

    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function buildSponsor(): AdminSponsor {
    const supplier = suppliers.find((s) => s.id === form.supplier_id);
    const category = form.category_id
      ? categoryOptions.find((c) => c.id === form.category_id)
      : null;
    return {
      id: id ?? `spn-${Date.now()}`,
      supplier_id: form.supplier_id,
      supplier_name: supplier?.name ?? form.supplier_id,
      tier: form.tier,
      // XOR enforced here: exactly one of category_id / keyword is non-null.
      category_id: placement === 'category' ? form.category_id : null,
      category_name: placement === 'category' ? category?.label.trim() ?? null : null,
      keyword: placement === 'keyword' ? form.keyword.trim() : null,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      amount: Number(form.amount),
      status: form.status,
      description: form.description.trim() || null,
      image_url: form.image_url.trim() || null,
      phone: form.phone.trim() || null,
      website: form.website.trim() || null,
    };
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!validate()) return;
    setSaving(true);
    try {
      const next = buildSponsor();
      const rows = readStore();
      const updated = isEdit
        ? rows.map((r) => (r.id === next.id ? next : r))
        : [next, ...rows];
      writeStore(updated);
      setToast(isEdit ? 'Sponsorship updated' : 'Sponsorship created');
      // small delay so user sees toast confirmation
      setTimeout(() => navigate('/admin/sponsors'), 600);
    } finally {
      setSaving(false);
    }
  }

  function handleDelete() {
    if (!id) return;
    const rows = readStore().filter((r) => r.id !== id);
    writeStore(rows);
    setToast('Sponsorship deleted');
    setTimeout(() => navigate('/admin/sponsors'), 500);
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading sponsor...</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* Page head with back link */}
      <header className={styles.pageHead}>
        <div>
          <Link to="/admin/sponsors" className={styles.backLink}>
            <ChevronLeft size={14} strokeWidth={2} />
            Sponsors
          </Link>
          <h1 className={styles.title}>
            {isEdit ? 'Edit Sponsorship' : 'New Sponsor'}
          </h1>
          <p className={styles.subtitle}>
            {isEdit ? 'Update placement, window, or status.' : 'Configure a paid placement.'}
          </p>
        </div>
      </header>

      <form className={styles.formGrid} onSubmit={handleSubmit} noValidate>
        {/* ── Placement panel ─────────────────────────────────────────── */}
        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h2 className={styles.panelTitle}>Placement</h2>
          </header>
          <div className={styles.panelBody}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="supplier_id">
                Sponsor <span className={styles.fieldReq}>*</span>
              </label>
              <div className={styles.selectWrap}>
                <select
                  id="supplier_id"
                  className={styles.select}
                  value={form.supplier_id}
                  onChange={(e) => update('supplier_id', e.target.value)}
                >
                  <option value="">Select supplier&hellip;</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              {errors.supplier_id && <div className={styles.fieldError}>{errors.supplier_id}</div>}
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="tier">
                Tier <span className={styles.fieldReq}>*</span>
              </label>
              <div className={styles.selectWrap}>
                <select
                  id="tier"
                  className={styles.select}
                  value={form.tier}
                  onChange={(e) => update('tier', e.target.value as SponsorTier)}
                >
                  {TIERS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className={styles.field}>
              <span className={styles.fieldLabel}>Placement type</span>
              <div className={styles.segControl} role="radiogroup" aria-label="Placement type">
                <button
                  type="button"
                  className={`${styles.segBtn} ${placement === 'category' ? styles.segBtnOn : ''}`}
                  onClick={() => {
                    setPlacement('category');
                    update('keyword', '');
                  }}
                  role="radio"
                  aria-checked={placement === 'category'}
                >
                  Category sponsor
                </button>
                <button
                  type="button"
                  className={`${styles.segBtn} ${placement === 'keyword' ? styles.segBtnOn : ''}`}
                  onClick={() => {
                    setPlacement('keyword');
                    update('category_id', '');
                  }}
                  role="radio"
                  aria-checked={placement === 'keyword'}
                >
                  Keyword sponsor
                </button>
              </div>
              <p className={styles.fieldHint}>
                Sponsors target exactly one placement &mdash; category banner or
                keyword takeover, never both.
              </p>
            </div>

            {placement === 'category' ? (
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="category_id">
                  Category <span className={styles.fieldReq}>*</span>
                </label>
                <div className={styles.selectWrap}>
                  <select
                    id="category_id"
                    className={styles.select}
                    value={form.category_id}
                    onChange={(e) => update('category_id', e.target.value)}
                  >
                    <option value="">Select category&hellip;</option>
                    {categoryOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                {errors.category_id && <div className={styles.fieldError}>{errors.category_id}</div>}
              </div>
            ) : (
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="keyword">
                  Keyword <span className={styles.fieldReq}>*</span>
                </label>
                <input
                  id="keyword"
                  type="text"
                  className={`${styles.textInput} ${styles.mono}`}
                  value={form.keyword}
                  onChange={(e) => update('keyword', e.target.value)}
                  placeholder="capacitors"
                />
                <p className={styles.fieldHint}>
                  Sponsorship triggers when buyers search this exact term.
                </p>
                {errors.keyword && <div className={styles.fieldError}>{errors.keyword}</div>}
              </div>
            )}
          </div>
        </section>

        {/* ── Window & price panel ────────────────────────────────────── */}
        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h2 className={styles.panelTitle}>Window &amp; price</h2>
          </header>
          <div className={styles.panelBody}>
            <div className={styles.formRow2}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="start_date">
                  Start date <span className={styles.fieldReq}>*</span>
                </label>
                <input
                  id="start_date"
                  type="date"
                  className={styles.textInput}
                  value={form.start_date}
                  onChange={(e) => update('start_date', e.target.value)}
                />
                {errors.start_date && <div className={styles.fieldError}>{errors.start_date}</div>}
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="end_date">
                  End date <span className={styles.fieldReq}>*</span>
                </label>
                <input
                  id="end_date"
                  type="date"
                  className={styles.textInput}
                  value={form.end_date}
                  onChange={(e) => update('end_date', e.target.value)}
                />
                {errors.end_date && <div className={styles.fieldError}>{errors.end_date}</div>}
              </div>
            </div>

            <div className={styles.formRow2}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="amount">
                  Monthly amount (USD) <span className={styles.fieldReq}>*</span>
                </label>
                <input
                  id="amount"
                  type="number"
                  className={`${styles.textInput} ${styles.mono}`}
                  value={form.amount}
                  onChange={(e) => update('amount', e.target.value)}
                  placeholder="1500"
                  min="0"
                  step="50"
                />
                {errors.amount && <div className={styles.fieldError}>{errors.amount}</div>}
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="status">
                  Status
                </label>
                <div className={styles.selectWrap}>
                  <select
                    id="status"
                    className={styles.select}
                    value={form.status}
                    onChange={(e) => update('status', e.target.value as SponsorStatus)}
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Creative panel (optional metadata) ──────────────────────── */}
        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h2 className={styles.panelTitle}>Creative &amp; contact</h2>
          </header>
          <div className={styles.panelBody}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="description">
                Description
              </label>
              <textarea
                id="description"
                className={styles.textArea}
                rows={3}
                value={form.description}
                onChange={(e) => update('description', e.target.value)}
                placeholder="Short pitch shown on the banner placement"
              />
            </div>
            <div className={styles.formRow2}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="image_url">
                  Image URL
                </label>
                <input
                  id="image_url"
                  type="url"
                  className={styles.textInput}
                  value={form.image_url}
                  onChange={(e) => update('image_url', e.target.value)}
                  placeholder="https://example.com/banner.png"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="website">
                  Website
                </label>
                <input
                  id="website"
                  type="url"
                  className={styles.textInput}
                  value={form.website}
                  onChange={(e) => update('website', e.target.value)}
                  placeholder="https://supplier.example"
                />
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="phone">
                Phone
              </label>
              <input
                id="phone"
                type="tel"
                className={styles.textInput}
                value={form.phone}
                onChange={(e) => update('phone', e.target.value)}
                placeholder="+1 (555) 123-4567"
              />
            </div>
          </div>
        </section>

        <div className={styles.formActions}>
          {isEdit && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnDanger}`}
              onClick={() => setShowDeleteConfirm(true)}
            >
              <Trash2 size={14} strokeWidth={2} />
              Delete
            </button>
          )}
          <div className={styles.formActionsSpacer} />
          <Link to="/admin/sponsors" className={`${styles.btn} ${styles.btnGhost}`}>
            Cancel
          </Link>
          <button
            type="submit"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={saving}
          >
            <Check size={14} strokeWidth={2} />
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create sponsorship'}
          </button>
        </div>
      </form>

      {showDeleteConfirm && (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true">
          <div className={styles.modal}>
            <h3 className={styles.modalTitle}>Delete this sponsorship?</h3>
            <p className={styles.modalBody}>
              This removes the placement immediately. This action cannot be undone.
            </p>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                onClick={() => setShowDeleteConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnDanger}`}
                onClick={handleDelete}
              >
                <Trash2 size={14} strokeWidth={2} />
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={styles.toast}>
          <Check size={16} strokeWidth={3} />
          {toast}
        </div>
      )}
    </div>
  );
}
