import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Check, ChevronLeft, Trash2 } from 'lucide-react';
import { adminApi } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
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
import Icon from '@shared/components/Icon';
import { BrandColorPicker } from '@shared/components/BrandColorPicker';
import { BrandColorSelectModal } from '@shared/components/BrandColorSelectModal';
import ImageUploadField from '@admin/components/ImageUploadField';
import styles from './SponsorFormPage.module.scss';

// Tier visual palette — the three tiers (Platinum/Gold/Silver) get flat fills.
// Reused for both the select trigger CSS data-attribute and the inline-styled
// <option> rows so the open dropdown reflects the same colors in Chromium/Firefox
// (Safari ignores option backgrounds — accepted).
const TIER_OPTION_STYLE: Record<SponsorTier, { background: string; color: string }> = {
  Platinum: { background: '#cbd5e1', color: '#0f172a' },
  Gold: { background: '#d4a017', color: '#1a1505' },
  Silver: { background: '#94a3b8', color: '#0f172a' },
};

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

const TIERS: SponsorTier[] = ['Platinum', 'Gold', 'Silver'];
const STATUSES: SponsorStatus[] = ['Active', 'Paused', 'Expired'];

// 3-way placement (2026-05-30): top-category vs subcategory was previously
// folded into a single 'category' bucket with a flat `— `-prefixed dropdown,
// which led to a sponsor meant for the parent landing on a child (e.g. PMICs →
// LDOs). Splitting the bucket makes the admin pick the level explicitly. The
// backend serialization stays the same — both buckets set category_id; only
// the form UX is split.
type Placement = 'top-category' | 'subcategory' | 'keyword';

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
  brand_primary: string;
  brand_secondary: string;
}

interface FormErrors {
  supplier_id?: string;
  category_id?: string;
  keyword?: string;
  amount?: string;
  start_date?: string;
  end_date?: string;
  brand_primary?: string;
  brand_secondary?: string;
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
    brand_primary: '',
    brand_secondary: '',
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
  const [placement, setPlacement] = useState<Placement>('subcategory');
  // One-shot guard: the placement bucket is derived from the loaded
  // category_id against the loaded categories list — on edit (from the
  // findSponsor hydration) AND on create with a prefilled category_id (from
  // the Supplier-detail Quick Actions, where the prefilled id is almost
  // always a subcategory). The derive must NOT re-fire when the user later
  // picks a different category from the dropdown (that would clobber an
  // explicit user choice). The ref pins it.
  const placementDerivedRef = useRef(false);
  // Reset the one-shot guard whenever the routed id changes — without this,
  // navigating /admin/sponsors/A/edit -> /admin/sponsors/B/edit (same
  // SponsorFormPage component instance) re-hydrates the form for B but
  // leaves the ref true from A's derive, so B's bucket stays at A's value.
  useEffect(() => { placementDerivedRef.current = false; }, [id]);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [suppliers, setSuppliers] = useState<AdminSupplier[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Set to the freshly cropped logo canvas so the two-step upload flow can open
  // the brand-color picker right after a crop. Null = no color screen open.
  const [colorSource, setColorSource] = useState<HTMLCanvasElement | null>(null);

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
            brand_primary: existing.brand_primary ?? '',
            brand_secondary: existing.brand_secondary ?? '',
          });
          // Provisional bucket — the keyword/category split is unambiguous
          // here; top-category vs subcategory is derived in the effect below
          // once `categories` finishes loading.
          setPlacement(existing.category_id ? 'top-category' : 'keyword');
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

  // Top-level categories only — for the "Top-level category" placement select.
  const topCategoryOptions = useMemo(
    () =>
      categories.map((c) => ({
        id: c.id,
        label: c.name,
        name: c.name,
        icon: c.icon ?? null,
      })),
    [categories],
  );

  // Subcategories only — labeled "Parent → Child" so admins can disambiguate
  // duplicate sub-names across parents at a glance.
  const subcategoryOptions = useMemo(() => {
    const out: Array<{ id: string; label: string; name: string; icon: string | null }> = [];
    for (const c of categories) {
      for (const child of c.children ?? []) {
        out.push({
          id: child.id,
          label: `${c.name} → ${child.name}`,
          name: child.name,
          icon: child.icon ?? null,
        });
      }
    }
    return out;
  }, [categories]);

  // Union — used by buildSponsor for the name/icon lookup since either bucket
  // submits the same category_id field.
  const allCategoryOptions = useMemo(
    () => [...topCategoryOptions, ...subcategoryOptions],
    [topCategoryOptions, subcategoryOptions],
  );

  // Derive the precise placement bucket once: on edit (after findSponsor
  // sets form.category_id) AND on create with a prefilled category_id
  // (from Supplier-detail Quick Actions — the prefilled id is almost always
  // a subcategory, since suppliers' parts attach to children). Without the
  // create-path coverage, the initial useState placement='top-category'
  // would mismatch a sub-prefilled id and the dropdown would render blank
  // while validation silently passes on the wrong bucket.
  useEffect(() => {
    if (
      placementDerivedRef.current
      || !form.category_id
      || topCategoryOptions.length === 0
    ) return;
    const isTop = topCategoryOptions.some((c) => c.id === form.category_id);
    setPlacement(isTop ? 'top-category' : 'subcategory');
    placementDerivedRef.current = true;
  }, [form.category_id, topCategoryOptions]);

  // Consolidated placement switch. Clears BOTH XOR fields and ANY stale
  // field errors so a failed-submit error message under the previous bucket
  // doesn't render under the new bucket's field. The 3 inline onClick
  // handlers previously diverged on what they cleared (the keyword button
  // skipped clearing keyword), which is a subtle footgun across rapid
  // bucket toggles.
  const choosePlacement = useCallback((p: Placement, keepTier = false) => {
    setPlacement(p);
    update('category_id', '');
    update('keyword', '');
    // Tier↔placement matrix (2026-06-11): Category=Platinum only,
    // Subcategory=Gold/Silver only, Keyword=Silver/Gold. Auto-correct the tier
    // so the form stays legal without a round-trip through the select.
    // `keepTier` skips this when the user just picked the tier (the tier-select
    // onChange drives the placement, not the other way around).
    if (!keepTier) {
      if (p === 'top-category') {
        if (form.tier !== 'Platinum') update('tier', 'Platinum');
      } else if (p === 'subcategory') {
        if (form.tier !== 'Gold' && form.tier !== 'Silver') update('tier', 'Gold');
      } else if (p === 'keyword') {
        if (form.tier !== 'Silver' && form.tier !== 'Gold') update('tier', 'Gold');
      }
    }
    setErrors((prev) => {
      const next = { ...prev };
      delete next.category_id;
      delete next.keyword;
      return next;
    });
  }, [update, form.tier]);

  function validate(): boolean {
    const e: FormErrors = {};
    if (!form.supplier_id) e.supplier_id = 'Required';

    // XOR placement validation — must satisfy backend CheckConstraint.
    if ((placement === 'top-category' || placement === 'subcategory') && !form.category_id) {
      e.category_id = placement === 'top-category' ? 'Pick a top-level category' : 'Pick a subcategory';
    }
    if (placement === 'keyword' && !form.keyword.trim()) {
      e.keyword = 'Enter a keyword';
    }

    const amt = Number(form.amount);
    if (!form.amount || Number.isNaN(amt) || amt < 0) e.amount = 'Required (USD)';
    if (!form.start_date) e.start_date = 'Required';
    if (!form.end_date) e.end_date = 'Required';

    const hexOk = (v: string) => !v.trim() || /^#[0-9a-f]{6}$/i.test(v.trim());
    if (!hexOk(form.brand_primary)) e.brand_primary = 'Use a hex color like #1d3a8f';
    if (!hexOk(form.brand_secondary)) e.brand_secondary = 'Use a hex color like #1d3a8f';

    // Both-or-neither: a lone brand color would flip a sold board to branded
    // with the OTHER channel silently pulled from fallback defaults.
    const hasPrimary = !!form.brand_primary.trim();
    const hasSecondary = !!form.brand_secondary.trim();
    if (hasPrimary !== hasSecondary) {
      const msg = 'Set both brand colors, or neither.';
      if (!hasPrimary) e.brand_primary = msg;
      else e.brand_secondary = msg;
    }

    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function buildSponsor(): AdminSponsor {
    const supplier = suppliers.find((s) => s.id === form.supplier_id);
    const isCategoryPlacement = placement === 'top-category' || placement === 'subcategory';
    const category =
      isCategoryPlacement && form.category_id
        ? allCategoryOptions.find((c) => c.id === form.category_id)
        : null;
    return {
      // Empty id on create → the store POSTs; a real id on edit → PATCH.
      id: id ?? '',
      supplier_id: form.supplier_id,
      supplier_name: supplier?.name ?? form.supplier_id,
      tier: form.tier,
      // XOR enforced here: exactly one of category_id / keyword is non-null.
      category_id: isCategoryPlacement ? form.category_id : null,
      category_name: category?.name ?? null,
      category_icon: category?.icon ?? null,
      keyword: placement === 'keyword' ? form.keyword.trim() : null,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      amount: Number(form.amount),
      status: form.status,
      description: form.description.trim() || null,
      image_url: form.image_url.trim() || null,
      brand_primary: form.brand_primary.trim() || null,
      brand_secondary: form.brand_secondary.trim() || null,
    };
  }

  async function handleSubmit(e?: React.FormEvent<HTMLFormElement>) {
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
      // Surface the backend's specific message when present — e.g. the single-slot
      // 409 "This category already has an active <tier> sponsor. Expire or remove
      // the current sponsor before adding another." — so the admin knows the slot
      // is taken and how to proceed, instead of a generic "try again".
      setToast(apiErrorDetail(err) ?? 'Save failed — try again');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!id) return;
    setShowDeleteConfirm(false);
    try {
      // Delete is a pure cascade on the backend: DELETE /api/admin/sponsors/{id}
      // removes the row, and the public banner reads the `sponsors` table
      // directly, so the company simply disappears. No client-side pre-step.
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
              <div className={styles.selectWrap} data-tier={form.tier}>
                <select
                  id="tier"
                  className={styles.select}
                  value={form.tier}
                  onChange={(e) => {
                    const next = e.target.value as SponsorTier;
                    update('tier', next);
                    // Flip placement to one valid for the new tier (matrix:
                    // Platinum→Category only; Gold/Silver→Subcategory or
                    // Keyword, never top-level). keepTier=true so we don't
                    // re-override the tier the user just chose.
                    if (next === 'Platinum' && placement !== 'top-category') {
                      choosePlacement('top-category', true);
                    } else if (
                      (next === 'Gold' || next === 'Silver') &&
                      placement === 'top-category'
                    ) {
                      choosePlacement('subcategory', true);
                    }
                  }}
                >
                  {TIERS.map((t) => (
                    <option key={t} value={t} style={TIER_OPTION_STYLE[t]}>
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
                  className={`${styles.segBtn} ${placement === 'top-category' ? styles.segBtnOn : ''}`}
                  onClick={() => choosePlacement('top-category')}
                  role="radio"
                  aria-checked={placement === 'top-category'}
                  disabled={form.tier !== 'Platinum'}
                  aria-disabled={form.tier !== 'Platinum'}
                  title={form.tier !== 'Platinum' ? 'Top-level Category placement requires the Platinum tier' : undefined}
                >
                  Category Sponsor
                </button>
                <button
                  type="button"
                  className={`${styles.segBtn} ${placement === 'subcategory' ? styles.segBtnOn : ''}`}
                  onClick={() => choosePlacement('subcategory')}
                  role="radio"
                  aria-checked={placement === 'subcategory'}
                  disabled={form.tier === 'Platinum'}
                  aria-disabled={form.tier === 'Platinum'}
                  title={form.tier === 'Platinum' ? 'Platinum tier is reserved for top-level Category placement' : undefined}
                >
                  Subcategory Sponsor
                </button>
                <button
                  type="button"
                  className={`${styles.segBtn} ${placement === 'keyword' ? styles.segBtnOn : ''}`}
                  onClick={() => choosePlacement('keyword')}
                  role="radio"
                  aria-checked={placement === 'keyword'}
                  disabled={form.tier === 'Platinum'}
                  aria-disabled={form.tier === 'Platinum'}
                  title={form.tier === 'Platinum' ? 'Platinum tier is reserved for top-level Category placement' : undefined}
                >
                  Keyword Sponsor
                </button>
              </div>
              <p className={styles.fieldHint}>
                <strong>Platinum</strong> → top-level Category (premium Category
                Sponsor board). <strong>Gold / Silver</strong> → Subcategory.{' '}
                <strong>Silver / Gold</strong> → Keyword.
              </p>
            </div>

            {placement === 'top-category' && (
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="category_id">
                  Top-level category <span className={styles.fieldReq}>*</span>
                </label>
                <IconSelect
                  id="category_id"
                  value={form.category_id}
                  options={topCategoryOptions}
                  onChange={(v) => update('category_id', v)}
                  placeholder="Select top-level category…"
                />
                <p className={styles.fieldHint}>
                  Becomes the premium Category Sponsor board on this top-level
                  category and every subpage. Single-slot — only one active
                  Platinum per category. To re-sell it, expire or remove the
                  current sponsor first.
                </p>
                {errors.category_id && <div className={styles.fieldError}>{errors.category_id}</div>}
              </div>
            )}

            {placement === 'subcategory' && (
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="category_id">
                  Subcategory <span className={styles.fieldReq}>*</span>
                </label>
                <IconSelect
                  id="category_id"
                  value={form.category_id}
                  options={subcategoryOptions}
                  onChange={(v) => update('category_id', v)}
                  placeholder="Select subcategory…"
                />
                <p className={styles.fieldHint}>
                  Shown as the PCB-flashlight sidebar card on the chosen
                  child page only.
                </p>
                {errors.category_id && <div className={styles.fieldError}>{errors.category_id}</div>}
              </div>
            )}

            {placement === 'keyword' && (
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
              <ImageUploadField
                id="image_url"
                label="Sponsor image / logo"
                value={form.image_url}
                onChange={(v) => update('image_url', v)}
                onCroppedCanvas={setColorSource}
                hint="Upload a logo/icon or paste an image URL. Shown on the sponsor board."
              />
            </div>
            <div className={styles.field} data-field="brand_colors">
              <label className={styles.fieldLabel}>Brand colors</label>
              <BrandColorPicker
                logoSrc={form.image_url.trim() || null}
                primary={form.brand_primary.trim() || null}
                secondary={form.brand_secondary.trim() || null}
                onChange={(role, hex) => update(role === 'primary' ? 'brand_primary' : 'brand_secondary', hex)}
                allowCustom
              />
              {errors.brand_primary && <div className={styles.fieldError}>{errors.brand_primary}</div>}
              {errors.brand_secondary && <div className={styles.fieldError}>{errors.brand_secondary}</div>}
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

      {colorSource && (
        <BrandColorSelectModal
          source={colorSource}
          initialPrimary={form.brand_primary.trim() || null}
          initialSecondary={form.brand_secondary.trim() || null}
          onApply={(p, s) => {
            update('brand_primary', p);
            update('brand_secondary', s);
            setColorSource(null);
          }}
          onSkip={() => setColorSource(null)}
        />
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

// ─── IconSelect ─────────────────────────────────────────────────────────────
// Custom listbox replacement for the top-level + subcategory `<select>` —
// native `<select>` strips child markup, so the Phosphor `<Icon>` glyph
// can only be rendered in a fully custom popover. Kept inline in this file
// per the brief (the form is the only consumer).
//
// Behavior:
//   • Outside-click + Esc closes the popover.
//   • ArrowUp/ArrowDown moves the active row; Enter/Space selects.
//   • Trigger button height/border matches `.select` so the form rhythm
//     stays uniform across native and custom selects.
//   • Keyboard nav guard mirrors PreferredPartnersBanner's chip pattern:
//     gate row-onKeyDown on `e.target === e.currentTarget` so inner
//     interactive descendants (none today, but defensive) keep their own
//     keyboard handling.

interface IconSelectOption {
  id: string;
  label: string;
  name: string;
  icon: string | null;
}

interface IconSelectProps {
  id?: string;
  value: string;
  options: IconSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}

function IconSelect({ id, value, options, onChange, placeholder }: IconSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const selected = useMemo(
    () => options.find((o) => o.id === value) ?? null,
    [options, value],
  );

  // On open: reset activeIndex to the selected row (or 0) AND move focus into
  // the listbox so the arrow-key handler (onListKey) actually receives events.
  // Without the focus(), focus stays on the trigger button and ArrowUp/Down
  // never reach the list — keyboard users could open the popover but not
  // navigate it (the trigger only re-fires setOpen(true)).
  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.id === value);
    setActiveIndex(idx >= 0 ? idx : 0);
    popoverRef.current?.focus();
  }, [open, options, value]);

  // Outside-click + Esc close. Pointerdown is used (not click) so the
  // popover closes before a synthesized click would re-open via the
  // trigger's own onClick. Guard `e.target instanceof Node` per the
  // CLAUDE.md scroll-close gotcha.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return;
      if (rootRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function commit(idx: number) {
    const opt = options[idx];
    if (!opt) return;
    onChange(opt.id);
    setOpen(false);
    btnRef.current?.focus();
  }

  function onTriggerKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onListKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      // APG listbox pattern: Home jumps to first. preventDefault stops the
      // popover from also scrolling.
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (activeIndex >= 0) commit(activeIndex);
    }
  }

  // Stable option ids so the listbox can point aria-activedescendant at the
  // active row (the container-focus pattern moves DOM focus to the listbox,
  // not the option buttons, so SRs need activedescendant to announce the
  // active option during arrow nav). Falls back to a constant base when the
  // optional `id` prop is absent.
  const optionBaseId = id ?? 'iconselect';
  const activeOptionId = activeIndex >= 0 ? `${optionBaseId}-opt-${activeIndex}` : undefined;

  return (
    <div className={styles.selectWrap} ref={rootRef}>
      <button
        id={id}
        ref={btnRef}
        type="button"
        className={styles.iconSelectBtn}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKey}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selected ? (
          <>
            <Icon name={selected.icon} />
            <span className={styles.iconSelectLabel}>{selected.label}</span>
          </>
        ) : (
          <span className={styles.iconSelectPlaceholder}>{placeholder ?? 'Select…'}</span>
        )}
      </button>
      {open && (
        <div
          ref={popoverRef}
          className={styles.iconSelectPopover}
          role="listbox"
          tabIndex={-1}
          aria-label={placeholder ?? 'Options'}
          aria-activedescendant={activeOptionId}
          onKeyDown={onListKey}
        >
          {options.length === 0 ? (
            <div className={styles.iconSelectEmpty}>No options</div>
          ) : (
            options.map((o, i) => (
              <button
                key={o.id}
                id={`${optionBaseId}-opt-${i}`}
                type="button"
                role="option"
                aria-selected={o.id === value}
                className={`${styles.iconSelectOption} ${i === activeIndex ? styles.iconSelectOptionActive : ''}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => commit(i)}
              >
                <Icon name={o.icon} />
                <span className={styles.iconSelectLabel}>{o.label}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
