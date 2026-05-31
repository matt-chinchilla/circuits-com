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
npx tsc --noEmit
npx eslint src/                         # boundary enforcement (exit 0 = clean)

# Deploy (requires AWS CLI + ~/.ssh/id_ed25519 + commits pushed)
./deploy.sh                             # full deploy — CHASE with --frontend
./deploy.sh --frontend                  # frontend rebuild + nginx restart (single step)
./deploy.sh --reseed                    # full deploy + clear/reseed DB (destructive)
./deploy.sh --status | --logs | --cert-renew
```

Production: t3.small EC2 (`i-0d456bd12719e2176`), EIP `100.55.235.167`. Migrations + seed auto-run on api container start via `docker-compose.prod.yml`. Domains `circuits.com` (primary), `www.circuits.com`, `circuits.matthew-chirichella.com` — all on one SAN cert at `/etc/letsencrypt/live/circuits.matthew-chirichella.com/`.

Static analysis: TypeScript strict + ESLint at `frontend/.eslintrc.json` (boundary rules only — no Prettier). Frontend has no test suite; API has pytest. Visual baselines at `tests/visual/baselines/`.

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
FastAPI in `app/main.py`, routers: categories / suppliers / search / forms / sponsors / admin_sponsors / parts / dashboard. Models: `Category` (self-referential tree, `parent_id`), `Supplier`, `CategorySupplier` (join, `is_featured`+`rank`), `Sponsor` (XOR `category_id` OR `keyword`), `Message`, `Part`/`PartListing`/`PriceBreak`, `Revenue`, `PageView`. Services: `category_service`, `search_service`, `email` (aiosmtplib + Hover SMTP, demo when `SMTP_HOST` unset). SQLAdmin mounts at `/admin` on api but is unreachable in prod (nginx routes `/admin` → frontend). React admin = `frontend/src/admin/pages/`, JWT in `localStorage.admin_token` via `adminApi.ts`. Entrypoint: alembic → seed → uvicorn.

### Frontend (`frontend/`)
React 19 + TypeScript + Vite + SCSS Modules + Framer Motion. **Bounded contexts**:
- `src/public/` — public site
- `src/admin/` — admin SPA
- `src/shared/` — cross-scope ONLY

Aliases `@public/*` / `@admin/*` / `@shared/*` in `vite.config.ts` + `tsconfig.app.json`. **≥2-consumer rule** for `@shared/`. ESLint boundary: admin ↛ public, public ↛ admin, shared ↛ either.

**Routing** — all public routes lazy-loaded except `HomePage` (eager for LCP). `PublicLayout` = thin `<Suspense><Outlet/></Suspense>` (NO AnimatePresence — see Gotchas). Persistent `<BackdropLayer />` mounted ABOVE `<Routes>` in `App.tsx`. Heavy vendor split via `manualChunks`. **No charting library** — `Dashboard`/`Reports` inline native SVG; Recharts removed; do NOT reintroduce.

**Adding a public page**: `pages/<name>/{index.tsx, <Name>Page.module.scss}` + `lazy(() => import("@public/pages/<name>"))` + `<Route>` in App.tsx. Inner pages start with `<PageHeaderBand page="X" title="..." subtitle="..." />`. Anchor-scroll = namespaced ids + `scrollIntoView({behavior:"smooth",block:"start"})` + `scroll-margin-top: 100px`.

**Adding an admin entity-CRUD**: `pages/<entity>/{list,form,detail}/index.tsx` + 3 lazy imports + 4 routes. Backend field scaffolds via `/add-model-field` skill (6 files).

**Keyword pages**: `/keyword` (landing) + `/keyword/:keyword` (sponsor profile). Both use `RequestModal`. Tier prices ($99/$299/$899) in `keyword-landing/constants.ts` are PLACEHOLDER. `useKeywordRequestModal` hook owns all form state; hosting pages own only open/close.

**Category page**: column-header sort/filter (`ColumnHeader.tsx`, portaled popover) + sticky subcategory pill-bar + client-side filter/sort/pagination (25/page). Parent pages fetch all parts (`per_page=500`); leaf pages same scoped to one sub. `?p=N` paginates; `activeSub` state for sub-chip filter.

**Catalog data**: 15 JSON files in `api/app/db/catalog_data/`. `_seed_real_catalog()` → Part/PartListing/PriceBreak. `_DEMO_CATALOG` kept for wizard demos. Revenue scaled by listing count via `_REVENUE_TIERS`. Total ~3,600 parts, ~41K listings, ~164K price breaks, 57 suppliers. Regenerate with `--reseed`.

**Per-qty best prices**: `_build_public_parts` + `_build_popular_parts` return `best_price` + `best_price_10/100/1000` via batched PriceBreak queries. `PartsTable` renders 4 price columns.

**Part page**: deep-links to exact part on distributor's site via `distributorUrl(supplier_website, part.sku)` map (`DISTRIBUTOR_SEARCH`, subdomain-tolerant via `endsWith`, generic `{domain}/search?q=` fallback). Searches by MPN (globally unique). Row `onClick` opens; guards `closest('a')` so inner `<a>` doesn't double-fire. Demo prices are synthetic — real price-reliability needs a distributor price-feed integration.

**Part slugs**: `Part.slug` non-unique index (migration 008), `slugify_sku(sku.lower())`. `GET /api/parts/by-slug/{slug}`. Duplicate SKUs across manufacturers share the slug.

**Category SEO descriptions**: `Category.description` (migration 009). `CATEGORY_DESCRIPTIONS` in `seed.py`. Live ONLY in `<meta description>` + JSON-LD `CollectionPage` — not rendered visually.

**Site analytics**: `PageView` + `POST /api/track` (rate-limited 30/min/session). Inline SPA tracker in `index.html` patches `pushState`/`replaceState`, `sendBeacon`, skips `/admin`. `GET /api/dashboard/analytics` aggregates by day/page/referrer/device/browser.

**SEO**: `robots.txt`, dynamic `sitemap.xml` via `GET /api/sitemap.xml` (~3,713 URLs). `react-helmet-async` (`HelmetProvider` in `main.tsx`) — per-page `<title>` + `<meta description>` + canonical + JSON-LD. Home: `WebSite` + `SearchAction`. Category: `CollectionPage` + `BreadcrumbList`. Part: `Product`. HSTS in `nginx.ssl.conf`. Gzip + `Cache-Control: immutable` on hashed assets. Search page is `noindex, follow`.

**Route prefetching**: `App.tsx` uses `requestIdleCallback` to eager-import top 5 chunks. All `import()` calls `.catch(() => {})` to suppress noise after deploys. **Hover prefetch** on `CategoryCard.tsx` + `SearchBar.tsx`: `onMouseEnter={() => import("@public/pages/category").catch(() => {})}`.

**Service Worker**: `vite-plugin-pwa` runtime-cache only (no precaching). `StaleWhileRevalidate` on `/api/categories/*` (300s TTL); `NetworkFirst` on other public API. `cleanupOutdatedCaches: true`. `manifest: false`. `navigateFallback: null`.

**API Cache-Control**: `GET /api/categories/` + `/api/categories/{slug}` return `Cache-Control: public, max-age=60`. Header set AFTER 404 check (HTTPException creates new response).

**Ultrawide (>1600px)**: `.subnavInner`, `.headerInner`, `.contentWide` all widen to `90vw`. `.contentWide max-width: calc(90vw + 56px)` so `.contentInner` aligns with `.chipBar`.

### Admin layout (`AdminLayout.tsx`)
240px Phosphor-Light sidebar + 64px sticky topbar (topbar controls still Lucide). Sidebar Parts/Suppliers/Import badges dynamic: demo → `DEMO_BADGES`, live → `adminApi.getStats()`. Bell + Messages badges synced on `[location.pathname]`. Admin chrome intentionally un-themed.

### Claude Code Automations (`.claude/`)
- **Hooks** — PreToolUse blocks `.env`/lock edits, warns on `api/app/admin.py`, runs `migration-safety-check.sh` on commits. PostToolUse: tsc on .ts/.tsx/.scss; pytest on .py; ruff format+check on .py (excl. alembic); `scss-lint.sh`; `frontend-rebuild.sh` (flock-deduped).
- **Ruff** (`api/pyproject.toml`): line 100, py312, E/F/W/I/UP/B, ignores E501+B008, excludes `alembic/versions/`.
- **Agents** — `deploy-preflight`, `seo-auditor`, `visual-regression-guard`, `frontend-perf-auditor`, `theme-persistency-guard`.
- **Skills** — `seo-writer`, `/add-model-field`.
- **MCP** — `context7` (project), `chrome-devtools-mcp` + `playwright` (global).
- **HeroColorTuner** — dev-only IC-opacity tuner, gated `{import.meta.env.DEV && <HeroColorTuner />}` at App.tsx.

### Data flow
- Forms POST → API → `BackgroundTasks` → `email.send_*_notification` (aiosmtplib + Hover SMTP). n8n still in compose, NOT in form path.
- Parts attach to subcategory in `seed.py` (test conftest attaches to subcategory too). Aggregates roll up `own + sum(children)`.
- Parent "Popular Parts" rollup: `category_service._build_popular_parts(db, parent_id, page, per_page)` — `WHERE category_id IN (self + children)`, GROUP BY part, ORDER BY SUM(stock) DESC. `<Pagination>` widget at `@public/components/widgets/Pagination.tsx`. Default `POPULAR_PER_PAGE=12`.

## Key Patterns

### SCSS Modules
```scss
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;
@use '../../styles/animations';
```
Mixins in `_mixins.scss`: `container`, `card-base`, `hover-lift`, `responsive($bp)`, `gold-shimmer-border`, `skeleton-shimmer`, `scrollbar-thin($height, $radius)`, `truncate` (single-line ellipsis, `min-width: 0` for flex), `line-clamp($lines: 3)` (`-webkit-box` multi-line). Hoist new repeated literals here before they sprout four places.

### Framer Motion page transitions
```tsx
initial={{ opacity: 0, x: 20 }}
animate={{ opacity: 1, x: 0 }}
exit={{ opacity: 0, x: -20 }}
transition={{ duration: 0.15, ease: 'easeInOut' as const }}
```
PublicLayout = `<Suspense><Outlet/></Suspense>` — `AnimatePresence` REMOVED at this level (left entering pages stuck at prior exit-state). Local UI like `keyword/index.tsx` chip-stagger keeps it. **Navbar MUST be sibling of `<Routes>`** in App.tsx — not inside a transforming ancestor (sub-pixel text blur).

### Theme system
4 themes (`base`, `steel`, `schematic`, `pcb`) in `_themes.scss` as CSS custom properties on `[data-theme]`. **Steel is prod default** — `ThemeBridge.tsx` hardcodes `theme="steel"` in prod (URL params + localStorage ignored). Dev: URL `?nav=A|B|C` → `localStorage.circuits.nav.theme` → `DEFAULT_THEME`. `_themes.scss` requires `@use 'variables' as *;` at top so `#{$font-heading}` interpolates for `--theme-brand-font`.

**Hero SVG cascade** — `CircuitTraces.module.scss` defines 6 CSS custom properties at the `.circuitTraces` ROOT (NOT per child — 140 paths × var() re-resolutions during 6s draw kill perf). Apply SVG filter at a `<g>` wrapper, NEVER per-path. Base theme has a carve-out suppressing shared glow via `.traceGroup { filter: none; }`. `<CircuitTraces variant="full" />` pinned everywhere. `viewBox 0 0 1200 400` with `preserveAspectRatio="xMidYMid slice"` — screen→viewBox y-map is SKEWED; use `getScreenCTM()` or work in source coords.

**Edge-connector pattern in `CircuitTraces`** (CN1 left, CN2 right): pass-through connectors with dual-side pin rows, board traces clipped to terminate at inner pins, short outer stubs continue off-board. Through-electrons fade across the body via `<animate attributeName="fill-opacity" values="1;1;0;0;1;1" keyTimes={hideKeyTimes}>` synced (same `dur`/`begin`/`repeatCount`) to the sibling `<animateMotion>`. keyTimes are arc-length fractions (`animateMotion` paced calcMode); inner `0;0` pair must span the FULL body crossing. Constants `CN1_PINS`/`CN2_PINS`/`CN2_OUTER`/`CN1_HIDE` module-level above `ELECTRONS`.

HeroSection + PageHeaderBand are TRANSPARENT layout-only — band is a "window" onto the persistent backdrop. Pause wiring: `IntersectionObserver` + `visibilitychange` (`svg.pauseAnimations()` + `data-paused="true"`). `animationend` releases completed animations.

### API conventions
All routes prefixed `/api/` (router prefix). **`routes/forms.py` is `/api`, NOT `/api/forms`** — endpoints `POST /api/contact`, `/api/join`, `/api/keyword-request`. Frontend uses relative paths. `part_to_dict()` returns `category_name`/`slug` + `parent_category_name`/`slug` (`| null` on top-level). Category API exposes siblings via `ParentCategoryResponse.children` (eager-loaded `lazy="selectin"`). `SubcategoryChips` URL-driven, `aria-current="page"` on active.

### Contact page motif
Datasheet card — founders labeled U1/U2 (schematic designators), crop-mark corners, PCB grid bg (24px cells, $nav-blue @ 3.5%). Don't flatten.

### Navbar — pinned-edge layout
Brand (`left: 20px`) + nav+LOGIN group (`right: 20px`) are `position: absolute` on `.topStrip`. Search bar centered via `left: 50%; transform: translateX(-50%)`, hidden on `/`. Do NOT use Grid or `space-between` (breaks on narrow side-track content).

### Footer + ErrorBoundary + overflow guard (site-wide)
- `<Footer />` mounted ONCE in `PublicLayout.tsx` (sibling of `<Outlet />`); layout `min-height: calc(100vh - $nav-height)`; footer `margin-top: auto`. Theme-aware.
- `<ErrorBoundary key={location.pathname}>` wraps Outlet (public) + Routes (admin) at `@shared/components/ErrorBoundary.tsx`. Pathname-keyed so error state auto-clears on nav.
- `html, body { overflow-x: clip }` in `global.scss`. Use `clip` NOT `hidden` (doesn't disturb `position: sticky` ancestors). Companion: `.contentWide { min-width: 0; width: 100% }` breaks the flex min-content chain.

### SPA scroll-to-top
`App.tsx`: `useEffect(() => { if (location.hash) return; window.scrollTo({top:0,left:0}); }, [location.pathname])`. Anchor nav preserved via hash skip.

### Seed data (idempotent)
15 categories, 75 subcategories (5 each, 2 levels), 7+ suppliers, 2 sponsors, 59 parts/179 listings/193 revenue (plus real-catalog rows). `get_or_create_*` skips existing. `CATEGORY_DATA` slugs are EXPLICIT per row — `get_or_create_category(name, slug, ...)` requires the slug arg (some slugs like `motor-motion-ics` don't match `slugify(name)`).

## Gotchas

(Each is a recurring trap. One-liners by design.)

- **TS strict** — remove unused vars, don't prefix `_`.
- **`?:` catches only `undefined`, NOT `null`** — Python `None` → JSON `null` slips through `field?: number`. Use `field?: T | null` + `!= null`; default with `??`.
- **`/admin` in prod = React SPA**, not SQLAdmin. Edit `frontend/src/admin/pages/`, not `app/admin.py`.
- **Adding a Supplier field = 6 files**: model + alembic + Response/Create/Update + `to_dict` + TS type + List COLUMNS + FormPage. Use `/add-model-field`.
- **`SupplierResponse` + `CategoryResponse` are shared by public AND admin endpoints** — fields appear in unauthenticated routes. Use separate auth-gated endpoints for admin-only fields.
- **`response_model=SchemaX` silently strips computed attrs** — stamping `obj.parts_count = N` works locally; Pydantic's `from_attributes=True` drops it. Drop `response_model=` or add the field with default.
- **`routes/sponsors.py` + `routes/admin_sponsors.py` are symmetric `SponsorResponse` consumers** — hand-rolled keyword response missed `email`/`contact_name` when added; Pydantic defaulted them to `None`. Any new `SponsorResponse` field touches BOTH sites.
- **Sponsor placement = write-side supersede + read-side filter** — `admin_sponsors._supersede_existing_for_category(...)` called from POST + PATCH. Public read in `category_service.get_category_detail` mirrors the same predicate (newest-by-`created_at` tiebreak).
- **`Sponsor.status` filters MUST treat NULL as Active** — legacy seed rows omit status. SQL three-valued logic: `status != 'Expired'` is UNKNOWN for NULL → silently SKIPS them. Use `or_(Sponsor.status == 'Active', Sponsor.status.is_(None))` everywhere.
- **Admin sponsor form = 3-way segmented placement** (`top-category|subcategory|keyword`). `placementDerivedRef` MUST reset on `[id]` change (separate `useEffect`) — otherwise cross-edit nav leaves bucket at the prior sponsor's. All 3 buttons go through one `choosePlacement(p)` helper.
- **Sponsor XOR is Postgres-only** (SQLite skips CHECK). Enforce client-side in SponsorFormPage `validate()` + `buildSponsor()`. Enforce server-side in Python in the router (422). Never both fields set or both empty.
- **Sponsor `tier` casing** — admin emits TitleCase (`Featured`/`Platinum`/`Gold`/`Silver`), seed uses lowercase. Public TS type is `tier: string`. Lowercase in JSX for `[data-tier='X']` selectors.
- **Tests use SQLite via `Base.metadata.create_all`** — SQLite ignores `String(N)` length AND CHECK constraints. For length contracts assert on metadata: `Model.__table__.c.col.type.length >= N`.
- **Parts→category attachment** — `conftest.py` attaches to subcategory; `db/seed.py` attaches to top-level. Aggregates must roll up `own + sum(children)`.
- **`Part.sub_slug` auto-derive** — `create_part` stamps `sub_slug = child.slug` when `category_id` is a child Category. Migration 006 backfills (PostgreSQL-only).
- **`featured_supplier_name` batch-query** — `get_all_categories` JOINs CategorySupplier WHERE `is_featured=true`, ORDER BY rank DESC, dict-comprehension last-write semantics → lowest-rank wins. No N+1. Mirror for any future denormalized winner-of-N.
- **`POST /api/parts/` atomic create** — `body.initial_listing` creates Part + PartListing in one transaction.
- **Deleting a Supplier cascades 6 surfaces** — `DELETE /api/suppliers/{id}` removes PriceBreak → PartListing → Sponsor (NOT NULL FK) → CategorySupplier → Revenue, NULLs `User.supplier_id`, then deletes. Order matters; mirrors `delete_part`.
- **Bulk `query(...).delete()` + `lazy="selectin"` → "Dependency rule tried to blank-out primary key"** on parent delete. Fix: `db.expire(parent)` between bulk-deletes and `db.delete(parent)`.
- **Auto-feature endpoint `POST /api/admin/category-suppliers/feature`** — feature-only (no unfeature variant). Idempotent upsert. Supplier-delete cascades the row.
- **Pyright "Import app.services.email could not be resolved"** is a false positive (stdlib `email` shadows). Runtime fine.
- **`dict(query(Col1, Col2).all())` mis-types under Pyright** — use `{row[0]: row[1] for row in query.all()}`.
- **Framer Motion v12 requires `as const` on ease**.
- **Framer Motion `whileHover` FIRES ON TOUCH** via Pointer Events hover synthesis — don't use on touch-drag components (card "jumps" on tap). Use CSS `@media (hover: hover)` for desktop-only hover-lift.
- **Don't reintroduce `AnimatePresence` around `<Suspense><Outlet/></Suspense>`** — FM12 leaves the second-nav entering motion.div stuck at the prior exit-state.
- **Don't gate visible content on JS-added classes inside `AnimatePresence`** — IO callbacks fire unreliably mid-transform, leaving `opacity: 0` stuck. Default visible; trigger entrance via `setTimeout`.
- **CSS `opacity: X` OVERRIDES SMIL `<animate attributeName="opacity">`** — CSS wins over SVG presentation-attribute animation. Animate `fill-opacity` (or `stroke-opacity`) instead.
- **SVG `<filter>` on `<g>` whose children animate = CPU raster on mobile** — `feGaussianBlur` was a documented lag cause. Apply at `<g>` wrapper, NEVER per-path. Mobile `@media (max-width: 768px) { .traceGroup { filter: none; } }`.
- **Never animate CSS `drop-shadow()`** — scroll lag. Use static shadows.
- **`filter: hue-rotate(0deg)` is NOT free** — promotes to compositor layer even at 0deg. Gate behind non-default themes.
- **Sub-pixel text blur from `transform: translate*(-50%)`** — fractional pixels + GPU layer = subpixel glyph raster. Use `top: 0; bottom: 0; display: flex; align-items: center`.
- **`Node.contains(window)` THROWS** — any scroll-close / outside-click guard must `e.target instanceof Node && popoverRef.current?.contains(e.target)`.
- **`setPointerCapture` retargets `pointerup` (and synthesized `click`)** — taps on child `<a>`/`<button>` silently stop. Guard `if (e.target?.closest('a, button, [role="button"], input, textarea, select, label')) return;` before capture.
- **iOS Safari fires `pointercancel` (NOT `pointerleave`) under `setPointerCapture`** when a system gesture preempts (Control Center pull, multi-finger). Listen for both, plus `pointerup` for touch.
- **`touch-action: pan-y` on touch-interactive surface CANCELS `pointermove`** the moment the browser commits to a vertical scroll. Use `touch-action: none` for full-direction tracking (trade-off: not a scroll surface).
- **SponsorBlock = backlit-PCB card with flashlight reveal** (`SponsorBlock.tsx`). `touch-action: none` + `setPointerCapture` for finger drag, but skip capture when target is an interactive descendant or child CTAs silently stop navigating. NO `whileHover` (FM fires on touch). `data-tier` lowercased in TSX. **PCB art SVG uses `preserveAspectRatio="xMidYMid meet"`** (NOT `slice`) — card is landscape on every viewport, viewBox is portrait `0 0 300 360`; `slice` overflows ~85px top/bottom (user perceives "circuit larger than PCB"). `meet` encases the art; `.substrate` + `.lamp` still fill the card. `mask-composite` rim gated behind `@supports`.
- **CategorySponsorBanner = parent-category sponsor surface** (`category/index.tsx`, gated `isParent && !activeSubInfo`). Medallion uses `lettermark()` with `<img onError>` fallback (broken `image_url` would paint browser broken-image glyph otherwise). `CopyChip` cleans up its `setTimeout` on unmount. CTA renders only when email OR website present — never `href="#"` (scrolls to top on tap). Flashlight is desktop-only (`(hover: hover) and (pointer: fine)`); mobile keeps substrate, no reveal.
- **Don't reintroduce `AnimatePresence`** on PublicLayout (see above).
- **`.outletWrap { position: relative; z-index: 1 }` is load-bearing** — without it BackdropLayer (z-index: 0) paints ON TOP of static page descendants.
- **Inner-page surface-bg goes on a body WRAPPER inside motion.div, NOT on motion.div** — `<BackdropLayer />` (z: 0, top: $nav-height, height: 420px) needs visibility through the band. PageHeaderBand + HeroSection are TRANSPARENT.
- **URL-param-absent ≠ default-intent** — a default-button click that clears a URL param is shadowed by stale localStorage. Write default to localStorage SYNCHRONOUSLY before `setParams`.
- **Don't put `setSearchParams` in a `useEffect` dep array** (React Router v7) — its identity changes when the URL changes; an effect that "resets `?p` to 1 on filter change" also fires on page change and clears `?p`. Depend only on filter values; the functional-update form `setSearchParams(prev => ...)` needs no setter dep.
- **State-dep effect + async fetch needs cancel-flag** — `let cancelled = false; ...; return () => { cancelled = true; }`; gate `.then`/`.catch` on `if (cancelled) return;`. AdminLayout's badge fetch is the canonical example.
- **Dev-only components gate at the CALL SITE** — `{import.meta.env.DEV && <X />}` at App.tsx mount. Don't `if (!DEV) return null` before hooks (Rules of Hooks).
- **Non-ASCII glyphs in JSX text get mangled to `\uXXXX` literal text** by the edit tooling — writing `>↗<` ends up as the 6-char string `↗` rendering literally. Use an HTML entity (`&#8599;`) or a JS-string expression (`{'↗'}`).
- **Empty SCSS rule → undefined CSS module class** — `.foo {}` makes `styles.foo === undefined`. Always include ≥1 declaration.
- **CSS Modules can't host BEM `--`** — `qa-card--primary` becomes invalid. Use camelCase (`qaCardPrimary`); compose at call site.
- **Source-line grep undercounts JSX rendered DOM** — `.map()` multiplies (CircuitTraces: 54 source `<rect>` → 193 rendered).
- **Structural-rename: grep `import.*\.scss` in TS/TSX**, not just `@use` in SCSS — side-effect imports (`main.tsx`'s `import './styles/global.scss'`) bypass `@use`.
- **`border-collapse: separate` for rounded table corners** — `collapse` ignores `border-radius` on cells. Use `separate` + `border-spacing: 0` + radii on corner th/td. Trap: borders on `<tr>` no longer render — move `border-bottom` to `.td`.
- **Buttons inherit `line-height: 1.6`** from body — overflows height-constrained rows. Fix: explicit `line-height: 1` + control via padding.
- **`<input type="url|email|tel>` silently kills form submit** for HTML5-invalid values — React `onSubmit` never runs, no `:invalid` styling, no console error. Use `type="text"` + `inputMode="..."` + JS validation + `noValidate` on form. Guard: `api/tests/test_no_type_url_form_input.py`.
- **`prependScheme` must be RFC-3986-aware** — naive `if (!startsWith('http'))` produces `https:////acme.com` or `https://mailto:…`. Use `^[a-z][a-z0-9+.-]*:` OR `^//` to skip already-schemed.
- **Phone formatter country-code paste** — `+1 (800) 555-0142` → `(180) 055-5014` if you just strip non-digits + slice(0,10). Strip leading `1` when input is 11 digits starting with `1`.
- **Avoid `grid-template-columns: 1fr auto 1fr` with asymmetric side-track content** — `1fr` = `minmax(auto, 1fr)`. Use `position: absolute` on a relative parent.
- **Tree-row `1fr auto auto` jams slug behind name on long titles** — promote children to `repeat(auto-fill, minmax(220px, 1fr))` tiles.
- **Supplier-detail panel stretch (Grid+Flex two-tier)** — `.detailGrid { align-items: stretch }` makes panels match tallest column; inner `.panel { display: flex; flex-direction: column }` + `.panelBody { flex: 1 }` makes Description backfill. Sidebar opts out via `align-self: start`.
- **Prefill bus at `@admin/services/prefillBus.ts`** — typed singleton with one-shot `consumePrefill(kind)`. Survives SPA nav (module memory), dies on full reload. Destination forms read in `useState(() => consumePrefill('part'))` lazy initializer.
- **Quick Actions hero strip** lives at `pages/suppliers/detail/QuickActionsPanel.tsx` — full-width 4-card grid; variants `qaCardPrimary/Blue/Gold/Purple` map to workflow categories.
- **Mobile data tables (PartsTable)**: `border-collapse: separate; border-spacing: 0` + 12px corner radii. `.tableWrap { overflow-x: auto }` ALWAYS. `min-width: 540px` at ≤1024px. Description column hides below **1450px**; Category hides ≤768px. Subcategory chips wrap at desktop, 2-col grid on mobile.
- **ColumnHeader sort/filter popover is PORTALED to `document.body`** (`createPortal`) with `position: fixed`, viewport clamp, flip-above-if-no-room-below, close-on-scroll/resize, outside-click + Escape. Two scroll-close guards: `e.target instanceof Node` BEFORE `.contains()`; skip scrolls from inside `.filterList`.
- **Mobile drawer state-machine** (Navbar + AdminLayout): `useState(menuOpen)` + 3 effects on `[menuOpen]` — body-scroll-lock (capture+restore `prev`), Esc keydown (attach only while open), `[location.pathname]` for auto-close. Compositor-only animations.
- **Admin `<aside>` needs conditional `aria-hidden`**: `aria-hidden={!menuOpen ? undefined : false}` (no attr when closed). Public drawer's `aria-hidden={!menuOpen}` would set `"true"` at desktop where the admin sidebar IS visible.
- **`backdrop-filter: blur(2px)` on full-viewport scrim is OK on mobile** when scrim only animates opacity. Don't add to elements that translate/scale.
- **Breakpoints in `_variables.scss`**: `$bp-mobile: 768px`, `$bp-tablet: 1024px`, `$bp-desktop: 1199px`, `$bp-admin-mobile: 820px`, `$bp-admin-compact: 420px`. Use `@include responsive(...)`.
- **`--a-blue` / `--a-purple` admin-scope tokens** — `AdminLayout.module.scss .admin` defines blue (`#2563eb`) + purple (`#7c3aed`) for Dashboard sparklines. Pass as `color="var(--a-blue)"`, NEVER inline hex.
- **Admin Supplier tier derived client-side** — `AdminSupplier` has no `tier` column. `SuppliersPage` derives Featured (≥200) / Platinum (≥100) / Gold (≥25) / Silver (else) from `parts_count`.
- **Admin sponsors are API-backed** (was localStorage). `@admin/services/sponsorStore.ts` is ASYNC over `adminApi`. Form supplier/category `<select>` pull REAL UUIDs from `getSuppliers()/getCategories()`.
- **Theme/route bug repro via SPA NavLink, NOT direct URL** — direct URL remounts everything.
- **Verify SVG persistence across SPA nav with session-marker pattern** — `svg.dataset.sessionMarker = 'tag-' + Date.now()` before NavLink click; `evaluate_script` after.
- **Wizard at `@admin/wizard/`** — `data-tour=` anchors on JSX + `data-field=` wrappers + literal `[data-modal=...]` for hash-safe modal polling. Pattern-guard: `api/tests/test_wizard_data_anchors.py` (excludes `flows.tsx` which uses the same syntax in selectors). `useAdvance` keeps route-based vs polling-based effects SEPARATE — combining caused Step 1→2 hangs.
- **Wizard `__auto_select__` for `<select>` fields** (UUID values can't be hardcoded) — `handleAutofill` picks the first non-empty `<option>`. Mobile auto-opens admin sidebar drawer when spotlight target lives there. Demo entity cleanup via `demoCleanup.ts` (localStorage UUIDs, fires on `exitFlow()`/`startFlow()`).
- **chrome-devtools-mcp programmatic form-fill** — React controlled inputs need the native setter: `Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v)` + `el.dispatchEvent(new Event('input', {bubbles: true}))`. For silent-submit-block triage: attach `document.addEventListener('submit', ..., true)` BEFORE click — if `click` fires but `submit` doesn't, suspect HTML5 constraint validation.
- **chrome-devtools-mcp `click(uid)` may not trigger React Router on `<Link>`** — for SPA-nav tests, use `evaluate_script` + `document.querySelector(...).click()`.
- **chrome-devtools-mcp looping (theme × route)**: open ONE page + `navigate_page`, NOT `new_page` per cell.
- **Full `docker compose up --build` rebuilds n8n** (313MB base re-extract) — `deploy.sh` scopes to `build api frontend` only and drops the trailing `docker builder prune`. t3.micro OOMs — stay on t3.small.
- **Frontend Dockerfile has 4 stages** (base/dev/build/prod); compose defaults to `prod`. Container serves hashed Vite bundle via nginx, no HMR. SCSS/TSX edits need `docker compose up --build -d frontend`. For local HMR, `target: dev`.
- **API container has `build: ./api` with NO volume mount** — edits don't reach running container via `restart`. Use `up -d --build api`. Symptom: seed reports success but data reflects OLD code.
- **`docker compose restart` does NOT re-evaluate `${VAR:-}` from `.env`** — env-only changes need `up -d --force-recreate <svc>`. Verify: `exec -T api python -c "..."`.
- **`docker compose exec -T <svc> <cmd>` consumes stdin** of wrapping `ssh ... <<HEREDOC` — rest of heredoc never reaches remote. Always `... exec -T < /dev/null`.
- **Docker cache can serve stale frontend** — if behavior not visible: `docker compose build --no-cache frontend && docker compose up -d frontend`.
- **`./deploy.sh --reseed` destructive scope** — TRUNCATEs `sponsors, category_suppliers, categories, suppliers CASCADE` → cascades to `users, parts, part_listings, price_breaks, revenue`. `messages` SURVIVES. Admin-UI rows outside seed.py ARE wiped.
- **Category slug changes need `--reseed`** — `get_or_create_category` keys on slug. Renaming a slug makes the new entry MISS the existing row → seed CREATEs a duplicate. Plain `./deploy.sh` won't fix it.
- **`./deploy.sh` (no flag) does NOT restart nginx** → 502 (stale upstream DNS). Always chase with `./deploy.sh --frontend`. **For frontend-only changes, `./deploy.sh --frontend` ALONE is sufficient** — skip the bare `./deploy.sh` so api isn't recreated for no reason. Run `deploy-preflight` agent before every deploy.
- **Deploying API changes → ~1-2 min of 502 on `/api/*`** — recreating api re-runs `alembic → seed → uvicorn`. HTML still serves 200. Transient; check api logs (`Seeding database...`) before intervening.
- **nginx HTTP/2 requires `http2 on;`** — `listen 443 ssl;` alone gives HTTP/1.1. All 3 SSL server blocks in `nginx/nginx.ssl.conf` carry `http2 on;`. Verify: `curl -sI --http2 https://circuits.com/ -w '%{http_version}\n'` (want `2`).
- **Category-page early preload couples `frontend/index.html` ↔ `api.ts`** — inline `<script>` fires the API fetch at HTML parse time on `/category/<slug>`, stashes promise on `window.__categoryPreload`, `api.getCategory` consumes it. **Any URL/param change must update BOTH** or api.ts skips the preload. Pattern is direct-load only; SPA nav goes through axios (hover-prefetch + SW cache cover that).
- **`index.html` served `no-cache`** (`frontend/nginx.conf` `location /`) so browsers revalidate the unhashed SPA entry. Hashed assets stay `immutable`. Guard: `api/tests/test_nginx_cache_headers.py`.
- **`sw.js` MUST NOT be cached immutable** — generic regex applies `immutable, 1y` to ALL js. Exact-match `location = /sw.js` + `location = /registerSW.js` with `Cache-Control: no-cache` (exact match wins over regex).
- **SW API caching: `StaleWhileRevalidate`, NOT `NetworkFirst`** — NetworkFirst always waits for network; SWR serves cache instantly + revalidates in background. 300s `maxAgeSeconds` bounds staleness after `--reseed`.
- **Workbox `runtimeCaching` regex MUST allow trailing slash** — `api.ts` requests end `/?params` (axios). Pattern needs `\/?` before query group: `/\/api\/categories(\/[^/?]+)?\/?(\?.*)?$/`. Verify: `caches.keys()` → open each → `cache.keys()`.
- **`global.scss` uses deprecated Sass `darken()`/`lighten()`** — new code uses `@use 'sass:color'` + `color.adjust()`.
- **ProxyHeadersMiddleware trusts all hosts** — required for admin HTTPS URL gen behind nginx. FastAPI 307-redirects missing-trailing-slash (`curl -L`; axios follows).
- **Adding a new hostname**: add to `server_name` in `nginx/nginx.ssl.conf` → stop nginx on EC2 → `sudo certbot certonly --standalone --expand --cert-name circuits.matthew-chirichella.com -d <every>` → start nginx. DNS must resolve first.
- **Cert dir is `circuits.matthew-chirichella.com`** even though `circuits.com` is primary (SAN match). Renaming is cosmetic + requires nginx path updates.
- **SMTP creds in `/opt/circuits-com/.env` on prod EC2** (not committed): `SMTP_HOST=mail.hover.com`, `SMTP_PORT=587`, `SMTP_USERNAME=no-reply@circuits.com`, `SMTP_PASSWORD=...`. Without `SMTP_HOST`, `email._smtp_send` runs in demo mode. `NOTIFY_RECIPIENTS` accepts JSON or CSV.
- **n8n no longer in form path** — `routes/forms.py` uses aiosmtplib + Hover SMTP via FastAPI BackgroundTasks.
- **Admin login creds (local dev)**: `matthew`/`mike`/`john` all password `admin` (seeded in `api/app/db/seed.py`). `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars are for SQLAdmin only (unreachable in prod).
- **Test fixtures must NOT pair a real-looking SMTP host with `SMTP_PASSWORD`** — GitGuardian pattern-matches host+user+password proximity. Use RFC 6761 reserved TLDs (`.invalid`/`.test`/`.example`) for hosts AND emails. Regression: `api/tests/test_no_smtp_credential_lookalikes.py`.
- **`EmailStr` rejects RFC 6761 reserved TLDs** — smoke tests need real-looking TLDs. Use `smoke-test+verify@circuits.com` (plus-tag self-route).
- **Claude Design handoffs are 4.2MB gzip** via `https://api.anthropic.com/v1/design/h/<hash>` — `WebFetch` saves to `<tmpdir>/tool-results/webfetch-*.bin`. Extract `tar -xzf <path>.bin -C design-handoff[-vN]/`. Versioned dirs gitignored.
- **ANY accent-colored text on a light card uses `var(--executive-blue)`** — `var(--theme-accent)` + `var(--theme-cta-bg)` fail WCAG-AA. Borders + chip backgrounds can keep `var(--theme-accent)`. `var(--fg2)` (#6b7280) passes on white (4.85:1) but fails on `var(--surface)` (4.07:1). **Exception**: `/keyword` uses `var(--theme-accent)` for section-num + tier price (a11y 91/100 documented).
- **Branch workflow (post v7)**: `master` = deploy tip, `updates` = active dev. Sequence: commit on `updates` → push → `git checkout master && git merge --ff-only updates && git push origin master` → `./deploy.sh && ./deploy.sh --frontend` → `git checkout updates`. No squash; ff-only keeps history linear.

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
