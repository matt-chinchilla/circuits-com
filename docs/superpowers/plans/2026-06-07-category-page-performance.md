# Category-Page Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make category browsing near-perfectly fluid between pages and fast on a cold mobile load, by fixing the real delivery-path defects (compression off, no conditional revalidation, unindexed queries, cold next-page nav) — not by re-architecting the fetch model.

**Architecture:** Four shippable phases + a deferred-paging tripwire. Phase 0 turns on edge gzip (639→189 KB cold load). Phase 1 adds ETag/304 to the detail endpoint (instant warm nav). Phase 2 indexes the hot DB columns. The tripwire guards the fetch-once model. Phase 3 warm-prefetches subcategory chips and runs a throttled-mobile bundle audit (brotli only if measured to be the long pole). Server-side paging is **deferred** — only its monitor is built.

**Tech Stack:** nginx (edge `nginx/nginx.ssl.conf`), FastAPI + SQLAlchemy + alembic (`api/`), React 19 + Vite + TS (`frontend/`), pytest (in-memory SQLite), chrome-devtools-mcp.

**Spec:** `docs/superpowers/specs/2026-06-07-category-page-performance-design.md`
**Branch:** `updates` — commit each task; **never** add a `Co-Authored-By` trailer. No push/merge/deploy without explicit owner go-ahead.
**Baseline suite:** 243 tests green (commit `83ef1d9`). Running totals below assume sequential execution on `updates`; if the baseline drifts the absolute count differs — **confirm `0 failed`**, the delta is what matters.

---

## File Structure

| File | Phase | Responsibility |
|---|---|---|
| `api/tests/test_nginx_gzip.py` (new) | 0 | Guard: edge nginx enables gzip for JSON+JS with `gzip_proxied` |
| `nginx/nginx.ssl.conf` (modify) | 0, 3* | Edge gzip directives (+ `*_static` only if brotli warranted) |
| `api/tests/test_cache_headers.py` (modify) | 1 | ETag-present + 304-on-If-None-Match tests for `/{slug}` |
| `api/app/routes/categories.py` (modify) | 1 | Route `get_category` through `_conditional_json` |
| `api/tests/test_part_indexes.py` (new) | 2 | Metadata guard: 5 hot columns have `index=True` |
| `api/app/models/part.py` (modify) | 2 | `index=True` on `category_id`, `sub_slug` |
| `api/app/models/part_listing.py` (modify) | 2 | `index=True` on `part_id`, `listing_id`, `min_quantity` |
| `api/alembic/versions/012_add_part_query_indexes.py` (new) | 2 | Index-only migration, revises `011` |
| `api/tests/test_category_size_tripwire.py` (new) | T | Fail when a category rollup nears the 500 cap |
| `frontend/src/public/pages/category/components/SubcategoryChips.tsx` (modify) | 3 | Hover/focus prefetch of sibling + parent categories |
| `frontend/vite.config.ts`, `frontend/package.json` (modify) | 3* | Precompression — **gated** on the audit |

`*` = conditional (only if the throttled-mobile audit shows the gzipped JS bundle is the long pole).

---

## Phase 0 — Edge gzip + guard test

Enables gzip at the edge nginx (`nginx/nginx.ssl.conf`) that terminates TLS and proxies `/`, `/api`, `/admin` — where compression is currently absent (config drift: the directive lives only in the inner `frontend/nginx.conf`, which does NOT apply to responses the edge proxies from the api upstream). Verified by a file-read guard test + a post-deploy wire check.

### Task 0.1: Failing guard test for edge gzip

**Files:** Create `api/tests/test_nginx_gzip.py`

- [ ] **Step 1: Write the failing guard test** (mirrors `test_nginx_cache_headers.py`'s file-read pattern; new file because that module's `NGINX_CONF` is scoped to the *inner* `frontend/nginx.conf` — this targets the *edge* `nginx/nginx.ssl.conf`).

```python
"""Regression guard for edge-nginx gzip compression.

The edge config (`nginx/nginx.ssl.conf`) terminates TLS and proxies `/`,
`/api`, and `/admin`. Gzip MUST be enabled HERE — the inner
`frontend/nginx.conf` gzip directive only compresses what the frontend
container serves directly; it does NOT apply to responses the edge proxies
back from the api upstream. Without edge gzip, the 116 KB category JSON and
the 522 KB JS bundle ship UNCOMPRESSED (config drift: CLAUDE.md claimed
compression on, but it was off at the edge). `gzip_proxied` must be set or
proxied `/api` responses stay uncompressed even with `gzip on`.
(2026-06-07 category-page performance — Phase 0.)
"""

from pathlib import Path

NGINX_CONF = Path(__file__).resolve().parents[2] / "nginx" / "nginx.ssl.conf"


def test_edge_gzip_is_enabled():
    conf = NGINX_CONF.read_text()
    assert "gzip on;" in conf, (
        "edge `nginx/nginx.ssl.conf` MUST set `gzip on;` so proxied responses "
        "(category JSON, JS bundle) compress — the inner frontend/nginx.conf "
        "gzip does NOT apply to what the edge proxies from the api upstream."
    )


def test_edge_gzip_covers_json_and_javascript():
    conf = NGINX_CONF.read_text()
    gzip_types_line = next(
        (ln for ln in conf.splitlines() if "gzip_types" in ln), ""
    )
    assert "application/json" in gzip_types_line, (
        "`gzip_types` MUST include application/json or the 116 KB category "
        "JSON ships uncompressed — the headline cold-load lever."
    )
    assert "application/javascript" in gzip_types_line, (
        "`gzip_types` MUST include application/javascript or the 522 KB JS "
        "bundle ships uncompressed."
    )


def test_edge_gzip_proxied_is_set():
    conf = NGINX_CONF.read_text()
    assert "gzip_proxied" in conf, (
        "`gzip_proxied` MUST be set (e.g. `any`) — nginx does NOT compress "
        "proxied responses by default, so /api responses from the api "
        "upstream would stay uncompressed even with `gzip on`."
    )
```

- [ ] **Step 2: Run → confirm FAIL**
  Run: `cd api && python -m pytest tests/test_nginx_gzip.py -v`
  Expected: `3 failed` — no `gzip` directive exists in `nginx.ssl.conf` yet.

### Task 0.2: Enable gzip at http-scope in the edge config

**Files:** Modify `nginx/nginx.ssl.conf` (insert after the `upstream api {}` block, before the first `# HTTP → HTTPS` comment)

- [ ] **Step 1: Insert the gzip block** (the file has no explicit `http {}` wrapper — it's included in nginx's main `http` context, so http-scope directives go at top level; this applies to all four `server {}` blocks).

  Edit `nginx/nginx.ssl.conf` —
  **old_string:**
  ```
  upstream api {
      server api:8000;
  }

  # HTTP → HTTPS for every hostname we serve
  ```
  **new_string:**
  ```
  upstream api {
      server api:8000;
  }

  # Edge gzip — compress proxied responses (category JSON from the api
  # upstream + the JS bundle from the frontend upstream). The inner
  # frontend/nginx.conf gzip does NOT cover what THIS edge proxies, and
  # gzip_proxied is required because nginx skips compressing proxied
  # responses by default. Cold mobile category load 639 -> 189 KB (3.4x).
  gzip on;
  gzip_vary on;
  gzip_proxied any;
  gzip_comp_level 6;
  gzip_min_length 1024;
  gzip_types text/plain text/css application/javascript application/json image/svg+xml application/xml;

  # HTTP → HTTPS for every hostname we serve
  ```
  > NOTE: the arrow in the existing comment is the literal Unicode `→` (U+2192) as on disk — match it exactly; do NOT substitute `->`.

- [ ] **Step 2: Run guard → confirm PASS**
  Run: `cd api && python -m pytest tests/test_nginx_gzip.py -v`
  Expected: `3 passed`.

- [ ] **Step 3: No-regression on the sibling nginx test**
  Run: `cd api && python -m pytest tests/test_nginx_cache_headers.py tests/test_nginx_gzip.py -q`
  Expected: `6 passed` (3 cache-header + 3 gzip; the cache test reads `frontend/nginx.conf`, untouched).

### Task 0.3: Commit Phase 0

- [ ] **Step 1: Confirm branch** — `git -C . branch --show-current` → `updates`
- [ ] **Step 2: Commit** (no Co-Authored-By)
```bash
git add nginx/nginx.ssl.conf api/tests/test_nginx_gzip.py
git commit -m "perf(nginx): enable edge gzip for JSON + JS (cold category load 639->189 KB)

Edge nginx.ssl.conf had no gzip directive — config drift (CLAUDE.md
claimed compression on; it lived only in the inner frontend/nginx.conf,
which does not apply to responses the edge proxies from the api upstream).
Add http-scope gzip on/vary/proxied any/comp_level 6/min_length 1024 +
gzip_types incl. application/json and application/javascript. Guarded by
new api/tests/test_nginx_gzip.py."
```

### Task 0.4: Post-deploy wire verification (AFTER `./deploy.sh` only — not local TDD)

> `./deploy.sh` restarts nginx automatically (since 2026-06-02), so a config-only change ships with a plain deploy. Run the `deploy-preflight` agent first. The guard test only asserts config *text*; these curls prove nginx actually compresses.

- [ ] **Verify proxied JSON gzipped:** `curl -sI -H 'Accept-Encoding: gzip' https://circuits.com/api/categories/ | grep -i content-encoding` → `content-encoding: gzip`
- [ ] **Verify JS bundle gzipped:** `JS=$(curl -s https://circuits.com/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1); curl -sI -H 'Accept-Encoding: gzip' "https://circuits.com$JS" | grep -i content-encoding` → `content-encoding: gzip`

---

## Phase 1 — ETag / 304 on `GET /api/categories/{slug}`

Wrap `get_category` in the existing `_conditional_json` helper (already used by `/partners`) so a warm re-nav with `If-None-Match` returns an empty 304 instead of re-sending the ~23 KB body. Stays `Cache-Control: no-cache`; the ETag is a strong sha256 content hash, so it changes on any sponsor/part/price change — no staleness reintroduced.

### Task 1.1: Failing test — `/{slug}` carries an ETag

**Files:** Modify `api/tests/test_cache_headers.py` (append after `test_get_partners_cache_header`, ~line 40)

- [ ] **Step 1: Write the failing test**
```python
def test_get_category_etag_header(client, seeded_db):
    # Detail route gains a strong content-hash ETag (conditional GET) so a warm
    # re-nav revalidates as a cheap 304 instead of re-sending the full body.
    # Stays no-cache (banner single-source freshness) — mirrors /partners.
    r = client.get("/api/categories/clock-and-timing")
    _assert_no_cache(r)
    etag = r.headers.get("etag")
    assert etag, "detail endpoint must carry an ETag for conditional GET"
    assert not etag.startswith("W/"), f"ETag must be strong (content hash), got: {etag!r}"
```
- [ ] **Step 2: Run → FAIL**
  Run: `cd api && python -m pytest tests/test_cache_headers.py::test_get_category_etag_header -v`
  Expected: `1 failed` — `AssertionError: detail endpoint must carry an ETag` (route currently sets only `Cache-Control`).

### Task 1.2: Failing test — matching `If-None-Match` → 304 empty body

**Files:** Modify `api/tests/test_cache_headers.py` (append after Task 1.1's test)

- [ ] **Step 1: Write the failing 304 test**
```python
def test_get_category_304_on_matching_if_none_match(client, seeded_db):
    # A warm re-navigation sends If-None-Match with the prior ETag; the server
    # returns 304 with an empty body (no 23 KB re-transfer). Mirrors /partners.
    first = client.get("/api/categories/clock-and-timing")
    etag = first.headers["etag"]
    second = client.get(
        "/api/categories/clock-and-timing", headers={"If-None-Match": etag}
    )
    assert second.status_code == 304, f"expected 304, got {second.status_code}"
    assert second.content == b"", f"304 body must be empty, got {second.content!r}"
    assert second.headers["etag"] == etag, "304 must echo the same ETag"
```
- [ ] **Step 2: Run → FAIL**
  Run: `cd api && python -m pytest tests/test_cache_headers.py::test_get_category_304_on_matching_if_none_match -v`
  Expected: `1 failed` — `KeyError: 'etag'` (no ETag emitted).

### Task 1.3: Implement — route `get_category` through `_conditional_json`

**Files:** Modify `api/app/routes/categories.py` (`get_category`, lines 66-100)

- [ ] **Step 1: Drop `response_model`, swap `response: Response` → `request: Request`**
  **old:**
  ```python
  @router.get("/{slug}", response_model=CategoryDetailResponse)
  def get_category(
      slug: str,
      response: Response,
      popular_page: int = Query(1, ge=1, alias="popular_page"),
      popular_per_page: int = Query(20, ge=1, le=500, alias="popular_per_page"),
      parts_page: int = Query(1, ge=1, alias="parts_page"),
      parts_per_page: int = Query(20, ge=1, le=500, alias="parts_per_page"),
      db: Session = Depends(get_db),
  ):
  ```
  **new:**
  ```python
  @router.get("/{slug}")
  def get_category(
      slug: str,
      request: Request,
      popular_page: int = Query(1, ge=1, alias="popular_page"),
      popular_per_page: int = Query(20, ge=1, le=500, alias="popular_per_page"),
      parts_page: int = Query(1, ge=1, alias="parts_page"),
      parts_per_page: int = Query(20, ge=1, le=500, alias="parts_per_page"),
      db: Session = Depends(get_db),
  ):
  ```
  > `Request` is already imported (line 4). `_conditional_json` serializes via `jsonable_encoder(by_alias=True)` and returns a raw `Response`, so `response_model=` is dropped (same as `/partners`).

- [ ] **Step 2: Build the model, return via `_conditional_json` (404 ordering preserved)**
  **old:**
  ```python
      if not result:
          raise HTTPException(404, "Category not found")
      response.headers["Cache-Control"] = _CATEGORY_CACHE_CONTROL
      # Build response that matches CategoryDetailResponse
      cat = result["category"]
      return CategoryDetailResponse(
          id=cat.id,
          name=cat.name,
          slug=cat.slug,
          icon=cat.icon,
          description=cat.description,
          children=cat.children,
          parent=cat.parent,
          sponsor=result["sponsor"],
          parts=result["parts"],
          popular_parts=result["popular_parts"],
      )
  ```
  **new:**
  ```python
      if not result:
          raise HTTPException(404, "Category not found")
      # Build response that matches CategoryDetailResponse
      cat = result["category"]
      model = CategoryDetailResponse(
          id=cat.id,
          name=cat.name,
          slug=cat.slug,
          icon=cat.icon,
          description=cat.description,
          children=cat.children,
          parent=cat.parent,
          sponsor=result["sponsor"],
          parts=result["parts"],
          popular_parts=result["popular_parts"],
      )
      return _conditional_json(request, model, _CATEGORY_CACHE_CONTROL)
  ```

- [ ] **Step 3: Run the cache-header file → PASS**
  Run: `cd api && python -m pytest tests/test_cache_headers.py -v`
  Expected: `5 passed` (incl. the still-green `test_get_category_cache_header` — no-cache preserved).

- [ ] **Step 4: Full suite → no regressions** (watch any test asserting the `/{slug}` body shape; bytes are identical, only headers gained an ETag)
  Run: `cd api && python -m pytest tests/ -q`
  Expected: `0 failed`; running total ≈ **248** (243 + 3 gzip + 2 ETag).

### Task 1.4: Lint + commit Phase 1

- [ ] **Step 1: ruff clean** — `cd api && ruff format app/routes/categories.py tests/test_cache_headers.py && ruff check app/routes/categories.py tests/test_cache_headers.py` → `All checks passed!` (`Response` still used inside `_conditional_json` → no F401).
- [ ] **Step 2: Commit** (confirm `updates`; no Co-Authored-By)
```bash
git add api/app/routes/categories.py api/tests/test_cache_headers.py
git commit -m "perf(api): ETag/304 conditional GET on /categories/{slug} (reuse _conditional_json)

Wrap get_category through the existing _conditional_json helper so a warm
re-navigation with If-None-Match revalidates as a cheap 304 instead of
re-sending the full detail body. Stays Cache-Control: no-cache; the ETag is a
strong sha256 content hash so it changes on any sponsor/part/price change.
Mirrors the /partners route. Drops response_model= (helper serializes the
body). Phase 1 of the category-page performance spec."
```
> The SW StaleWhileRevalidate + 304 interplay is browser-proven in Phase 3 (no frontend change needed here — axios + SW already send `If-None-Match` from the cached ETag).

---

## Phase 2 — Index the hot DB columns (alembic 012, indexes only)

Add `index=True` to the five columns driving every category query, plus an index-only migration 012. Index-only DDL → cannot deadlock a `--reseed` heavy-DDL race.

### Task 2.1: Failing metadata test for the five indexes

**Files:** Create `api/tests/test_part_indexes.py`

- [ ] **Step 1: Write the failing test** (dialect-agnostic — SQLite ignores index *performance* but the model flag is assertable; mirrors the icon-length guard in `test_categories.py:114`)
```python
"""Regression guard for alembic 012: the five hot query columns must be indexed.

These columns drive the category-page query path: the per-page WHERE on
Part.category_id, the denormalized Part.sub_slug filter, and the batched
price-break joins (PartListing.part_id, PriceBreak.listing_id,
PriceBreak.min_quantity). SQLite (used by the test suite) ignores index
*performance*, but the SQLAlchemy column `index` flag is dialect-agnostic and
pins the schema regardless of DB engine — same approach as the icon-length
metadata guard in test_categories.py.
"""

import pytest

from app.models.part import Part
from app.models.part_listing import PartListing, PriceBreak

# (model, column_name) pairs that MUST carry index=True after migration 012.
INDEXED_HOT_COLUMNS = [
    (Part, "category_id"),
    (Part, "sub_slug"),
    (PartListing, "part_id"),
    (PriceBreak, "listing_id"),
    (PriceBreak, "min_quantity"),
]


@pytest.mark.parametrize("model, column_name", INDEXED_HOT_COLUMNS)
def test_hot_column_is_indexed(model, column_name):
    """Each hot query column declares index=True in the model metadata."""
    column = model.__table__.c[column_name]
    assert column.index is True, (
        f"{model.__name__}.{column_name} must declare index=True "
        f"(got index={column.index!r}). Add index=True to the model column and "
        "a matching CREATE INDEX in alembic migration 012."
    )
```
- [ ] **Step 2: Run → FAIL** — `cd api && python -m pytest tests/test_part_indexes.py -q` → `5 failed` (each reports `index=None`).

### Task 2.2: Add `index=True` to the two `Part` columns

**Files:** Modify `api/app/models/part.py`

- [ ] **Step 1: `Part.category_id`**
  old: `category_id = Column(\n        UUID(as_uuid=True), ForeignKey("categories.id"), nullable=True\n    )`
  new: `category_id = Column(\n        UUID(as_uuid=True), ForeignKey("categories.id"), nullable=True, index=True\n    )`
- [ ] **Step 2: `Part.sub_slug`**
  old: `sub_slug = Column(String(80), nullable=True)`
  new: `sub_slug = Column(String(80), nullable=True, index=True)`

### Task 2.3: Add `index=True` to the `PartListing` + `PriceBreak` columns

**Files:** Modify `api/app/models/part_listing.py`

- [ ] **Step 1: `PartListing.part_id`**
  old: `part_id = Column(\n        UUID(as_uuid=True), ForeignKey("parts.id"), nullable=False\n    )`
  new: `part_id = Column(\n        UUID(as_uuid=True), ForeignKey("parts.id"), nullable=False, index=True\n    )`
- [ ] **Step 2: `PriceBreak.listing_id`**
  old: `listing_id = Column(\n        UUID(as_uuid=True), ForeignKey("part_listings.id"), nullable=False\n    )`
  new: `listing_id = Column(\n        UUID(as_uuid=True), ForeignKey("part_listings.id"), nullable=False, index=True\n    )`
- [ ] **Step 3: `PriceBreak.min_quantity`**
  old: `min_quantity = Column(Integer, nullable=False)`
  new: `min_quantity = Column(Integer, nullable=False, index=True)`
- [ ] **Step 4: Run metadata test → PASS** — `cd api && python -m pytest tests/test_part_indexes.py -q` → `5 passed`.
- [ ] **Step 5: Full suite → no regressions** — `cd api && python -m pytest tests/ -q` → `0 failed`; running total ≈ **253**.

### Task 2.4: Create migration 012 + verify the chain

**Files:** Create `api/alembic/versions/012_add_part_query_indexes.py`

- [ ] **Step 1: Confirm `011` is the single head**
  Run: `cd api && DATABASE_URL="sqlite:///./test.db" alembic heads`
  Expected: `011 (head)` — so `down_revision = "011"`. (If a later migration has landed, set `down_revision` to the true head.)
- [ ] **Step 2: Write the migration** (style mirrors `008_add_part_slug.py`; names match SQLAlchemy's auto `ix_<table>_<col>` so no model/migration drift)
```python
"""Index the hot category-page query columns

Phase 2 of the category-page performance work. Adds plain B-tree indexes on the
columns that drive every category nav: the per-page Part.category_id scan, the
denormalized Part.sub_slug filter, and the batched price-break joins
(PartListing.part_id, PriceBreak.listing_id, PriceBreak.min_quantity). Before
this, all five were unindexed -> sequential scans on ~3.6K parts / 41K listings /
164K price breaks.

Index-only migration — no column/constraint/trigger DDL — so it carries only a
brief lock during the api restart window and CANNOT deadlock a --reseed against a
heavy-DDL migration (the 011 hazard).

Revision ID: 012
Revises: 011
Create Date: 2026-06-07
"""

from alembic import op

revision = "012"
down_revision = "011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_parts_category_id", "parts", ["category_id"], unique=False
    )
    op.create_index("ix_parts_sub_slug", "parts", ["sub_slug"], unique=False)
    op.create_index(
        "ix_part_listings_part_id", "part_listings", ["part_id"], unique=False
    )
    op.create_index(
        "ix_price_breaks_listing_id", "price_breaks", ["listing_id"], unique=False
    )
    op.create_index(
        "ix_price_breaks_min_quantity",
        "price_breaks",
        ["min_quantity"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_price_breaks_min_quantity", table_name="price_breaks")
    op.drop_index("ix_price_breaks_listing_id", table_name="price_breaks")
    op.drop_index("ix_part_listings_part_id", table_name="part_listings")
    op.drop_index("ix_parts_sub_slug", table_name="parts")
    op.drop_index("ix_parts_category_id", table_name="parts")
```
- [ ] **Step 3: Verify 012 is the new head** — `cd api && DATABASE_URL="sqlite:///./test.db" alembic heads` → `012 (head)`.
- [ ] **Step 4: Verify the chain** — `cd api && DATABASE_URL="sqlite:///./test.db" alembic history | head -3` → top line `011 -> 012 (head), Index the hot category-page query columns`.

### Task 2.5: Commit Phase 2

- [ ] Confirm `updates`, stage the 4 files (`git status --short` shows `M part.py`, `M part_listing.py`, `A test_part_indexes.py`, `A 012_...py`), commit (no Co-Authored-By):
```bash
git add api/app/models/part.py api/app/models/part_listing.py api/tests/test_part_indexes.py api/alembic/versions/012_add_part_query_indexes.py
git commit -m "perf(api): index hot category-page query columns + alembic 012

Add index=True on Part.category_id, Part.sub_slug, PartListing.part_id,
PriceBreak.listing_id, PriceBreak.min_quantity and a matching index-only
migration 012 (revises 011). Stops the per-page category_id scan and the four
batched price-break joins from sequential scans -> faster TTFB on every
category nav. Index-only DDL, cannot deadlock a --reseed race. Guarded by a
dialect-agnostic metadata test."
```
> The `migration-safety-check.sh` PreToolUse hook runs on commit; an index-only migration passes cleanly.

---

## Phase T — Deferred-paging tripwire (category-size monitor)

A guard that fails when the fetch-everything model is about to outgrow itself. **Not** server-side paging — only the monitor. Engineered to PASS today (measured max rollup = 320, PMICs < 450), so it's a regression tripwire, not a red-green cycle.

### Task T.1: Add the tripwire test

**Files:** Create `api/tests/test_category_size_tripwire.py`

- [ ] **Step 1: Write it** (measures the REAL catalog JSON — `api/app/db/catalog_data/*.json` is what prod seeds from — replaying seed's SKU-dedup; runs in <1s, no DB. The conftest fixture has only 2 parts → would give false comfort; a full `seed(db)` costs ~35s → too heavy for every run.)
```python
"""Deferred-paging TRIPWIRE — guards the fetch-everything category model.

The category page fetches every part for a top-level category in ONE request
(`per_page=500`), then filters/sorts/paginates client-side. Per the approved
spec (docs/superpowers/specs/2026-06-07-category-page-performance-design.md),
server-side paging is DEFERRED because at today's scale it would hurt nav
fluidity for a negligible cold-load gain. This test is the automatic signal
for if/when that ever needs to flip.

It computes, for the SEEDED real catalog, each top-level category's part
rollup — the SUM of its children's parts, which is exactly what
`category_service._build_popular_parts` loads for a parent page (the biggest
single-page set) — and asserts the max stays below 90% of the 500 cap.

WHY MEASURE THE CATALOG JSON DIRECTLY (not the conftest fixture, not a full
`seed(db)`):
  - The conftest `seeded_db` fixture has only 2 parts — asserting against it
    would give false comfort (it can never trip). The REAL ~3,600-part catalog
    is what matters.
  - A full `seed(db)` reproduces the exact prod rollup (PMICs = 325) but costs
    ~35s — too heavy for a guard that runs in every suite run.
  - `api/app/db/catalog_data/*.json` IS the real catalog prod seeds from. This
    test replays seed's own attachment logic — map each `sub_slug` to its
    parent via `CATEGORY_DATA`, dedupe parts by SKU exactly as
    `_seed_real_catalog` does (`if existing: continue`) — so the number tracks
    the real data, in milliseconds, with no DB.
  - Small known delta: this yields 320 vs the DB's 325 (the difference is the
    handful of `_DEMO_CATALOG` demo parts the full seed also adds). Both are
    far below the 450 threshold; the JSON figure is slightly conservative.
  - The ULTIMATE check is prod: the live `/api/categories/` rollup sums.
"""

import json
from pathlib import Path

from app.db.seed import CATEGORY_DATA

# 90% of the 500 fetch-everything cap (per_page=500 at the 3 call sites).
ROLLUP_THRESHOLD = 450
CATALOG_DIR = Path(__file__).resolve().parents[1] / "app" / "db" / "catalog_data"


def _rollup_by_top_level() -> dict[str, int]:
    """Parts per top-level category = sum over its children, deduped by SKU —
    mirrors `_seed_real_catalog` (sorted files, skip already-seen SKU) and the
    `category_service._build_popular_parts` self+children rollup."""
    sub_to_parent: dict[str, str] = {}
    for _name, parent_slug, _icon, subs in CATEGORY_DATA:
        for _sub_name, sub_slug, _sub_icon in subs:
            sub_to_parent[sub_slug] = parent_slug

    seen_skus: set[str] = set()
    rollup: dict[str, int] = {}
    for jf in sorted(CATALOG_DIR.glob("*.json")):
        data = json.loads(jf.read_text())
        for sub_slug, parts_list in data.items():
            parent_slug = sub_to_parent.get(sub_slug)
            if parent_slug is None:
                continue  # unknown sub_slug — seed warns + skips it too
            for part in parts_list:
                sku = part["sku"]
                if sku in seen_skus:
                    continue  # _seed_real_catalog: `if existing: continue`
                seen_skus.add(sku)
                rollup[parent_slug] = rollup.get(parent_slug, 0) + 1
    return rollup


def test_catalog_dir_present():
    """Sanity: the real catalog is what we measure. If it ever moves, this
    tripwire must fail loudly rather than silently pass on an empty rollup."""
    assert CATALOG_DIR.is_dir(), f"catalog_data dir missing at {CATALOG_DIR}"
    assert any(CATALOG_DIR.glob("*.json")), "no catalog JSON files to measure"


def test_no_category_rollup_exceeds_fetch_everything_threshold():
    rollup = _rollup_by_top_level()
    assert rollup, "rollup empty — catalog JSON not measured (see CATALOG_DIR)"
    biggest_slug = max(rollup, key=lambda k: rollup[k])
    biggest = rollup[biggest_slug]
    assert biggest < ROLLUP_THRESHOLD, (
        f"DEFERRED-PAGING TRIPWIRE TRIPPED: top-level category "
        f"'{biggest_slug}' has grown to {biggest} parts in its rollup, past "
        f"the safe threshold of {ROLLUP_THRESHOLD} (90% of the 500 "
        f"fetch-everything cap). A category has grown past the safe threshold "
        f"for the fetch-everything model — time to build server-side paging. "
        f"See docs/superpowers/specs/2026-06-07-category-page-performance-"
        f"design.md (the 'Deferred' section)."
    )
```
- [ ] **Step 2: Run → PASS today** — `cd api && python -m pytest tests/test_category_size_tripwire.py -v` → `2 passed` (biggest rollup 320, `power-management-ics-pmics` < 450).
- [ ] **Step 3: Prove it CAN fail (the "red" half), then revert** — temporarily set `ROLLUP_THRESHOLD = 300`, run `cd api && python -m pytest tests/test_category_size_tripwire.py::test_no_category_rollup_exceeds_fetch_everything_threshold -q` → `1 failed` with the `...grown to 320 parts...` message; then revert to `450` and re-run → `2 passed`.
- [ ] **Step 4: Full suite** — `cd api && python -m pytest tests/ -q` → `0 failed`; running total ≈ **255**.
- [ ] **Step 5: Commit** (confirm `updates`; no Co-Authored-By)
```bash
git add api/tests/test_category_size_tripwire.py
git commit -m "test(api): deferred-paging tripwire — fail when a category rollup nears the 500 fetch-everything cap

Guards the fetch-once category model (per_page=500) deferred in the
2026-06-07 category-page performance spec. Computes each top-level
category's rollup from the real catalog JSON (deduped by SKU as
_seed_real_catalog does) and asserts max < 450. Passes today (max 320,
PMICs); trips loudly when it's time to build server-side paging."
```

---

## Phase 3 — Prefetch subcategory chips + throttled-mobile bundle audit

Make next-page nav warm by hover/focus-prefetching every chip in `SubcategoryChips.tsx`, reusing the idempotent `_prefetchedCategories` guard in `api.ts`. Then a measure-then-decide audit; brotli precompression only if the gzipped JS bundle is confirmed the long pole. **Frontend has no unit test runner** — verification is `tsc --noEmit` + `eslint src/` + an in-browser network check.

### Task 3.1: Prefetch sibling + parent on chip hover/focus

**Files:** Modify `frontend/src/public/pages/category/components/SubcategoryChips.tsx`

- [ ] **Step 1 (note): re-read the file** to confirm it does NOT import `api`, the "All" chip is `<motion.button key="__all__" onClick={() => navigate(categoryPath(parentSlug))}>`, and each sibling is `<motion.button key={sub.id} onClick={() => navigate(categoryPath(sub.slug, parentSlug))}>`. `api.prefetchCategory(slug)` is idempotent via the module-level `_prefetchedCategories` Set (no stampede). Pass the **bare slug**, not a path.
- [ ] **Step 2: Add the `api` import** (mirror `CategoryCard.tsx:4`)
  old:
  ```tsx
  import { motion } from 'framer-motion';
  import { useNavigate } from 'react-router-dom';
  import Icon from '@shared/components/Icon';
  ```
  new:
  ```tsx
  import { motion } from 'framer-motion';
  import { useNavigate } from 'react-router-dom';
  import { api } from '@public/services/api';
  import Icon from '@shared/components/Icon';
  ```
- [ ] **Step 3: Warm the parent on the "All" chip** — add to the `key="__all__"` button:
  ```tsx
          onMouseEnter={() => api.prefetchCategory(parentSlug)}
          onFocus={() => api.prefetchCategory(parentSlug)}
  ```
  (immediately after its `onClick={() => navigate(categoryPath(parentSlug))}` line). It navigates to the parent top-level page → prefetch `parentSlug`. `onFocus` covers keyboard a11y.
- [ ] **Step 4: Warm each sibling on its chip** — add to the `key={sub.id}` button:
  ```tsx
            onMouseEnter={() => api.prefetchCategory(sub.slug)}
            onFocus={() => api.prefetchCategory(sub.slug)}
  ```
  (after its `onClick={() => navigate(categoryPath(sub.slug, parentSlug))}` line). Sibling navigates to the nested path but `prefetchCategory` keys on the **child** slug (the page fetch is `getCategory(sub.slug,...)`; the API resolves child→parent) — matches the `CategoryCard`/`SearchBar` convention. Passing `parentSlug` here would warm the wrong slug.
  > The active chip also prefetches — a benign no-op via the guard. Do NOT add `if (isActive) return`.

### Task 3.2: Verify (tsc + eslint + browser warm-nav)

- [ ] **Step 1: TypeScript strict** — `cd frontend && npx tsc --noEmit` → exit 0, no output.
- [ ] **Step 2: ESLint boundaries** — `cd frontend && npx eslint src/` → exit 0 (the new `@public/services/api` import from a `src/public/` file is a permitted same-scope import).
- [ ] **Step 3: Browser-prove** (chrome-devtools-mcp): start the stack (`docker compose up -d --build frontend api db nginx` or `cd frontend && npm run dev`), navigate to a leaf `/category/{parent}/{child}` whose parent has multiple children; `take_snapshot` → `hover(uid)` a sibling chip → `list_network_requests` shows exactly ONE new `GET /api/categories/{thatSlug}/?...per_page=500...`; hover the SAME chip again → ZERO additional requests (guard held); click → instant warm transition.

### Task 3.3: Commit the prefetch change

- [ ] Confirm `updates`, only `SubcategoryChips.tsx` staged, commit (no Co-Authored-By):
```bash
git add frontend/src/public/pages/category/components/SubcategoryChips.tsx
git commit -m "perf(web): hover/focus-prefetch subcategory chips (warm next-page nav, reuse _prefetchedCategories guard)"
```

### Task 3.4: Throttled-mobile bundle audit (MEASURE — produces the brotli decision, no speculative code)

- [ ] **Step 1 (note): serve a PROD build through the edge** so gzip is live and assets are minified/chunked/hashed: `cd . && DOCKER_BUILDKIT=1 docker compose up -d --build frontend api db nginx`. Pick the worst-case category (PMICs, ~325 parts). (Vite dev numbers are meaningless for this decision.)
- [ ] **Step 2: Emulate throttled mobile** (chrome-devtools): `emulate`/`resize_page` to ~390×844, set network to Slow 4G / Slow 3G + CPU throttle, clear SW + asset caches (cold load is the priority-#2 scenario).
- [ ] **Step 3: Capture a cold-load trace** (chrome-devtools): `performance_start_trace(reload=true, autoStop=true)` → navigate to the category URL; read LCP, `performance_analyze_insight` on the LCP insight; `list_network_requests` and sum transferred bytes for entry JS (index+framer+router) + category JSON + CSS; `get_network_request` on the big JS chunk to read `content-encoding` (should be `gzip` — confirms Phase 0). Baseline to beat: ~189 KB total (166 KB-gz JS + 23 KB-gz JSON).
- [ ] **Step 4 (note): apply the decision rule** — IF the gzipped JS transfer is the dominant transferred-bytes item AND LCP is gated on JS download in the critical path → brotli is **warranted** (proceed to Task 3.5). IF LCP is gated elsewhere (TTFB / JSON / main-thread CPU/parse) → brotli is **not warranted**, STOP and record the actual bottleneck for a future phase. Also confirm code-split boundaries are already optimal (framer + router are isolated vendor chunks; an unexpectedly large single chunk is a chunking fix, not compression). **Record the measured numbers + the yes/no decision in the plan notes.** This task's deliverable is the DECISION, not code.

### Task 3.5: [GATED] Precompressed `.br`/`.gz` assets + nginx `*_static`

> **Proceed ONLY if Task 3.4's recorded decision is "brotli warranted."** Uses precompressed-static (no runtime `brotli on;` dependency — `brotli_static` is a safe no-op if `ngx_brotli` is absent, degrading to gzip/identity). Depends on Phase 0's gzip block already in `nginx.ssl.conf`.

- [ ] **Step 1: Gate check** — confirm the "warranted" decision; design uses precompressed-static only.
- [ ] **Step 2: Add dev dep** — `cd frontend && npm install -D vite-plugin-compression` (build-only; emits sibling `.gz`/`.br`; do not hand-edit the lockfile — the PreToolUse hook blocks that).
- [ ] **Step 3: Register in `vite.config.ts`**
  old (imports — the file's full top block):
  ```ts
  import { defineConfig } from 'vite'
  import react from '@vitejs/plugin-react'
  import { VitePWA } from 'vite-plugin-pwa'
  import path from 'path'
  import { SW_CACHE_API_CATEGORIES, SW_CACHE_API_GENERAL } from './src/shared/swCacheNames'
  ```
  new:
  ```ts
  import { defineConfig } from 'vite'
  import react from '@vitejs/plugin-react'
  import { VitePWA } from 'vite-plugin-pwa'
  import viteCompression from 'vite-plugin-compression'
  import path from 'path'
  import { SW_CACHE_API_CATEGORIES, SW_CACHE_API_GENERAL } from './src/shared/swCacheNames'
  ```
  Then add two entries to the `plugins: [...]` array AFTER the `VitePWA({...})` entry:
  ```ts
      viteCompression({ algorithm: 'gzip', ext: '.gz', threshold: 1024, deleteOriginAssets: false }),
      viteCompression({ algorithm: 'brotliCompress', ext: '.br', threshold: 1024, deleteOriginAssets: false }),
  ```
  (`deleteOriginAssets: false` is required for identity/gzip fallback; `threshold: 1024` mirrors `gzip_min_length`.)
- [ ] **Step 4: Enable `*_static` in `nginx.ssl.conf`** — in the SAME http block as Phase 0's gzip, add `gzip_static on;` and `brotli_static on;` (nginx negotiates `.br` → `.gz` → runtime gzip → identity; no double-serve). Keep Phase 0's runtime `gzip on;` for dynamic `/api` responses.
- [ ] **Step 5: Verify + commit** — `npm run build && ls dist/assets | grep -E '\.(js|css)\.(gz|br)$'` shows siblings; rebuild through edge; `curl -sI -H 'Accept-Encoding: br' <asset>` → `content-encoding: br`, gzip fallback works, no-AE → identity; re-run the throttled trace (JS transfer −15-20%). Commit the 4 config files on `updates` (no Co-Authored-By); run `deploy-preflight` before any deploy.

---

## Task 3.4 — Measured audit + brotli decision (RECORDED 2026-06-08)

**Method:** Cold load of the worst-case PMICs parent (`/category/power-management-ics-pmics`, 320-part rollup) in a fresh isolated browser context (empty cache, no controlling SW), throttled to **Slow 4G + 4× CPU, 390×844 mobile**, via chrome-devtools-mcp. Local `/api` is not gzipped (Phase 0 lives in `nginx.ssl.conf` only), so the API figure below is the measured `gzip(-6)` of the per_page=500 body (24 KB) — the prod transfer.

**Cold-load result (prod-projected transfer):**
| Metric | Value |
|---|---|
| FCP | 3,264 ms |
| **LCP** | **4,332 ms — element = `<h1>` page title** (system `$font-heading`, NOT the icon font) |
| Main-thread long tasks | 7 / **550 ms** (JS parse/exec) |
| TTFB | 4 ms (local; prod HTML is no-cache + tiny) |

| Transfer | KB | % of total |
|---|---|---|
| JS (13 files, 600 KB decoded) | 181 | **46%** |
| Phosphor-Light.woff2 (1 file, already-compressed woff2) | 152 | **39%** |
| CSS (9 files) | 34 | 9% |
| API JSON (gz, per_page=500) | 24 | 6% |
| **TOTAL** | **391** | |
| Brotli-addressable (JS+CSS) | 215 | est. saving ~39 KB (~18%) |

**Decision: brotli NOT warranted now → Task 3.5 SKIPPED.** Rationale (per the Task 3.4 decision rule):
- The brotli-addressable bytes (JS+CSS) would save ~39 KB (~10% of the 391 KB cold load, ~200–400 ms on Slow 4G) — **real but the smallest lever.**
- The **single largest resource is the 155 KB Phosphor icon font, which is incompressible** (woff2) — brotli cannot touch it. Subsetting it to the ~90 icons actually used would save ~100+ KB, ~3× brotli's gain. **This is the #1 cold-load lever now.**
- LCP (4,332 ms) is significantly gated by **main-thread parse/exec** (550 ms long tasks at 4×; worse on real low-end) — brotli does not reduce parse cost. Lever = code-split / shrink the 600 KB decoded JS.
- The API JSON is already 24 KB via Phase 0 — no longer a gate.
- Code-split boundaries are already reasonable (framer + router are isolated vendor chunks; the 356 KB-raw entry is the documented eager-HomePage-for-LCP tradeoff). The big entry is a chunking question, not a compression one.

**Recorded bottlenecks for a FUTURE phase (priority order):** (1) **Phosphor font subsetting** (~100+ KB, the largest single lever, brotli-immune); (2) **main-thread JS parse** (550 ms — code-split / defer non-critical); (3) brotli precompressed-static as a smaller optional follow-up (~39 KB) once (1)+(2) land. None block this campaign.

---

## Post-implementation
- **Deploy** (owner-gated): `deploy-preflight` agent → `./deploy.sh` (restarts nginx) → run the Phase 0.4 wire checks → browser-prove the throttled-mobile cold load + 304 warm nav on prod.
- **claude-md-improver**: persist the gzip-config-drift gotcha (edge vs inner nginx), the `/{slug}` ETag, the 5 new indexes + migration 012, the subcategory-chip prefetch, and the deferred-paging tripwire (~450 threshold).

## Self-review notes (applied)
- pytest invocations normalized to `python -m pytest`.
- Suite pass-counts are **cumulative** (246 → 248 → 253 → 255), with "confirm 0 failed; delta is what matters."
- `vite.config.ts` import `old_string` (Task 3.5) completed to include line 5 (`swCacheNames`).
- Spec coverage: every spec requirement (gzip+guard, ETag/304+tests, 5 indexes+test+migration, prefetch, bundle audit, gated brotli, tripwire) maps to a task. No placeholders; cross-phase names/paths/revision verified against the live codebase by the adversarial critique.
