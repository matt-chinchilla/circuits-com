import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Check, ChevronLeft, Trash2 } from 'lucide-react';
import { adminApi } from '@admin/services/adminApi';
import { consumePrefill, type SponsorPrefill } from '@admin/services/prefillBus';
import {
  deleteSponsor,
  findSponsor,
  upsertSponsor,
} from '@admin/services/sponsorStore';
import type {
  AdminSponsor,
  AdminSupplier,
  AdminCategory,
  SponsorTier,
  SponsorStatus,
} from '@admin/types/admin';
import styles from './SponsorFormPage.module.scss';

// Phase A6 — Sponsor New/Edit form, ported from
// design-import/circuits-com-design-system/project/ui_kits/admin/pages.jsx
// (SponsorForm + SponsorNewPage + SponsorEditPage). The XOR placement
// constraint (category_id XOR keyword) is enforced at submit time, mirroring
// the backend Sponsor.__table_args__ CheckConstraint.
//
// Persistence is now API-backed (`@admin/services/sponsorStore` → adminApi).
// The supplier + category selects pull live UUIDs from getSuppliers() /
// getCategories() so the form submits REAL ids — the old localStorage seed
// used fake `cat-*` ids that never matched the public-site categories.

const TIERS: SponsorTier[] = ['Featured', 'Platinum', 'Gold', 'Silver'];
const STATUSES: SponsorStatus[] = ['Active', 'Paused', 'Expired'];

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
  };
}

export default function SponsorFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  // One-shot consume from the Supplier-detail Quick Actions handoff.
  const [prefill] = useState<SponsorPrefill | null>(() =>
    isEdit ? null : consumePrefill('sponsor'),
  );

  const [form, setForm] = useState<FormState>(() => {
    const base = emptyForm();
    if (!prefill) return base;
    return {
      ...base,
      supplier_id: prefill.supplier_id,
      tier: prefill.tier ?? base.tier,
      category_id: prefill.category_id ?? base.category_id,
    };
  });
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

  // Hydrate form on edit — findSponsor is async (fetches from the API). Cancel
  // flag guards against a late resolve after unmount / id change.
  useEffect(() => {
    if (!isEdit || !id) return;
    let cancelled = false;
    setLoading(true);
    findSponsor(id)
      .then((existing) => {
        if (cancelled) return;
        if (existing) {
          setForm({
            supplier_id: existing.supplier_id,
            tier: existing.tier,
            category_id: existing.category_id ?? '',
            keyword: existing.keyword ?? '',
            start_date: existing.start_date ?? '',
            end_date: existing.end_date ?? '',
            amount: existing.amount != null ? String(existing.amount) : '',
            status: existing.status ?? 'Active',
            description: existing.description ?? '',
            image_url: existing.image_url ?? '',
          });
          setPlacement(existing.category_id ? 'category' : 'keyword');
        }
      })
      .catch((err) => {
        if (!cancelled) console.error('[SponsorFormPage] load failed', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
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

  // Flat list of (category, sub) options for the placement select. `label` is
  // the option text only; `name`/`icon` are kept separate so buildSponsor can
  // submit a clean category_name + the Phosphor icon name (the <option> label
  // would otherwise carry leading indent whitespace).
  const categoryOptions = useMemo(() => {
    const out: Array<{ id: string; label: string; name: string; icon: string | null }> = [];
    for (const c of categories) {
      out.push({ id: c.id, label: c.name, name: c.name, icon: c.icon ?? null });
      for (const child of c.children ?? []) {
        out.push({
          id: child.id,
          label: `— ${child.name}`,
          name: child.name,
          icon: child.icon ?? null,
        });
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
    const category =
      placement === 'category' && form.category_id
        ? categoryOptions.find((c) => c.id === form.category_id)
        : null;
    return {
      // Empty id on create → the store POSTs; a real id on edit → PATCH.
      id: id ?? '',
      supplier_id: form.supplier_id,
      supplier_name: supplier?.name ?? form.supplier_id,
      tier: form.tier,
      // XOR enforced here: exactly one of category_id / keyword is non-null.
      category_id: placement === 'category' ? form.category_id : null,
      category_name: category?.name ?? null,
      category_icon: category?.icon ?? null,
      keyword: placement === 'keyword' ? form.keyword.trim() : null,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      amount: Number(form.amount),
      status: form.status,
      description: form.description.trim() || null,
      image_url: form.image_url.trim() || null,
    };
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!validate()) return;
    setSaving(true);
    try {
      await upsertSponsor(buildSponsor());
      setToast(isEdit ? 'Sponsorship updated' : 'Sponsorship created');
      // small delay so user sees toast confirmation
      setTimeout(() => navigate('/admin/sponsors'), 600);
    } catch (err) {
      console.error('[SponsorFormPage] save failed', err);
      setToast('Save failed — try again');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!id) return;
    setShowDeleteConfirm(false);
    try {
      await deleteSponsor(id);
      setToast('Sponsorship deleted');
      setTimeout(() => navigate('/admin/sponsors'), 500);
    } catch (err) {
      console.error('[SponsorFormPage] delete failed', err);
      setToast('Delete failed — try again');
    }
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
          <Link
            to={prefill && !isEdit ? `/admin/suppliers/${prefill.supplier_id}` : '/admin/sponsors'}
            className={styles.backLink}
          >
            <ChevronLeft size={14} strokeWidth={2} />
            {prefill && !isEdit ? `Back to ${prefill.supplier_name}` : 'Sponsors'}
          </Link>
          <h1 className={styles.title}>
            {isEdit ? 'Edit Sponsorship' : 'New Sponsor'}
          </h1>
          <p className={styles.subtitle}>
            {isEdit ? (
              'Update placement, window, or status.'
            ) : prefill ? (
              <>
                Sponsorship for <strong>{prefill.supplier_name}</strong> —
                supplier + tier pre-filled.
              </>
            ) : (
              'Configure a paid placement.'
            )}
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

            <div className={styles.field} data-field="tier">
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
              <div className={styles.field} data-field="amount">
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
            <h2 className={styles.panelTitle}>Creative</h2>
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
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="image_url">
                Image URL
              </label>
              <input
                id="image_url"
                type="text"
                inputMode="url"
                className={styles.textInput}
                value={form.image_url}
                onChange={(e) => update('image_url', e.target.value)}
                placeholder="https://example.com/banner.png"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
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
            data-tour="submit-sponsor"
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
