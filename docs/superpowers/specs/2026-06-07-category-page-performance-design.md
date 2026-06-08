# Category-Page Performance — Fluid Nav + Fast Mobile Cold-Load (Design Spec)

> Status: **approved** (2026-06-07). Next step: implementation plan via `writing-plans`.
> Branch: `updates`. No migration head change except Phase 2 (alembic 012, indexes only).

## Goal

Make the category browsing experience **near-perfectly fluid between pages** and **fast on a cold load in low-service mobile zones**, by fixing the actual root-cause defects in the delivery path — not by re-architecting the fetch model. Full server-side paging is **deferred behind a tripwire**, because at today's catalog size it would degrade nav fluidity for a negligible cold-load gain.

### Priorities (in order, per the owner)
1. Page-to-page navigation is near-perfectly fluid.
2. The site loads fast in low-service zones, out of the gate, on mobile.
3. Root-cause fixes only — no bandaids; future-stable.

## Measured baseline (prod, 2026-06-07 — these numbers justify the plan)

| Metric | Value | Source |
|---|---|---|
| Biggest category (parent rollup) | **325** parts (PMICs); biggest leaf 95; cap 500 | `/api/categories/` rollup sums |
| Category JSON (325 parts) | **119,242 B** (116 KB), **served uncompressed** | `curl` — `Accept-Encoding: gzip` returns byte-identical, no `content-encoding` |
| Category JSON compressed | **23,269 B** (23 KB) — 5.1× | `gzip -9` locally |
| Entry JS (index + framer + router) | **534,703 B** (522 KB) raw → **170,428 B** (166 KB) gz (3.1×), **served uncompressed** | per-asset `curl` + `gzip -9` |
| **Cold mobile category load, today** | **639 KB** (522 KB JS + 116 KB JSON) | sum |
| **Cold mobile category load, gzip only** | **189 KB** (3.4× less) | sum |
| gzip at the edge (`nginx.ssl.conf`) | **absent** — directive exists only in the inner `frontend/nginx.conf`, which the edge does not pass through | `grep`, wire |
| Hot DB columns indexed? | **No** — `category_id`, `sub_slug`, `listing_id`, `min_quantity`, `part_id` all unindexed (only `sku`, `slug`) | model files |
| ETag on `GET /{slug}` | **No** — `no-cache` only; `_conditional_json`/ETag used only by `/partners` | `routes/categories.py` |

### The reframe (why server-side paging is deferred, not built)
The cold-load bottleneck is the **JS bundle** (166 KB of the 189 KB gzipped total), not the parts JSON (23 KB gzipped). Server-side paging would shrink the JSON ~20 KB (~10% of the load) **while adding a network round-trip per filter/sort/page**, which works directly against priority #1. At a max of 325 rows, **fetch-once + gzip + cache is the more fluid architecture**: one small gzipped request, then instant client-side filter/sort/paginate, SW-cached for re-nav. Keeping it is the correct call — with a tripwire so we know if/when that ever flips.

## Architecture — four phases, each independently shippable, tested, reviewed

Order matters: each phase makes the next better and is safe on its own. Phase 0 alone delivers the headline win.

### Phase 0 — Edge gzip (the single biggest lever; both priorities)
- **Change:** add to the edge nginx `http` block in `nginx/nginx.ssl.conf`: `gzip on; gzip_vary on; gzip_proxied any; gzip_comp_level 6; gzip_min_length 1024; gzip_types text/plain text/css application/javascript application/json image/svg+xml application/xml;`
- **Effect:** cold mobile category load **639 → 189 KB (3.4×)**; every API response + the JS bundle compress site-wide. Faster cold load *and* faster per-nav transfer.
- **Root cause fixed:** compression was claimed on (CLAUDE.md) but off at the edge — config drift. Fixing it is permanent, not a bandaid.
- **Guard:** a test asserting the edge config enables gzip for `application/json` + `application/javascript` (mirrors the existing `test_nginx_cache_headers.py` config-grep pattern) so it can't silently regress again.
- **Deploy note:** nginx-only change → `./deploy.sh` restarts nginx (since 2026-06-02); verify on the wire post-deploy.

### Phase 1 — ETag / 304 on `GET /api/categories/{slug}` (priority #1: fluid nav)
- **Change:** wrap the `get_category` response in the existing `_conditional_json(request, model, _CATEGORY_CACHE_CONTROL)` helper (already used by `/partners`), so a warm re-navigation with `If-None-Match` returns an empty **304** instead of re-sending 23 KB.
- **Effect:** page-to-page revisits are near-instant; combines with gzip + the SW `StaleWhileRevalidate` `api-categories` cache.
- **Invariant preserved:** stays `Cache-Control: no-cache` (banner single-source freshness); the ETag is a strong content hash so it changes whenever any sponsor/part/price data changes — no staleness reintroduced.
- **Guard:** extend `test_cache_headers.py` — assert `/{slug}` carries an ETag and returns 304 on matching `If-None-Match` (model the two `/partners` ETag tests).

### Phase 2 — DB index pass (priority #1 TTFB + future stability)
- **Change:** alembic migration **012** + `index=True` on the models: `Part.category_id`, `Part.sub_slug`, `PartListing.part_id`, `PriceBreak.listing_id`, `PriceBreak.min_quantity`.
- **Effect:** the per-page `category_id` scan and the batched `price_breaks` joins (4 per page) stop doing unindexed scans → faster TTFB on every nav, and the queries stay fast as the catalog grows. Plain `CREATE INDEX` (tables are small: ~3.6K parts / 41K listings / 164K breaks — fast, brief lock acceptable during the api restart window).
- **Guard:** a metadata/migration test asserting the five indexes exist (SQLite ignores index *performance* but the migration + model flags are assertable).

### Phase 3 — Prefetch + mobile bundle polish (both priorities)
- **Concrete deliverable — prefetch:** extend the existing `api.prefetchCategory` hover/idle warming (today on `CategoryCard` + `SearchBar`) to the **subcategory pill-bar** (`SubcategoryChips.tsx`) — `onMouseEnter`/idle prefetch sibling + parent slugs so the next category page is warm in cache before the click → "near-perfectly fluid." Reuse the `_prefetchedCategories` guard.
- **Measure-then-decide — bundle:** a throttled-mobile Lighthouse / chrome-devtools pass (the 166 KB-gz bundle is the remaining cold-load cost). Output: confirm code-split/lazy boundaries are optimal and decide on **precompression/brotli** (e.g. `vite-plugin-compression` emitting `.gz`/`.br` + `gzip_static`/`brotli_static`) if the runtime-gzip bundle is still the long pole. Brotli is ~15–20% smaller than gzip on JS but needs the nginx module/precompressed assets — scoped as a follow-on only if the measurement says it's worth it.

## Deferred (behind a tripwire — monitored, not a bandaid)
Full **server-side paging + faceted counts + price-tier denormalization** (the old inc4/inc5 surgery). Deferred because it hurts priority #1 at current scale. To keep it future-stable:
- **Tripwire guard test:** fail (or loudly warn) if any category's part rollup exceeds a safe threshold (~450, i.e. ≥90% of the 500 cap). This is the automatic signal that the fetch-once model needs to become server-side. Runs against the seeded catalog.
- When it trips, the deferred design is: add `q`/`mfg`/`sub`/`sort`/`dir` params + a `facets` block to `GET /{slug}`, drop default `per_page` to 25, denormalize `best_price_10/100/1000` onto `Part` so price-column sorts are a plain `ORDER BY`, move filters into the URL, and flip the three `per_page=500` call sites (`index.html`, `api.ts` reuse guard, `api.ts` prefetch) atomically.

## Data flow (unchanged by Phases 0–3)
`Browser → edge nginx (now gzip + 304) → API (now indexed queries) → CategoryPage fetches the full category once (gzipped, ETag-revalidated, SW-cached) → instant client-side filter/sort/paginate.` Prefetch warms the next category before navigation.

## Error handling / risk
- **Phase 0:** wrong `gzip_types` (omitting `application/json`) → JSON stays uncompressed. Guard test + post-deploy wire check (`content-encoding: gzip`).
- **Phase 1:** ETag must be a strong content hash over the serialized body (not a weak/time hash) or staleness returns; mirror `/partners`. SW `StaleWhileRevalidate` + 304 interplay verified in-browser.
- **Phase 2:** migration must be index-only (no DDL that could deadlock a `--reseed`); separate from any heavy migration.
- **Phase 3:** prefetch must not stampede (reuse the session guard); precompression must not double-serve (let nginx pick `_static`).

## Testing & verification
- Per-phase: failing test first (TDD), `feature-dev:code-reviewer` on the diff, commit on `updates`, EXTRA review at the integration points (Phase 0 deploy, Phase 1 SW/304).
- Guard tests: gzip-active (Phase 0), `/{slug}` ETag+304 (Phase 1), five indexes exist (Phase 2), category-size tripwire (deferred-item monitor).
- Browser-prove on a **throttled-mobile** profile (chrome-devtools emulation + network throttle): cold-load transfer drops to ~189 KB and shrinks further with precompression; re-nav returns 304s; subcategory nav is warm/instant.
- `deploy-preflight` agent before any deploy.

## Out of scope
Server-side paging/facets/price-denorm (deferred above); SEO `itemListElement` for the parts table; cross-tab BroadcastChannel push; the category-LIST client memo (inc3).
