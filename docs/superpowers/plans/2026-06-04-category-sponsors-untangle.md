# Category Sponsors — Untangle, Persist, Cache — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Preferred Partners Banner a persistent, cached, top-level-category artifact served by a new lightweight endpoint; delete the redundant "Top Distributors" surface; and remove the overloaded `suppliers` field so each sponsor surface has exactly one source.

**Architecture:** A new `GET /api/categories/{slug}/partners` (resolves any slug to its top-level ancestor) returns just the Featured sponsors + `no-cache` + ETag/304. The banner moves into `PublicLayout` as a sibling of the pathname-keyed `ErrorBoundary` (like `Footer`/`BackdropLayer`) so it never remounts during intra-subtree navigation. `get_category_by_slug` drops the `suppliers` list entirely; `SponsorBlock`'s `sponsor` stays. The SW `urlPattern` widens to cache (and bust) `/partners`.

**Tech Stack:** FastAPI + SQLAlchemy + Pydantic v2 (backend), React 19 + React Router v7 + TypeScript + Vite + vite-plugin-pwa/Workbox (frontend), pytest (SQLite in-memory), chrome-devtools-mcp (browser-prove).

**Spec:** `docs/superpowers/specs/2026-06-04-category-sponsors-untangle-design.md`

**Process directive (memory `feedback_review_cadence_tdd`):** Code-review after EVERY phase; EXTRA review at the integration/persistence/cache phases (D, E). Failing tests first. Each phase is a green-and-reviewable stopping point. Backend phases A/B are testable with no frontend change. Browser-prove D and E.

**Constraints:** No migration (head stays 011). Commit on `updates`; NO `Co-Authored-By`. No master-merge/deploy without explicit user go-ahead. API container has no volume mount → backend changes need `docker compose up -d --build api` when verifying in Docker (pytest runs locally without Docker). Keep `CLAUDE.md` < 40,960 B.

---

## File Structure

**Backend**
- `api/app/schemas/category.py` — *modify*: add `CategoryPartnersResponse`; remove `suppliers` from `CategoryDetailResponse`.
- `api/app/services/category_service.py` — *modify*: add `get_category_partners(db, slug)`; remove the `suppliers` build + return key from `get_category_by_slug`.
- `api/app/routes/categories.py` — *modify*: add `conditional_json` helper + the `/{slug}/partners` route; drop `suppliers=` from the detail-route constructor.
- `api/tests/test_category_partners.py` — *create*: endpoint + ETag/304 + child→parent resolution tests.
- `api/tests/test_categories.py` — *modify*: migrate the detail-`suppliers` assertions.
- `api/tests/test_sponsorship_single_source.py` — *modify*: migrate the 5 banner/child tests off `["suppliers"]`.

**Frontend**
- `frontend/src/public/types/category.ts` — *modify*: remove `suppliers` from `CategoryDetail`; add `CategoryPartners`.
- `frontend/src/public/services/api.ts` — *modify*: add `getCategoryPartners(slug)`.
- `frontend/src/public/pages/category/components/CategoryPartnersBanner.tsx` — *create*: location→top-level-slug→fetch→render `PreferredPartnersBanner`.
- `frontend/src/public/components/layout/PublicLayout.tsx` — *modify*: mount `<CategoryPartnersBanner />` above the ErrorBoundary.
- `frontend/src/public/pages/category/index.tsx` — *modify*: remove the banner render, the `<TopPartners>` usage + import, `sidebarGap`, and `category.suppliers` refs.
- `frontend/src/public/pages/category/components/TopPartners.tsx` + `TopPartners.module.scss` — *delete*.
- `frontend/src/public/pages/category/CategoryPage.module.scss` — *modify*: remove the now-unused `.sidebarGap`.
- `frontend/vite.config.ts` — *modify*: widen the `api-categories` SW `urlPattern`.
- `PreferredPartnersBanner.tsx` — **unchanged** (it filters `is_featured` + sorts `rank`; the endpoint stamps both, so it works as-is fed the partners list).

---

## PHASE A — Backend: the `/partners` endpoint (TDD)

*Stopping point: pytest green + code-review. Endpoint is testable via curl with no frontend change.*

### Task A1: `CategoryPartnersResponse` schema

**Files:** Modify `api/app/schemas/category.py`

- [ ] **Step 1: Add the schema** after `class FeaturedSupplier` (top of file, before `CategoryResponse`):

```python
class CategoryPartnersResponse(BaseModel):
    """The Preferred Partners banner payload for a TOP-LEVEL category.

    Split out of the heavy CategoryDetailResponse (2026-06-04) so the banner is
    a small, cacheable, top-level artifact fetched once per category subtree.
    `slug`/`name` are the RESOLVED top-level category (a child slug resolves to
    its parent), so the banner shows the same partners on every subpage.
    """

    slug: str
    name: str
    partners: list[SupplierResponse] = []
    model_config = ConfigDict(from_attributes=True)
```

- [ ] **Step 2: Verify it imports**

Run: `cd api && python -c "from app.schemas.category import CategoryPartnersResponse; print('ok')"`
Expected: `ok`

### Task A2: `get_category_partners` service (TDD)

**Files:** Test `api/tests/test_category_partners.py` (create); Modify `api/app/services/category_service.py`

- [ ] **Step 1: Write the failing test** — create `api/tests/test_category_partners.py`:

```python
"""GET /api/categories/{slug}/partners — the top-level Category Sponsors banner.

The banner is a TOP-LEVEL-category artifact: a child slug resolves to its parent,
so every subpage shows the same partners. Featured sponsors only (top-level tier).
"""


def _auth(client):
    token = client.post(
        "/api/auth/login", json={"username": "admin", "password": "testpass123"}
    ).json()["token"]
    return {"Authorization": f"Bearer {token}"}


def _feature(client, headers, supplier_id, category_id):
    return client.post(
        "/api/admin/sponsors/",
        json={"supplier_id": str(supplier_id), "category_id": str(category_id),
              "tier": "Featured", "status": "Active"},
        headers=headers,
    )


def test_partners_service_top_level_returns_featured(client, seeded_db, db):
    # NOTE: use the conftest `db` fixture (in-memory StaticPool engine), NOT
    # app.db.session.SessionLocal — the latter binds to the file DATABASE_URL
    # ("sqlite:///./test.db") and would NOT see the seeded in-memory data
    # (and would recreate the test.db file commit 899a004 removed).
    from app.services.category_service import get_category_partners

    headers = _auth(client)
    sup, parent = seeded_db["supplier1"], seeded_db["parent"]
    assert _feature(client, headers, sup.id, parent.id).status_code == 200

    result = get_category_partners(db, parent.slug)
    assert result is not None
    assert result["slug"] == parent.slug
    assert {s.name for s in result["partners"]} == {"Avnet"}


def test_partners_service_child_resolves_to_parent(client, seeded_db, db):
    from app.services.category_service import get_category_partners

    headers = _auth(client)
    sup, parent, child = seeded_db["supplier1"], seeded_db["parent"], seeded_db["child"]
    assert _feature(client, headers, sup.id, parent.id).status_code == 200

    result = get_category_partners(db, child.slug)
    assert result is not None
    # Child slug resolves to the parent's identity + the parent's partners.
    assert result["slug"] == parent.slug
    assert result["name"] == parent.name
    assert {s.name for s in result["partners"]} == {"Avnet"}


def test_partners_service_unknown_slug_returns_none(db):
    from app.services.category_service import get_category_partners

    assert get_category_partners(db, "nonexistent-slug") is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd api && pytest tests/test_category_partners.py -v`
Expected: FAIL — `ImportError: cannot import name 'get_category_partners'`

- [ ] **Step 3: Implement the service** — in `api/app/services/category_service.py`, add after `get_all_categories` (it reuses `_active_sponsor()` + `_tier_order()` already defined at the top):

```python
def get_category_partners(db: Session, slug: str) -> dict | None:
    """Preferred Partners for the TOP-LEVEL category of `slug`.

    Resolves a child slug to its top-level ancestor (2-level tree: a child's
    `parent` IS the top level), so the banner shows the SAME partners on the
    parent page and every subpage. Returns the resolved top-level identity plus
    its active sponsors, tier-ordered. Unknown slug → None (route → 404).
    """
    category = db.query(Category).filter(Category.slug == slug).first()
    if not category:
        return None
    top = category if category.parent_id is None else category.parent

    sponsor_suppliers = (
        db.query(Supplier)
        .join(Sponsor, Sponsor.supplier_id == Supplier.id)
        .filter(Sponsor.category_id == top.id)
        .filter(_active_sponsor())
        .order_by(_tier_order(), Sponsor.created_at)
        .all()
    )
    partners = []
    for position, supplier in enumerate(sponsor_suppliers, start=1):
        supplier.is_featured = True
        supplier.rank = position
        partners.append(supplier)

    return {"slug": top.slug, "name": top.name, "partners": partners}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd api && pytest tests/test_category_partners.py -v`
Expected: PASS (3 service tests)

### Task A3: the `/{slug}/partners` route + ETag (TDD)

**Files:** Test `api/tests/test_category_partners.py` (extend); Modify `api/app/routes/categories.py`

- [ ] **Step 1: Write the failing route tests** — append to `api/tests/test_category_partners.py`:

```python
def test_partners_route_shape_and_no_cache(client, seeded_db):
    headers = _auth(client)
    sup, parent = seeded_db["supplier1"], seeded_db["parent"]
    assert _feature(client, headers, sup.id, parent.id).status_code == 200

    r = client.get(f"/api/categories/{parent.slug}/partners")
    assert r.status_code == 200
    body = r.json()
    assert body["slug"] == parent.slug
    assert {p["name"] for p in body["partners"]} == {"Avnet"}
    cc = r.headers["cache-control"].lower()
    assert "no-cache" in cc and "max-age" not in cc
    assert r.headers.get("etag")


def test_partners_route_child_resolves_to_parent(client, seeded_db):
    headers = _auth(client)
    sup, parent, child = seeded_db["supplier1"], seeded_db["parent"], seeded_db["child"]
    assert _feature(client, headers, sup.id, parent.id).status_code == 200

    r = client.get(f"/api/categories/{child.slug}/partners")
    assert r.status_code == 200
    assert r.json()["slug"] == parent.slug


def test_partners_route_404_for_unknown(client, seeded_db):
    assert client.get("/api/categories/nope/partners").status_code == 404


def test_partners_etag_304_when_unchanged(client, seeded_db):
    headers = _auth(client)
    sup, parent = seeded_db["supplier1"], seeded_db["parent"]
    assert _feature(client, headers, sup.id, parent.id).status_code == 200

    r1 = client.get(f"/api/categories/{parent.slug}/partners")
    etag = r1.headers["etag"]
    r2 = client.get(f"/api/categories/{parent.slug}/partners",
                    headers={"If-None-Match": etag})
    assert r2.status_code == 304
    assert r2.content == b""
    assert "no-cache" in r2.headers["cache-control"].lower()


def test_partners_etag_changes_after_mutation(client, seeded_db):
    """Anti-staleness guard: adding a sponsor changes the ETag, so an old
    If-None-Match no longer 304s. Proves inc1's freshness invariant survives."""
    headers = _auth(client)
    a, b, parent = seeded_db["supplier1"], seeded_db["supplier2"], seeded_db["parent"]
    assert _feature(client, headers, a.id, parent.id).status_code == 200

    etag1 = client.get(f"/api/categories/{parent.slug}/partners").headers["etag"]
    assert _feature(client, headers, b.id, parent.id).status_code == 200  # 2nd Featured
    r = client.get(f"/api/categories/{parent.slug}/partners",
                   headers={"If-None-Match": etag1})
    assert r.status_code == 200  # content changed → no 304
    assert r.headers["etag"] != etag1
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd api && pytest tests/test_category_partners.py -v -k route or partners_etag`
Expected: FAIL — 404 (route not defined) / KeyError on `etag`.

- [ ] **Step 3: Implement the helper + route** — in `api/app/routes/categories.py`:

Update the import line and add stdlib imports at the top:

```python
import hashlib
import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas import CategoryDetailResponse, CategoryPartnersResponse, CategoryResponse
from app.services.category_service import (
    get_all_categories,
    get_category_by_slug,
    get_category_partners,
)
```

Add the helper after `_CATEGORY_CACHE_CONTROL`:

```python
def _conditional_json(request: Request, model, cache_control: str) -> Response:
    """Serialize `model` to JSON, attach a strong content-hash ETag + the given
    Cache-Control, and return 304 (empty body) when the client's If-None-Match
    matches. The ETag is over the EXACT bytes sent (by_alias to match FastAPI's
    default output), so it changes iff the content changes — never serving a
    stale banner. `no-cache` keeps the body revalidatable; the ETag makes that
    revalidation a cheap 304 instead of a re-download.
    """
    body = json.dumps(jsonable_encoder(model, by_alias=True)).encode("utf-8")
    etag = '"' + hashlib.sha256(body).hexdigest()[:32] + '"'
    headers = {"Cache-Control": cache_control, "ETag": etag}
    inm = request.headers.get("if-none-match", "")
    if etag in [tag.strip().removeprefix("W/") for tag in inm.split(",")]:
        return Response(status_code=304, headers=headers)
    return Response(content=body, media_type="application/json", headers=headers)
```

Add the route (place it BEFORE `get_category` so the literal `partners` segment reads clearly; FastAPI matches by pattern so order is not strictly required). No `response_model=` — we hand-serialize, so it would be ignored when returning a `Response`:

```python
@router.get("/{slug}/partners")
def get_partners(slug: str, request: Request, db: Session = Depends(get_db)):
    result = get_category_partners(db, slug)
    if result is None:
        raise HTTPException(404, "Category not found")
    model = CategoryPartnersResponse(
        slug=result["slug"], name=result["name"], partners=result["partners"]
    )
    return _conditional_json(request, model, _CATEGORY_CACHE_CONTROL)
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd api && pytest tests/test_category_partners.py -v`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Confirm `CategoryPartnersResponse` is exported from `app.schemas`**

Run: `cd api && grep -n "CategoryPartnersResponse\|CategoryDetailResponse" app/schemas/__init__.py`
If `CategoryDetailResponse` is re-exported but `CategoryPartnersResponse` is not, add it to `__init__.py` mirroring the existing export line. Re-run Step 4.

### Task A4: Phase A — code review + commit

- [ ] **Step 1: Run ruff**

Run: `cd api && ruff format app/routes/categories.py app/services/category_service.py app/schemas/category.py tests/test_category_partners.py && ruff check app/routes/categories.py app/services/category_service.py app/schemas/category.py`
Expected: no errors.

- [ ] **Step 2: Code review** — dispatch `feature-dev:code-reviewer` (or `/code-review`) on the uncommitted diff. Focus: ETag correctness (strong, content-hash, `by_alias=True` matches FastAPI output, no field leakage via `SupplierResponse`), child→parent resolution, 404 path, `no-cache` present on both 200 and 304. Address any high-confidence findings before committing.

- [ ] **Step 3: Commit**

```bash
git add api/app/schemas/category.py api/app/services/category_service.py api/app/routes/categories.py api/tests/test_category_partners.py api/app/schemas/__init__.py
git commit -m "feat(api): GET /api/categories/{slug}/partners — top-level Category Sponsors + ETag/304"
```

---

## PHASE B — Backend: simplify `get_category_by_slug` + drop `suppliers` (TDD)

*Stopping point: pytest green + code-review. Backend fully done + standalone.*

### Task B1: Migrate the detail-`suppliers` assertions (tests first)

**Files:** Modify `api/tests/test_categories.py`, `api/tests/test_sponsorship_single_source.py`

- [ ] **Step 1: Migrate `test_categories.py::test_get_category_by_slug`** — replace the `suppliers` block (current lines ~47-54) so it asserts the field is GONE and the `sponsor` (SponsorBlock) still carries Kennedy:

```python
def test_get_category_by_slug(client, seeded_db):
    """GET /api/categories/clock-and-timing returns detail with sponsor (banner
    moved to /partners as of 2026-06-04 — `suppliers` is gone from this payload)."""
    response = client.get("/api/categories/clock-and-timing")
    assert response.status_code == 200
    data = response.json()
    assert data["slug"] == "clock-and-timing"
    assert data["name"] == "Clock and Timing"

    # `suppliers` no longer exists on the detail payload — the banner is a
    # top-level artifact served by /api/categories/{slug}/partners.
    assert "suppliers" not in data

    # SponsorBlock's single sponsor (Kennedy Gold on this child) stays.
    assert data["sponsor"] is not None
    assert data["sponsor"]["supplier_name"] == "Kennedy Electronics"
    assert data["sponsor"]["tier"] == "gold"
    assert data["sponsor"]["image_url"] == "/test.jpg"
```

- [ ] **Step 2: Migrate `test_categories.py::test_parent_category_does_not_roll_up_child_featured_suppliers`** — the no-rollup invariant now lives on `/partners`. Replace its body:

```python
def test_parent_category_does_not_roll_up_child_featured_suppliers(client, seeded_db):
    """The partners banner shows a TOP-LEVEL category's OWN Featured sponsors —
    never a child's sponsor rolled up. conftest features Kennedy on the CHILD
    only and nothing on the parent, so the parent's /partners is empty, and the
    child's /partners (resolving to the parent) is empty too."""
    parent = client.get("/api/categories/integrated-circuits/partners")
    assert parent.status_code == 200
    assert parent.json()["partners"] == [], "no child→parent rollup onto the banner"

    # Child resolves to the parent for the banner → also empty (no own Featured).
    child = client.get("/api/categories/clock-and-timing/partners")
    assert child.status_code == 200
    assert child.json()["slug"] == "integrated-circuits"
    assert child.json()["partners"] == []
```

- [ ] **Step 3: Migrate the 5 `test_sponsorship_single_source.py` tests** that read `["suppliers"]`. Apply these exact edits:

`test_banner_reflects_sponsor_create_then_delete` — change `banner_names()`:

```python
    def banner_names():
        return {s["name"] for s in
                client.get(f"/api/categories/{parent.slug}/partners").json()["partners"]}
```

`test_new_child_sponsor_supersedes_prior` — the child's single-slot sponsor lives in `["sponsor"]` now (SponsorBlock), not the banner:

```python
    sponsor = client.get(f"/api/categories/{child.slug}").json()["sponsor"]
    assert sponsor is not None and sponsor["supplier_name"] == "Avnet", sponsor
```

`test_featured_top_level_sponsors_coexist` — read `/partners`:

```python
    names = {s["name"] for s in
             client.get(f"/api/categories/{parent.slug}/partners").json()["partners"]}
    assert names == {"Avnet", "Kennedy Electronics"}, names
```

`test_legacy_null_status_sponsor_visible` — the legacy NULL child sponsor is visible via `["sponsor"]`:

```python
def test_legacy_null_status_sponsor_visible(client, seeded_db):
    """The seeded Kennedy sponsor has NULL status (legacy). It must still surface
    as the child's SponsorBlock sponsor — NULL is treated as Active."""
    child = seeded_db["child"]
    sponsor = client.get(f"/api/categories/{child.slug}").json()["sponsor"]
    assert sponsor is not None and sponsor["supplier_name"] == "Kennedy Electronics"
```

`test_expired_sponsor_hidden_from_banner` — read `/partners`:

```python
    names = {s["name"] for s in
             client.get(f"/api/categories/{parent.slug}/partners").json()["partners"]}
    assert "Avnet" not in names
```

- [ ] **Step 2 (run): verify the migrated tests now FAIL for the right reason** — the field still exists, so the new `assert "suppliers" not in data` fails:

Run: `cd api && pytest tests/test_categories.py::test_get_category_by_slug -v`
Expected: FAIL on `assert "suppliers" not in data` (field still present — proves the test is non-vacuous).

### Task B2: Remove `suppliers` from the service, schema, and route

**Files:** Modify `api/app/services/category_service.py`, `api/app/schemas/category.py`, `api/app/routes/categories.py`

- [ ] **Step 1: Service** — in `get_category_by_slug`, delete the `sponsor_suppliers` query + the `is_featured`/`rank` stamping loop (current lines ~299-311, the block building `suppliers = []`), and remove `"suppliers": suppliers,` from the returned dict. Keep the `sponsor` block and everything else.

- [ ] **Step 2: Schema** — in `api/app/schemas/category.py`, remove `suppliers: list[SupplierResponse]` from `CategoryDetailResponse`. (Keep the `SupplierResponse` import — `CategoryPartnersResponse` uses it.)

- [ ] **Step 3: Route** — in `api/app/routes/categories.py` `get_category`, delete the `suppliers=result["suppliers"],` line from the `CategoryDetailResponse(...)` constructor.

- [ ] **Step 4: Grep for any missed reader**

Run: `cd api && grep -rn '\["suppliers"\]\|\.suppliers\|suppliers=' app/`
Expected: no remaining reference to the category detail `suppliers` (search-result/supplier-CRUD hits in other routers are unrelated; verify none are in `category_service.get_category_by_slug` or the category route).

- [ ] **Step 5: Run the migrated tests**

Run: `cd api && pytest tests/test_categories.py tests/test_sponsorship_single_source.py tests/test_category_partners.py -v`
Expected: PASS (all).

- [ ] **Step 6: Run the full backend suite** (catches any other `suppliers` consumer — e.g. `test_categories_featured_suppliers_list.py`, which tests the LIST `featured_suppliers` and should be unaffected)

Run: `cd api && pytest -q`
Expected: PASS. If `test_categories_featured_suppliers_list.py` fails, it asserted on detail `suppliers` — migrate it the same way; otherwise it tests `get_all_categories.featured_suppliers` and stays green.

### Task B3: Phase B — code review + commit

- [ ] **Step 1: ruff**

Run: `cd api && ruff format app/ tests/test_categories.py tests/test_sponsorship_single_source.py && ruff check app/`
Expected: clean.

- [ ] **Step 2: Code review** — dispatch `feature-dev:code-reviewer` on the diff. Focus: the detail response no longer leaks/loses anything else; `sponsor` (SponsorBlock) intact; no orphaned `suppliers`/`Supplier` import left dangling in the service; test migrations assert real behavior (not vacuous).

- [ ] **Step 3: Commit**

```bash
git add api/app/services/category_service.py api/app/schemas/category.py api/app/routes/categories.py api/tests/test_categories.py api/tests/test_sponsorship_single_source.py
git commit -m "refactor(api): drop category detail 'suppliers' — banner now sourced from /partners"
```

---

## PHASE C — Frontend: delete Top Distributors + de-banner CategoryPage

*Stopping point: tsc + eslint + build green + code-review. Smaller, testable: page renders sans banner (valid intermediate state).*

### Task C1: Delete TopPartners + strip CategoryPage

**Files:** Delete `frontend/src/public/pages/category/components/TopPartners.tsx` + `TopPartners.module.scss`; Modify `frontend/src/public/pages/category/index.tsx`, `frontend/src/public/types/category.ts`, `frontend/src/public/pages/category/CategoryPage.module.scss`

- [ ] **Step 1: Delete the component files**

```bash
git rm frontend/src/public/pages/category/components/TopPartners.tsx \
       frontend/src/public/pages/category/components/TopPartners.module.scss
```

- [ ] **Step 2: `index.tsx` — remove imports** (lines 8-9): delete both
  `import PreferredPartnersBanner from './components/PreferredPartnersBanner';`
  and `import TopPartners from './components/TopPartners';`.

- [ ] **Step 3: `index.tsx` — remove the banner render block** (the `{/* Preferred Partners banner — v14 ... */}` block, currently ~lines 360-369):

Delete:
```tsx
        {/* Preferred Partners banner — v14. ... */}
        {!busy && category && (
          <PreferredPartnersBanner
            suppliers={category.suppliers}
            categoryName={category.name}
          />
        )}
```

- [ ] **Step 4: `index.tsx` — simplify the right sidebar** (currently ~lines 414-418). Replace:

```tsx
            <div className={styles.right}>
              <SponsorBlock sponsor={category.sponsor} />
              <div className={styles.sidebarGap} />
              <TopPartners suppliers={category.suppliers} />
            </div>
```

with:

```tsx
            <div className={styles.right}>
              <SponsorBlock sponsor={category.sponsor} />
            </div>
```

- [ ] **Step 5: `types/category.ts`** — remove the `suppliers` line from `CategoryDetail` (current line 38: `suppliers: import('./supplier').Supplier[];`).

- [ ] **Step 6: `CategoryPage.module.scss`** — remove the now-unused `.sidebarGap { ... }` rule (current line ~299).

- [ ] **Step 7: tsc**

Run: `cd frontend && npx tsc --noEmit`
Expected: exit 0. (If a `category.suppliers` reference remains anywhere, tsc errors here — fix it.)

- [ ] **Step 8: eslint**

Run: `cd frontend && npx eslint src --ext .ts,.tsx`
Expected: exit 0 (boundary-clean; the pre-existing `useEntrance.ts:60` warning, if present, is unrelated).

- [ ] **Step 9: build**

Run: `cd frontend && npm run build`
Expected: build succeeds.

### Task C2: Phase C — code review + commit

- [ ] **Step 1: Code review** — dispatch `feature-dev:code-reviewer` on the diff. Focus: no dangling imports/refs to `TopPartners`/`PreferredPartnersBanner`/`category.suppliers`; the page still renders correctly without a banner (intermediate state is intentional — the banner returns in Phase D).

- [ ] **Step 2: Commit**

```bash
git add -A frontend/src/public/pages/category frontend/src/public/types/category.ts
git commit -m "refactor(web): delete Top Distributors + remove banner from CategoryPage (banner moves to layout)"
```

---

## PHASE D — Frontend: persistent banner in PublicLayout  *(EXTRA review)*

*Stopping point: browser-prove persistence + code-review EXTRA.*

### Task D1: API method + types

**Files:** Modify `frontend/src/public/types/category.ts`, `frontend/src/public/services/api.ts`

- [ ] **Step 1: Add the type** to `frontend/src/public/types/category.ts`:

```typescript
export interface CategoryPartners {
  slug: string;
  name: string;
  partners: import('./supplier').Supplier[];
}
```

- [ ] **Step 2: Add the API method** to `frontend/src/public/services/api.ts` — import the type and add to the `api` object:

```typescript
// (add CategoryPartners to the existing category type import)
import type { Category, CategoryDetail, CategoryPartners } from '@public/types/category';

  // Top-level Category Sponsors banner (small, cacheable). Trailing-slash-free
  // to match the route exactly; resolves a child slug to its parent server-side.
  getCategoryPartners: (slug: string) =>
    client.get<CategoryPartners>(`/categories/${slug}/partners`).then(r => r.data),
```

- [ ] **Step 3: tsc**

Run: `cd frontend && npx tsc --noEmit`
Expected: exit 0.

### Task D2: `CategoryPartnersBanner` wrapper

**Files:** Create `frontend/src/public/pages/category/components/CategoryPartnersBanner.tsx`

- [ ] **Step 1: Create the component:**

```tsx
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '@public/services/api';
import PreferredPartnersBanner from './PreferredPartnersBanner';
import type { CategoryPartners } from '@public/types/category';

/**
 * Persistent Preferred Partners banner. Mounted ONCE in PublicLayout (a sibling
 * of the pathname-keyed ErrorBoundary), so it survives intra-category navigation
 * without remounting — the banner is a TOP-LEVEL-category artifact, identical on
 * the parent page and every subpage.
 *
 * The first path segment after /category/ is the top-level slug in canonical
 * URLs; the endpoint resolves a child slug to its parent anyway, so a brief
 * pre-redirect flat-child URL still yields the correct banner. The fetch effect
 * keys on that slug, so navigating WITHIN a category (slug unchanged) never
 * refetches; only switching top-level categories does.
 */
function topLevelSlug(pathname: string): string | null {
  const m = pathname.match(/^\/category\/([^/]+)/);
  return m ? m[1] : null;
}

export default function CategoryPartnersBanner() {
  const { pathname } = useLocation();
  const slug = topLevelSlug(pathname);
  const [data, setData] = useState<CategoryPartners | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    // Clear stale data on a top-level switch so we never flash the previous
    // category's partners on the new one (intra-subtree nav doesn't run this —
    // slug is unchanged).
    setData(null);
    api
      .getCategoryPartners(slug)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [slug]);

  if (!slug || !data || data.partners.length === 0) return null;
  return <PreferredPartnersBanner suppliers={data.partners} categoryName={data.name} />;
}
```

- [ ] **Step 2: tsc**

Run: `cd frontend && npx tsc --noEmit`
Expected: exit 0.

### Task D3: Mount in PublicLayout

**Files:** Modify `frontend/src/public/components/layout/PublicLayout.tsx`

- [ ] **Step 1: Import + mount** — add the import and render the banner as the first child of `.outletWrap` (above the Suspense/ErrorBoundary so it stays outside the pathname key):

```tsx
import CategoryPartnersBanner from '@public/pages/category/components/CategoryPartnersBanner'
```

```tsx
      <div className={styles.outletWrap}>
        {/* Persistent Category Sponsors banner — sits OUTSIDE the pathname-keyed
            ErrorBoundary so it does not remount on intra-category navigation.
            Self-gates to /category/* and to non-empty partners. */}
        <CategoryPartnersBanner />
        <Suspense fallback={<RouteFallback />}>
          <ErrorBoundary key={location.pathname} scope="page">
            <Outlet />
          </ErrorBoundary>
        </Suspense>
      </div>
```

- [ ] **Step 2: tsc + eslint + build**

Run: `cd frontend && npx tsc --noEmit && npx eslint src --ext .ts,.tsx && npm run build`
Expected: all green.

### Task D4: Browser-prove persistence  *(this is the EXTRA-review checkpoint)*

- [ ] **Step 1: Rebuild the prod frontend image** (SW + hashed assets only run in the prod build):

Run: `docker compose up -d --build frontend` (and `api` if Phase A/B not yet in the running container: `docker compose up -d --build api`)

- [ ] **Step 2: Seed a Featured sponsor** on a top-level category (e.g. PMICs) via `/admin/sponsors` so the banner is non-empty, OR confirm one exists.

- [ ] **Step 3: chrome-devtools-mcp prove** — open `http://localhost/category/power-management-ics-pmics`:
  - Clear SW + caches, hard reload (`ignoreCache`).
  - Stamp a marker on the banner DOM: `evaluate_script` →
    `document.querySelector('[aria-label^="Preferred partners"]').dataset.probe = 'D4'`.
  - SPA-navigate to `…/ldo-regulators`, `…/dc-dc-converters`, `…/battery-management` (use `evaluate_script` + `querySelector('a[href$="ldo-regulators"]').click()` — `click(uid)` may miss React `<Link>`).
  - Re-check the marker after each nav: it must STILL read `'D4'` (same DOM node = no remount), and the banner content (count, names, "in <TopLevelName>") must be identical on every page.
  - Confirm the Network panel shows the `/partners` request fires **once** (first category load), not per subcategory.

- [ ] **Step 2 (review): Code review EXTRA** — dispatch `feature-dev:code-reviewer` on the full D diff. Focus: the persistence claim (banner outside the pathname key), the stale-clear on top-level switch, cancel-flag correctness, no layout/z-index regression (banner inside `.outletWrap` z-index:1 above BackdropLayer), CLS acceptability. Also confirm masthead placement (banner above breadcrumb) reads acceptably — flag if not.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/public/types/category.ts frontend/src/public/services/api.ts \
        frontend/src/public/pages/category/components/CategoryPartnersBanner.tsx \
        frontend/src/public/components/layout/PublicLayout.tsx
git commit -m "feat(web): persistent top-level Category Sponsors banner in PublicLayout"
```

---

## PHASE E — Caching: SW regex + ETag/304 + bust, end-to-end  *(EXTRA review)*

*Stopping point: browser-prove cache + invalidation + code-review EXTRA.*

### Task E1: Widen the SW urlPattern

**Files:** Modify `frontend/vite.config.ts`

- [ ] **Step 1: Update the `api-categories` regex** (current `urlPattern: /\/api\/categories(\/[^/?]+)?\/?(\?.*)?$/`) to allow the second `/partners` segment:

```typescript
            // Matches /api/categories , /api/categories/{slug} , and
            // /api/categories/{slug}/partners (≤2 path segments), with optional
            // trailing slash + query. Keeps /partners in the api-categories cache
            // so the existing bustSponsorCaches() sweeps it on every mutation.
            urlPattern: /\/api\/categories(\/[^/?]+){0,2}\/?(\?.*)?$/,
```

- [ ] **Step 2: build**

Run: `cd frontend && npm run build`
Expected: build succeeds; inspect `dist/sw.js` to confirm the new pattern is emitted (`grep -o 'categories[^,]*{0,2}[^,]*' dist/sw.js` or open the generated runtime-caching entry).

### Task E2: Browser-prove 304 + bust  *(EXTRA-review checkpoint)*

- [ ] **Step 1: Rebuild prod frontend**: `docker compose up -d --build frontend`.

- [ ] **Step 2: chrome-devtools-mcp — 304 through the SW + nginx gzip:**
  - Load `http://localhost/category/power-management-ics-pmics`, let the SW cache `/partners`.
  - Navigate away and back (or reload). In the Network panel, the `/partners` revalidation must show **304 Not Modified** (served from the browser HTTP cache via `If-None-Match`), not a full 200 body — confirming the ETag survives the nginx gzip proxy hop.

- [ ] **Step 3: chrome-devtools-mcp — bust on mutation:**
  - In `/admin/sponsors`, add (or delete) a Featured sponsor on PMICs.
  - Confirm `bustSponsorCaches()` ran (the `adminApi` choke point) — `caches.keys()` shows `api-categories` was deleted/recreated.
  - SPA-navigate to a PMICs page → the banner reflects the change on next navigation (no manual cache clear). This proves `/partners` is swept by the existing bust and the inc1 staleness invariant holds end-to-end.

- [ ] **Step 4: Code review EXTRA** — dispatch `feature-dev:code-reviewer` on the E diff. Focus: regex still matches the original two shapes (no over-broad match of unrelated paths), `/partners` is genuinely in `api-categories` (the cache `bustSponsorCaches` deletes), no `max-age` re-introduced. This is the cache-correctness gate — must not re-open the inc1 staleness bug.

- [ ] **Step 5: Commit**

```bash
git add frontend/vite.config.ts
git commit -m "feat(web): cache /partners in api-categories SW cache (swept by bustSponsorCaches)"
```

---

## PHASE F — Polish + final review

*Stopping point: full suites green + final whole-diff review.*

### Task F1: (Optional) "All" sub-nav chip on child pages

**Files:** Modify `frontend/src/public/pages/category/components/SubcategoryChips.tsx`

- [ ] **Step 1:** If desired, prepend an "All" chip linking to the parent's all-parts view (`categoryPath(parentSlug)`) so child pages match the parent's sub-nav. Keep crawlable `<Link>`s + `aria-current` semantics. If deferring, note it and skip.

- [ ] **Step 2:** tsc + eslint + build green.

### Task F2: Final verification + review + commit

- [ ] **Step 1: Full backend suite**

Run: `cd api && pytest -q`
Expected: PASS (full ~234-test suite; targeted runs were used per-phase for speed).

- [ ] **Step 2: Frontend gates**

Run: `cd frontend && npx tsc --noEmit && npx eslint src --ext .ts,.tsx && npm run build`
Expected: all green.

- [ ] **Step 3: Icon-text-node guard** (CLAUDE.md sweep — the new component renders no raw `{x.icon}`):

Run: `grep -rn ">{[a-zA-Z_]*\.icon}<\|>{[a-zA-Z_]*\.category_icon}<" frontend/src --include="*.tsx"`
Expected: empty.

- [ ] **Step 4: Final code review** — dispatch `feature-dev:code-reviewer` on the entire branch diff vs `master` (`git diff master...updates`). Whole-feature pass: the untangle is complete (3→2 surfaces), no dead code, the spec's §7 risk checklist is satisfied.

- [ ] **Step 5:** Stop and hand back to the user for verification before any `master` merge / deploy (per constraints — no master-push/deploy without explicit go-ahead).

---

## Self-Review (plan vs spec)

- **Spec §2/§3.2 (untangle, drop `suppliers`)** → Phase B. ✓
- **Spec §3.1 (persistence via PublicLayout sibling)** → Phase D (Task D3). ✓
- **Spec §3.2 (new endpoint + child→parent + ETag)** → Phase A. ✓
- **Spec §3.3 (delete TopPartners, de-banner CategoryPage, new wrapper, api, types)** → Phases C, D. ✓
- **Spec §3.3/§3.4 (SW regex widen + bust)** → Phase E. ✓
- **Spec §4 (masthead placement)** → Task D3 + reviewed in D4. ✓
- **Spec §5 (ETag rides /partners; detail/list ETag + inc4/inc5 deferred)** → Phase A only ETags /partners; deferred items not in plan. ✓
- **Spec §6 (TDD phases + review cadence; EXTRA at D/E)** → every phase ends with code-review; D4/E4 are EXTRA. ✓
- **Spec §7 risk checklist** — grep other `suppliers` consumers (B2 S4 + done pre-plan), migrate inc1 hardening tests (B1), SW regex tolerance (E1 comment + E4), nginx-gzip ETag (E2 S2), prove EB non-remount (D4 S3). ✓
- **Type consistency:** `get_category_partners` returns `{slug,name,partners}` (A2) → `CategoryPartnersResponse{slug,name,partners}` (A1) → route builds it (A3) → TS `CategoryPartners{slug,name,partners}` (D1) → wrapper consumes `.partners`/`.name` (D2). Names align. ✓
- **No migration / head 011** — confirmed; no alembic task. ✓
