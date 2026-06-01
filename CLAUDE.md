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
FastAPI in `app/main.py`. Routers: categories/suppliers/search/forms/sponsors/admin_sponsors/parts/dashboard. Models: `Category` (self-ref tree, `parent_id`), `Supplier`, `CategorySupplier` (join, `is_featured`+`rank`), `Sponsor` (XOR `category_id` OR `keyword`), `Message`, `Part`/`PartListing`/`PriceBreak`, `Revenue`, `PageView`. Services: `category_service`, `search_service`, `email` (aiosmtplib+Hover SMTP, demo when `SMTP_HOST` unset). SQLAdmin mounts at `/admin` on api but is unreachable in prod (nginx routes `/admin` → frontend). React admin = `frontend/src/admin/pages/`, JWT in `localStorage.admin_token` via `adminApi.ts`. Entrypoint: alembic → seed → uvicorn.

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

**Category page**: column-header sort/filter (`ColumnHeader.tsx`, portaled popover) + sticky subcat pill-bar + client-side filter/sort/pagination (25/page). Parent pages fetch all parts (`per_page=500`); leaf pages same scoped to one sub. `?p=N` paginates; `activeSub` for sub-chip filter.

**Catalog data**: 15 JSON files in `api/app/db/catalog_data/`. `_seed_real_catalog()` → Part/PartListing/PriceBreak. `_DEMO_CATALOG` for wizard demos. Revenue scaled by listing count via `_REVENUE_TIERS`. ~3,600 parts, ~41K listings, ~164K price breaks, 57 suppliers. Regenerate via `--reseed`.

**Per-qty best prices**: `_build_public_parts` + `_build_popular_parts` return `best_price` + `best_price_10/100/1000` via batched PriceBreak queries. `PartsTable` renders 4 price columns.

**Part page**: deep-links via `distributorUrl(supplier_website, part.sku)` (`DISTRIBUTOR_SEARCH` map, `endsWith` subdomain-tolerant, `{domain}/search?q=` fallback). Searches by MPN. Row `onClick` opens; guards `closest('a')` so inner `<a>` doesn't double-fire. Demo prices synthetic — real reliability needs price-feed integration.

**Part slugs**: `Part.slug` non-unique index (migration 008), `slugify_sku(sku.lower())`. `GET /api/parts/by-slug/{slug}`. Duplicate SKUs across manufacturers share the slug.

**Category SEO descriptions**: `Category.description` (migration 009). `CATEGORY_DESCRIPTIONS` in `seed.py`. Live ONLY in `<meta description>` + JSON-LD `CollectionPage` — not rendered visually.

**Site analytics**: `PageView` + `POST /api/track` (30/min/session). Inline SPA tracker in `index.html` patches `pushState`/`replaceState`, `sendBeacon`, skips `/admin`. `GET /api/dashboard/analytics` aggregates day/page/referrer/device/browser.

**SEO**: `robots.txt`, dynamic `sitemap.xml` via `GET /api/sitemap.xml` (~3,713 URLs). `react-helmet-async` (`HelmetProvider` in `main.tsx`) — per-page `<title>`/meta/canonical/JSON-LD. Home: `WebSite`+`SearchAction`. Category: `CollectionPage`+`BreadcrumbList`. Part: `Product`. HSTS in `nginx.ssl.conf`. Gzip + `Cache-Control: immutable` on hashed assets. Search page `noindex, follow`.

**Route prefetching**: `App.tsx` uses `requestIdleCallback` to eager-import top 5 chunks. All `import()` calls `.catch(() => {})` to suppress post-deploy noise. **Hover prefetch** on `CategoryCard.tsx` + `SearchBar.tsx` via `onMouseEnter`.

**Service Worker**: `vite-plugin-pwa` runtime-cache only (no precaching). `StaleWhileRevalidate` on `/api/categories/*` (300s); `NetworkFirst` on other public API. `cleanupOutdatedCaches: true`, `manifest: false`, `navigateFallback: null`.

**API Cache-Control**: `GET /api/categories/` + `/api/categories/{slug}` return `public, max-age=60`. Set AFTER 404 check (HTTPException creates new response).

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
Datasheet card — founders labeled U1/U2 (schematic designators), crop-mark corners, PCB grid bg (24px cells, $nav-blue @ 3.5%). Don't flatten.

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
- **Sponsor placement = write-side supersede + read-side filter** — `admin_sponsors._supersede_existing_for_category(...)` on POST+PATCH; `category_service.get_category_detail` mirrors the predicate (newest-by-`created_at`).
- **`Sponsor.status` filters MUST treat NULL as Active** — legacy seed omits status. `status != 'Expired'` is UNKNOWN for NULL → silently skipped. Use `or_(status=='Active', status.is_(None))`.
- **Admin sponsor form = 3-way segmented placement** (`top-category|subcategory|keyword`) — `placementDerivedRef` MUST reset on `[id]` change (separate `useEffect`) or cross-edit nav keeps prior bucket. All 3 buttons go through `choosePlacement(p)`.
- **Sponsor XOR is Postgres-only** (SQLite skips CHECK) — enforce client-side in SponsorFormPage `validate()`/`buildSponsor()` AND server-side in router (422). Never both fields set or both empty.
- **Sponsor `tier` casing** — admin emits TitleCase, seed lowercase. TS type `tier: string`. Lowercase in JSX for `[data-tier='X']`.
- **Tests use SQLite via `Base.metadata.create_all`** — SQLite ignores `String(N)` length AND CHECK. For length contracts assert on metadata: `Model.__table__.c.col.type.length >= N`.
- **Parts→category attachment** — `conftest.py` to subcategory; `seed.py` to top-level. Aggregates roll up `own + sum(children)`.
- **`Part.sub_slug` auto-derive** — `create_part` stamps `sub_slug = child.slug` when `category_id` is a child. Migration 006 backfills (PG-only).
- **`featured_supplier_name` batch-query** — `get_all_categories` JOINs CategorySupplier WHERE `is_featured=true`, ORDER BY rank DESC, dict-comp last-write → lowest-rank wins. No N+1.
- **`POST /api/parts/` atomic create** — `body.initial_listing` creates Part + PartListing in one txn.
- **Deleting a Supplier cascades 6 surfaces** — order: PriceBreak → PartListing → Sponsor (NOT NULL FK) → CategorySupplier → Revenue, NULL `User.supplier_id`, then delete. Mirrors `delete_part`.
- **Bulk `query(...).delete()` + `lazy="selectin"` → "Dependency rule tried to blank-out primary key"** on parent delete. Fix: `db.expire(parent)` between bulk-deletes and `db.delete(parent)`.
- **Auto-feature endpoint `POST /api/admin/category-suppliers/feature`** — feature-only, idempotent upsert. Supplier-delete cascades the row.
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
- **SponsorBlock = subcategory backlit-PCB card with flashlight reveal** (`SponsorBlock.tsx`). `touch-action: none` + `setPointerCapture`; skip capture when target is an interactive descendant. NO `whileHover` (FM fires on touch). PCB art SVG = `preserveAspectRatio="xMidYMid meet"` (NOT `slice` — viewBox is portrait `0 0 300 360`; `slice` overflows ~85px top/bottom). `mask-composite` rim gated behind `@supports`.
- **CategorySponsorBanner = parent-category sponsor surface** (`category/index.tsx`, gated `isParent && !activeSubInfo`). **v11 traces-first PCB**: 220px banner = 6+43+11+100+11+43+6. Four DIP chips (100×240vu, 6 pins/side via `TOP_STUB_DX=BOT_STUB_DX=[-50,-30,-10,10,30,50]`) flanked by symmetric 43px SVG strips (top: VCC + SDA + SCL buses; bot: GND + DOUT-A + DOUT-B). Monochrome gold, brightness-only hierarchy (`.busVcc/.busGnd` 75% / `.traces/.busSignal` 55% / `.tracesFaint` 28%). Zero components — every trace endpoint terminates at via dot or bus tap (no open leads). Per-chip `<g data-net='pN'>` wraps PRIVATE drop-taps only; shared buses sit outside any data-net wrapper (always-lit infra). CopyChip cleans setTimeout on unmount; CTA never `href="#"`. NO cursor-lamp (deleted v11.2 — perf regression).
- **Hybrid HTML-chip + SVG-strip coordinate locking** (CategorySponsorBanner pattern, reusable): SVG uses `preserveAspectRatio="none"` + viewBox-W `1100`. HTML chip absolutely positioned at `left: var(--cx-pct)` where `--cx-pct = CHIP_X[i]/1100*100%` (`CHIP_X={p1:137,p2:412,p3:687,p4:962}`), `width: var(--cw-pct) = 240/1100*100%`, `transform: translateX(-50%)`. Each `.chipPin { left: ((dx+120)/240)*100% }` absolute within chip. Both layers share "% of rail width" as common scale → pin tabs land on SVG trace endpoints at any rail width (verified sub-pixel drift). Mobile (≤1080px) reverts chips to CSS grid (SVG strips `display: none`).
- **`mix-blend-mode: screen` + per-pointermove CSS-var updates = full-banner CPU recomposite** — the gradient center moves per frame, so the compositor cannot cache the blend pass. `mask-image` on a sibling element compounds it (mask layer is uncacheable under the blend). For warm-pool ambient effects: pre-baked rgba radial-gradient with `will-change: background` stays GPU-fast; bake fade overlays into stacked `background:` linear-gradients instead of `mask-image`. Documented in CategorySponsorBanner v11.1/.2 — net delete was simpler than fixing.
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
- **Admin Supplier tier derived client-side** — `AdminSupplier` has no `tier` col. `SuppliersPage` derives Featured(≥200)/Platinum(≥100)/Gold(≥25)/Silver from `parts_count`.
- **Admin sponsors are API-backed** (was localStorage). `@admin/services/sponsorStore.ts` ASYNC over `adminApi`. Form `<select>` pull REAL UUIDs from `getSuppliers()/getCategories()`.
- **Theme/route bug repro via SPA NavLink, NOT direct URL** — direct URL remounts everything. Verify SVG persistence across SPA nav: stamp `svg.dataset.sessionMarker` before click, re-check after.
- **Wizard at `@admin/wizard/`** — `data-tour=`/`data-field=`/`[data-modal=]` anchors; guard `api/tests/test_wizard_data_anchors.py` (excludes `flows.tsx`). `useAdvance` keeps route-based vs polling-based effects SEPARATE — combining caused Step 1→2 hangs. `__auto_select__` for `<select>` (UUIDs) via `handleAutofill`. Demo entity cleanup via `demoCleanup.ts` on `exitFlow/startFlow`.
- **chrome-devtools-mcp form-fill** — React controlled inputs need native setter: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)` + `dispatchEvent(new Event('input', {bubbles:true}))`. Silent-submit triage: `addEventListener('submit', ..., true)` BEFORE click — no submit = HTML5 constraint validation.
- **chrome-devtools-mcp `click(uid)` may miss React Router `<Link>`** — for SPA-nav, use `evaluate_script` + `querySelector(...).click()`. Looping (theme × route): one page + `navigate_page`, NOT `new_page` per cell.
- **Full `docker compose up --build` rebuilds n8n** (313MB re-extract) — `deploy.sh` scopes `build api frontend` only. t3.micro OOMs — stay on t3.small.
- **Frontend Dockerfile = 4 stages** (base/dev/build/prod); compose defaults `prod` (nginx + hashed Vite, no HMR). SCSS/TSX edits need `up --build -d frontend`. Local HMR = `target: dev`.
- **API container has NO volume mount** — edits don't reach via `restart`; use `up -d --build api`. Symptom: seed succeeds but data reflects OLD code.
- **`docker compose restart` does NOT re-eval `${VAR:-}` from `.env`** — env changes need `up -d --force-recreate <svc>`.
- **`docker compose exec -T <svc> <cmd>` consumes stdin** of wrapping `ssh ... <<HEREDOC` — always `exec -T < /dev/null`.
- **Docker cache can serve stale frontend** — if invisible: `build --no-cache frontend && up -d frontend`.
- **`./deploy.sh --reseed` destructive scope** — TRUNCATEs `sponsors, category_suppliers, categories, suppliers CASCADE` → cascades to `users/parts/listings/breaks/revenue`. `messages` SURVIVES. Admin-UI rows outside seed.py ARE wiped.
- **Category slug changes need `--reseed`** — `get_or_create_category` keys on slug; rename creates a duplicate. Plain `./deploy.sh` won't fix.
- **`./deploy.sh` (no flag) does NOT restart nginx** → 502 (stale upstream DNS). Always chase with `--frontend`. Frontend-only: `--frontend` ALONE suffices. Run `deploy-preflight` agent before every deploy.
- **Deploying API → ~1-2 min of 502 on `/api/*`** — recreating api re-runs `alembic → seed → uvicorn`. HTML still 200. Check api logs (`Seeding database...`) before intervening.
- **nginx HTTP/2 requires `http2 on;`** — `listen 443 ssl;` alone gives HTTP/1.1. All 3 SSL blocks in `nginx.ssl.conf` carry it. Verify: `curl -sI --http2 https://circuits.com/ -w '%{http_version}\n'` (want `2`).
- **Category-page early preload couples `frontend/index.html` ↔ `api.ts`** — inline `<script>` on `/category/<slug>` stashes promise on `window.__categoryPreload`; `api.getCategory` consumes it. URL/param changes must update BOTH or api.ts skips. Direct-load only; SPA nav uses axios.
- **`index.html` served `no-cache`** (`frontend/nginx.conf` `location /`) so browsers revalidate the SPA entry. Hashed assets stay `immutable`. Guard: `api/tests/test_nginx_cache_headers.py`.
- **`sw.js` MUST NOT be cached immutable** — generic regex applies `immutable, 1y` to ALL js. Exact-match `location = /sw.js` + `/registerSW.js` with `no-cache` (exact wins over regex).
- **SW API caching uses `StaleWhileRevalidate`** (not `NetworkFirst`) — SWR serves cache instantly + revalidates; 300s `maxAgeSeconds` bounds staleness after `--reseed`.
- **Workbox `runtimeCaching` regex MUST allow trailing slash** — axios ends `/?params`. Need `\/?` before query: `/\/api\/categories(\/[^/?]+)?\/?(\?.*)?$/`.
- **`global.scss` uses deprecated Sass `darken()`/`lighten()`** — new code uses `@use 'sass:color'` + `color.adjust()`.
- **ProxyHeadersMiddleware trusts all hosts** — required for admin HTTPS URL gen behind nginx. FastAPI 307-redirects missing trailing slash (axios follows).
- **Adding a hostname**: add `server_name` in `nginx.ssl.conf` → stop nginx → `sudo certbot certonly --standalone --expand --cert-name circuits.matthew-chirichella.com -d <every>` → start. DNS must resolve first. Cert dir stays `circuits.matthew-chirichella.com` even though `circuits.com` is primary (SAN match).
- **SMTP creds in `/opt/circuits-com/.env` on prod EC2** (Hover: host/587/no-reply@circuits.com). Without `SMTP_HOST`, `email._smtp_send` runs demo. `NOTIFY_RECIPIENTS` = JSON or CSV.
- **n8n no longer in form path** — `routes/forms.py` uses aiosmtplib + Hover SMTP via BackgroundTasks.
- **Admin login creds (local dev)**: `matthew`/`mike`/`john` pw `admin` (seeded). `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars are SQLAdmin-only (unreachable in prod).
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
