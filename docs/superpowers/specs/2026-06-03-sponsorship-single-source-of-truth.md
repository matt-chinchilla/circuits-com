# Sponsorship: single source of truth (Phase 1)

**Date:** 2026-06-03 · **Branch:** updates · **Status:** approved, building

## Problem
The category page's Preferred Partners banner reads `category_suppliers.is_featured`
(a flag on the CategorySupplier join), while `/admin/sponsors` reads the separate
`sponsors` table. The two drift: PMICs showed 8 "featured" companies but only 2 had
sponsor rows. There is no DB-level uniqueness, so a company can be sponsored/featured
twice. The model is not consistency-enforced.

## Target model — `sponsors` is the single source of truth
Each `sponsors` row = one Company's sponsorship at one placement. Everything
sponsorship-related on the public site derives from it. `category_suppliers` reverts to
a pure association (powers "Top Distributors"); its `is_featured`/`rank` columns are
DROPPED. The banner reads Featured sponsorships directly → `/admin/sponsors` and the
category page are the same rows (1:1).

### Placement / tier matrix
| Placement | category_id | keyword | Allowed tier(s) | Max per company |
|---|---|---|---|---|
| Category | top-level (15) | null | **Featured** | 15 (1 per cat) |
| Subcategory | child (75) | null | **Platinum, Gold** | 75 (1 per cat) |
| Keyword | null | set | **Silver, Gold, Platinum** | ∞ (1 per keyword) |

Silver is keyword-exclusive. Caps fall out of the uniqueness constraint (15+75 cats).

### ACID (Postgres-enforced)
- `UNIQUE(supplier_id, category_id)` — no dup per category. NULL category_id (keyword
  rows) are NULL-distinct, so ∞ keyword sponsors coexist. Works on SQLite too (tests).
- `UNIQUE(supplier_id, keyword)` — no dup per keyword; category rows (keyword NULL)
  coexist.
- Trigger `sponsor_tier_placement_check` (PG-only; SQLite tests rely on the app 422):
  Featured⟺top-level, Platinum/Gold⟺child, keyword⟺Silver/Gold/Platinum.

## Change buckets (KEEP/REPOINT/REMOVE/ADD)
- **Model** (`models/supplier.py`): REMOVE `CategorySupplier.is_featured`/`rank`.
  (`models/sponsor.py`): ADD two `UniqueConstraint`s.
- **Migration 011** (head=010): drop the 2 columns; add the 2 unique constraints; add the
  PG trigger; backfill legacy `gold`-on-top-level → `Featured`.
- **Service** (`category_service.py`): REPOINT `get_category_by_slug.suppliers` and
  `get_all_categories.featured_suppliers` to read Featured sponsorships.
- **Router** (`admin_sponsors.py`): REPOINT `_validate_tier_placement` to the matrix
  (Silver→keyword-only); REMOVE `_upsert_category_supplier_featured`,
  `_unfeature_after_delete` + their calls; ADD IntegrityError→409.
- **Delete** `routes/admin_category_suppliers.py` + unregister in `main.py`.
- **Seed**: drop `is_featured`/`rank` args; emit conforming Sponsor rows.
- **Frontend**: PreferredPartnersBanner drop the `is_featured` filter; admin sponsor form
  matrix gating (Silver→keyword); admin categories tree → read-only featured display
  (remove Unfeature button; management via /admin/sponsors); remove
  feature/unfeature from adminApi; repoint wizard feature step → createSponsor(Featured).
- **Tests**: remove test_admin_category_suppliers, test_admin_sponsors_featured,
  test_category_supplier_rollup; rewrite conftest (Featured sponsor) + the featured-list
  tests; add uniqueness + matrix + banner-source tests.

## Reconcile
Corrected `seed.py` + `--reseed` (local). Prod deploy gated separately.

## Phase 2 (later)
Company-centric sponsorship management UX on the supplier detail page.
