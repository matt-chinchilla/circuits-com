# Category Sponsors — Untangle, Persist, Cache

**Date:** 2026-06-04
**Branch:** `updates`
**Status:** Design approved (placement = top-of-view masthead); pending spec review → writing-plans.

---

## 1. Problem

The category page has **three** partner/sponsor surfaces, but only **two** distinct
ideas — and the read path collapses them badly:

| Surface | Reads today | What that actually is | Verdict |
|---|---|---|---|
| Preferred Partners Banner | `category.suppliers` | active sponsors `WHERE category_id == THIS category` — on a **parent**: Featured (e.g. 2); on a **child**: that child's Platinum/Gold (e.g. 1) | ❌ conflated — the banner *switches meaning* between parent and child |
| SponsorBlock (sidebar) | `category.sponsor` | newest active sponsor for **this** category | ✅ correctly per-page |
| Top Distributors (`TopPartners`) | `category.suppliers` **(same array)** + hardcoded `"Silver"` | the *same sponsor list* as the banner | ❌ conflated — not even the distributor association |

Symptoms the user reported:
- Entering **PMICs** shows 2 Category Sponsors; entering a subcategory (e.g. `ldo-regulators`)
  the banner "turns to 1" and loses context — because the banner's data source silently
  switches from the **parent's Featured sponsors** to **the child's own sponsor**.
- Category pages "take forever to load" and re-load while browsing within a category.

**Root insight (from the user):** the *subcategory sponsor* and the *category (top-level)
sponsor* are **entirely separate concepts** that got interwoven through one overloaded
`suppliers` field doing double duty.

## 2. Final model (3 surfaces → 2)

- **Preferred Partners Banner** ← the **top-level category's** Featured sponsors (the
  "Category Sponsors"). A top-level artifact: identical on the parent page and **every**
  subpage, persistent across the subtree, cached. *Replaces Top Distributors.*
- **SponsorBlock** ← this subcategory's own sponsor. **Unchanged.**
- ~~**Top Distributors** (`TopPartners`)~~ — **deleted** (component + SCSS). The banner
  supersedes it.

Net effect: `category.suppliers` loses **both** consumers and is **removed entirely** from
the detail response — the read path simplifies.

## 3. Architecture

### 3.1 Persistence mechanism (the key decision)

`PublicLayout` wraps `<Outlet/>` in `<ErrorBoundary key={location.pathname}>`. That key
remounts the entire Outlet subtree on **every** pathname change — so a banner placed
inside a category page, or inside a nested layout route rendered *through* that Outlet,
would remount on `pmics → pmics/ldo-regulators` and defeat persistence.

**Decision:** render the banner **in `PublicLayout`, as a sibling of the ErrorBoundary**
(next to `<Footer/>`), gated to `/category/*`. PublicLayout is the route-group layout — it
does **not** remount on navigation; only its Outlet's children swap. So the banner lives
*outside* the pathname key and persists across all public navigation, exactly like
`<Footer/>` and `<BackdropLayer/>` already do.

- **No routing change.** The two existing routes (`/category/:slug`,
  `/category/:parentSlug/:childSlug`) stay as-is.
- **No ErrorBoundary change.**
- The banner reads the **first path segment** after `/category/` (always the top-level
  slug in canonical URLs) and feeds the existing `PreferredPartnersBanner`.

### 3.2 Backend

- **New service** `get_category_partners(db, slug) -> dict | None`:
  - Resolve `slug` to its **top-level ancestor** (2-level tree: a child's `parent` IS the
    top level). Passing a child slug therefore still returns the parent's partners — robust
    during the brief flat→nested redirect window.
  - Return `{ "slug", "name", "partners": [Supplier...] }`, active
    (`_active_sponsor()`) and tier-ordered (`_tier_order()`). Partners are pre-filtered and
    pre-ordered, so the banner ranks by **position** (no reliance on stamped
    `is_featured`/`rank`).
  - Unknown slug → `None` (route → 404).
- **New schema** `CategoryPartnersResponse { slug: str; name: str; partners: list[SupplierResponse] }`.
- **New route** `GET /api/categories/{slug}/partners`:
  - `Cache-Control: no-cache` (set after the 404 check — same pattern as the detail route).
  - **ETag/304** (strong, content-hash of the serialized body; `If-None-Match` → 304). This
    is a tiny payload — the ideal home for the ETag work (was inc2). Keep `no-cache` (not
    `no-store`) so 304 works.
- **Simplify** `get_category_by_slug`: delete the `sponsor_suppliers` query + the
  `is_featured`/`rank` stamping loop + the `"suppliers"` key in the return dict. Keep
  `sponsor` (SponsorBlock).
- **Schema** `CategoryDetailResponse`: **remove the `suppliers` field.**

### 3.3 Frontend

- **Delete** `pages/category/components/TopPartners.tsx` + `TopPartners.module.scss`.
- **`CategoryPage`** (`pages/category/index.tsx`): remove the `<PreferredPartnersBanner>`
  render (moves to PublicLayout), remove `<TopPartners>`, drop all `category.suppliers`
  usage + the `sidebarGap`. Keep `<SponsorBlock>`.
- **New** `CategoryPartnersBanner` (thin wrapper, mounted in PublicLayout): `useLocation()`
  → top-level slug → fetch partners (effect keyed on the slug) → render
  `PreferredPartnersBanner`. Renders `null` off `/category/*` and while empty/loading.
- **`PreferredPartnersBanner`:** take the partners list from the endpoint; drop the
  client-side `is_featured` filter (endpoint pre-filters); show the **top-level** category
  name (stable across subpages).
- **`api.ts`:** `getCategoryPartners(slug)`. **Types:** drop `suppliers` from
  `CategoryDetail`; add the partners type.
- **`vite.config.ts`:** widen the SW `urlPattern` regex so `…/{slug}/partners` is matched
  by the `api-categories` cache — so it's cached *and* swept by the existing
  `bustSponsorCaches` (inc1). Current regex allows ≤1 path segment after `categories`; needs
  to allow 2.

### 3.4 Caching / Big-O

Three layers, no new machinery:
1. **Persistent component state** — banner stays mounted across intra-subtree nav →
   **O(1)** banner fetches per subtree (was O(C) for C subcategories, each bundled in the
   heavy detail fetch).
2. **SW `StaleWhileRevalidate`** (`api-categories`) — instant on remount / return-to-category;
   already busted on every sponsor mutation (inc1).
3. **`no-cache` + ETag/304** (inc2) — revalidation costs headers, not the payload.

Banner query is **O(F)** (F = featured count, tiny) on an indexed
`sponsors(category_id, status)` lookup. No separate JS memo-cache needed (state + SW cover
it); the original **inc3** (category *list* memo) remains a separate, later item.

## 4. Visible change

The banner moves to the **top of the category view, above the breadcrumb/title** — it
becomes a stable "category masthead." This is a consequence of persistence (it cannot sit
below the per-page header and still persist). **Approved.** Watch for CLS on first paint
(banner appears after fetch) during browser-prove.

## 5. Scope & sequencing

This one cohesive increment delivers: the **untangle** + **inc6** (banner/parts split) +
**inc2's ETag** (now on `/partners`). It **supersedes** standalone inc2.

Still separate afterward (not in this increment):
- ETag on the **heavy** detail/list endpoints (optional; smaller win now that the banner is split).
- **inc4** — lighten the 500-part parts payload (the real "cold load" fix; own mini-design).
- **inc5** — indexes / precompute `best_price_*`.
- Minor follow-on: an **"All" chip** on the child-page sub-nav (the user's "all button"
  observation — it's the sticky sub-nav, not the banner). ~1 line; include in Phase F or defer.

## 6. Implementation sequencing — TDD + review cadence (per user directive)

> **Directive:** run a code-reviewing agent at **every plausible step**; think + review
> **EXTRA** at "stopping points" (where the changes are now independently testable); prefer
> **small** increments so every component is tested individually (test-driven-development).

Each phase below is a **stopping point**: it ends green-and-reviewable, and each is testable
in isolation. Backend (A, B) is fully testable via pytest/curl with **no** frontend change.

- **Phase A — Backend: new `/partners` endpoint (TDD).**
  Failing tests first: `get_category_partners` (top-level → Featured tier-ordered; child →
  resolves to parent; unknown → None; empty → []) and the route (200 shape; `ETag` present;
  `If-None-Match` → 304 empty body; `no-cache`; 404). → implement → green.
  **STOP:** pytest green + code-review. *(Endpoint independently testable via curl.)*

- **Phase B — Backend: simplify `get_category_by_slug` + drop `suppliers` (TDD).**
  First migrate/replace tests that asserted on detail `suppliers` (incl. the inc1 hardening
  tests that checked the banner via `suppliers`) to use the new endpoint/service; assert
  `sponsor` (SponsorBlock) unchanged. → remove the query/stamping + the field → green.
  **STOP:** pytest green + code-review. *(Backend complete + standalone.)*

- **Phase C — Frontend: delete Top Distributors + de-banner CategoryPage.**
  Delete `TopPartners.*`; strip `<TopPartners>` + `<PreferredPartnersBanner>` +
  `category.suppliers` from CategoryPage; update `CategoryDetail` type.
  **STOP:** `tsc --noEmit` + `eslint --ext .ts,.tsx` + `build` green + code-review.
  *(Smaller, testable: page renders sans banner — valid intermediate state.)*

- **Phase D — Frontend: persistent banner in PublicLayout.** *(EXTRA review.)*
  New `CategoryPartnersBanner` + `api.getCategoryPartners`; mount in PublicLayout gated to
  `/category/*`; adapt `PreferredPartnersBanner` props.
  **STOP:** browser-prove (clear SW + ignoreCache): banner identical on parent + every child;
  **persists across intra-subtree nav with no remount/refetch**; top-level name correct.
  Code-review **EXTRA** (this is the persistence integration).

- **Phase E — Caching: SW regex + ETag/304 + bust, end-to-end.** *(EXTRA review.)*
  Widen SW regex; confirm `bustSponsorCaches` sweeps `/partners`.
  **STOP:** browser-prove on prod-like build: 304 fires through the SW **and the nginx gzip
  hop**; an admin sponsor add/delete updates the banner on next nav (bust works). Code-review
  **EXTRA** (cache correctness — must not re-open the inc1 staleness bug).

- **Phase F — Polish + final review.**
  Optional "All" sub-nav chip; CLS check; full-suite pytest; final code-review of the whole diff.

## 7. Risks / verification checklist

- **Other `suppliers` consumers** — grep `category.suppliers` / `.suppliers` across
  `frontend/src` and the `suppliers` field server-side before deleting; confirm only the
  banner + TopPartners used it.
- **inc1 hardening tests** — `test_sponsorship_single_source.py` may assert the banner via
  `get_category_by_slug(...)["suppliers"]`; migrate to `get_category_partners`.
- **No new field leakage** — `/partners` returns `SupplierResponse` (same data as the old
  `suppliers`), so no new auth-gated field exposure; verify against the shared-schema gotcha.
- **SW regex** — must still match `/api/categories/`, `/api/categories/{slug}`, AND
  `/api/categories/{slug}/partners`, with the trailing-slash + query tolerance intact.
- **nginx gzip + ETag** — verify `If-None-Match` round-trips through the proxy on a
  prod-like build (green in pytest ≠ green through nginx).
- **EB persistence** — prove the banner truly does not remount on intra-subtree nav (stamp a
  `dataset` marker before nav, re-check after — the CLAUDE.md SPA-nav technique).
- **No migration** — head stays 011; no `--reseed` needed.

## 8. Files touched (estimate)

Backend: `routes/categories.py`, `services/category_service.py`, `schemas/category.py`,
tests (`test_cache_headers.py` or a new `test_category_partners.py`, plus migrating
`test_sponsorship_single_source.py` / category endpoint tests).
Frontend: `components/layout/PublicLayout.tsx`, new
`pages/category/components/CategoryPartnersBanner.tsx` (defined there, imported + mounted by PublicLayout),
`pages/category/index.tsx`, `components/PreferredPartnersBanner.tsx`, **delete**
`components/TopPartners.tsx` + `.module.scss`, `services/api.ts`, `types/category.ts`,
`vite.config.ts`. ~12–14 files; mostly deletion + one endpoint + one moved component.
