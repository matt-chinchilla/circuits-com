# Sponsor Tier Boards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the multi-supplier Preferred Partners banner with a three-tier sponsor system — single **Platinum** Category Sponsor board (animated canvas), per-subcategory **Gold** card + **Silver** directory — on the existing single-source `sponsors` table.

**Architecture:** Backend rewrites the tier↔placement matrix (Postgres trigger + Python validator + tier-aware supersede) and reshapes the two existing read seams (`/partners`→single Platinum; category-detail→Gold sponsor + Silver list). Frontend ports the design's vanilla canvas engine (`CsFx`) verbatim into TS + three board components, and restructures the category page (Platinum band → tier-row → full-width parts).

**Tech Stack:** FastAPI + SQLAlchemy + Alembic (PG; SQLite for tests) · React 19 + TS + SCSS Modules + Canvas 2D · pytest.

**Spec:** `docs/superpowers/specs/2026-06-11-sponsor-tier-boards-design.md`
**Design source (port 1:1):** `design-handoff-v11/circuits-com-design-system/project/ui_kits/website/` — `BANNER_SPEC.md`, `components/{CsFx,CategorySponsor,SilverPartners,Category}.jsx`, `category-sponsor.css`, `data.js`.

**Branch:** `updates`. Commits: no Co-Authored-By. **No deploy** — ends at a local container rebuild.

**The new matrix (LOCKED):** top-level category ⇒ `platinum` (1, supersede); subcategory ⇒ `gold` (1, supersede Gold) or `silver` (many); keyword ⇒ `silver`/`gold`.

---

## File Map

**Backend (create/modify):**
- `api/alembic/versions/013_sponsor_tier_matrix.py` (CREATE) — drop→backfill→recreate trigger.
- `api/alembic/versions/014_supplier_board_fields.py` (CREATE) — 4 Supplier columns.
- `api/app/routes/admin_sponsors.py` — `_validate_tier_placement`, supersede (tier-aware), `_is_featured`→`_is_single_slot`.
- `api/app/models/supplier.py` — 4 columns.
- `api/app/services/category_service.py` — `get_category_partners` (→platinum), `get_category_by_slug` (→gold+silver), `_tier_order`.
- `api/app/schemas/{supplier,sponsor,category}.py` — new fields + reshaped responses.
- `api/app/routes/categories.py` — `/partners` + detail wiring.
- `api/app/db/seed.py`, `api/tests/conftest.py` — new tiers + Silver rows + board fields.
- `api/tests/test_sponsor_tier_matrix.py` (CREATE) + update `test_sponsorship_single_source.py`, `test_admin_sponsors.py`, `test_category_partners.py`.

**Frontend (create/modify):**
- `frontend/src/public/pages/category/components/csFx.ts` (CREATE) — verbatim engine port.
- `…/components/CategorySponsor.tsx` + `.module.scss` (CREATE) — Platinum board.
- `…/components/SilverPartners.tsx` + `.module.scss` (CREATE) — Silver directory.
- `…/components/SponsorBlock.tsx` + scss — re-tier Gold.
- `…/components/CategoryPartnersBanner.tsx` — always-render CategorySponsor.
- `…/components/PreferredPartnersBanner.*` (DELETE after migration).
- `…/pages/category/index.tsx` + `CategoryPage.module.scss` — layout restructure.
- `frontend/src/public/types/{sponsor,category}.ts` + `services/api.ts`.
- `frontend/src/admin/pages/sponsors/form/index.tsx` — matrix gating.
- `api/app/schemas/forms.py` — `SponsorTier` keyword Literal drops `platinum`.

---

## PHASE 1 — Backend: tier↔placement matrix

### Task 1.1: Validator → new matrix

**Files:** Modify `api/app/routes/admin_sponsors.py:83-124`; Test `api/tests/test_sponsor_tier_matrix.py` (CREATE).

- [ ] **Step 1: Failing tests** — create `api/tests/test_sponsor_tier_matrix.py`:

```python
import pytest
from fastapi import HTTPException
from app.routes.admin_sponsors import _validate_tier_placement


def test_top_level_requires_platinum(db_session, top_category):
    with pytest.raises(HTTPException) as ei:
        _validate_tier_placement(db_session, "featured", top_category.id)
    assert ei.value.status_code == 422
    _validate_tier_placement(db_session, "platinum", top_category.id)  # ok


def test_subcategory_requires_gold_or_silver(db_session, child_category):
    for ok in ("gold", "silver"):
        _validate_tier_placement(db_session, ok, child_category.id)
    with pytest.raises(HTTPException):
        _validate_tier_placement(db_session, "platinum", child_category.id)


def test_keyword_rejects_platinum(db_session):
    for ok in ("silver", "gold"):
        _validate_tier_placement(db_session, ok, None)
    with pytest.raises(HTTPException):
        _validate_tier_placement(db_session, "platinum", None)
```

Add `top_category` / `child_category` fixtures to `conftest.py` if absent (a `parent_id IS NULL` category and a child).

- [ ] **Step 2: Run → fail** — `cd api && pytest tests/test_sponsor_tier_matrix.py -v` → FAIL (current validator allows featured top-level).
- [ ] **Step 3: Implement** — rewrite `_validate_tier_placement` body + docstring:

```python
    t = (tier or "").strip().lower()
    has_category = category_id is not None
    if not has_category:
        if t not in ("silver", "gold"):
            raise HTTPException(422, "Keyword placement requires the Silver or Gold tier.")
        return
    cat = db.query(Category).filter(Category.id == category_id).first()
    if cat is None:
        raise HTTPException(404, "Category not found")
    if cat.parent_id is None:
        if t != "platinum":
            raise HTTPException(422, "Top-level category placement requires the Platinum tier.")
    elif t not in ("gold", "silver"):
        raise HTTPException(422, "Subcategory placement requires the Gold or Silver tier.")
```

- [ ] **Step 4: Run → pass** — `pytest tests/test_sponsor_tier_matrix.py -v` → PASS.
- [ ] **Step 5: Commit** — `feat(api): rewrite sponsor tier↔placement validator (platinum top / gold+silver sub / silver+gold keyword)`.

### Task 1.2: Tier-aware supersede

**Files:** Modify `api/app/routes/admin_sponsors.py:37-45,139-168,192-197,254-265`.

Single-slot tiers (Platinum on top-level, Gold on child) supersede same-tier peers; Silver never supersedes.

- [ ] **Step 1: Failing tests** — append to `test_sponsor_tier_matrix.py` (use the admin client + auth header like `test_admin_sponsors.py`):

```python
def test_second_platinum_supersedes_first(admin_client, top_category, two_suppliers):
    a, b = two_suppliers
    r1 = admin_client.post("/api/admin/sponsors/", json={"supplier_id": str(a.id), "category_id": str(top_category.id), "tier": "platinum"})
    assert r1.status_code == 200
    admin_client.post("/api/admin/sponsors/", json={"supplier_id": str(b.id), "category_id": str(top_category.id), "tier": "platinum"})
    active = [s for s in admin_client.get("/api/admin/sponsors/").json()
              if s["category_id"] == str(top_category.id) and s["status"] != "Expired"]
    assert len(active) == 1 and active[0]["supplier_id"] == str(b.id)


def test_silver_does_not_supersede_and_coexists(admin_client, child_category, two_suppliers):
    a, b = two_suppliers
    admin_client.post("/api/admin/sponsors/", json={"supplier_id": str(a.id), "category_id": str(child_category.id), "tier": "silver"})
    admin_client.post("/api/admin/sponsors/", json={"supplier_id": str(b.id), "category_id": str(child_category.id), "tier": "silver"})
    active = [s for s in admin_client.get("/api/admin/sponsors/").json()
              if s["category_id"] == str(child_category.id) and s["status"] != "Expired"]
    assert len(active) == 2
```

- [ ] **Step 2: Run → fail** — `pytest tests/test_sponsor_tier_matrix.py -k supersede -v`.
- [ ] **Step 3: Implement** — replace `_is_featured` with:

```python
def _is_single_slot(tier: str | None, is_top_level: bool) -> bool:
    """Single-occupant placements that supersede same-tier peers:
    Platinum on a top-level category, Gold on a child. Silver (directory)
    and keyword placements are multi-occupant — never supersede."""
    t = (tier or "").strip().lower()
    return (t == "platinum" and is_top_level) or (t == "gold" and not is_top_level)
```

Make `_supersede_existing_for_category` accept the tier and filter to it:

```python
def _supersede_existing_for_category(db, category_id, tier, exclude_id=None):
    q = db.query(Sponsor).filter(
        Sponsor.category_id == category_id,
        func.lower(func.coalesce(Sponsor.tier, "")) == (tier or "").strip().lower(),
        or_(Sponsor.status == "Active", Sponsor.status.is_(None)),
    )
    if exclude_id is not None:
        q = q.filter(Sponsor.id != exclude_id)
    for old in q.all():
        old.status = "Expired"
```

(Import `func` from sqlalchemy.) In `create_sponsor` + `update_sponsor`, gate supersede on `_is_single_slot(tier, cat.parent_id is None)` (look up the category's `parent_id`), passing `tier` to the supersede call. Keyword rows (`category_id is None`) never supersede.

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `feat(api): tier-aware supersede (platinum/gold single-slot; silver multi)`.

### Task 1.3: Migration 013 — trigger rewrite + backfill

**Files:** Create `api/alembic/versions/013_sponsor_tier_matrix.py`.

- [ ] **Step 1:** Write the migration (`down_revision = "012"`). `upgrade()` MUST: (1) drop the old trigger + function; (2) backfill; (3) create the new function + trigger. **Order is load-bearing** — the old trigger would reject the backfill.

```python
revision = "013"; down_revision = "012"

TRIGGER_FN = """
CREATE OR REPLACE FUNCTION sponsor_tier_placement_check() RETURNS trigger AS $$
DECLARE is_top_level boolean; t text := lower(coalesce(NEW.tier, ''));
BEGIN
  IF NEW.category_id IS NOT NULL THEN
    SELECT (parent_id IS NULL) INTO is_top_level FROM categories WHERE id = NEW.category_id;
    IF is_top_level THEN
      IF t <> 'platinum' THEN RAISE EXCEPTION 'Top-level category sponsorship must be Platinum (got %)', NEW.tier; END IF;
    ELSE
      IF t NOT IN ('gold','silver') THEN RAISE EXCEPTION 'Subcategory sponsorship must be Gold or Silver (got %)', NEW.tier; END IF;
    END IF;
  ELSIF NEW.keyword IS NOT NULL THEN
    IF t NOT IN ('silver','gold') THEN RAISE EXCEPTION 'Keyword sponsorship must be Silver or Gold (got %)', NEW.tier; END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
"""

def upgrade():
    op.execute("DROP TRIGGER IF EXISTS sponsor_tier_placement_check_trg ON sponsors")
    op.execute("DROP FUNCTION IF EXISTS sponsor_tier_placement_check()")
    op.execute("UPDATE sponsors SET tier='platinum' WHERE category_id IN (SELECT id FROM categories WHERE parent_id IS NULL) AND lower(coalesce(tier,'')) <> 'platinum'")
    op.execute("UPDATE sponsors SET tier='gold' WHERE category_id IN (SELECT id FROM categories WHERE parent_id IS NOT NULL) AND lower(coalesce(tier,'')) NOT IN ('gold','silver')")
    op.execute("UPDATE sponsors SET tier='gold' WHERE keyword IS NOT NULL AND lower(coalesce(tier,'')) NOT IN ('silver','gold')")
    op.execute(TRIGGER_FN)
    op.execute("CREATE TRIGGER sponsor_tier_placement_check_trg BEFORE INSERT OR UPDATE ON sponsors FOR EACH ROW EXECUTE FUNCTION sponsor_tier_placement_check()")

def downgrade():
    # restore migration 011's trigger (featured/platinum-gold/silver-gold-platinum)
    ...  # inverse: drop, then re-create the 011 function body verbatim
```

(Copy the 011 function body verbatim into `downgrade()`.)

- [ ] **Step 2: Verify SQLite suite still builds** — `cd api && pytest tests/test_models.py -q` (SQLite skips the trigger; this just confirms no import/DDL breakage). Trigger behavior is verified on PG in Phase 6.
- [ ] **Step 3: Commit** — `feat(api): migration 013 — rewrite sponsor tier matrix trigger + backfill`.

### Task 1.4: Update existing matrix tests + seed/conftest tiers

**Files:** Modify `api/tests/test_sponsorship_single_source.py`, `test_admin_sponsors.py`; `api/app/db/seed.py:1074-1121`; `api/tests/conftest.py:153-161`.

- [ ] **Step 1:** Update any test asserting the OLD matrix (e.g. "top-level requires Featured", "keyword allows platinum") to the new strings. Run `pytest tests/test_sponsorship_single_source.py tests/test_admin_sponsors.py -v` and fix each failure to the new matrix.
- [ ] **Step 2:** `seed.py` — top-level sponsors `tier="Platinum"` (was Featured); keep subcat `tier="Gold"`; **add ≥2 Silver subcat sponsors** + set `contact_role`/`coverage_hours`/`brand_primary`/`brand_secondary` on the suppliers used as sponsors (added in Phase 2 — leave a TODO marker only if Phase 2 not yet merged, else fill now). conftest child sponsor stays `tier="gold"`; add a `platinum` top-level sponsor fixture + a `silver` child fixture for the read-path tests.
- [ ] **Step 3:** `cd api && pytest -q` → all green.
- [ ] **Step 4: Commit** — `test(api): update sponsor matrix tests + seed/conftest to platinum/gold/silver`.

---

## PHASE 2 — Backend: board data

### Task 2.1: Migration 014 — Supplier board fields

**Files:** Modify `api/app/models/supplier.py`; Create `api/alembic/versions/014_supplier_board_fields.py`; Test `api/tests/test_supplier_board_fields.py`.

- [ ] **Step 1: Failing test** (metadata — SQLite ignores `String(N)`):

```python
from app.models.supplier import Supplier
def test_supplier_has_board_fields():
    cols = Supplier.__table__.c
    for name in ("contact_role", "coverage_hours", "brand_primary", "brand_secondary"):
        assert name in cols
    assert cols.contact_role.type.length >= 120
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — add to `Supplier`: `contact_role = Column(String(120), nullable=True)`, `coverage_hours = Column(String(60), nullable=True)`, `brand_primary = Column(String(9), nullable=True)`, `brand_secondary = Column(String(9), nullable=True)`. Create migration 014 (`down_revision="013"`) with 4 `op.add_column` + drops in `downgrade`.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `feat(api): migration 014 — Supplier contact_role/coverage_hours/brand colors`.

### Task 2.2: Schemas reshape

**Files:** `api/app/schemas/{supplier,sponsor,category}.py`; Test `api/tests/test_board_schemas.py`.

- [ ] **Step 1: Failing tests** — assert `CategoryPartnersResponse` has `platinum` (not `partners`); `CategoryDetailResponse` has `silver`; `SupplierResponse` has `contact_role` and NOT `is_featured`; `SponsorResponse` has `brand_primary`/`coverage_hours`/`contact_role`/`logo_url`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement:**
  - `SupplierResponse`: add `contact_role: str | None = None`; **remove `is_featured`/`rank`**.
  - `SponsorResponse`: add `logo_url: str | None = None`, `contact_role: str | None = None`, `coverage_hours: str | None = None`, `brand_primary: str | None = None`, `brand_secondary: str | None = None`.
  - `CategoryPartnersResponse`: replace `partners: list[SupplierResponse]` with `platinum: SponsorResponse | None = None`.
  - `CategoryDetailResponse`: add `silver: list[SupplierResponse] = []`.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `feat(api): reshape partner/sponsor/category schemas for tier boards`.

### Task 2.3 + 2.4: Read paths + route wiring

**Files:** `api/app/services/category_service.py`; `api/app/routes/categories.py`; Test `api/tests/test_category_partners.py`, `test_categories.py`.

- [ ] **Step 1: Failing tests** — `/api/categories/{top}/partners` returns `{"slug","name","platinum": {...|null}}`; `/api/categories/{child}` returns `sponsor` = the child's Gold and `silver` = list of the child's Silver suppliers. Use the new conftest fixtures.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement:**
  - `get_category_partners` → resolve to top-level, select the newest visible `platinum` sponsor, return `{"slug","name","platinum": <rich dict | None>}` (rich dict = supplier-joined fields the board needs).
  - `get_category_by_slug` → `sponsor` = newest visible **gold** for this child; add `"silver"` = visible **silver** suppliers for this child (join Sponsor→Supplier, tier-filtered, `_active_sponsor()`), shaped as SupplierResponse dicts (incl. `contact_role`).
  - `_tier_order` → drop `featured` (order `platinum > gold > silver`).
  - `categories.py` `get_partners` → build `CategoryPartnersResponse(slug=…, name=…, platinum=result["platinum"])`. `get_category` → add `silver=result["silver"]` to `CategoryDetailResponse`.
- [ ] **Step 4: Run → pass** + `pytest tests/test_cache_headers.py` (ETag still works).
- [ ] **Step 5: Commit** — `feat(api): /partners→single platinum, category detail→gold sponsor + silver list`.

### Task 2.5: Seed/conftest board fields

**Files:** `api/app/db/seed.py`, `api/tests/conftest.py`.

- [ ] **Step 1:** Set `contact_role`/`coverage_hours`/`brand_primary`/`brand_secondary` on the seeded sponsor suppliers (use the design's `data.js` values, e.g. TI `#c00000`/`#ff9e85`); ensure each top-level has a Platinum sponsor and ≥1 subcat has Gold + multiple Silver. conftest: set the same on the sponsor-supplier fixture.
- [ ] **Step 2:** `cd api && pytest -q` → green.
- [ ] **Step 3: Commit** — `feat(api): seed/conftest board fields + silver sponsors`.

---

## PHASE 3 — Frontend: canvas engine + Platinum board

### Task 3.1: Port `csFx.ts` (VERBATIM)

**Files:** Create `frontend/src/public/pages/category/components/csFx.ts`.

Port `design-handoff-v11/.../components/CsFx.jsx` to a TS module. Export `mountTileField`, `brandVars`, `extractBrandColors`, `csTelHref`, and a `CsCopy` React component. Replace `window.*` globals with ES exports + imports; replace `React.useState/Ref/Effect` with named imports. **Preserve EVERY literal** — verify this checklist after porting:

- [ ] `GAP === 19`, `dpr = Math.min(devicePixelRatio, 2)`
- [ ] Shimmer `SH_SPEED = 0.36`, `SH_BAND = 60`, `SH_AMP = 0.5`, `br = Math.random() < 0.03`
- [ ] Dome `R = 72`, `z += k*k`, `lift = z * 13`, `ext = 1.5 + lift*0.45`
- [ ] Hole `roundRect(...,2)` + `destination-out`; underglow sprite `lighter` `0.46*lvl` `GAP*3.8`; top face un-brightened `drawImage(pcb …)`
- [ ] Wave `WAVE_SPEED = 0.34`, `FLIPLEN = 255`; flip `w = GAP*|cos|`; back=`pcb`/front=`pcbOld`; SHADOW ONLY; re-raster at `[120,600]`
- [ ] `brandVars` resolves concrete `rgb()` via 1×1 readback (never color-mix)
- [ ] IO + visibilitychange + reduced-motion + ResizeObserver lifecycle; `destroy()` tears all down

Type the tile/field objects (`interface Tile`, `interface TileField { setCursor; clearCursor; wave; refreshColor; destroy }`). No behavior change.

- [ ] **Verify:** `cd frontend && npx tsc --noEmit` → clean.
- [ ] **Commit** — `feat(web): port CsFx canvas tile-field engine to TS (constants 1:1)`.

### Task 3.2: `CategorySponsor.tsx` + SCSS (Platinum)

**Files:** Create `CategorySponsor.tsx` + `CategorySponsor.module.scss`. Port `CategorySponsor.jsx` + the `.csb*/.csbA*/.cs-band` rules from `category-sponsor.css`.

- [ ] Port the 3 states: **sponsored**, **open slot** (drop/file-pick), **pitch** (session takeover). Keep `useCsBoardFx` (synchronous cursor feed), `useCsEntrance` (WAAPI, `fill:"none"`), `runWave` (two-rAF). Honor the **no-`translateZ` hit-testing gotcha** on `.csbA-pad`/`.csbA-rail`.
- [ ] Props: `{ sponsor: PlatinumSponsor | null; categoryName: string; slug: string; onNavigate: (k: 'sponsor') => void }`. Derive `lettermark` from company name. `onNavigate('sponsor')` → Contact (prefilled) — wire in Task 4.3.
- [ ] Tokens as **plain CSS custom properties** (NOT `@property`); `.csb.csbA` locks the platinum palette + fixed `--txt-*`.
- [ ] **Verify:** `tsc --noEmit` + `eslint --ext .ts,.tsx src/`.
- [ ] **Commit** — `feat(web): CategorySponsor platinum board (sponsored/open/pitch)`.

### Task 3.3: Visual fidelity gate

- [ ] Render the prototype (`design-handoff-v11/.../ui_kits/website/index.html`) and the local CategorySponsor side-by-side via chrome-devtools-mcp; confirm idle shimmer cadence, hover dome ("ball"), and click-flip wave match. Capture before/after. (No commit — gate only.)

---

## PHASE 4 — Frontend: Silver + Gold + layout

### Task 4.1: `SilverPartners.tsx` + SCSS

**Files:** Create `SilverPartners.tsx` + `.module.scss`. Port `SilverPartners.jsx` + `.svp*` rules.

- [ ] `SVP_ENERGIZE_MS = 1500`; `SvChip` columns `64px 1.15fr .8fr 1.25fr 1.3fr`; transparent `.svp-headrow`; `U{i+1}` refdes; `CsCopy` on phone/email. **`CircuitTraces variant="static"`** (hero-only-`full` invariant). Props `{ suppliers: PartnerSupplier[]; categoryName: string; onNavigate }`.
- [ ] **Commit** — `feat(web): SilverPartners silver-tier directory`.

### Task 4.2: SponsorBlock → Gold

**Files:** `SponsorBlock.tsx` + scss.

- [ ] Set `data-tier="gold"`; confirm it still consumes the `SponsorResponse` (`category.sponsor`). No data-source change.
- [ ] **Commit** — `feat(web): re-tier SponsorBlock to Gold`.

### Task 4.3: Banner wrapper + types + api

**Files:** `CategoryPartnersBanner.tsx`; `types/{sponsor,category}.ts`; `services/api.ts`; delete `PreferredPartnersBanner.*`.

- [ ] `getCategoryPartners` returns `{ slug, name, platinum: PlatinumSponsor | null }`. `CategoryPartnersBanner` **always** renders `<CategorySponsor sponsor={data?.platinum ?? null} …/>` (Open-Placement when null — the "always present" requirement); memo unchanged. `onNavigate('sponsor')` → `navigate('/contact', { state: { subject, category } })` (prefill).
- [ ] Types: `PlatinumSponsor` (company/contact/role/phone/hours/email/logo/tier/brand*), `PartnerSupplier` (name/website/contact/role/phone/email). Use `field?: T | null` + `!= null` (null gotcha).
- [ ] Delete `PreferredPartnersBanner.tsx`/`.module.scss`; grep no remaining imports.
- [ ] **Commit** — `feat(web): banner always renders CategorySponsor; partners→platinum shape`.

### Task 4.4: CategoryPage layout restructure

**Files:** `pages/category/index.tsx:422-479`; `CategoryPage.module.scss`.

- [ ] Replace the `.contentInner` (parts-left / sponsor-right) with: Platinum band (`<CategoryPartnersBanner/>`, already at top) → **on subpages only** a `.tierRow` (`SilverPartners` main `flex:1`, `SponsorBlock` aside `~340px`, stack on mobile) → **parts table full-width**. Parent pages: no tier-row, parts full-width. Port `.tier-row*` rules from `category-sponsor.css:487-499`.
- [ ] Subpage detection: render the tier-row only when the category is a child (`category.parent != null`).
- [ ] **Verify:** `tsc` + `eslint`; load a parent and a subpage in the running stack.
- [ ] **Commit** — `feat(web): category layout — platinum band + tier-row (subpages) + full-width parts`.

---

## PHASE 5 — Admin + form types

### Task 5.1: SponsorFormPage matrix gating

**Files:** `frontend/src/admin/pages/sponsors/form/index.tsx:26-280`.

- [ ] `TIERS = ['Platinum','Gold','Silver']` (drop Featured); remove `Featured` from `TIER_OPTION_STYLE`. Rewrite `choosePlacement` matrix: `top-category` → force `Platinum`; `subcategory` → force `Gold`/`Silver` (default Gold); `keyword` → force `Silver`/`Gold` (default Gold; clear Platinum). Update the disabled-gating on the tier `<select>` accordingly.
- [ ] **Verify:** `tsc` + `eslint`; manually exercise the 3 placement buttons.
- [ ] **Commit** — `feat(admin): sponsor form matrix gating (platinum/gold/silver)`.

### Task 5.2: Keyword tier Literal

**Files:** `api/app/schemas/forms.py`; admin `SponsorTier` TS type.

- [ ] `SponsorTier` keyword Literal `["silver","gold","platinum"]` → `["silver","gold"]`. Update/relocate any test asserting the old Literal. Admin TS `SponsorTier` drops `Featured`.
- [ ] **Verify:** `cd api && pytest -q` + `tsc`.
- [ ] **Commit** — `feat: drop platinum from keyword-request tier set`.

---

## PHASE 6 — Verify, review, local rebuild (NO deploy)

### Task 6.1: Full green
- [ ] `cd api && pytest -q` (all pass) · `cd frontend && npx tsc --noEmit` · `npx eslint --ext .ts,.tsx src/` (exit 0).

### Task 6.2: Local container rebuild + PG verification
- [ ] `docker compose up -d --build api frontend` (re-runs alembic 013+014 + seed on PG).
- [ ] Verify the **trigger on PG**: an INSERT of a `featured` top-level sponsor is rejected; `platinum` accepted; child `platinum` rejected (`docker compose exec -T db psql -U circuits -d circuits -c "…"`).
- [ ] Browser-prove on the running stack: parent page = Platinum only; subpage = Platinum + Gold + Silver; Open-Placement when unsold. **Perf gate:** chrome-devtools-mcp throttled trace — LCP + long-frames not regressed vs. baseline.

### Task 6.3: Review + simplify
- [ ] `/code-review:code-review` on the branch diff; fix findings.
- [ ] `/simplify` on the diff; apply cleanups (incl. the `SupplierResponse.is_featured/rank` removal verification).
- [ ] Final `feature-dev:code-reviewer` pass on the whole diff → APPROVED.
- [ ] Hand back the locally-rebuilt stack for user review. **Do not deploy.**

---

## Self-Review notes
- **Spec coverage:** matrix (1.1-1.3), supersede (1.2), board fields (2.1), schemas (2.2), read paths (2.3-2.4), seed (1.4/2.5), csFx port + constants (3.1), Platinum/Silver/Gold boards (3.2/4.1/4.2), layout (4.4), Open-Placement→Contact (4.3), admin gating (5.1), keyword tier (5.2), perf + visual gates (3.3/6.2), review/simplify/rebuild (6.3) — all covered.
- **Type consistency:** `_is_single_slot`, `_supersede_existing_for_category(db, category_id, tier, exclude_id)`, `platinum`/`silver` response keys, `PlatinumSponsor`/`PartnerSupplier` TS types used consistently.
- **Migration order** (drop→backfill→recreate) called out as load-bearing.
