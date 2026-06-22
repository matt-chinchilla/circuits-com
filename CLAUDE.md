# Circuits.com

Electronic components directory prototype — Vite React SPA + FastAPI + PostgreSQL + n8n, all in Docker.

## Prerequisites
Docker & Docker Compose · Python ≥3.12 · Node.js

## Commands

```bash
# Dev stack
docker compose up --build               # 5 services: db, api, frontend, n8n, nginx
docker compose down -v                  # stop + drop volumes

# API (from api/)
cd api && pip install -e ".[dev]"
pytest tests/ -v                        # ~165 tests, SQLite in-memory
alembic upgrade head
python -m app.db.seed                   # idempotent

# Frontend (from frontend/)
cd frontend && npm install
npm run dev                             # Vite on :3000
npm run build
npx tsc -b                              # type-gate (`tsc --noEmit`=NO-OP here: solution tsconfig, files:[]); `npm run build` too
npx eslint --ext .ts,.tsx src/          # boundary enforcement (exit 0=clean; --ext req'd, eslint 8)
npm test                                # vitest run (unit-logic only; *.test.ts, happy-dom per-file for DOM)

# Deploy (requires AWS CLI + ~/.ssh/id_ed25519 + commits pushed)
./deploy.sh                             # full deploy — INCLUDES nginx restart since 2026-06-02
./deploy.sh --frontend                  # frontend-only rebuild + nginx restart (faster path)
./deploy.sh --reseed                    # full deploy + clear/reseed DB (destructive)
./deploy.sh --status | --logs | --cert-renew
```

Production: t3.small EC2 (`i-0d456bd12719e2176`), EIP `100.55.235.167`. Migrations + seed auto-run on api container start via `docker-compose.prod.yml`. Domains `circuits.com` (primary), `www.circuits.com`, `circuits.matthew-chirichella.com` — all on one SAN cert at `/etc/letsencrypt/live/circuits.matthew-chirichella.com/`.

Static analysis: TypeScript strict + ESLint at `frontend/.eslintrc.json` (boundary rules only — no Prettier). Frontend has a minimal vitest harness (`npm test`, unit-logic only — `*.test.ts` excluded from `tsc -b` + eslint via `tsconfig.app.json`/`.eslintrc.json`); API has pytest. Visual baselines at `tests/visual/baselines/`.

## Architecture

```
Browser → Nginx(:80/:443)
  ├── /        → Frontend(:3000)  Vite React SPA
  ├── /api/*   → API(:8000)        FastAPI
  └── /admin*  → Frontend(:3000)  React admin SPA
                    ↕
              PostgreSQL(:5432)
                    ↕
                n8n(:5678)         workflow automation (NOT in form path)
```

### API (`api/`)
FastAPI in `app/main.py`. Routers: categories/suppliers/search/forms/sponsors/admin_sponsors/parts/dashboard. Models: `Category` (self-ref tree, `parent_id`), `Supplier`, `CategorySupplier` (join association), `Sponsor` (XOR `category_id` OR `keyword`; single source for the banner), `Message`, `Part`/`PartListing`/`PriceBreak`, `Revenue`, `PageView`. Services: `category_service`, `search_service`, `email` (aiosmtplib+Hover SMTP, demo when `SMTP_HOST` unset). SQLAdmin mounts at `/admin` on api but is unreachable in prod (nginx routes `/admin` → frontend). React admin = `frontend/src/admin/pages/`, JWT in `localStorage.admin_token` via `adminApi.ts`. Entrypoint: alembic → seed → uvicorn.

### Frontend (`frontend/`)
React 19 + TypeScript + Vite + SCSS Modules + Framer Motion. **Bounded contexts**:
- `src/public/` — public site
- `src/admin/` — admin SPA
- `src/shared/` — cross-scope ONLY

Aliases `@public/*` / `@admin/*` / `@shared/*` in `vite.config.ts` + `tsconfig.app.json`. **≥2-consumer rule** for `@shared/`. ESLint boundary: admin ↛ public, public ↛ admin, shared ↛ either.

**Routing** — public routes lazy-loaded except `HomePage` (eager for LCP). `PublicLayout` = thin `<Suspense><Outlet/></Suspense>` (NO AnimatePresence). Persistent `<BackdropLayer />` mounted ABOVE `<Routes>` in `App.tsx`. Heavy vendor split via `manualChunks`. **No charting library** — `Dashboard`/`Reports` inline native SVG; Recharts removed; do NOT reintroduce.

**Adding a public page**: `pages/<name>/{index.tsx, <Name>Page.module.scss}` + `lazy(() => import("@public/pages/<name>"))` + `<Route>` in App.tsx. Inner pages start with `<PageHeaderBand page="X" title="..." subtitle="..." />`. Anchor-scroll = namespaced ids + `scrollIntoView({behavior:"smooth",block:"start"})` + `scroll-margin-top:100px`.

**Adding an admin entity-CRUD**: `pages/<entity>/{list,form,detail}/index.tsx` + 3 lazy imports + 4 routes. Backend scaffold via `/add-model-field` (6 files).

**Keyword pages**: `/keyword` (landing) + `/keyword/:keyword` (sponsor profile). Both use `RequestModal`. Tier prices ($99/$299/$899) in `keyword-landing/constants.ts` are PLACEHOLDER. `useKeywordRequestModal` owns form state; hosting pages own open/close only.

**Category page**: column-header sort/filter (`ColumnHeader.tsx`, portaled popover) + sticky subcat pill-bar + client-side filter/sort/pagination (25/page). Parent pages fetch all parts (`per_page=500`); leaf pages same scoped to one sub. `?p=N` paginates. Subcats are NESTED pages — pill chips `<Link>` to `/category/:parent/:child` (no `activeSub`; column sub-filter stays).

**Catalog data**: 15 JSON files in `api/app/db/catalog_data/`. `_seed_real_catalog()` → Part/PartListing/PriceBreak. `_DEMO_CATALOG` for wizard demos. Revenue scaled by listing count via `_REVENUE_TIERS`. ~3,600 parts, ~41K listings, ~164K price breaks, 57 suppliers. Regenerate via `--reseed`.

**Per-qty best prices**: `_build_public_parts` + `_build_popular_parts` return `best_price` + `best_price_10/100/1000` via batched PriceBreak queries. `PartsTable` renders 4 price columns.

**Part page**: deep-links via `distributorUrl(supplier_website, part.sku)` (`DISTRIBUTOR_SEARCH` map, `endsWith` subdomain-tolerant, `{domain}/search?q=` fallback). Searches by MPN. Row `onClick` opens; guards `closest('a')` so inner `<a>` doesn't double-fire. Demo prices synthetic — real reliability needs price-feed integration.

**Part slugs**: `Part.slug` non-unique index (migration 008), `slugify_sku(sku.lower())`. `GET /api/parts/by-slug/{slug}`. Duplicate SKUs across manufacturers share the slug.

**Category SEO descriptions**: `Category.description` (migration 009). `CATEGORY_DESCRIPTIONS` in `seed.py`. Live ONLY in `<meta description>` + JSON-LD `CollectionPage` — not rendered visually.

**Site analytics**: `PageView` + `POST /api/track` (30/min/session). Inline SPA tracker in `index.html` patches `pushState`/`replaceState`, `sendBeacon`, skips `/admin`. `GET /api/dashboard/analytics` aggregates day/page/referrer/device/browser.

**SEO**: `robots.txt`, dynamic `sitemap.xml` via `GET /api/sitemap.xml` (~3,713 URLs). `react-helmet-async` (`HelmetProvider` in `main.tsx`) — per-page `<title>`/meta/canonical/JSON-LD. Home: `WebSite`+`SearchAction`. Category: `CollectionPage`+`BreadcrumbList`. Part: `Product`. HSTS in `nginx.ssl.conf`. Gzip + `Cache-Control: immutable` on hashed assets. Search page `noindex, follow`.

**Route prefetching**: `App.tsx` uses `requestIdleCallback` to eager-import top 5 chunks. All `import()` calls `.catch(() => {})` to suppress post-deploy noise. **Hover prefetch** on `CategoryCard.tsx` + `SearchBar.tsx` via `onMouseEnter`.

**Service Worker**: `vite-plugin-pwa` runtime-cache only (no precaching). `StaleWhileRevalidate` on `/api/categories/*` (60s); `NetworkFirst` on other public API. `cleanupOutdatedCaches: true`, `manifest: false`, `navigateFallback: null`.

**Ultrawide (>1600px)**: `.subnavInner`, `.headerInner`, `.contentWide` all widen to `90vw`. `.contentWide max-width: calc(90vw + 56px)` so `.contentInner` aligns with `.chipBar`.

### Admin layout (`AdminLayout.tsx`)
240px Phosphor-Light sidebar + 64px sticky topbar (Lucide). Parts/Suppliers/Import badges: demo → `DEMO_BADGES`, live → `adminApi.getStats()`. Bell + Messages badges sync on `[location.pathname]`. Admin chrome intentionally un-themed.

### Claude Code Automations (`.claude/`)
- **Hooks** — PreToolUse: blocks `.env`/lock edits, warns on `api/app/admin.py`, `migration-safety-check.sh` on commits. PostToolUse: tsc on .ts/.tsx/.scss; pytest on .py; ruff format+check (excl alembic); `scss-lint.sh`; `frontend-rebuild.sh` (flock).
- **Ruff** (`api/pyproject.toml`): line 100, py312, E/F/W/I/UP/B, ignores E501+B008, excludes `alembic/versions/`.
- **Agents** — `deploy-preflight`, `seo-auditor`, `visual-regression-guard`, `frontend-perf-auditor`, `theme-persistency-guard`.
- **Skills** — `seo-writer`, `/add-model-field`. **MCP** — `context7`, `chrome-devtools-mcp`, `playwright`.
- **HeroColorTuner** — dev-only IC-opacity tuner, gated at App.tsx.

### Data flow
- Forms POST → API → `BackgroundTasks` → `email.send_*_notification` (aiosmtplib + Hover SMTP). n8n still in compose, NOT in form path.
- Parts attach to subcategory in `seed.py` (conftest too). Aggregates roll up `own + sum(children)`.
- Parent "Popular Parts" rollup: `category_service._build_popular_parts(db, parent_id, page, per_page)` — `WHERE category_id IN (self + children)`, GROUP BY part, ORDER BY SUM(stock) DESC. `<Pagination>` at `@public/components/widgets/Pagination.tsx`. `POPULAR_PER_PAGE=12`.

## Key Patterns

### SCSS Modules
```scss
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;
@use '../../styles/animations';
```
Mixins in `_mixins.scss`: `container`, `card-base`, `hover-lift`, `responsive($bp)`, `gold-shimmer-border`, `skeleton-shimmer`, `scrollbar-thin($height,$radius)`, `truncate` (single-line ellipsis, `min-width:0` for flex), `line-clamp($lines:3)`. Hoist repeated literals here before they sprout four places.

### Framer Motion page transitions
```tsx
initial={{ opacity: 0, x: 20 }}
animate={{ opacity: 1, x: 0 }}
exit={{ opacity: 0, x: -20 }}
transition={{ duration: 0.15, ease: 'easeInOut' as const }}
```
PublicLayout = `<Suspense><Outlet/></Suspense>` — `AnimatePresence` REMOVED here (left entering pages stuck at prior exit-state). Local UI like `keyword/index.tsx` chip-stagger keeps it. **Navbar MUST be sibling of `<Routes>`** in App.tsx — not inside a transforming ancestor (sub-pixel text blur).

### Theme system
4 themes (`base`, `steel`, `schematic`, `pcb`) in `_themes.scss` as CSS custom properties on `[data-theme]`. **Steel is prod default** — `ThemeBridge.tsx` hardcodes `theme="steel"` in prod (URL + localStorage ignored). Dev: URL `?nav=A|B|C` → `localStorage.circuits.nav.theme` → `DEFAULT_THEME`. `_themes.scss` requires `@use 'variables' as *;` for `#{$font-heading}` interpolation.

**Hero SVG cascade** — `CircuitTraces.module.scss` defines 6 CSS custom properties at `.circuitTraces` ROOT (NOT per child — 140 paths × var() re-resolutions kill perf). Apply SVG filter at a `<g>` wrapper, NEVER per-path. Base theme carve-out suppresses shared glow via `.traceGroup { filter: none; }`. `<CircuitTraces variant="full" />` pinned everywhere. `viewBox 0 0 1200 400` w/ `preserveAspectRatio="xMidYMid slice"` — screen→viewBox y-map SKEWED; use `getScreenCTM()` or source coords.

**Edge-connector pattern in `CircuitTraces`** (CN1 left, CN2 right): pass-through connectors w/ dual-side pin rows, board traces clipped to inner pins, short outer stubs continue off-board. Through-electrons fade via `<animate attributeName="fill-opacity" values="1;1;0;0;1;1" keyTimes={hideKeyTimes}>` synced (same `dur`/`begin`/`repeatCount`) to sibling `<animateMotion>`. keyTimes are arc-length fractions (paced calcMode); inner `0;0` must span FULL body. Constants `CN1_PINS`/`CN2_PINS`/`CN2_OUTER`/`CN1_HIDE` module-level above `ELECTRONS`.

HeroSection + PageHeaderBand are TRANSPARENT layout-only — band is a "window" onto persistent backdrop. Pause wiring: `IntersectionObserver` + `visibilitychange` (`svg.pauseAnimations()` + `data-paused="true"`). `animationend` releases completed animations.

### API conventions
All routes prefixed `/api/` (router prefix). **`routes/forms.py` is `/api`, NOT `/api/forms`** — endpoints `POST /api/contact`, `/api/join`, `/api/keyword-request`. Frontend uses relative paths. `part_to_dict()` returns `category_name`/`slug` + `parent_category_name`/`slug` (`| null` top-level). Category API exposes siblings via `ParentCategoryResponse.children` (`lazy="selectin"`). `SubcategoryChips` URL-driven, `aria-current="page"` on active.

### Contact page motif
Datasheet card — founders labeled U1/U2 (schematic designators), crop-mark corners, PCB grid bg (24px cells, $nav-blue @ 3.5%). Don't flatten. Emails/phones are plain `<a href="mailto:|tel:">` (no JS handler, PCB-grid/crop-mark overlays are `pointer-events: none`) — an "email app won't open" report is ENVIRONMENTAL (no OS default mail handler / corp browser protocol policy), NOT a code bug; don't add an onClick to "fix" it.

### Navbar — pinned-edge layout
Brand (`left: 20px`) + nav+LOGIN (`right: 20px`) are `position: absolute` on `.topStrip`. Search bar centered via `left: 50%; transform: translateX(-50%)`, hidden on `/`. Do NOT use Grid or `space-between` (breaks on narrow side-track content).

### Footer + ErrorBoundary + overflow guard (site-wide)
- `<Footer />` mounted ONCE in `PublicLayout.tsx` (sibling of `<Outlet />`); `min-height: calc(100vh - $nav-height)`; footer `margin-top: auto`. Theme-aware.
- `<ErrorBoundary key={location.pathname}>` wraps Outlet (public) + Routes (admin) at `@shared/components/ErrorBoundary.tsx`. Pathname-keyed → auto-clears on nav.
- `html, body { overflow-x: clip }` in `global.scss` (NOT `hidden` — disturbs `position: sticky`). Companion: `.contentWide { min-width: 0; width: 100% }` breaks flex min-content chain.

### SPA scroll-to-top
`App.tsx`: `useEffect(() => { if (location.hash) return; window.scrollTo({top:0,left:0}); }, [location.pathname])`. Hash skip preserves anchor nav.

### Seed data (idempotent)
15 cats, 75 subcats (5 × 2 levels), 7+ suppliers, 2 sponsors, 59 parts/179 listings/193 revenue (plus real-catalog). `get_or_create_*` skips existing. `CATEGORY_DATA` slugs EXPLICIT per row — `get_or_create_category(name, slug, ...)` requires slug arg (some like `motor-motion-ics` don't match `slugify(name)`).

## Gotchas

(Each is a recurring trap. One-liners by design.)

- **TS strict** — remove unused vars, don't prefix `_`.
- **`?:` catches only `undefined`, NOT `null`** — Python `None` → JSON `null` slips through `field?: number`. Use `field?: T | null` + `!= null`; default w/ `??`.
- **`/admin` in prod = React SPA**, not SQLAdmin. Edit `frontend/src/admin/pages/`, not `app/admin.py`.
- **Adding a Supplier field = 6 files**: model + alembic + Response/Create/Update + `to_dict` + TS type + List COLUMNS + FormPage. Use `/add-model-field` skill.
- **`SupplierResponse`/`CategoryResponse` are shared by public AND admin** — fields appear in unauthenticated routes. Use separate auth-gated endpoints for admin-only fields.
- **`response_model=SchemaX` silently strips computed attrs** — `obj.parts_count = N` stamps work locally; Pydantic's `from_attributes=True` drops them. Drop `response_model=` or add the field w/ default.
- **`routes/sponsors.py` + `routes/admin_sponsors.py` are symmetric `SponsorResponse` consumers** — any new field touches BOTH sites or Pydantic defaults silently to `None`.
- **Sponsor placement = write-side BLOCK + read-side filter (2026-06-22; was supersede)** — single-slot placements (Platinum on a top-level cat, Gold on a child) hold ONE active sponsor. `admin_sponsors._reject_if_slot_taken(...)` runs on POST+PATCH and rejects a 2nd active same-tier sponsor with **409** — the incumbent (oldest active) keeps the slot (was: `_supersede_existing_for_category` Expired the old one so the NEWEST won). `category_service` reads the single active sponsor (tier-filtered, Active OR NULL). To re-sell a slot the admin expires/removes the current sponsor first. **Exempt: Silver** (subcategory directory, multi) AND **keyword** (multi per keyword) — never blocked.
- **Sponsorships are the SINGLE source of truth (migration 011)** — the banner reads ACTIVE `sponsors` rows, tier-ordered, via `get_category_partners` (`/partners`), NOT a join flag. `CategorySupplier.is_featured`/`rank` DROPPED (pure association, cascade only). /admin/sponsors ↔ banner 1:1 — deleting a sponsor removes the company, no side-effect.
- **Sponsor tier↔placement matrix (2026-06-12 tier-boards)** — top-level cat (`parent_id IS NULL`)=**Platinum** only (single-slot); subcategory=**Gold** (single-slot) **+ Silver** (multi directory); keyword=**Silver/Gold**. "Featured" MERGED→Platinum (gone; migration 013 rewrote the trigger + backfilled prod). 3-way: TRIGGER `sponsor_tier_placement_check` (rejects raw SQL), `_validate_tier_placement`→422, admin `choosePlacement`. **Single-slot is BLOCK, not supersede (2026-06-22): `_is_single_slot(tier,is_top_level)` gates `_reject_if_slot_taken`→409 when an active same-tier peer holds the slot (incumbent wins; Platinum-top/Gold-child single; Silver+keyword multi). Migration 016 = two Postgres partial unique indexes `uq_active_{platinum,gold}_per_category` (`WHERE category_id NOT NULL AND lower(tier)=X AND (status='Active' OR status IS NULL)`) — the un-bypassable DB backstop; its cleanup kept oldest-active + HARD-DELETED Expired single-slot rows. `seed.get_or_create_sponsor` is slot-aware (returns None/skips if an active sponsor already holds the slot, so a post-cleanup reseed can't crash the index).** `UNIQUE(supplier_id,category_id|keyword)`→≤once; dup POST→409.
- **`Sponsor.status` filters MUST treat NULL as Active** — legacy seed omits status. `status != 'Expired'` is UNKNOWN for NULL → silently skipped. Use `or_(status=='Active', status.is_(None))`.
- **Admin sponsor form = 3-way segmented placement** (`top-category|subcategory|keyword`) — `placementDerivedRef` MUST reset on `[id]` change (separate `useEffect`) or cross-edit nav keeps the prior bucket; all 3 buttons → `choosePlacement(p)`. Gating (2026-06-02): Category=`disabled={tier!=='Featured'}`, Subcategory+Keyword=`disabled={tier==='Featured'}`. Top-level + subcategory dropdowns are a custom `IconSelect` listbox (native `<select>` strips `<Icon>` markup) w/ `aria-activedescendant` a11y. Tier `<select>` `data-tier` → tier badges (`TIER_OPTION_STYLE`).
- **Sponsor XOR is Postgres-only** (SQLite skips CHECK) — enforce client-side in SponsorFormPage `validate()`/`buildSponsor()` AND server-side in router (422). Never both fields set or both empty.
- **Sponsor `tier` casing — normalize at EVERY read site** — admin emits TitleCase, legacy seed/DB store lowercase (`'platinum'`/`'gold'`); `tier` is a free string (no enum). Client-side: ALWAYS `@admin/services/sponsorTier.normalizeSponsorTier` (the single home + `SPONSOR_TIER_RANK` / `isActiveSponsor`(Active|null) / `countActiveSponsorsByTier`). A TitleCase-only comparison silently DROPS lowercase rows — 2026-06-14: lowercase `'platinum'` showed **None** on Suppliers, was uncounted/unfilterable on Sponsors-list, and drove a fabricated Featured slice on the Dashboard chart. Seed `get_or_create_sponsor` `.capitalize()`s on write; prod normalized once via `UPDATE sponsors SET tier=initcap(tier)`. Server-side: `_is_featured(tier)` (`.strip().lower()`), never `tier == 'Featured'` literal. Lowercase in JSX for `[data-tier='X']`.
- **Tests use SQLite via `Base.metadata.create_all`** — SQLite ignores `String(N)` length AND CHECK. For length contracts assert on metadata: `Model.__table__.c.col.type.length >= N`. **`postgresql.UUID` renders as bare `UUID` on SQLite → NUMERIC affinity → ~1e-6 of uuid4 hex coerce to float (`'float' has no .replace`) = intermittent ~34%/run seed crash.** Fix = conftest `@compiles(UUID,'sqlite')`→`CHAR(32)` (TEXT affinity); guard `test_uuid_sqlite_affinity.py`. The per-test `engine.dispose()` only gives data isolation — it never fixed the float.
- **Parts→category attachment** — `conftest.py` to subcategory; `seed.py` to top-level. Aggregates roll up `own + sum(children)`.
- **`Part.sub_slug` auto-derive** — `create_part` stamps `sub_slug = child.slug` when `category_id` is a child. Migration 006 backfills (PG-only).
- **`featured_supplier_name` batch-query** — `get_all_categories` JOINs `sponsors` (active) per category, tier-ordered, dict-comp → `featured_suppliers[0].name`. No N+1.
- **`POST /api/parts/` atomic create** — `body.initial_listing` creates Part + PartListing in one txn.
- **Deleting a Supplier cascades 6 surfaces** — order: PriceBreak → PartListing → Sponsor (NOT NULL FK) → CategorySupplier → Revenue, NULL `User.supplier_id`, then delete. Mirrors `delete_part`.
- **Bulk `query(...).delete()` + `lazy="selectin"` → "Dependency rule tried to blank-out primary key"** on parent delete. Fix: `db.expire(parent)` between bulk-deletes and `db.delete(parent)`.
- **Pyright "Import app.services.email could not be resolved"** is a false positive (stdlib `email` shadows). Runtime fine.
- **`dict(query(Col1,Col2).all())` mis-types under Pyright** — use `{row[0]: row[1] for row in query.all()}`.
- **Framer Motion v12 requires `as const` on ease**.
- **Framer Motion `whileHover` FIRES ON TOUCH** via Pointer Events hover synthesis — card "jumps" on tap. Use CSS `@media (hover: hover)` for desktop-only.
- **Don't reintroduce `AnimatePresence` around `<Suspense><Outlet/></Suspense>`** — FM12 leaves second-nav entering motion.div stuck at prior exit-state.
- **Don't gate visible content on JS-added classes inside `AnimatePresence`** — IO callbacks fire unreliably mid-transform, leaving `opacity: 0` stuck. Default visible; trigger via `setTimeout`.
- **CSS `opacity: X` OVERRIDES SMIL `<animate attributeName="opacity">`** — CSS wins over SVG presentation-attribute animation. Animate `fill-opacity`/`stroke-opacity` instead.
- **SVG `<filter>` on `<g>` whose children animate = CPU raster on mobile** — `feGaussianBlur` is the lag cause. Apply at `<g>` wrapper, never per-path. Mobile: `.traceGroup { filter: none }` ≤768px.
- **Never animate CSS `drop-shadow()`** — scroll lag. Use static shadows.
- **`filter: hue-rotate(0deg)` is NOT free** — promotes to compositor layer even at 0deg. Gate behind non-default themes.
- **Sub-pixel text blur from `transform: translate*(-50%)`** — fractional px + GPU layer = subpixel glyph raster. Use `top:0; bottom:0; display:flex; align-items:center`.
- **`Node.contains(window)` THROWS** — scroll-close/outside-click guards must `e.target instanceof Node && ref.current?.contains(e.target)`.
- **`setPointerCapture` retargets `pointerup` + synthesized `click`** — child `<a>`/`<button>` taps silently stop. Guard: `if (e.target?.closest('a,button,[role="button"],input,textarea,select,label')) return;` before capture.
- **iOS Safari fires `pointercancel` (NOT `pointerleave`) under `setPointerCapture`** when a system gesture preempts. Listen for both plus `pointerup`.
- **`touch-action: pan-y` on touch-interactive surface CANCELS `pointermove`** once browser commits vertical scroll. Use `touch-action: none` for full tracking (trade-off: not a scroll surface).
- **SponsorBlock = the **Gold** subcategory flashlight PCB card** (`SponsorBlock.tsx`, `data-tier="gold"`). `touch-action: none` + `setPointerCapture` (skip on interactive descendants). NO `whileHover` (FM fires on touch). PCB SVG `preserveAspectRatio="xMidYMid meet"` (NOT `slice`; portrait viewBox `0 0 300 360`). `mask-composite` rim behind `@supports`. Float-in ONCE/session. **Flashlight is compositor-only (2026-06-21 rework, profiled 28→~21ms/frame @6×CPU)**: `.reveal` is a fixed 280px transform-WINDOW with a STATIC centred mask + a counter-translated `.revealInner` art holder (NOT a moving `mask-image at var(--mx)` — that re-rastered the full card ~8ms/frame); `.lamp` is a pre-baked gradient moved by `translate3d` (NO `mix-blend-mode` — the "deleted twice" anti-pattern); all positioned by DIRECT element transforms in a `place()` rAF (no cascading `--mx/--my` on the card → no subtree recalc). `will-change:transform` ONLY under `[data-lit]` — permanent will-change pins DPR³ GPU layers = iPhone OOM-reload.
- **Platinum `<canvas>` tile field (`csFx.tsx`) — the "alive" PCB**: a perpetual ~60fps `frame()` loop (ambient shimmer + cursor dome + click-flip) runs WHILE the board is on-screen — this IS the intended "alive" feel; **do NOT idle-pause it** (explicitly user-rejected 2026-06-21). The ONLY culling is its `IntersectionObserver` (+ `visibilitychange`), which pauses the loop OFF-screen only (verified rAF 60→0). **Deflate-on-release**: `clearCursor` sets `releaseAt` + `start()`; `frame()` ramps `domeStrength` 1→0 over `DEFLATE_MS` so all raised tiles descend together. **Mobile finger control**: `.csb.csbA` `touch-action:none` + `setPointerCapture` (onDown/onUp/onCancel in `useCsBoardFx`, guard interactive descendants) so a finger drives the dome without page-scroll (mirrors Gold). NEVER alter the visual consts (GAP 19 / shimmer .36 / dome R 72 / flip .34). Badge copy: Platinum `CsBadge`="Exclusive Partner", Gold kicker="◆ PREMIERE PARTNER" (2026-06-21; were "Category Sponsor"/"FEATURED PARTNER").
- **Sponsor boards, one source `sponsors`** — **Platinum** `CategorySponsor.tsx` = top-level via `GET /api/categories/{slug}/partners` → `platinum: SponsorResponse|null` (child→parent; `<canvas>` `csFx.tsx` 1:1 **never alter** GAP 19/shimmer .36/dome R 72/flip .34·255; GLOBAL `categorySponsor.scss`; `.cs-band` no gutter). **`csFx.snapshotCircuit` MUST strip `stroke-dash*` off the SVG clone** — the `.static .trace{dashoffset:0}` rule isn't in the serialized SVG → paths un-drawn → blank traces. `setEmblem` composites the open-slot upload icon into `pcb`; logos → **`CsLogo`/Gold `SbLogo` onError→lettermark**. **Gold** `SponsorBlock` (`category.sponsor`). **Silver** `SilverPartners.tsx` (`category.silver[]`, **first col 92px** desktop, **always U1–U5** w/ `SvSlotEmpty` "Advertise here"→`/contact`). `CategoryPartnersBanner.tsx` ALWAYS renders `<CategorySponsor>` (**Open-Placement when null — only on UNSOLD cats**; seed Platinum→2 flagships, PROD all-15-sold→free a cat). Layout band→`.tierRow`(SUBPAGES-ONLY)→parts. **Mobile**: `.tierRowMain` MUST `flex:0 0 auto` ≤900 (`flex:1 1 0`+`min-height:0`→collapses to 0, Silver overflows Gold); `.svp` reflows ≤768 (5-col→1-col; empty cols `{x?…:null}`).
- **Subcats NESTED `/category/:parent/:child`; flat `/category/:slug` redirects** — both routes → one `CategoryPage`. Canonical redirect MUST be an EFFECT (`navigate(...,{replace})`), NOT render `<Navigate>` — `ErrorBoundary key={pathname}` drops the rendered child's nav-effect on remount (empty page, frozen URL). `?p`-reset effect bails while redirecting (`if (needsCanonicalRedirect) return`). URLs via `categoryPath(slug, parentSlug?)`; sitemap nested.
- **`<CircuitTraces variant="full" />` is hero-ONLY** — once, in `BackdropLayer` (App.tsx, above `<Routes>`, persistent across nav). ALL other instances (incl. Silver `SilverPartners`) use `variant="static"`. `full`=14 SMIL loops+6s draw+IO bookkeeping; a 2nd `full` on a non-hero route breaks the perf invariant. (Silver was `full` until 2026-06-21 — reverted to `static`: its IO-gate only pauses when OFF-screen, but users hover it ON-screen, so the 14 loops starved the hover raster budget and the hover effect trailed the cursor.)
- **Fixed-angle 3D *decoration* = ONE vector `<svg>`, NOT CSS-3D `preserve-3d`** — preserve-3d is O(faces) GPU layers (the login board was ~210); at the iPhone's **DPR 3** pinch-zoom re-rasters them all → WebContent **OOM crash + auto-reload**, and the per-frame composite **flickers** once animating. SVG = O(1) layer (vector-crisp at any zoom, no flicker). Login `IsoBoard`: **desktop CSS-3D** (`IsoBoard.tsx`, has the headroom at DPR 1–2) / **mobile `<svg>`** (`IsoBoardSvg.tsx`, ≤900px) — BOTH project the SAME `isoGeometry.ts` (orthographic iso `sx=.707(x+y)`, `sy=.395(y−x)−.829z` ≙ CSS `rotateX(56)rotateZ(−45)`; a horizontal circle → axis-aligned ellipse `ry=r·cos56`, used for the cap). `transform: scale()` is **visual-only** (shrinks neither layout box NOR GPU backing store) → mobile scale-down cuts ZERO GPU cost; page-fit via grid `minmax(0,1fr)` (NOT `1fr`=`minmax(auto,1fr)`, which the fixed-px board inflates past the viewport). NEVER `will-change`/`overflow:clip` a preserve-3d/perspective node on mobile (DPR² layer-pin OOM / flatten / chip-crop). SVG @keyframes live in the sibling PLAIN `LoginPage.keyframes.scss` (CSS-Modules hashes @keyframes even inside `:global`).
- **Verifying animations via chrome-devtools: sample ACROSS real frames** — a busy-wait + `getComputedStyle` returns a FROZEN snapshot (the anim clock doesn't advance on a blocked main thread → false "not moving"). Confirm motion with async rAF sampling (`requestAnimationFrame`+`setTimeout` over a few frames → `offset-distance`/`transform` advancing). Real iOS-device GPU bugs (DPR-3 OOM crash) are NOT reproducible in chrome-devtools at all → iterate via the user's device; trust the served CSS.
- **`mix-blend-mode: screen` + per-pointermove CSS-var updates = full-banner CPU recomposite** — the moving gradient center defeats the compositor's blend cache; `mask-image` on a sibling compounds it. Use a pre-baked rgba radial-gradient (`will-change: background`) + stacked `background:` linear-gradient fades instead. Deleted twice (v11.2 cursor-lamp, v15 `useFlashlight`) — do not reintroduce.
- **Category-page = opacity-only fades; breadcrumb `fade-in-up`/`useEntrance` REMOVED** (re-fire per subcat remount = "jitter"). Sibling subcat nav renders breadcrumb/title/chips SYNC from session memo `@public/services/categoryShellMemo.ts` (keyed top-level slug, from `category`|`category.parent`) — no skeleton/fly-in; only parts+counts load. `SubcategoryChips` chips are `<button>` (JS-nav) not `<a>`; `.chips` has NO `margin-top` so parent/child/skeleton subnav heights match (else the banner snaps). **Busy skeletons MUST reserve REAL heights** (banner paints instantly above → undersized skeletons snap it down): title/meta 42/24px, subnav = 6 wrapping pills. **NEVER `min-height` on the flex `.chipBar`** (`align:stretch` balloons a 1-row's chips/icons on wide). **Parts + counts ALSO cached now (2026-06-21)** via `@shared/services/categoryDetailMemo` (generic `Map<unknown>` so it stays @shared without importing @public types; **LRU cap 12** — each entry holds ≤500 parts, unbounded = mobile heap) — read SYNC in CategoryPage's `useState` initializers so a RE-visited (sub)category paints parts + the "N parts" count on the FIRST frame (kills the white-flash skeleton); revalidates in the bg (stale-while-revalidate + cancel-flag); cold first visit still fetches+skeleton. Busted by `bustSponsorCaches()` (now also `clearCategoryDetailMemo`). **Part mutations — `createPart`/`updatePart`/`deletePart` AND `batchImportParts` — MUST wrap `bustingAfter`** in `adminApi` (sponsor/supplier already did) or counts/SKUs go stale.
- **`.outletWrap { position: relative; z-index: 1 }` is load-bearing** — without it BackdropLayer (z:0) paints ON TOP of static page descendants.
- **Inner-page surface-bg goes on a body WRAPPER inside motion.div, NOT on motion.div** — `<BackdropLayer />` (z:0, top: $nav-height, height: 420px) needs visibility through the band. PageHeaderBand + HeroSection are TRANSPARENT.
- **URL-param-absent ≠ default-intent** — default-button click clearing a URL param is shadowed by stale localStorage. Write default to localStorage SYNC before `setParams`.
- **Don't put `setSearchParams` in `useEffect` deps** (RR v7) — identity changes on URL change; effect that "resets `?p` on filter change" also fires on page change. Depend only on filter values; functional form `setSearchParams(prev => ...)` needs no setter dep.
- **State-dep effect + async fetch needs cancel-flag** — `let cancelled=false; ...; return () => { cancelled=true; }`; gate `.then`/`.catch` on `if (cancelled) return;`. AdminLayout badge fetch is canonical.
- **Dev-only components gate at the CALL SITE** — `{import.meta.env.DEV && <X />}` at App.tsx. Don't `if (!DEV) return null` before hooks (Rules of Hooks).
- **Non-ASCII glyphs in JSX text get mangled to `\uXXXX` literals** by edit tooling — `>↗<` ends up rendering the literal 6-char string. Use HTML entity (`&#8599;`) or JS expression (`{'↗'}`).
- **Empty SCSS rule → undefined CSS module class** — `.foo {}` makes `styles.foo === undefined`. Always include ≥1 declaration.
- **CSS Modules can't host BEM `--`** — `qa-card--primary` becomes invalid. Use camelCase (`qaCardPrimary`); compose at call site.
- **Source-line grep undercounts JSX rendered DOM** — `.map()` multiplies (CircuitTraces: 54 src `<rect>` → 193 rendered).
- **Structural-rename: grep `import.*\.scss` in TS/TSX**, not just `@use` in SCSS — side-effect imports (`import './styles/global.scss'`) bypass `@use`.
- **`border-collapse: separate` for rounded table corners** — `collapse` ignores cell `border-radius`. Use `separate` + `border-spacing: 0` + corner-cell radii. Borders on `<tr>` no longer render — move `border-bottom` to `.td`.
- **Buttons inherit `line-height: 1.6`** from body — overflows height-constrained rows. Fix: explicit `line-height: 1` + padding.
- **`<input type="url|email|tel">` silently kills form submit** for HTML5-invalid values — React `onSubmit` never runs, no `:invalid` styling, no console error. Use `type="text"` + `inputMode` + JS validation + `noValidate`. Guard: `api/tests/test_no_type_url_form_input.py`.
- **`prependScheme` must be RFC-3986-aware** — naive `!startsWith('http')` produces `https:////acme.com` or `https://mailto:…`. Skip already-schemed via `^[a-z][a-z0-9+.-]*:` OR `^//`.
- **Sponsor/external website hrefs MUST go through `safeHttpUrl` (`@shared/utils/url`), NOT raw `prependScheme`** — prependScheme PRESERVES an existing scheme, so a DB/admin `website` of `javascript:`/`data:`/`vbscript:` flows straight into `href` = stored DOM-XSS. `safeHttpUrl` prepends a scheme THEN validates http(s) via `new URL` (resolves `//host`→https), returns `null` to hide the link. All 3 sponsor links use it (Platinum coname, Gold/Silver "Visit Website") + `rel="sponsored noopener noreferrer"` (paid links). Guard `frontend/src/shared/utils/url.test.ts`.
- **Phone formatter country-code paste** — `+1 (800) 555-0142` → `(180) 055-5014` if you strip non-digits + slice(0,10). Strip leading `1` when input is 11 digits starting with `1`.
- **Avoid `grid-template-columns: 1fr auto 1fr` with asymmetric side-track content** — `1fr` = `minmax(auto, 1fr)`. Use `position: absolute` on relative parent.
- **Tree-row `1fr auto auto` jams slug behind name on long titles** — promote children to `repeat(auto-fill, minmax(220px, 1fr))`.
- **Supplier-detail panel stretch (Grid+Flex two-tier)** — `.detailGrid { align-items: stretch }`; inner `.panel { display:flex; flex-direction:column }` + `.panelBody { flex:1 }` backfills Description. Sidebar opts out via `align-self: start`.
- **Prefill bus at `@admin/services/prefillBus.ts`** — typed singleton, one-shot `consumePrefill(kind)`. Survives SPA nav, dies on full reload. Forms read via `useState(() => consumePrefill('part'))`.
- **Quick Actions hero strip** at `pages/suppliers/detail/QuickActionsPanel.tsx` — 4-card grid; variants `qaCardPrimary/Blue/Gold/Purple`.
- **Mobile data tables (PartsTable)**: `border-collapse: separate; border-spacing: 0` + 12px radii. `.tableWrap { overflow-x: auto }` ALWAYS. `min-width: 540px` ≤1024px. Description hides ≤1450px; Category ≤768px. Subcategory chips wrap desktop, 2-col on mobile.
- **ColumnHeader sort/filter popover PORTALED to `document.body`** (`createPortal`) — `position: fixed`, viewport clamp, flip-above-if-no-room, close-on-scroll/resize, outside-click + Esc. Two scroll-close guards: `e.target instanceof Node` BEFORE `.contains()`; skip scrolls from inside `.filterList`.
- **Mobile drawer state-machine** (Navbar + AdminLayout): `useState(menuOpen)` + 3 effects on `[menuOpen]` — body-scroll-lock, Esc keydown (attach while open), `[location.pathname]` auto-close. Compositor-only animations.
- **Admin `<aside>` needs conditional `aria-hidden`**: `aria-hidden={!menuOpen ? undefined : false}`. Public drawer `aria-hidden={!menuOpen}` would set `"true"` at desktop where admin sidebar IS visible.
- **`backdrop-filter: blur(2px)` on full-viewport scrim is OK** when scrim only animates opacity. Don't add to elements that translate/scale.
- **Breakpoints in `_variables.scss`**: mobile 768 / tablet 1024 / desktop 1199 / admin-mobile 820 / admin-compact 420. Use `@include responsive(...)`.
- **`--a-blue`/`--a-purple` admin-scope tokens** — defined in `AdminLayout.module.scss .admin` for Dashboard sparklines. Pass as `color="var(--a-blue)"`, NEVER inline hex.
- **Admin Supplier badge = real active sponsorship (2026-06-14)** — `AdminSupplier` has no tier col, so the list/detail badge cross-references sponsor rows: `suppliers/sponsorship.ts` (`buildSponsorshipBySupplier`→supplier's highest **active** tier; `supplierSponsorship`→Platinum/Gold/Silver or **None**) + a None filter chip (`SPONSORSHIP_FILTERS`). Both list+detail fetch `getSponsors()` (best-effort, cancel-flagged). The old `parts_count` SIZE tier (`suppliers/tier.ts` `deriveSupplierTier`, ≥100/≥25, no Featured) survives ONLY as a new-sponsorship hint in `QuickActionsPanel`. `.tierNone` = dashed muted badge.
- **Admin sponsors are API-backed** (was localStorage). `@admin/services/sponsorStore.ts` ASYNC over `adminApi`. Form `<select>` pull REAL UUIDs from `getSuppliers()/getCategories()`.
- **Theme/route bug repro via SPA NavLink, NOT direct URL** — direct URL remounts everything. Verify SVG persistence across SPA nav: stamp `svg.dataset.sessionMarker` before click, re-check after.
- **Wizard at `@admin/wizard/`** — `data-tour=`/`data-field=`/`[data-modal=]` anchors; guard `api/tests/test_wizard_data_anchors.py` (excludes `flows.tsx`). `useAdvance` keeps route-based vs polling-based effects SEPARATE — combining caused Step 1→2 hangs. `__auto_select__` for `<select>` (UUIDs) via `handleAutofill`. Demo entity cleanup via `demoCleanup.ts` on `exitFlow/startFlow`.
- **chrome-devtools-mcp form-fill** — React controlled inputs need native setter: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)` + `dispatchEvent(new Event('input', {bubbles:true}))`. Silent-submit triage: `addEventListener('submit', ..., true)` BEFORE click — no submit = HTML5 constraint validation.
- **chrome-devtools-mcp `click(uid)` may miss React Router `<Link>`** — for SPA-nav, use `evaluate_script` + `querySelector(...).click()`. Looping (theme × route): one page + `navigate_page`, NOT `new_page` per cell.
- **Full `docker compose up --build` rebuilds n8n** (313MB re-extract) — `deploy.sh` scopes `build api frontend` only. t3.micro OOMs — stay on t3.small.
- **Frontend Dockerfile = 4 stages** (base/dev/build/prod); compose defaults `prod` (nginx + hashed Vite, no HMR). SCSS/TSX edits need `up --build -d frontend`. Local HMR = `target: dev`.
- **API container has NO volume mount** — edits don't reach via `restart`; use `up -d --build api`. Symptom: seed succeeds but data reflects OLD code.
- **`docker compose restart` traps** — (1) does NOT re-eval `${VAR:-}` from `.env` → `up -d --force-recreate`; (2) WSL2/Docker-Desktop: `restart` AFTER editing a bind-mounted file fails (`mount … no such file`, stale inode) → `up -d --force-recreate <svc>`.
- **`docker compose exec -T <svc> <cmd>` consumes stdin** of wrapping `ssh ... <<HEREDOC` — always `exec -T < /dev/null`.
- **Docker cache can serve stale frontend** — if invisible: `build --no-cache frontend && up -d frontend`.
- **`./deploy.sh --reseed` destructive scope** — TRUNCATEs `sponsors, category_suppliers, categories, suppliers CASCADE` → cascades to `users/parts/listings/breaks/revenue`. `messages` SURVIVES. Admin-UI rows outside seed.py ARE wiped.
- **`--reseed` can DEADLOCK on a heavy-DDL migration** — `deploy_reseed` recreates api (alembic+seed) THEN `TRUNCATE`s; migration DDL (CREATE TRIGGER/DROP COLUMN = AccessExclusiveLock) races the TRUNCATE → `deadlock detected`, old data persists. Recovery: re-run clear+reseed alone (`docker exec db psql -c 'TRUNCATE …CASCADE'` then `docker exec api python -m app.db.seed`).
- **Prod one-shot SQL fix** (apostrophe/HEREDOC escape hell): `Write tmp/fix.sql → ec2-instance-connect send-ssh-public-key → scp → sudo docker cp → docker exec … psql -f`. Instance Connect key = 60s TTL, push right before each ssh/scp.
- **Category slug changes need `--reseed`** — `get_or_create_category` keys on slug; rename creates a duplicate. Plain `./deploy.sh` won't fix.
- **`./deploy.sh` restarts nginx automatically** (2026-06-02; run `deploy-preflight` first). **Local `nginx.conf` self-heals** (`resolver 127.0.0.11` + variable `proxy_pass`) so a local `up --build <svc>` re-resolves new container IPs; prod `nginx.ssl.conf` relies on the deploy restart.
- **`.dockerignore` in `frontend/` + `api/`** (2026-06-02) — frontend context was 236MB (230MB `node_modules`); now ~5MB. Both Dockerfiles also gain `# syntax=docker/dockerfile:1.6` + BuildKit `--mount=type=cache` on `/root/.npm` (frontend) and `/root/.cache/{uv,pip}` (api). `deploy.sh` exports `DOCKER_BUILDKIT=1` for older Docker. Rebuild on unchanged deps is now near-instant.
- **Deploying API → ~1-2 min of 502 on `/api/*`** — recreating api re-runs `alembic → seed → uvicorn`. HTML still 200. Check api logs (`Seeding database...`) before intervening.
- **nginx HTTP/2 requires `http2 on;`** — `listen 443 ssl;` alone gives HTTP/1.1. All 3 SSL blocks in `nginx.ssl.conf` carry it. Verify: `curl -sI --http2 https://circuits.com/ -w '%{http_version}\n'` (want `2`).
- **Category preload couples `frontend/index.html` ↔ `api.ts`** — inline `<script>` stashes the fetch promise on `window.__categoryPreload`; `api.getCategory` reuses it (matching slug+params). Direct-load only; SPA nav = axios.
- **`index.html` served `no-cache`** (`frontend/nginx.conf` `location /`) so browsers revalidate the SPA entry. Hashed assets stay `immutable`. Guard: `api/tests/test_nginx_cache_headers.py`.
- **Stale lazy-chunk after deploy → `vite:preloadError` recovery reload** — lazy routes (App.tsx) are content-hashed chunks; a deploy deletes the old hashes, so a returning client on a pre-deploy `index.html`/module graph (most often a tab left open across the deploy) dynamic-imports a 404'd chunk → `import()` rejects → ErrorBoundary "failed to load" dead-end until a manual browser-cache reset (eager `HomePage` is immune; every lazy route was affected — it's not contact-specific). `@shared/preloadErrorRecovery.ts` (called in `main.tsx` BEFORE render, bundled in the EAGER entry chunk) turns `vite:preloadError` into ONE `sessionStorage`-guarded recovery reload — fail-open if storage throws (Safari private mode / locked-down browsers), whole install `try/catch`-wrapped so a hardened-browser `window.sessionStorage` throw can't white-screen bootstrap. Don't remove the `installPreloadErrorRecovery()` call. Guard: `frontend/src/shared/preloadErrorRecovery.test.ts` (vitest, 5 tests).
- **`sw.js` MUST NOT be cached immutable** — generic regex applies `immutable, 1y` to ALL js. Exact-match `location = /sw.js` + `/registerSW.js` with `no-cache` (exact wins over regex).
- **Sponsor cache invalidation (inc1)** — category endpoints send `no-cache` (set AFTER the 404 check — HTTPException makes a new response; guard `test_cache_headers.py`); `bustSponsorCaches()` (`@admin/services/swCache.ts`) deletes the `api-categories`+`api-general` SW caches, wired in `adminApi` so every sponsor/supplier mutation + wizard-feature busts. **ETag/304 on `/{slug}` + `/partners` via `_conditional_json`** (`If-None-Match`→304); cross-tab push deferred.
- **Edge gzip = `nginx/nginx.ssl.conf`** (`gzip on`/`gzip_proxied any`, json+js) — was OFF (drift). **PROD-only: LOCAL non-SSL nginx does NOT gzip /api — verify on prod** (`per_page=500` 127→24.9 KB, 5.1×). Guard `test_nginx_gzip.py`. **alembic 012** = hot-col indexes (`parts.category_id`/`sub_slug`, `part_listings.part_id`, `price_breaks.listing_id`/`min_quantity`), index-only; guard `test_part_indexes.py`.
- **Workbox `runtimeCaching` regex MUST allow trailing slash** — axios ends `/?params`. Need `\/?` before query: `/\/api\/categories(\/[^/?]+)?\/?(\?.*)?$/`.
- **`global.scss` uses deprecated Sass `darken()`/`lighten()`** — new code uses `@use 'sass:color'` + `color.adjust()`.
- **ProxyHeadersMiddleware trusts all hosts** — required for admin HTTPS URL gen behind nginx. FastAPI 307-redirects missing trailing slash (axios follows).
- **Adding a hostname**: add `server_name` in `nginx.ssl.conf` → stop nginx → `sudo certbot certonly --standalone --expand --cert-name circuits.matthew-chirichella.com -d <every>` → start. DNS must resolve first. Cert dir stays `circuits.matthew-chirichella.com` even though `circuits.com` is primary (SAN match).
- **SMTP creds in `/opt/circuits-com/.env` on prod EC2** (Hover: host/587/no-reply@circuits.com). Without `SMTP_HOST`, `email._smtp_send` runs demo. `NOTIFY_RECIPIENTS` = JSON or CSV.
- **Prod `ADMIN_SECRET_KEY` MUST be in `/opt/circuits-com/.env`** — `docker-compose.prod.yml` reads it `${...:?}` fail-fast (base default is dev-only), so every prod `up`/deploy errors without it. Rotate via host secret → `up -d --force-recreate api`.
- **n8n no longer in form path** — `routes/forms.py` uses aiosmtplib + Hover SMTP via BackgroundTasks.
- **Admin login = v13 two-panel (`pages/login/`) + recovery** — creds add `demo`/`demo` (admins seeded w/ emails, migration 015). `LoginPage.module.scss` ports the design under ONE hashed `.authRoot{:global{…}}` (literal classnames, sibling-global keyframes, no `*`/`body` leak). Reset-link origin MUST be `settings.APP_BASE_URL`, NEVER `request.base_url` (poisoning). **Mobile board = vector `<svg>` (`IsoBoardSvg`/`isoGeometry`), desktop = live CSS-3D — see the "fixed-angle 3D = ONE vector svg" gotcha.**
- **Test fixtures must NOT pair a real-looking SMTP host with `SMTP_PASSWORD`** — GitGuardian pattern-matches host+user+pw proximity. Use RFC 6761 TLDs (`.invalid`/`.test`/`.example`). Guard: `api/tests/test_no_smtp_credential_lookalikes.py`. But `EmailStr` rejects those TLDs — smoke tests use plus-tag self-route (`smoke-test+verify@circuits.com`).
- **Claude Design handoffs** — `WebFetch` saves to `<tmpdir>/tool-results/webfetch-*.bin`; extract `tar -xzf <path>.bin -C design-handoff-vN/`. Versioned dirs gitignored.
- **Accent-colored text on light cards uses `var(--executive-blue)`** — `var(--theme-accent)`/`--theme-cta-bg` fail WCAG-AA. Borders/chip-bg can keep `--theme-accent`. `--fg2` passes on white (4.85:1), fails on `--surface` (4.07:1). Exception: `/keyword` uses `--theme-accent` for section-num + tier price (a11y 91/100 documented).
- **Branch workflow**: `master` = deploy tip, `updates` = active dev. Commit on `updates` → push → `checkout master && merge --ff-only updates && push` → deploy → `checkout updates`. No squash; ff-only.

## Brand Colors & Type

Defined in `frontend/src/shared/styles/_variables.scss`:

```
$executive-blue:  #0a4a2e   PCB dark green — headers, hero bg
$nav-blue:        #44bd13   bright green — nav, links, accents
$sponsor-gold:    #a88d2e   sponsor blocks, premium CTAs
$surface:         #eef1f5   page backgrounds
$error-red:       #c0392b   form validation, required-field markers
$font-heading/body  SF Pro / Segoe UI / Inter fallback (native stack, no webfont)
$font-mono          ui-monospace / SF Mono (SKUs, prices, designators)
```

`global.scss` has NO Google Fonts `@import`. h1 letter-spacing `-0.022em`, h2 `-0.015em`.

### Icon system

Public + admin both render Phosphor Light data icons via `<Icon name={x.icon} />` at `@shared/components/Icon.tsx` (regex guard `/^[a-z][a-z0-9-]*$/` no-ops on non-Phosphor strings). Font self-hosted at `frontend/public/fonts/phosphor-light/` (~1.2MB), loaded once in `frontend/index.html`. Admin **sidebar nav** uses Phosphor; topbar controls (Search/Bell/Plus/Menu) stay Lucide.

Names live in `api/app/db/seed.py` (15 + 75 = 90 strings). New category: kebab-case Phosphor name from https://phosphoricons.com — no `ph-` prefix. `Category.icon` is `String(40)` (alembic 005); regression asserts column metadata length ≥24 (SQLite ignores VARCHAR len).

**Don't render `{x.icon}` as a raw text-node** — it'll display the literal name. Pre-commit guard:
```bash
grep -rn ">{[a-zA-Z_]*\.icon}<\|>{[a-zA-Z_]*\.category_icon}<" frontend/src --include="*.tsx"
# Empty = clean. Sweep frontend/src (not just /public).
```
`<option>` labels are HTML-text-only — drop any `${cat.icon}` prefix. When debugging icon rendering, screenshot — `getComputedStyle().content` is empty `""` for Phosphor's PUA glyphs in Chromium serializer even though the glyph paints.
