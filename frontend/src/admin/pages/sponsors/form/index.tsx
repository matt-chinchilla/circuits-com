import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Check, ChevronLeft, Trash2 } from 'lucide-react';
import { adminApi } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import { consumePrefill, type SponsorPrefill } from '@admin/services/prefillBus';
import {
  deleteSponsor,
  loadSponsors,
  upsertSponsor,
} from '@admin/services/sponsorStore';
import { isActiveSponsor, normalizeSponsorTier } from '@admin/services/sponsorTier';
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
  tier?: string;
  category_id?: string;
  keyword?: string;
  amount?: string;
  start_date?: string;
  end_date?: string;
  brand_primary?: string;
  brand_secondary?: string;
}

// Today's date in America/New_York as `YYYY-MM-DD` (the shape
// <input type="date"> wants). en-CA is the locale that formats ISO-style, and
// the explicit timeZone keeps it DST-safe. NEVER
// `new Date().toISOString().slice(0, 10)` — that's UTC, so every evening after
// ~7-8pm ET the form would default to TOMORROW.
function estToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// +1 year by incrementing the YEAR component of the STRING. Date math is out:
// `new Date('YYYY-MM-DD')` parses as UTC and setFullYear + DST can shift the
// day off by one. Feb 29 clamps to Feb 28 when the target year isn't a leap
// year, so the value is never a date <input type="date"> rejects.
function plusOneYear(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  const year = Number(y) + 1;
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const day = m === '02' && d === '29' && !isLeap ? '28' : d;
  return `${year}-${m}-${day}`;
}

// Supplier creative fields are `string | null` (Python None → JSON null), so
// normalize before use — `?:`/falsy checks miss null and `.trim()` throws on it.
function nonEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.trim() || null;
}

function emptyForm(): FormState {
  const start = estToday();
  return {
    supplier_id: '',
    tier: 'Gold',
    category_id: '',
    keyword: '',
    start_date: start,
    end_date: plusOneYear(start),
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
  // category_id against the loaded (RAW, unfiltered) categories list — on edit
  // (from the loadSponsors hydration) AND on create with a prefilled
  // category_id (from the Supplier-detail Quick Actions, which may hand over
  // either level). The derive must NOT re-fire when the user later
  // picks a different category from the dropdown (that would clobber an
  // explicit user choice). The ref pins it.
  const placementDerivedRef = useRef(false);
  // One-shot guard for the prefill-bus Creative default (see the effect below
  // copySupplierCreative).
  const prefillCreativeRef = useRef(false);
  const [errors, setErrors] = useState<FormErrors>({});
  // Inline notice set by the occupancy sweep below when it drops a category
  // whose single-slot tier is already sold — without it the clear is silent and
  // the admin just sees the select mysteriously back at its placeholder.
  const [slotNote, setSlotNote] = useState<string | null>(null);
  // The RAW stored tier of the row being edited when it falls outside the live
  // set (the retired 'Featured', or a typo). Non-null = keep that value visible
  // in the tier select and block the save until the admin picks a real tier —
  // see the hydration effect below.
  const [unknownTier, setUnknownTier] = useState<string | null>(null);
  // Reset the one-shot guard whenever the routed id changes — without this,
  // navigating /admin/sponsors/A/edit -> /admin/sponsors/B/edit (same
  // SponsorFormPage component instance) re-hydrates the form for B but
  // leaves the ref true from A's derive, so B's bucket stays at A's value.
  // Both transient notices are per-row too: a stale "slot taken" / "stored
  // tier" note must not follow the admin onto the next sponsor.
  useEffect(() => {
    placementDerivedRef.current = false;
    setSlotNote(null);
    setUnknownTier(null);
  }, [id]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [suppliers, setSuppliers] = useState<AdminSupplier[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  // Every sponsorship — read ONLY to hide categories whose SINGLE-SLOT tier is
  // already taken (Platinum on a top-level, Gold on a child — see
  // occupiedSlots below).
  const [sponsors, setSponsors] = useState<AdminSponsor[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Set to the freshly cropped logo canvas so the two-step upload flow can open
  // the brand-color picker right after a crop. Null = no color screen open.
  const [colorSource, setColorSource] = useState<HTMLCanvasElement | null>(null);

  // Hydrate suppliers + categories from the live API. The sponsors list is
  // pulled here ONLY on create: the edit path below already loads the full list
  // and finds the row (the backend has no sponsor detail endpoint), so fetching
  // in both places would GET /api/admin/sponsors/ twice per edit.
  useEffect(() => {
    adminApi
      .getSuppliers()
      .then(setSuppliers)
      .catch(() => setSuppliers([]));
    adminApi
      .getCategories()
      .then(setCategories)
      .catch(() => setCategories([]));
    if (isEdit) return;
    loadSponsors()
      .then(setSponsors)
      .catch(() => setSponsors([]));
  }, [isEdit]);

  // Hydrate form on edit — loadSponsors is async (fetches from the API) and
  // doubles as the `sponsors` hydration for the single-slot option filters, so
  // the page issues exactly one sponsors request. Cancel flag guards against a
  // late resolve after unmount / id change.
  useEffect(() => {
    if (!isEdit || !id) return;
    let cancelled = false;
    setLoading(true);
    loadSponsors()
      .then((rows) => {
        if (cancelled) return;
        setSponsors(rows);
        const existing = rows.find((s) => s.id === id);
        if (existing) {
          // Normalize casing on the way IN — `tier` is a free-form column and
          // legacy/seed rows store lowercase ('platinum'/'gold'), which no
          // TitleCase <option value> matches, so the tier <select> would render
          // blank (and every downstream tier comparison read false).
          const storedTier = normalizeSponsorTier(existing.tier);
          const rawTier = (existing.tier ?? '').trim();
          // A stored tier OUTSIDE the live set (the retired 'Featured', or a
          // typo) is NOT silently rewritten: `unknownTier` keeps the raw string
          // visible in the select and validate() blocks the save until the admin
          // picks a real tier. Fabricating the default here meant that editing
          // (say) a window date on a 'Featured' row quietly persisted Gold — an
          // accidental downgrade with no signal. A known lowercase ('gold')
          // still resolves through normalizeSponsorTier and is unaffected.
          setUnknownTier(!storedTier && rawTier ? rawTier : null);
          setForm({
            supplier_id: existing.supplier_id,
            // Placeholder only when the stored tier is unknown — `unknownTier`
            // masks it in the UI and validate() refuses to save, so this value
            // can never reach the API without an explicit pick.
            tier: storedTier ?? 'Gold',
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

  // Canonical TitleCase tier for every tier COMPARISON below. `form.tier` is
  // hydrated from a free-form column, so a raw `form.tier === 'Gold'` silently
  // reads false for a legacy lowercase row (see CLAUDE.md "Sponsor tier
  // casing") — which would leave a sold Gold subcategory selectable and the
  // single-slot hint wrong. Hydration normalizes too; this is belt-and-braces.
  //
  // While `unknownTier` is set the tier is UNDETERMINED (the stored value isn't
  // one we offer and the admin hasn't picked yet), so it reads null rather than
  // the internal placeholder: nothing Gold-specific — hiding sold Gold
  // subcategories, or the occupancy sweep clearing one — may act on a tier the
  // admin never chose.
  const tierNorm = useMemo(
    () => (unknownTier ? null : normalizeSponsorTier(form.tier)),
    [form.tier, unknownTier],
  );

  // Copy the chosen supplier's STORED logo + brand colors into the Creative
  // fields — the supplier record is the source of truth (saving a supplier
  // re-syncs its logo + colors onto its active Platinum sponsorships), so these
  // fields are a per-placement STARTING POINT, not a permanent override.
  // `force` (the "Use supplier logo & colors" button) overwrites; otherwise
  // (the supplier-select default) it fills ONLY empty fields so an admin's edit
  // is never clobbered. Deliberately NOT an unguarded useEffect keyed on
  // [suppliers]: a late getSuppliers resolve would then re-run and stomp edits
  // made in the meantime — the one place it IS effect-driven (the prefill-bus
  // default below) is ref-guarded to fire exactly once. Brand colors move as a
  // PAIR — validate() rejects a lone color, and a half-set pair flips a sold
  // board to branded with the other channel silently defaulted.
  //
  // ⚠ The LOGO half of the auto path is PLATINUM-ONLY. All three tier boards
  // read `image_url ?? logo_url`, so an EMPTY image_url is not a missing logo —
  // it's a live reference that keeps following the supplier record. Copying the
  // logo in for every tier turned that reference into a frozen SNAPSHOT (plus a
  // duplicate base64 blob per row): change the supplier's logo afterwards and
  // the Gold/Silver board kept rendering the old one, because the supplier-save
  // propagation that re-syncs sponsorships is Platinum-only. Platinum keeps the
  // copy — that propagation is what maintains it, and the takeover board is
  // brand-critical enough to want an explicit per-placement value. `force`
  // (the "Use supplier logo & colors" button) is a deliberate admin override
  // and still copies at any tier. Brand COLORS are unaffected: they're
  // per-placement overrides by design (`brand_takeover`), not a fallback chain.
  const copySupplierCreative = useCallback(
    (supplierId: string, force: boolean) => {
      const sup = suppliers.find((s) => s.id === supplierId);
      if (!sup) return;
      const logo = nonEmpty(sup.logo_url);
      const primary = nonEmpty(sup.brand_primary);
      const secondary = nonEmpty(sup.brand_secondary);
      const autoLogoOk = !form.image_url.trim() && tierNorm === 'Platinum';
      if (logo && (force || autoLogoOk)) {
        update('image_url', logo);
      }
      const colorsEmpty = !form.brand_primary.trim() && !form.brand_secondary.trim();
      if (primary && secondary && (force || colorsEmpty)) {
        update('brand_primary', primary);
        update('brand_secondary', secondary);
      }
    },
    [suppliers, form.image_url, form.brand_primary, form.brand_secondary, tierNorm, update],
  );

  // The Supplier-detail Quick Actions handoff seeds supplier_id inside the
  // form's useState initializer, so the supplier <select>'s onChange never
  // fires and the Creative panel would stay empty — a Platinum created that way
  // saves NULL brand colors, so `brand_takeover` is false and the sold board
  // renders un-branded. Run the same fill-empty-only copy once, as soon as
  // `suppliers` first resolves. One-shot + force=false means a late resolve can
  // never clobber an edit the admin made in the meantime.
  useEffect(() => {
    if (
      isEdit
      || !prefill?.supplier_id
      || prefillCreativeRef.current
      || suppliers.length === 0
    ) return;
    prefillCreativeRef.current = true;
    copySupplierCreative(prefill.supplier_id, false);
  }, [suppliers, prefill, isEdit, copySupplierCreative]);

  // Category ids whose SINGLE-SLOT tier is already held by an ACTIVE sponsor,
  // bucketed by tier: Platinum on a top-level category and Gold on a child are
  // both single-slot (409 from `_reject_if_slot_taken` + the migration-016
  // partial unique indexes). Silver is deliberately absent — the Silver
  // subcategory directory is multi-occupant, as are keyword placements.
  // Casing is normalized (legacy/seed rows store lowercase 'platinum'/'gold')
  // and a NULL status reads as Active (legacy seed omits status) — both per the
  // CLAUDE.md sponsor gotchas.
  //
  // The row BEING EDITED is skipped: it occupies its own slot, so counting it
  // would hide the sponsor's own saved category from the dropdown. Excluding it
  // here (keyed on the ROUTE id, which never changes while the form is open)
  // instead of re-adding it downstream keyed on the LIVE form.category_id also
  // makes switching away and back work — a carve-out keyed on form.category_id
  // moves with the selection, so the original category vanished the moment the
  // admin picked a different one.
  const occupiedSlots = useMemo(() => {
    const platinum = new Set<string>();
    const gold = new Set<string>();
    for (const s of sponsors) {
      if (isEdit && s.id === id) continue;
      if (s.category_id == null) continue;
      if (!isActiveSponsor(s.status)) continue;
      const tier = normalizeSponsorTier(s.tier);
      if (tier === 'Platinum') platinum.add(s.category_id);
      else if (tier === 'Gold') gold.add(s.category_id);
    }
    return { platinum, gold };
  }, [sponsors, isEdit, id]);

  // Is the row this form is editing itself COMPETING for a single slot?
  //   • create        → always yes (the POST would add an occupant).
  //   • edit + Active → yes.
  //   • edit + Paused/Expired → NO. The backend only blocks a second occupant
  //     when the POST-UPDATE row would be active (`new_is_active` in
  //     admin_sponsors.update_sponsor), so an inactive row may legally keep
  //     sitting on a slot a peer has since taken — which is exactly the state
  //     the documented RE-SELL workflow produces (expire the incumbent, sell
  //     the slot to someone else, then come back to edit the expired row).
  // Treating that row as a competitor is what made the sweep + option filters
  // clear and then HIDE its own saved category, leaving it unsaveable
  // (validate() demands a category the dropdown no longer offered).
  const selfActive = !isEdit || isActiveSponsor(form.status);

  // The category the edited row is SAVED on, exposed ONLY while that row is
  // inactive (i.e. not competing) so the occupancy filters below can keep it
  // visible even though a peer holds the slot. Read from the loaded row keyed
  // on the ROUTE id — never `form.category_id` — so it doesn't move with the
  // live selection: a carve-out that follows the selection makes the original
  // category vanish the moment the admin picks a different one (same reasoning
  // as occupiedSlots' self-exclusion above). Null when the row IS competing,
  // and category ids are non-empty strings, so `id === keepOwnCategoryId`
  // reads false in that case without a second condition at each call site.
  const keepOwnCategoryId = useMemo(() => {
    if (selfActive || !isEdit || !id) return null;
    return sponsors.find((s) => s.id === id)?.category_id ?? null;
  }, [selfActive, sponsors, isEdit, id]);

  // THE occupancy sweep — one effect, both entry paths. Drops a category_id
  // whose SINGLE-SLOT tier is already sold, so an invisible selection (the
  // IconSelect trigger showing its placeholder while form.category_id still
  // holds an id the option list HIDES) can never reach submit and 409.
  //
  //   1. CREATE with a prefilled category: Quick Actions hands over
  //      `smartCategoryId` (the supplier's most-listed category — top-level in
  //      prod, where all 15 Platinum slots are sold) straight into form state,
  //      so it can name a category the lists below hide.
  //   2. A TIER SWITCH on an already-picked category (e.g. Silver → Gold on a
  //      subcategory that is free for Silver but Gold-sold): the id stays put
  //      while the Gold filter starts hiding it. This is why the sweep is NOT
  //      one-shot — it re-evaluates on every tier and occupancy change.
  //
  // Occupancy is tested by the category's LEVEL so it mirrors the two option
  // filters EXACTLY (top-level → the Platinum set; child → the Gold set, and
  // only when the tier is Gold): "cleared" therefore means precisely "no longer
  // in the rendered list". Level comes from the RAW `categories`, so the sweep
  // no-ops until they load — and an unresolved/failed `sponsors` fetch leaves
  // occupiedSlots empty, which would clear nothing anyway.
  //
  // A VALID selection is never clobbered: only ids sitting in an occupied
  // single-slot set are cleared, so anything the admin can actually pick from
  // the (already filtered) dropdown survives. On EDIT the row's own slot is
  // safe for free — occupiedSlots excludes the routed id, so the edited
  // sponsor's own category never reads as occupied. And an INACTIVE edited row
  // isn't competing at all (see `selfActive`), so the sweep sits out entirely
  // rather than clearing a category the backend would still accept.
  useEffect(() => {
    if (!selfActive) return;
    if (!form.category_id || categories.length === 0) return;
    const isTop = categories.some((c) => c.id === form.category_id);
    let blocking: SponsorTier | null = null;
    if (isTop && occupiedSlots.platinum.has(form.category_id)) blocking = 'Platinum';
    else if (!isTop && tierNorm === 'Gold' && occupiedSlots.gold.has(form.category_id)) {
      blocking = 'Gold';
    }
    if (!blocking) return;
    update('category_id', '');
    setSlotNote(
      `That category's ${blocking} slot is already taken — pick an open one.`,
    );
  }, [form.category_id, categories, occupiedSlots, tierNorm, selfActive, update]);

  // Top-level categories only — for the "Top-level category" placement select.
  // Categories whose Platinum slot is already sold are HIDDEN (IconSelect has
  // no per-option disabled state, and its "No options" empty row covers the
  // all-sold case), so the admin can't pick a placement the backend would
  // reject with a 409. That 409 stays as the server-side backstop.
  //
  // An ACTIVE edited row needs no carve-out — occupiedSlots already excludes
  // it, so the sponsor's own saved category stays in the list (and comes back
  // if the admin switches away and changes their mind). An INACTIVE one does:
  // its slot is legitimately held by a PEER now, which would hide the row's own
  // saved category and make it uneditable — `keepOwnCategoryId` pins it
  // visible. This list is for RENDERING only: the placement-derive effect below
  // reads the raw `categories`, so filtering here can never flip the bucket.
  const topCategoryOptions = useMemo(
    () =>
      categories
        .filter((c) => !occupiedSlots.platinum.has(c.id) || c.id === keepOwnCategoryId)
        .map((c) => ({
          id: c.id,
          label: c.name,
          name: c.name,
          icon: c.icon ?? null,
        })),
    [categories, occupiedSlots, keepOwnCategoryId],
  );

  // Subcategories only — labeled "Parent → Child" so admins can disambiguate
  // duplicate sub-names across parents at a glance. Gold-on-child is single-slot
  // too, so when the tier is Gold the children whose Gold slot is already sold
  // are hidden — same treatment as Platinum above (and the same self-exclusion
  // via occupiedSlots plus the same inactive-row carve-out), which keeps the
  // "already sold are hidden" hint truthful for BOTH single-slot tiers. Silver
  // leaves the list complete (multi-occupant).
  const subcategoryOptions = useMemo(() => {
    const out: Array<{ id: string; label: string; name: string; icon: string | null }> = [];
    for (const c of categories) {
      for (const child of c.children ?? []) {
        const goldTaken = tierNorm === 'Gold' && occupiedSlots.gold.has(child.id);
        if (goldTaken && child.id !== keepOwnCategoryId) continue;
        out.push({
          id: child.id,
          label: `${c.name} → ${child.name}`,
          name: child.name,
          icon: child.icon ?? null,
        });
      }
    }
    return out;
  }, [categories, occupiedSlots, tierNorm, keepOwnCategoryId]);

  // Union — used by buildSponsor for the name/icon lookup since either bucket
  // submits the same category_id field.
  const allCategoryOptions = useMemo(
    () => [...topCategoryOptions, ...subcategoryOptions],
    [topCategoryOptions, subcategoryOptions],
  );

  // Derive the precise placement bucket once: on edit (after the sponsor load
  // sets form.category_id) AND on create with a prefilled category_id (from
  // Supplier-detail Quick Actions). Without it the initial useState
  // placement='subcategory' would mismatch a TOP-LEVEL id and the dropdown
  // would render blank while validation silently passes on the wrong bucket.
  //
  // Gate + membership test read the RAW `categories`, never the Platinum-
  // filtered `topCategoryOptions`: in prod every top-level Platinum slot can be
  // sold, which empties the filtered list, and gating on that would return
  // forever — a Gold/Silver subcategory sponsor would then be stuck showing the
  // wrong bucket with its saved subcategory invisible and uneditable.
  useEffect(() => {
    if (
      placementDerivedRef.current
      || !form.category_id
      || categories.length === 0
    ) return;
    const isTop = categories.some((c) => c.id === form.category_id);
    setPlacement(isTop ? 'top-category' : 'subcategory');
    placementDerivedRef.current = true;
  }, [form.category_id, categories]);

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
    // The slot notice named the category we just cleared, so it's stale now.
    // If the new bucket/tier lands on another sold slot the sweep re-sets it.
    setSlotNote(null);
    // Tier↔placement matrix (2026-06-11): Category=Platinum only,
    // Subcategory=Gold/Silver only, Keyword=Silver/Gold. Auto-correct the tier
    // so the form stays legal without a round-trip through the select.
    // `keepTier` skips this when the user just picked the tier (the tier-select
    // onChange drives the placement, not the other way around).
    if (!keepTier) {
      let corrected: SponsorTier | null = null;
      if (p === 'top-category') {
        if (form.tier !== 'Platinum') corrected = 'Platinum';
      } else if (p === 'subcategory') {
        if (form.tier !== 'Gold' && form.tier !== 'Silver') corrected = 'Gold';
      } else if (p === 'keyword') {
        if (form.tier !== 'Silver' && form.tier !== 'Gold') corrected = 'Gold';
      }
      if (corrected) {
        update('tier', corrected);
        // An auto-corrected tier is a real value the select now displays, so
        // stop masking it with a retired stored tier — otherwise the select
        // would read 'Featured' while the form holds Platinum.
        setUnknownTier(null);
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

    // The stored tier isn't one we offer (retired/typo) — require an explicit
    // pick instead of letting the internal placeholder persist as a downgrade.
    if (unknownTier) e.tier = 'Pick a tier — the stored value is no longer offered.';

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
                  onChange={(e) => {
                    const next = e.target.value;
                    update('supplier_id', next);
                    // Default the Creative panel from the supplier record
                    // (only-if-empty — see copySupplierCreative).
                    if (next) copySupplierCreative(next, false);
                  }}
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
              {/* `unknownTier` (a retired/typo'd stored tier) is shown as-is
                  instead of being silently replaced: no data-tier rule matches
                  it, so the trigger stays neutral rather than wearing a tier
                  color it isn't. */}
              <div className={styles.selectWrap} data-tier={unknownTier ?? form.tier}>
                <select
                  id="tier"
                  className={styles.select}
                  value={unknownTier ?? form.tier}
                  onChange={(e) => {
                    // Re-picking the transient stored-tier row is not a choice.
                    const next = normalizeSponsorTier(e.target.value);
                    if (!next) return;
                    setUnknownTier(null);
                    // Stale: it named the previous tier's slot. The occupancy
                    // sweep re-sets it if the new tier's slot is sold too.
                    setSlotNote(null);
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
                  {unknownTier && (
                    <option value={unknownTier}>{unknownTier} (not offered)</option>
                  )}
                  {TIERS.map((t) => (
                    <option key={t} value={t} style={TIER_OPTION_STYLE[t]}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              {unknownTier && (
                <p className={styles.fieldHint} role="status">
                  This placement is stored as <strong>{unknownTier}</strong>, a
                  tier we no longer offer. Pick Platinum, Gold, or Silver before
                  saving &mdash; we won&rsquo;t guess one for you.
                </p>
              )}
              {/* Gated on the same condition that produces it, so the error can
                  never outlive the unknown tier (picking any real tier, or a
                  placement that auto-corrects it, drops both at once). */}
              {unknownTier && errors.tier && (
                <div className={styles.fieldError}>{errors.tier}</div>
              )}
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
                  onChange={(v) => {
                    update('category_id', v);
                    setSlotNote(null);
                  }}
                  placeholder="Select top-level category…"
                />
                {slotNote && (
                  <p className={styles.fieldHint} role="status">
                    <strong>Cleared:</strong> {slotNote}
                  </p>
                )}
                <p className={styles.fieldHint}>
                  Becomes the premium Category Sponsor board on this top-level
                  category and every subpage. Single-slot — only one active
                  Platinum per category, so categories that are already sold
                  are hidden from this list. To re-sell one, expire or remove
                  its current sponsor first.
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
                  onChange={(v) => {
                    update('category_id', v);
                    setSlotNote(null);
                  }}
                  placeholder="Select subcategory…"
                />
                {slotNote && (
                  <p className={styles.fieldHint} role="status">
                    <strong>Cleared:</strong> {slotNote}
                  </p>
                )}
                <p className={styles.fieldHint}>
                  Shown as the PCB-flashlight sidebar card on the chosen
                  child page only.
                  {/* Two independent branches, not an either/or: `tierNorm` is
                      null while the stored tier is unknown, and neither claim
                      holds for a tier the admin hasn't picked yet. */}
                  {tierNorm === 'Gold' && (
                    <>
                      {' '}Gold is single-slot &mdash; subcategories that already
                      have an active Gold sponsor are hidden. To re-sell one,
                      expire or remove its current sponsor first.
                    </>
                  )}
                  {tierNorm === 'Silver' && (
                    <>
                      {' '}Silver placements are unlimited per subcategory
                      (the Preferred Partners directory).
                    </>
                  )}
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
            <div className={styles.field}>
              <div>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnGhost}`}
                  onClick={() => copySupplierCreative(form.supplier_id, true)}
                  disabled={!form.supplier_id}
                  title={!form.supplier_id ? 'Pick a sponsor first' : undefined}
                >
                  Use supplier logo &amp; colors
                </button>
              </div>
              <p className={styles.fieldHint}>
                Re-copies the selected supplier&rsquo;s stored logo and brand
                colors over the values above.
                {tierNorm === 'Platinum' ? (
                  <>
                    {' '}Platinum defaults both from the supplier record, and
                    the supplier stays the source of truth &mdash; saving that
                    supplier re-syncs its logo and colors onto its active
                    Platinum placements, so values set here can be replaced
                    later. Edit the supplier to change them for good.
                  </>
                ) : (
                  <>
                    {' '}On Gold and Silver only the colors default from the
                    supplier record. Leaving the logo EMPTY makes the board fall
                    back to the supplier&rsquo;s own logo, so it keeps following
                    a later supplier edit; setting one here freezes it, because
                    re-syncing on supplier save only targets Platinum
                    placements.
                  </>
                )}
              </p>
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
