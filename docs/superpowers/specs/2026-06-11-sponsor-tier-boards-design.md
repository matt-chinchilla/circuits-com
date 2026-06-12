# Sponsor Tier Boards — Platinum / Gold / Silver Redesign

**Date:** 2026-06-11
**Status:** Design — awaiting user review before plan
**Design source:** `design-handoff-v11/circuits-com-design-system/` (Claude Design bundle), canonical files:
- `project/ui_kits/website/BANNER_SPEC.md` — every literal animation constant (reproduce 1:1)
- `project/ui_kits/website/components/{CsFx,CategorySponsor,SilverPartners,Category}.jsx`
- `project/ui_kits/website/category-sponsor.css`, `data.js`

---

## Goal

Replace the multi-supplier "Preferred Partners" banner with a **three-tier sponsor system** driven by the existing single-source `sponsors` table:

- **Platinum** — one premium "Category Sponsor" board per top-level category (the animated `.csbA` canvas board), always present (Open-Placement fallback when unsold), shown on the category page **and every subpage**.
- **Gold** — one featured sponsor card per **subcategory** (the existing `SponsorBlock`, re-tiered).
- **Silver** — a multi-supplier scrollable directory per **subcategory** (new `SilverPartners` board), beside the Gold card.

"Featured" merges into "Platinum" (everything formerly Featured is now Platinum; Platinum is used for **nothing else**).

## Non-goals

- No change to the keyword *landing/profile* pages' visual design (only their tier set drops Platinum).
- No server-side parts paging (separate, deferred behind the existing tripwire).
- No deploy in this work — the deliverable is a **locally-rebuilt container** for the user to review.

---

## The new tier ↔ placement matrix (LOCKED)

| Placement (`sponsors` row) | Allowed tier(s) | Cardinality | Board |
|---|---|---|---|
| **Top-level category** (`parent_id IS NULL`) | `platinum` ONLY | exactly 1 (supersede peers) | `CategorySponsor` `.csbA` |
| **Subcategory** (child) | `gold` or `silver` | Gold = 1 (supersede Gold peers); Silver = many | Gold→`SponsorBlock`; Silver→`SilverPartners` |
| **Keyword** | `silver` or `gold` | many (no supersede) | keyword pages (unchanged visuals) |

Changes vs. today: top-level `featured`→`platinum` and becomes **single** (was multi); subcategory drops `platinum` (now `gold`/`silver`); keyword drops `platinum`.

This matrix is enforced in **three places that must move together** (today's invariant): the Postgres trigger, the Python validator, and the admin form gating.

---

## Architecture

### Data delivery — reuse the two existing seams (no new endpoint)

1. **`GET /categories/{slug}/partners`** (top-level artifact, child→parent resolved, memoized via `partnersMemo`, shown on every subpage) → payload changes from `partners: [Supplier]` to **`platinum: SponsorResponse | null`**. This is the always-present Platinum board's data; `null` → Open-Placement.
2. **`GET /categories/{slug}`** (`CategoryDetailResponse`) → `sponsor` becomes **this child's Gold** sponsor (single); add **`silver: list[SupplierResponse]`** = this child's Silver sponsors (many).

Rationale: Platinum *is* a top-level artifact shown across subpages — exactly what `/partners` + the memo already do (zero layout-shift). Gold/Silver are this-subcategory artifacts — exactly what category-detail already carries. A single fat endpoint was rejected (loses the cross-subpage memo and churns more).

### Backend changes (`api/`)

**Migration `013` — rewrite the matrix (order matters):**
1. `DROP TRIGGER` + `DROP FUNCTION sponsor_tier_placement_check` (old matrix would *reject* the backfill UPDATEs).
2. Backfill existing rows to the new tiers:
   - top-level (`parent_id IS NULL`) `featured` → `platinum`
   - child (`parent_id IS NOT NULL`) `platinum` → `gold`
   - keyword `platinum` → `gold`
3. `CREATE` the new trigger function: top-level ⇒ `platinum`; child ⇒ `gold`/`silver`; keyword ⇒ `silver`/`gold`. Recreate the `BEFORE INSERT OR UPDATE` trigger.

(The two `UNIQUE` constraints from migration 011 stay. Single-Platinum-per-category is enforced by **supersede** (write) + newest-wins (read), matching how the old single subcat slot worked — not by a new constraint.)

**Migration `014` — Supplier board fields** (the boards consume fields `Supplier` lacks; per "implement what the design has"):
- `contact_role` `String(120)` — job title under the contact (Silver chips + Gold + Platinum).
- `coverage_hours` `String(60)` — sales hours under the phone (Platinum board).
- `brand_primary` `String(9)` / `brand_secondary` `String(9)` — hex brand-takeover colors (Platinum energize-wave). Nullable → `CsFx` falls back to the locked platinum palette.

All nullable `ADD COLUMN` (PG-only; SQLite tests build from models via `create_all`). Use the `/add-model-field` chain (model + migration + Response/Create/Update + `to_dict` + TS type + admin List/Form).

**`_validate_tier_placement` (admin_sponsors.py)** → mirror the new matrix (422). Replace `_is_featured` with a tier-aware "single-slot placement?" helper.

**Supersede becomes tier-aware** (`_supersede_existing_for_category`): supersede only **same-single-slot-tier** peers — Platinum on a top-level category; Gold on a child. **Silver never supersedes** (multi directory); keyword never supersedes. Today's "supersede all non-Featured on this category" predicate is replaced by a tier-scoped one.

**Read paths (`category_service.py`):**
- `get_category_partners` → return the single visible **Platinum** sponsor (rich shape) for the resolved top-level category, instead of a supplier list.
- `get_category_by_slug` → `sponsor` = this child's newest visible **Gold**; add `silver` = this child's visible **Silver** suppliers (tier-filtered).
- `_tier_order` → drop `featured` (now `platinum > gold > silver`).

**Schemas:**
- `CategoryPartnersResponse`: `partners: [Supplier]` → `platinum: SponsorResponse | None`.
- `SponsorResponse`: add `logo_url`, `contact_role`, `coverage_hours`, `brand_primary`, `brand_secondary` (joined from supplier).
- `SupplierResponse`: add `contact_role`; **remove vestigial `is_featured`/`rank`** (columns dropped in migration 011 — always False/0 now).
- `CategoryDetailResponse`: add `silver: list[SupplierResponse] = []`.

**Seed + conftest:** emit the new tiers (top-level `platinum`, subcats `gold`/`silver`); add a few Silver sponsors per subcategory so the directory is populated; set `contact_role`/`coverage_hours`/brand colors on the seeded suppliers used as sponsors. Update fixtures that assert the old matrix.

### Frontend changes (`frontend/`)

| File | Action |
|---|---|
| `public/pages/category/components/csFx.ts` | **NEW** — verbatim TS port of `CsFx.jsx` (canvas engine + `brandVars` + `extractBrandColors` + `CsCopy` + `csTelHref`). Every constant preserved. |
| `…/components/CategorySponsor.tsx` (+`.module.scss`) | **NEW** — Platinum `.csbA` board; sponsored / Open-Placement / pitch states. Replaces `PreferredPartnersBanner.*`. |
| `…/components/SilverPartners.tsx` (+`.module.scss`) | **NEW** — Silver `.svp` multi-supplier directory. `CircuitTraces variant="static"` (hero-only-`full` invariant). |
| `…/components/SponsorBlock.tsx` | KEEP — re-tier to **Gold** (`data-tier="gold"`). |
| `…/components/CategoryPartnersBanner.tsx` | Always render `<CategorySponsor sponsor={platinum} …/>` (Open-Placement when null — the "always present" requirement). |
| `…/pages/category/index.tsx` | Restructure: Platinum band → `.tier-row` (`SilverPartners` main + `SponsorBlock` aside) **on subpages only** → **parts table full-width**. Parent page: Platinum band + full-width parts (no tier-row). |
| `category-sponsor.css` → SCSS modules | Port both boards' styling (`.csb*/.csbA*/.svp*/.cs-band/.tier-row`). |
| `public/types/{sponsor,category}.ts` | New `platinum`/`silver` shapes + new fields (`field?: T \| null` + `!= null` per the null gotcha). |
| `public/services/api.ts`, `partnersMemo.ts` | `getCategoryPartners` returns the platinum shape; memo unchanged in mechanism. |
| Open-Placement CTA | "Become a sponsor →" → **Contact page, prefilled** with category context (lands as a `Message`). Reuse the prefill pattern. |
| admin `SponsorFormPage` | Update tier↔placement gating + tier `<select>` options + `TIER_OPTION_STYLE` to the new matrix. |

**`.tier-row` layout (from `category-sponsor.css`):** `display:flex; gap:28px; align-items:stretch`. Main (`SilverPartners`) `flex:1 1 0; min-height:340px` with `.svp` absolutely filling it; aside (`SponsorBlock`) `flex:0 0 ~340px`. Stacks to one column on mobile.

### Performance guardrails (this lands on the just-optimized category page)

- Canvas is **one** GPU layer; gated by `IntersectionObserver` + `visibilitychange` + `prefers-reduced-motion` (static paint). Cursor fed **synchronously** per `pointermove`. Underglow is a **cached sprite**. (All already in `CsFx`.)
- Platinum board's `CircuitTraces` is snapshot-only (`opacity:0`, SMIL paused). Silver's `CircuitTraces` MUST be `variant="static"` — never `full` on a non-hero route (Tier-3 perf invariant).
- **Gate:** a `chrome-devtools-mcp` throttled trace (LCP + long-frame check) proving no regression vs. the campaign we just shipped.

---

## Animation fidelity — acceptance criteria (the critical requirement)

Port `CsFx` **verbatim**; these literals are the contract (do not round). Verified by a **side-by-side visual diff against the prototype** before the phase is marked done:

- Tile pitch `GAP 19`; `dpr min(devicePixelRatio, 2)`.
- **Idle shimmer**: band sweeps left→right, `SH_SPEED 0.36 px/ms`, `SH_BAND 60`, `SH_AMP 0.5`; only `br = Math.random() < 0.03` (~3%) tiles participate; cosine falloff.
- **Hover dome ("the ball")**: tiles within `R 72px` rise straight up, `z += k²` (`k = 1 − dist/R`); `lift = z*13`, `ext = 1.5 + lift*0.45`; see-through rounded `GAP×GAP` hole (radius 2); cached underglow sprite (`lighter`, `α = .46*lvl`, `GAP*3.8`); side-wall depth + drop shadow; top face keeps the exact resting color (no brightening).
- **Energize flip wave**: `WAVE_SPEED 0.34 px/ms`, `FLIPLEN 255` (⇒ ~750 ms/tile); OLD outside the ring, NEW inside `R−FLIPLEN`; `drawFlipTile` rotates 0→180° (`w = GAP*|cos|`), front=`pcbOld`/back=`pcb`; **shadow only** (no underglow/socket); re-rasterize circuit at +120 ms/+600 ms; `maxR` = far corner +`FLIPLEN+20`.
- **Brand takeover**: logo click → `brandVars` (concrete `rgb()`, never `color-mix`) → two rAFs → `field.wave(padCenter)`; color persists. Pitch mode: drag/file-pick → `extractBrandColors` (28px downscale, hue-bucket) → persists per session (`sessionStorage["cs-pitch-<slug>"]`).
- **Hit-testing gotcha**: `.csbA-pad` / `.csbA-rail` must carry **no `translateZ`** (else real clicks miss the logo). Tokens are plain custom properties (NOT `@property`).

---

## Data contract mapping (design field → backend)

| Board field | Source |
|---|---|
| `company` | `supplier.name` |
| `lettermark` | derived (initials of name) — not stored |
| `logo` | `sponsor.image_url` ?? `supplier.logo_url` |
| `blurb`/`desc` | `description` |
| `contact` | `contact_name` |
| `role` | `contact_role` (NEW) |
| `phone` / `email` / `website` | existing |
| `hours` | `coverage_hours` (NEW, Platinum) |
| `brandPrimary`/`brandSecondary` | `brand_primary`/`brand_secondary` (NEW; null → platinum default) |
| `tier` | `sponsor.tier` |

---

## Testing

- **Matrix** (trigger + validator): each wrong combo rejected; each right combo accepted (incl. keyword no longer accepts `platinum`).
- **Supersede cardinality**: 2nd Platinum on a top-level supersedes the 1st; 2nd Gold on a child supersedes the 1st Gold but leaves Silver intact; multiple Silver coexist.
- **Backfill**: migration 013 maps legacy `featured`/`platinum` rows correctly (metadata/data test).
- **Read shapes**: `/partners` returns `platinum|null`; detail returns `gold` + `silver[]`.
- **New Supplier fields**: column metadata length assertions (SQLite ignores `String(N)`), round-trip through admin Create/Update.
- **Frontend**: `tsc --noEmit`, `eslint --ext .ts,.tsx src/` (boundary). No runtime test suite — covered by the visual + perf MCP gates.
- Run existing suite first (confirm green baseline), then per-phase.

---

## Rollout / verification (NO deploy)

Per the standing workflow + this session's explicit instruction:
1. Build via subagent-driven-development, commit per phase on `updates` (no Co-Authored-By).
2. After implementation: **`/code-review:code-review`** then **`/simplify`** on the diff.
3. **Rebuild the container locally** (`docker compose up -d --build api frontend`) so the local stack matches the branch, for the user to review **before** any deploy.
4. Deploy is a separate, explicitly-gated step — not part of this work.

---

## Risks / open items

- **Migration order** (drop trigger → backfill → recreate) is load-bearing; a backfill UPDATE under the old trigger would raise.
- **Brand-color extraction on real sponsors**: external logo URLs taint the canvas (`getImageData` throws), so real sponsors use stored `brand_primary/secondary` or the platinum default; live pixel-extraction stays in the local-drag pitch preview (data-URL, no taint).
- **Layout shift**: parent vs. subpage differ (tier-row present only on subpages) — keep the Platinum band height stable across nav (memo already does this for data).
- **4 new Supplier columns** = real scope (the 6-file chain ×4); justified by "implement what the design has."
- **Scope** is large but single-subsystem (the sponsor boards) — one plan, phased.
