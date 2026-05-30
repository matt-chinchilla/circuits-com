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

Static analysis: TypeScript strict (`noUnusedLocals`/`noUnusedParameters`) + ESLint at `frontend/.eslintrc.json` (boundary rules only — no Prettier). Frontend has no test suite; API has pytest. Visual baselines at `tests/visual/baselines/` captured via chrome-devtools-mcp.

## Architecture

5 containers:
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
FastAPI in `app/main.py`, routers: categories / suppliers / search / forms / sponsors. Models: `Category` (self-referential tree, `parent_id`), `Supplier`, `CategorySupplier` (join, `is_featured`+`rank`), `Sponsor` (XOR `category_id` OR `keyword`), `Message`. Services: `category_service`, `search_service`, `email` (aiosmtplib + Hover SMTP, demo-mode when `SMTP_HOST` unset). SQLAdmin mounts at `/admin` on api but is unreachable in prod (nginx routes `/admin` → frontend). React admin = `frontend/src/admin/pages/`, JWT in `localStorage.admin_token` via `adminApi.ts`. Config via pydantic-settings (`DATABASE_URL`, `CORS_ORIGINS`, `SMTP_*`, `NOTIFY_RECIPIENTS`, `ADMIN_*`). Entrypoint: alembic → seed → uvicorn.

### Frontend (`frontend/`)
React 19 + TypeScript + Vite + SCSS Modules + Framer Motion. **Bounded contexts**:
- `src/public/` — public site (`pages/`, `components/`, `hooks/`, `services/`, `types/`)
- `src/admin/` — admin SPA (`pages/`, `components/`, `services/{adminApi,sponsorStore,messageStore}.ts`)
- `src/shared/` — cross-scope ONLY (`styles/`, `services/constants.ts`, `components/{ErrorBoundary,Icon}.tsx`)

Path aliases `@public/*` / `@admin/*` / `@shared/*` in `vite.config.ts` + `tsconfig.app.json`. **≥2-consumer rule** for `@shared/`: only promote if BOTH scopes import. ESLint boundary: admin ↛ public, public ↛ admin, shared ↛ either.

**Routing** — All public routes lazy-loaded except HomePage (eager for LCP). PublicLayout = thin `<Suspense><Outlet/></Suspense>` (NO AnimatePresence — see Gotchas). Each page owns its own motion.div entrance. Persistent `<BackdropLayer />` mounted in `App.tsx` ABOVE `<Routes>` — single SVG instance per session. Heavy vendor split via `manualChunks`.

**No charting library** — `Dashboard`/`Reports` inline native SVG (Sparkline / RevenueChart / SponsorRing / HBarChart). Recharts removed 2026-04-25 (~400KB saved). Do NOT reintroduce.

**Adding a public page**: `pages/<name>/{index.tsx, <Name>Page.module.scss}` + `lazy(() => import("@public/pages/<name>"))` + `<Route>` in App.tsx. Inner pages MUST start with `<PageHeaderBand page="X" title="..." subtitle="..." />` (About/Join/Contact/Privacy/NotFound/Keyword use this — Home is exception). Multi-route reuse OK (`/privacy` + `/terms` → PrivacyPage). For anchor-scroll: namespaced ids + `scrollIntoView({behavior:"smooth",block:"start"})` + `scroll-margin-top: 100px`.

**Adding an admin entity-CRUD**: `pages/<entity>/{list,form,detail}/index.tsx` + 3 lazy imports + 4 routes (`/<entity>`, `/<entity>/new`, `/<entity>/:id`, `/<entity>/:id/edit`). For backend-field scaffolds use `/add-model-field` skill (6 files).

**Keyword pages**: `/keyword` (landing, 6 sections in `pages/keyword-landing/`) + `/keyword/:keyword` (sponsor profile in `pages/keyword/`). Both reuse `RequestModal`. Tier prices ($99/$299/$899) + FAQ in `keyword-landing/constants.ts` are PLACEHOLDER.

**`useKeywordRequestModal` hook** (`@public/hooks/`): owns `name`/`companyName`/`email`/`message`/`selectedTier`/`submitting`/`submitted`/`formError` + `handleSubmit(keyword)` + `resetAfterClose()`. Default `selectedTier='gold'`. Hosting pages own only open/close.

**`SponsorTier` Literal** (`api/app/schemas/forms.py`): `Literal["silver","gold","platinum"]`. Bogus payloads 422 at Pydantic with `literal_error`.

**Form-message persistence**: `routes/forms.py` writes a `Message` row BEFORE scheduling email. Admin Messages API-backed via `GET/PATCH /api/admin/messages/`. `messageStore.refreshMessages()` on mount + route change.

**Category page (public)**: Column-header sort/filter dropdowns (`ColumnHeader.tsx`) + sticky subcategory pill-bar + client-side filtering/sorting/pagination (25/page). LayoutSwitcher/Grid/List/Compact/Cards DELETED 2026-05-26. Parent pages fetch all parts (`per_page=500`) for client-side filter; leaf pages same pattern scoped to one subcategory. `?p=N` for pagination, `activeSub` state for subcategory chip filter.

**Real catalog data**: 15 JSON files in `api/app/db/catalog_data/` (one per top-level category). `_seed_real_catalog()` reads JSON → creates Part/PartListing/PriceBreak rows. `_DEMO_CATALOG` (formerly `_PART_CATALOG`) kept for wizard demos. Revenue seeded for ALL 57 suppliers via `_REVENUE_TIERS` data-driven table (scaled by listing count: ≥1000 listings = $2-5K/mo sponsorship, ≥500 = $1-2.5K, ≥100 = $500-1K, else = $100-500). Demo suppliers keep their original amounts via `_DEMO_TIER`. Requires `--reseed` to regenerate. Total: ~3,600 parts, ~41K listings, ~164K price breaks, 57 suppliers.

**Per-quantity best prices**: `_build_public_parts` AND `_build_popular_parts` both return `best_price` (qty 1) + `best_price_10` / `best_price_100` / `best_price_1000` via batched PriceBreak queries. `PublicPartResponse` + `PublicPart` TS type carry all four fields. PartsTable renders Qty 1/10/100/1k columns.

**Part page (`pages/part/`)**: header has "← Back" button (`navigate(-1)`). "Distributor Comparison" `.sectionTitle` is WHITE — it sits on the dark backdrop (part page has no surface-bg body wrapper). Distributor table shows per-qty pricing (Qty 1 = `listing.unit_price`, 10/100/1k from `listing.price_breaks` via `priceAtQty`). **Distributor rows deep-link to the exact part on the distributor's site** (the paid-placement feature): `distributorUrl(supplier_website, part.sku)` builds a search URL from the `DISTRIBUTOR_SEARCH` domain→endpoint map (Digi-Key `keywords=`, Mouser `/c/?q=`, Newark/Farnell/element14 `?st=`, RS `/web/c/?searchTerm=`, Arrow `?q=`, …) keyed by registrable domain (subdomain-tolerant via `endsWith`), generic `{domain}/search?q=` fallback. Searches by MPN (`part.sku`) because it's globally unique → resolves to the one part. Row `onClick` opens it (guards `closest('a')` so the inner `<a>` doesn't double-fire). `listing_to_dict` returns `supplier_website` (from `listing.supplier.website`); `PartListing` TS type carries `supplier_website` + `price_breaks`. NOTE: demo prices are seeded/synthetic — they won't match live distributor prices; real price-reliability needs a distributor price-feed integration.

**Part slugs**: `Part.slug` column (migration 008, non-unique index) derived from `slugify_sku(sku.lower())`. `GET /api/parts/by-slug/{slug}` endpoint. `slugify_sku` in `routes/parts.py` — lowercase, non-alphanumeric→hyphens, collapse, strip. Duplicate SKUs across manufacturers share the same slug (index is non-unique). Seed sets slug on creation for both demo and real catalog parts.

**Category SEO descriptions**: `Category.description` column (migration 009, Text, nullable). `CATEGORY_DESCRIPTIONS` dict in `seed.py` keyed by slug — 15 parent categories, ~100-150 words each. Descriptions live ONLY in `<meta description>` and JSON-LD `CollectionPage` schema — NOT rendered visually on the page (removed as user feedback: engineers don't need them).

**Site analytics**: `PageView` model + `POST /api/track` (rate-limited 30/min/session, no auth). Inline SPA tracker in `index.html` monkey-patches `pushState`/`replaceState`, uses `sendBeacon`, skips `/admin`. `GET /api/dashboard/analytics` (auth) aggregates by day/page/referrer/device/browser. Reports "Site Analytics" tab renders TrafficChart, DeviceTrendChart, DeviceDonut, top pages table, referrer/category/part bars.

**SEO layer**: `robots.txt` at `frontend/public/robots.txt`. Dynamic `sitemap.xml` via `GET /api/sitemap.xml` (proxied through nginx `location = /sitemap.xml`), ~3,713 URLs. `react-helmet-async` (`HelmetProvider` in `main.tsx`) gives per-page `<title>` + `<meta description>` + canonical + JSON-LD on all 10 public pages. Home has `WebSite` + `SearchAction` schema; category pages have `CollectionPage` + `BreadcrumbList`; part pages have `Product` schema. Static fallback OG/Twitter cards in `index.html`. HSTS header in `nginx.ssl.conf`. Gzip + `Cache-Control: immutable` on hashed assets in `frontend/nginx.conf`. Search page is `noindex, follow`.

**Route prefetching**: `App.tsx` uses `requestIdleCallback` to eagerly `import()` the 5 most-visited route chunks (category, search, part, about, join) after initial render. JS modules are cached by the browser for instant SPA navigation. All `import()` calls use `.catch(() => {})` to suppress console noise when chunk hashes change after deploys.

**Hover prefetch**: `CategoryCard.tsx` (home page) and `SearchBar.tsx` (nav dropdown) add `onMouseEnter={() => import("@public/pages/category").catch(() => {})}` so the category chunk loads ~200ms before click. NOT on `SubcategoryChips` — it lives inside the category chunk, so prefetch there is a no-op.

**Service Worker (Workbox)**: `vite-plugin-pwa` in `vite.config.ts` generates a SW with runtime caching only (no precaching — nginx handles static assets). `NetworkFirst` with 3s timeout on `/api/categories/*` (cache name `api-categories`, 300s TTL). `NetworkFirst` on other public API routes, excluding `/api/admin|auth|dashboard|track`. `cleanupOutdatedCaches: true` evicts stale caches on SW update. `manifest: false` — no PWA install prompt. `navigateFallback: null` — SPA routing stays with nginx.

**API Cache-Control**: `GET /api/categories/` and `GET /api/categories/{slug}` return `Cache-Control: public, max-age=60`. Header set AFTER 404 check on detail endpoint (HTTPException creates a new response, so pre-check headers don't leak). Browser caches JSON for 1 minute; SW provides the 5-minute layer.

**Ultrawide responsive (>1600px)**: `.subnavInner`, `.headerInner`, and `.contentWide` all widen to `90vw` at viewports above 1600px. `.contentWide` uses `max-width: calc(90vw + 56px)` to account for its own padding so `.contentInner` aligns with `.chipBar`.

### Admin layout (`AdminLayout.tsx`)
240px Phosphor-Light sidebar (v5 2026-05-23: nav items use Phosphor names `gauge`/`package`/`buildings`/`squares-four`/`star`/`chart-bar`/`envelope`/`upload-simple`/`gear-six`/`arrow-square-out`/`sign-out`) + 64px sticky topbar (still Lucide: Search/Bell/Plus/Menu/X + Sign-Out modal's LogOut). Sidebar Parts/Suppliers/Import badges are dynamic: demo mode → seeded magnitudes (`DEMO_BADGES` constant in `AdminLayout.tsx`), live mode → `adminApi.getStats()`. Bell + sidebar-Messages badges synced via `useEffect` on `location.pathname`. Pages render content area only. Admin chrome is intentionally un-themed (light surface).

### Claude Code Automations (`.claude/`)
- **Hooks** — PreToolUse blocks `.env`/lock edits, warns on `api/app/admin.py`, runs `migration-safety-check.sh` on commits. PostToolUse: tsc on .ts/.tsx/.scss; pytest on .py; ruff format+check on .py (excl. alembic); `scss-lint.sh`; `frontend-rebuild.sh` (flock-deduped).
- **Ruff** (`api/pyproject.toml`): line 100, py312, E/F/W/I/UP/B, ignores E501+B008, excludes `alembic/versions/`.
- **Agents** — `deploy-preflight`, `seo-auditor`, `visual-regression-guard`, `frontend-perf-auditor`, `theme-persistency-guard`.
- **Skills** — `seo-writer`, `/add-model-field`.
- **MCP** — `context7` (project), `chrome-devtools-mcp` + `playwright` (global).
- **HeroColorTuner** — dev-only IC-opacity tuner, gated `{import.meta.env.DEV && <HeroColorTuner />}` at App.tsx.

### Data flow
- Forms POST → API → `BackgroundTasks` → `email.send_*_notification` via aiosmtplib (Hover SMTP). n8n still in compose for future workflows but NOT in form path.
- Parts attach to subcategory in `seed.py` `_DEMO_CATALOG` (NOT top-level). Aggregates must roll up `own + sum(children)`.
- Parent-category "Popular Parts" rollup: `category_service._build_popular_parts(db, parent_id, page, per_page)` — `WHERE category_id IN (self + children)`, GROUP BY part, ORDER BY SUM(stock) DESC. URL `?p=N` paginates. `<Pagination>` widget at `@public/components/widgets/Pagination.tsx`. Default `POPULAR_PER_PAGE=12`.

## Key Patterns

### SCSS Modules
```scss
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;
@use '../../styles/animations';
```
Mixins in `_mixins.scss`: `container`, `card-base`, `hover-lift`, `responsive($bp)`, `gold-shimmer-border`, `skeleton-shimmer`, and (added 2026-05-29) `scrollbar-thin($height, $radius)` (thin custom scrollbar for overflow-x containers), `truncate` (single-line ellipsis with `min-width: 0` — works inside flex), `line-clamp($lines: 3)` (`-webkit-box` multi-line clamp). Used across PartsTable / SupplierTable / ReportsPage / SponsorBlock / TopPartners / CategoryPage / breadcrumb. Hoist new repeated literals here before they sprout four places.

### Framer Motion page transitions
```tsx
initial={{ opacity: 0, x: 20 }}
animate={{ opacity: 1, x: 0 }}
exit={{ opacity: 0, x: -20 }}
transition={{ duration: 0.15, ease: 'easeInOut' as const }}
```
PublicLayout is `<Suspense><Outlet/></Suspense>` — `AnimatePresence` at this level was REMOVED (left entering pages stuck at prior exit-state on second nav). Still appears in `keyword/index.tsx` for chip-stagger — local UI, don't reintroduce at layout level. **Navbar MUST be a sibling of `<Routes>` in App.tsx**, not inside a page — putting it inside a transforming ancestor causes sub-pixel text blur.

### Theme system
4 themes (`base`, `steel`, `schematic`, `pcb`) in `_themes.scss` as CSS custom properties on `[data-theme]`. **Steel is prod default** — `ThemeBridge.tsx` hardcodes `theme="steel"` in prod (URL params + localStorage ignored). Dev: URL `?nav=A|B|C` → `localStorage.circuits.nav.theme` → `DEFAULT_THEME`. `_themes.scss` requires `@use 'variables' as *;` at top so `#{$font-heading}` / `#{$font-mono}` interpolate for `--theme-brand-font`.

**Hero SVG cascade** — `CircuitTraces.module.scss` defines 6 CSS custom properties at the `.circuitTraces` ROOT (not per child — otherwise 140 paths × var() re-resolutions during 6s draw kill perf). Base theme has a carve-out restoring pre-refactor rgba + suppressing shared glow via `.traceGroup { filter: none; }`. **Apply SVG filter at a `<g>` wrapper, NEVER per-path** (140× cost). `<defs>` glow filter removed 2026-04-19 (mobile-lag cause). `<CircuitTraces variant="full" />` pinned to `'full'` everywhere.

**Edge-connector pattern in `CircuitTraces`** (CN1 left x28-58, CN2 right x1142-1172): pass-through connectors — dual-side pin rows (inner faces board, outer faces screen edge); board traces clipped to terminate at **inner pins** (NOT through the body); short outer stubs continue off-board to the screen edge (`M23 y H0` for CN1; `M1177 y H1200` for CN2). The 4 through-electrons fade invisible across the body via `<animate attributeName="fill-opacity" values="1;1;0;0;1;1" keyTimes={hideKeyTimes}>` synced (same `dur`/`begin`/`repeatCount`) to the sibling `<animateMotion>`. **keyTimes are arc-length fractions** of the path — `animateMotion`'s default `paced` calcMode makes time-fraction == length-fraction; the inner `0;0` pair must span the FULL body crossing `[f1, f2]` with a tiny fade JUST OUTSIDE (don't shrink the fully-hidden window inside the body or the electron is partially opaque while crossing it). Pin rows hoisted as `CN1_PINS` / `CN2_PINS` / `CN2_OUTER` / `CN1_HIDE` module-level consts above `ELECTRONS`. **viewBox `0 0 1200 400` with `preserveAspectRatio="xMidYMid slice"`** vertically crops in the rendered ~1521×420 box (top/bottom ~28px hidden) → a naïve screen→viewBox linear y-map is SKEWED; use `getScreenCTM()` round-trips or work in source coords (no group transforms, so trace `d` coords == viewBox coords).

HeroSection + PageHeaderBand are TRANSPARENT layout-only — band is a "window" onto the persistent backdrop. Pause wiring: `IntersectionObserver` + `visibilitychange` (`svg.pauseAnimations()` + `data-paused="true"`). `animationend` releases completed animations.

### API conventions
All routes prefixed `/api/` (router prefix). **`routes/forms.py` is `/api`, NOT `/api/forms`** — endpoints `POST /api/contact`, `/api/join`, `/api/keyword-request`. Frontend uses relative paths (`/api/...`). Part API surfaces full lineage: `part_to_dict()` returns `category_name`/`slug` + `parent_category_name`/`slug` (`| null` on top-level). Category API exposes siblings via `ParentCategoryResponse.children` (eager-loaded `lazy="selectin"`). `SubcategoryChips` is URL-driven, `aria-current="page"` on active.

### Contact page motif
Datasheet card — founders labeled U1/U2 (schematic designators), crop-mark corners, PCB grid bg (24px cells, $nav-blue @ 3.5%). Don't flatten.

### Navbar — pinned-edge layout
Brand (`left: 20px`) + nav+LOGIN group (`right: 20px`) are `position: absolute` on `.topStrip`. Search bar centered via `left: 50%; transform: translateX(-50%)`, hidden on `/`. Do NOT use Grid or `space-between` (breaks on narrow side-track content).

### Footer + ErrorBoundary + overflow guard (all site-wide)
- `<Footer />` mounted ONCE in `PublicLayout.tsx` (sibling of `<Outlet />`); layout flex column `min-height: calc(100vh - $nav-height)`; footer `margin-top: auto`. Don't import/render `<Footer />` in new pages. Theme-aware (`background: var(--theme-nav-bg)` + per-theme overrides).
- `<ErrorBoundary key={location.pathname}>` wraps Outlet (public) + Routes (admin) at `@shared/components/ErrorBoundary.tsx`. Pathname-keyed so error state auto-clears on nav.
- `html, body { overflow-x: clip }` in `global.scss`. Use `clip` NOT `hidden` (`clip` doesn't disturb `position: sticky` ancestors). Companion: `pages/category/CategoryPage.module.scss .contentWide { min-width: 0; width: 100% }` breaks the flex min-content chain.

### SPA scroll-to-top
`App.tsx`: `useEffect(() => { if (location.hash) return; window.scrollTo({top:0,left:0}); }, [location.pathname])`. Anchor nav preserved via `location.hash` skip.

### Seed data (idempotent)
15 categories, 75 subcategories (5 each, 2 levels), 7 suppliers, 2 sponsors, 59 parts/179 listings/193 revenue. `get_or_create_*` skips existing rows. `CATEGORY_DATA` (module-level in `seed.py`) holds canonical taxonomy — slugs are EXPLICIT per row (mirror `ui_kits/website/data.js`). Notably `motor-motion-ics` / `security-auth-ics` / `ldo-regulators` / `8bit-mcus` / `32bit-mcus` etc. don't match `slugify(name)` — `get_or_create_category(name, slug, ...)` requires the slug arg now.

## Gotchas

(Each is a recurring trap. Lines intentionally tight.)

- **TS strict** — remove unused vars, don't prefix `_`.
- **`?:` in TS catches only `undefined`, NOT `null`** — Python `None` → JSON `null` slips through `field?: number`. Use `field?: T | null` AND `!= null`; default with `??`.
- **`/admin` in prod = React SPA**, not SQLAdmin. Edit `frontend/src/admin/pages/`, not `app/admin.py`.
- **Adding a Supplier field requires 6 files**: model + alembic + Response/Create/Update + `to_dict` + TS type + List COLUMNS + FormPage. Use `/add-model-field`.
- **`SupplierResponse` + `CategoryResponse` are shared by public AND admin endpoints** — fields appear in unauthenticated routes. Use separate auth-gated endpoints for admin-only fields.
- **Full `docker compose up --build` thrashes even t3.small** — it rebuilds **n8n** (`build: ./n8n` → 313MB `n8nio/n8n` base re-extract), and a trailing `docker builder prune` makes it recurrent → deploy hangs extracting the n8n layer + live API times out (2026-05-28 outage). `deploy.sh` now scopes to `build api frontend` (never n8n) + drops the builder-prune. Recovery if it recurs: kill the deploy's orphaned `ssh …ec2…` process; hard thrash → stop+start the instance (not reboot). t3.micro OOMs — stay on t3.small.
- **Tests use SQLite via `Base.metadata.create_all`** — schema from models, not Alembic. SQLite ignores `String(N)` length AND CHECK constraints. For schema-length contracts assert on metadata: `Model.__table__.c.col.type.length >= N`.
- **`index.html` is served `no-cache`** (`frontend/nginx.conf` `location /`) so browsers always revalidate the unhashed SPA entry and pick up new hashed-asset names after a rebuild/deploy — prevents the stale-HTML→404→"failed to preload the CSS" bug (2026-05-28). Hashed assets stay `immutable`. A one-time hard-refresh (Ctrl/Cmd+Shift+R) only clears copies cached *before* this fix. Guard: `api/tests/test_nginx_cache_headers.py`.
- **Framer Motion v12 requires `as const` on ease**.
- **Sponsor XOR Postgres-only** (SQLite skips CHECK). Enforce client-side in SponsorFormPage `validate()` AND `buildSponsor()`. Never both fields set or both empty.
- **`global.scss` uses deprecated Sass `darken()`/`lighten()`** — new code uses `@use 'sass:color'` + `color.adjust()`.
- **Frontend Dockerfile has 4 stages** (base/dev/build/prod); compose defaults to `prod`. Container serves hashed Vite bundle via nginx, no HMR. SCSS/TSX edits need `docker compose up --build -d frontend` (~20s). For local HMR, add `target: dev`.
- **API container has `build: ./api` with NO volume mount** — same trap. Edits don't reach a running container via `restart`. Use `up -d --build api`. Symptom: seed reports success but data reflects OLD code.
- **`./deploy.sh --reseed` destructive scope** — TRUNCATEs `sponsors, category_suppliers, categories, suppliers CASCADE` → cascades to `users, parts, part_listings, price_breaks, revenue`. `messages` SURVIVES. Admin-UI rows outside seed.py ARE wiped.
- **Category slug changes need `--reseed`** — `get_or_create_category` keys on slug. Renaming a slug in `CATEGORY_DATA` (e.g. `motor-motion-control-ics` → `motor-motion-ics`) makes the new entry MISS the existing row → seed CREATEs a duplicate alongside the old one (30 top-level cats instead of 15). Plain `./deploy.sh` won't fix it — must `--reseed`.
- **Docker cache can serve stale frontend** — if behavior not visible: `docker compose build --no-cache frontend && docker compose up -d frontend`.
- **`sw.js` MUST NOT be cached immutable** — `frontend/nginx.conf`'s generic `~* \.(js|...)$` rule applies `Cache-Control: immutable, 1y` to ALL js, including the service worker. Browsers then never pick up new SW caching rules on deploy. Fix: exact-match `location = /sw.js` + `location = /registerSW.js` with `Cache-Control: no-cache` (exact match wins over regex regardless of order). 2026-05-27 deploy bug.
- **SW API caching: use `StaleWhileRevalidate`, NOT `NetworkFirst`** — NetworkFirst always waits for the network even when the SW has a fresh cached response, so EVERY category visit eats the full API latency (~1.1s on t3.small for the 500-part payload). SWR serves cache instantly (47ms) + revalidates in background. The 300s `maxAgeSeconds` bounds staleness after `--reseed`. 2026-05-27 perf bug.
- **Workbox `runtimeCaching` regex MUST allow the trailing slash** — `api.ts` requests `/api/categories/{slug}/?params` (trailing `/` before `?`, since axios paths end in `/`). A pattern like `/\/api\/categories(\/[^/?]+)?(\?.*)?$/` does NOT match that and the request silently falls through to the next rule (or NetworkFirst), so SWR never engages. Add `\/?` before the query group: `/\/api\/categories(\/[^/?]+)?\/?(\?.*)?$/`. Verify which cache a URL lands in: `caches.keys()` → open each → `cache.keys()`. 2026-05-28 bug — SWR looked deployed but never ran; the apparent speedup was just the HTTP `max-age` cache.
- **Don't put `setSearchParams` in a `useEffect` dep array** (React Router v7) — its identity changes when the URL changes, so an effect that "resets `?p` to page 1 on filter change" also fires on page change and deletes `?p` → pagination buttons appear dead (URL flips to `?p=2` then back to empty in ~30ms). Depend only on the actual filter values; the functional-update form `setSearchParams(prev => …)` needs no setter dep. `category/index.tsx` 2026-05-28 bug.
- **Non-ASCII glyphs in JSX text nodes get mangled to `\uXXXX` literal text** by the edit tooling — writing `>↗<` ends up as the 6-char string `↗` rendering literally. Use an HTML entity in the JSX text node (`&#8599;` → ↗, JSX decodes it) or a JS-string expression `{'↗'}` (the escape is evaluated). Verify with `od -c` on the line or check `el.textContent.codePointAt(0)` in the browser (want a single U+xxxx, not `U+5C` backslash). 2026-05-28 part-page icon bug.
- **Never animate CSS `drop-shadow()`** — scroll lag. Use static shadows.
- **SVG `<filter>` on `<g>` whose children animate = CPU raster on mobile** — `feGaussianBlur` was the 2026-04-19 lag cause. `@media (max-width: 768px) { .traceGroup { filter: none; } }`. Apply at `<g>` wrapper, NEVER per-path.
- **CSS `opacity: X` on an element OVERRIDES SMIL `<animate attributeName="opacity">`** — CSS property wins over SVG presentation-attribute animation; the animate fires (current value updates) but the element stays at the CSS opacity. Workaround: animate `fill-opacity` (or `stroke-opacity`) — CSS doesn't usually set those, and for fill-only elements `fill-opacity: 0` fully hides. Used by the electron-hide animation in `CircuitTraces` (`.electron { opacity: 0.9 }`).
- **`Node.contains(window)` THROWS** ("parameter 1 is not of type 'Node'"). Any scroll-close / outside-click guard that does `popoverRef.current?.contains(e.target as Node)` will throw when `e.target` is `window` (window-level scroll events). Always `e.target instanceof Node && popoverRef.current?.contains(e.target)`. ColumnHeader 2026-05-29 bug.
- **Framer Motion `whileHover` FIRES ON TOUCH** via Pointer Events hover synthesis — the element transforms on every tap (SponsorBlock had `whileHover={{ y: -3 }}` → card "jumped up" on phone tap, removed 2026-05-30). Don't use it on components whose primary interaction is touch-drag. For desktop-only hover-lift, gate via a CSS-only `@media (hover: hover)` rule.
- **`setPointerCapture` retargets `pointerup` (and the synthesized `click`) to the capture target** — taps on child `<a>`/`<button>` silently stop navigating. In any touch-capture handler on a container with interactive descendants, guard `if (e.target?.closest('a, button, [role="button"], input, textarea, select, label')) return;` before `setPointerCapture`. Verified to silently kill the sponsor CTAs on iOS Safari before the guard.
- **iOS Safari fires `pointercancel` (NOT `pointerleave`) under `setPointerCapture`** when a system gesture preempts (Control Center pull, incoming call, multi-finger). Listen for both, plus `pointerup` for touch as belt-and-braces, or `data-lit` (or equivalent state) sticks "true" and the visual freezes at the last finger position.
- **`touch-action: pan-y` on a touch-interactive surface CANCELS `pointermove` the moment the browser commits to a vertical scroll** — flashlight / drag-tracker stops mid-drag. Use `touch-action: none` for full-direction tracking (trade-off: element isn't a scroll surface — user scrolls by touching outside it). Reverted SponsorBlock `pan-y` → `none` 2026-05-30 per real-device test.
- **Sponsor `tier` is TitleCase from admin (`Featured`/`Platinum`/`Gold`/`Silver`) but lowercase from seed (`gold`/`silver`)** — the public type at `frontend/src/public/types/sponsor.ts` is `tier: string` (the `'gold'|'silver'|'bronze'` union was fiction). `SponsorBlock` lowercases `data-tier` so `[data-tier='gold|silver|platinum|featured']` selectors match either casing. Keep this normalization anywhere `sponsor.tier` is read.
- **Dev-only components gate at the CALL SITE** — `{import.meta.env.DEV && <X />}` at App.tsx mount. Don't `if (!DEV) return null` before hooks (Rules of Hooks).
- **ProxyHeadersMiddleware trusts all hosts** — required for admin HTTPS URL gen behind nginx. FastAPI 307-redirects missing-trailing-slash (`curl -L`; axios follows).
- **Adding a new hostname**: add to `server_name` in `nginx/nginx.ssl.conf` → on EC2 stop nginx → `sudo certbot certonly --standalone --expand --cert-name circuits.matthew-chirichella.com -d <every>` → start nginx. DNS must resolve first.
- **Cert dir is `circuits.matthew-chirichella.com`** even though `circuits.com` is primary (SAN match). Renaming is cosmetic + requires nginx path updates.
- **`./deploy.sh` (no flag) does NOT restart nginx** → 502 (stale upstream DNS). Always chase with `./deploy.sh --frontend`. **For frontend-only changes, `./deploy.sh --frontend` ALONE is sufficient** (rebuilds frontend container + restarts nginx + verifies the 3 domains) — skip the bare `./deploy.sh` so the API container isn't recreated for no reason and the `/api/*` 502 window is avoided. Run the `deploy-preflight` agent before every deploy.
- **nginx HTTP/2 requires `http2 on;`** — `listen 443 ssl;` alone gives HTTP/1.1 even on modern nginx. With ~18 critical-path resources, HTTP/1.1's 6-connection limit serialized everything and pushed the category-API fetch to ~419 ms (2026-05-30 LCP regression). All 3 SSL server blocks in `nginx/nginx.ssl.conf` carry `http2 on;`. Verify post-deploy with `curl -sI --http2 https://circuits.com/ -w '%{http_version}\n'` (want `2`). Browser may keep reporting `http/1.1` on cached resources for one session — that's `nextHopProtocol` reflecting the original fetch; truly fresh requests are h2.
- **Category-page early preload couples `frontend/index.html` ↔ `api.ts`** — the inline `<script>` in index.html fires the API fetch at HTML parse time on `/category/<slug>` loads, stashes the promise on `window.__categoryPreload`, and `api.getCategory` consumes it. **If you change the URL or per-page params for category fetches, change them in BOTH places** — a mismatch (URL or `popular_per_page=500` etc.) makes api.ts skip the preload and fire its own request → wasted origin call + the LCP regression returns. Pattern is direct-load only; SPA navigation falls through to axios (hover-prefetch + SW cache cover that path).
- **Deploying API changes → ~1-2 min of 502 on `/api/*`** — recreating the api container re-runs `alembic → seed → uvicorn` on boot, so `/api/*` 502s while it reseeds (HTML still serves 200). Transient — uvicorn comes up when seed finishes. Don't mistake it for a crash; check `./deploy.sh --status` + api logs (look for `Seeding database...`) before intervening.
- **`docker compose restart` does NOT re-evaluate `${VAR:-}` from `.env`** — env-only changes need `up -d --force-recreate <svc>`. Verify: `exec -T api python -c "from app.config import settings; print(...)"`.
- **`docker compose exec -T <svc> <cmd>` consumes stdin** of wrapping `ssh ... <<HEREDOC` — rest of heredoc never reaches remote. Always `... exec -T < /dev/null`.
- **Avoid `grid-template-columns: 1fr auto 1fr` with asymmetric side-track content** — `1fr` = `minmax(auto, 1fr)`. Use `position: absolute` on a relative parent.
- **Admin login creds (local dev)**: `matthew`/`mike`/`john` all password `admin` (seeded in `api/app/db/seed.py`, admin-user block). `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars are for SQLAdmin only (unreachable in prod).
- **Breakpoints in `_variables.scss`**: `$bp-mobile: 768px`, `$bp-tablet: 1024px`, `$bp-desktop: 1199px`, `$bp-admin-mobile: 820px`, `$bp-admin-compact: 420px`. Use `@include responsive(...)`.
- **Mobile drawer state-machine** (Navbar.tsx + AdminLayout.tsx): `useState(menuOpen)` + 3 effects on `[menuOpen]` — body-scroll-lock (capture+restore `prev`), Esc keydown (attach only while open), `[location.pathname]` for auto-close. Drawer link `onClick` calls `setMenuOpen(false)` BEFORE NavLink navigates. Compositor-only animations (transform+opacity).
- **Admin `<aside>` needs conditional `aria-hidden`**: `aria-hidden={!menuOpen ? undefined : false}` (no attr when closed, `"false"` when open). Public drawer's `aria-hidden={!menuOpen}` would set `"true"` at desktop where the admin sidebar IS visible.
- **`backdrop-filter: blur(2px)` on a full-viewport scrim is OK on mobile** when scrim only animates opacity. Don't add to elements that translate/scale.
- **Mobile data tables**: PartsTable uses `border-collapse: separate; border-spacing: 0` + 12px corner cell radii. `.tableWrap` is `overflow-x: auto` ALWAYS (not just mobile) — combined with the portaled ColumnHeader popover, the table scrolls within `.left` without bleeding under the sponsor sidebar. `min-width: 540px` at ≤1024px prevents column compression. Description column hides below **1450px** via `styles.hideDesc` (so all 4 price cols fit beside the 340px sponsor sidebar at common laptop widths); Category hides ≤768px via `styles.hideMobile`. Subcategory chips wrap at desktop (`flex-wrap: wrap`) and switch to 2-col grid on mobile.
- **ColumnHeader sort/filter popover is PORTALED to `document.body`** (`createPortal`) with `position: fixed`, viewport clamp, flip-above-if-no-room-below, close-on-scroll/resize, outside-click + Escape (restores focus to trigger). Two scroll-close guards: (1) `e.target instanceof Node` BEFORE `popoverRef.current.contains(e.target)` — `Node.contains(window)` throws otherwise; (2) skip if the scroll originated inside the popover's own `.filterList` so long manufacturer lists stay scrollable mid-interaction. Portal escapes the new `.tableWrap` overflow clip so the dropdown renders unclipped even when the table scrolls horizontally.
- **`border-collapse: separate` for rounded table corners** — `collapse` ignores `border-radius` on cells. Use `separate` + `border-spacing: 0` + radii on corner th/td. Trap: borders on `<tr>` no longer render — move `border-bottom` to `.td` with `.row:last-child &` override.
- **Buttons inherit `line-height: 1.6`** from body — overflows height-constrained rows. Fix: explicit `line-height: 1` + control height via padding.
- **Sub-pixel text blur from `transform: translate*(-50%)`** — fractional pixels + GPU layer = subpixel glyph raster. Use `top: 0; bottom: 0; display: flex; align-items: center`.
- **`filter: hue-rotate(0deg)` is NOT free** — promotes to compositor layer even at 0deg. Gate behind non-default themes.
- **URL-param-absent ≠ default-intent** — a default-button click that clears a URL param is shadowed by stale localStorage. Write the default to localStorage SYNCHRONOUSLY before `setParams`.
- **Inner-page surface-bg goes on a body WRAPPER inside motion.div, NOT on motion.div** — `<BackdropLayer />` (z-index: 0, top: $nav-height, height: 420px) needs visibility through the band on inner pages. motion.div has no bg; an inner `<div>` carries `background: var(--theme-surface-bg)`. PageHeaderBand + HeroSection are TRANSPARENT.
- **Don't reintroduce `AnimatePresence` around `<Suspense><Outlet/></Suspense>`** — FM12 leaves the second-nav entering motion.div stuck at the previous child's exit-state (both `mode="wait"` and `"popLayout"`).
- **`.outletWrap { position: relative; z-index: 1 }` is load-bearing** — without it, painting order puts BackdropLayer (z-index: 0) ON TOP of static page descendants.
- **Verify SVG persistence across SPA nav with session-marker pattern** — `svg.dataset.sessionMarker = 'tag-' + Date.now()` before NavLink click, then `evaluate_script` after. Stronger than visual diff.
- **Don't gate visible content on JS-added classes inside `AnimatePresence`** — IO callbacks fire unreliably mid-transform, leaving `opacity: 0` stuck. Default visible; trigger entrance via `setTimeout`.
- **Admin sponsors are API-backed** (was localStorage; flipped 2026-05-28, `4a40e7d`) — admin-authed CRUD at `GET/POST/PATCH/DELETE /api/admin/sponsors` (`routes/admin_sponsors.py`; schemas `AdminSponsor{Create,Response,Update}` in `schemas/sponsor.py`). `@admin/services/sponsorStore.ts` is now ASYNC over `adminApi` (`loadSponsors`→GET, `upsertSponsor`→POST/PATCH, `deleteSponsor`→DELETE, `findSponsor` fetches the list). Migration 010 added nullable `amount NUMERIC(10,2)` + `status VARCHAR(20)`. XOR (`category_id` vs `keyword`) is enforced **in Python in the router** (422) since SQLite ignores the CHECK. Form supplier/category `<select>`s pull REAL UUIDs from `adminApi.getSuppliers()/getCategories()` — the old fake `cat-*` seed ids are gone.
- **Sponsor lifecycle = write-side supersede + read-side status filter** (post-2026-05-30 rebuild) — `admin_sponsors._supersede_existing_for_category(db, category_id, exclude_id=None)` is called from BOTH POST `/api/admin/sponsors/` AND PATCH `/api/admin/sponsors/{id}` whenever `category_id` is set / changes. It flips any prior visible sponsor on the same category to `status='Expired'` (preserves the row for billing/audit). The public read in `category_service.get_category_detail` mirrors the same status predicate (`Active OR NULL`) so the banner picks a single deterministic sponsor and an admin marking a sponsor Expired actually takes the slot down. Newest-by-`created_at` still wins as the tiebreaker. `Paused` is preserved unchanged (deliberate lifecycle hold, not stale).
- **Sponsor.status filters MUST treat NULL as Active** — legacy seed sponsors (`db/seed.py:_get_or_create_sponsor`) omit `status`, leaving the column NULL. SQL three-valued logic: `status != 'Expired'` is UNKNOWN for NULL rows, so a naive filter silently SKIPS them (the supersede then leaves a legacy row Active alongside the new one). Use `or_(Sponsor.status == 'Active', Sponsor.status.is_(None))` everywhere — both the write-path supersede AND the public read. 2026-05-30 review-fix bug, surfaced by 5 independent finders on the original ship.
- **Admin sponsor form = 3-way segmented placement** (`'top-category' | 'subcategory' | 'keyword'`, post 2026-05-30) — replaces the prior flat `— `-prefixed dropdown that let a parent-meant sponsor silently land on a child. `topCategoryOptions` / `subcategoryOptions` (children labeled `${parent.name} → ${child.name}`) drive the focused select. The bucket on edit AND on create-with-prefill is derived ONCE from `form.category_id` against `topCategoryOptions` (`placementDerivedRef` one-shot guard). The ref MUST be reset on `id` change (separate `useEffect`) — otherwise cross-edit nav (`/admin/sponsors/A/edit` → `B/edit` on the same mounted form) leaves B at A's bucket. All 3 segment buttons go through one `choosePlacement(p)` helper that clears `form.category_id` + `form.keyword` AND the corresponding `errors.{category_id,keyword}` — diverging inline handlers were a documented footgun.
- **`routes/sponsors.py` + `routes/admin_sponsors.py` are symmetric `SponsorResponse` consumers** — the public keyword endpoint (`GET /api/sponsors/keyword/{kw}`) builds the response by hand and was missed when `email`/`contact_name` were added to `SponsorResponse` for the new `CategorySponsorBanner`. Pydantic silently defaulted them to `None` for every keyword sponsor (mirror of the "response_model silently strips computed attrs" gotcha, but inverted — additive schema + hand-rolled constructor). Any future field on `SponsorResponse` requires touching BOTH `routes/sponsors.py:get_sponsor_by_keyword` AND `services/category_service.get_category_detail`. Long-term: hoist to a single `serialize_sponsor(sponsor, supplier)` helper.
- **CategorySponsorBanner = parent-category sponsor surface** (shipped 2026-05-30, Concept A from design handoff v3 `category-sponsor/`) — full-width "Breakout Board" dark ENIG card rendered ABOVE the parts table in `category/index.tsx`, gated to `!loading && category && isParent && !activeSubInfo`. Identity block (medallion with `lettermark()` initials when no logo) left, 4 break-out pads right (Company / Contact / Phone / Email — P1-P4). Click-to-copy on phone+email via local `CopyChip` (timer-ref'd cleanup on unmount). CTA renders only when email OR website is present (don't fall back to `href="#"` — that scrolls the user to top on tap). Empty-state placeholder ALWAYS renders on parent pages so the open slot is discoverable. Data: `sponsor.{supplier_name,description,phone,email,contact_name}` — MVP equates supplier-level contact with the sales rep; future `Sponsor.rep_*` columns will split them. Sibling — NOT replacement — of `SponsorBlock` (which still owns the SUBCATEGORY sidebar slot). **Chrome stack** (z-order): `.substrate` (z=0, faint copper-dot grid, always painted, diagonal-mask fade) → `.reveal` (z=1, hidden routed copper SVG — 4 horizontal traces + 15 pads/holes, viewBox 1200×200 — under a `radial-gradient(circle var(--beam,150px) at var(--mx) var(--my))` CSS mask) + `.lamp` (z=1, warm gold `mix-blend-mode: screen` glow at the same point) → id+rail content (z=2) → fid+designator (z=4) → rim (z=5). Flashlight is **desktop-only**: `(hover: hover) and (pointer: fine) and !(prefers-reduced-motion)` gate via `matchMedia` + change listeners; touch/coarse-pointer gets `display: none` on `.reveal/.lamp` (substrate stays — mobile sees the texture, just no cursor reveal). Pointermove caches `getBoundingClientRect` on enter, invalidates on scroll/resize, rAF-locks the `--mx/--my` write so back-to-back moves coalesce. `data-lit` is set imperatively via `setAttribute` — no React re-render per frame. Inline contact-rep form state-machine from design Concept A is DEFERRED.
- **SponsorBlock = "backlit PCB" card with cursor/finger flashlight reveal** (shipped 2026-05-29 — sub-category sponsor card). Dark PCB substrate + CSS `radial-gradient` mask on `.reveal` (PCB component SVG) centered at `--mx --my` + screen-blend `.lamp` glow. Pointer Events unify mouse + touch: `pointerenter/move/leave` handle hover-flashlight on desktop AND finger-drag reveal on touch. **Touch specifics**: `.card { touch-action: none }` (full beam control — card isn't a scroll surface); `setPointerCapture` for non-mouse pointers BUT skip when `e.target.closest('a, button, [role="button"], input, textarea, select, label')` — capture otherwise retargets `pointerup`/`click` to the card and child CTAs silently stop navigating. Handlers: enter/move/leave + `pointerdown` (capture) + `pointercancel` + `pointerup` (touch/pen — iOS Safari fires `pointercancel` not `pointerleave` under capture). Seed `--mx/--my` SYNCHRONOUSLY in `onEnter` so tap-without-move shows the beam immediately. `.reveal/.lamp` are `visibility: hidden` at rest (delayed visibility transition on exit) so the compositor skips them when not lit. `role="region" aria-label="Featured sponsor|Open sponsor slot"` on the card root; `.content` re-enables `user-select: text` so phone/desc/name stay copyable. Per-tier `--accent` via `[data-tier='gold|silver|platinum|featured']` — `data-tier` is **lowercased in TSX** because admin emits TitleCase, seed lowercase. **NO `whileHover`** on the motion.div: Framer Motion fires it on touch → card jumps on tap. `mask-composite` rim gated behind `@supports` so engines without it lose the rim rather than paint an opaque rectangle over content. **PCB art SVG uses `preserveAspectRatio="xMidYMid meet"`** (NOT `slice`) — the card is landscape on every viewport (mobile 358×259 aspect 1.38, desktop sidebar 340×259 aspect 1.31) but the artwork viewBox is portrait `0 0 300 360` (aspect 0.83); `slice` forced the SVG to fill width, overflowing ~85px above and below the card. Even with `overflow: hidden` clipping it visually, on mobile touch interaction the user perceived "circuit larger than PCB" and content "jumping up/left" (2026-05-30 bug `c0ae2e8`). `meet` centers the art inside the card at the smaller dimension and lets the always-visible `.substrate` dot grid + `.lamp` glow fill the empty edges — the beam still illuminates substrate-only zones intentionally.
- **State-dep effect + async fetch needs cancel-flag** — pattern: `useEffect` keyed on a toggle (e.g. `[demoMode]`) firing `fetch()`. A late response can stomp the new synchronous state. Always `let cancelled = false; ...; return () => { cancelled = true; };` and gate `.then`/`.catch` on `if (cancelled) return;`. AdminLayout's badge fetch is the canonical example.
- **`--a-blue` / `--a-purple` admin-scope tokens** — `AdminLayout.module.scss .admin` defines blue (`#2563eb`) + purple (`#7c3aed`) for Dashboard sparklines. Pass to React as `color="var(--a-blue)"`, NEVER inline hex (palette variants).
- **Admin Supplier tier derived client-side** — `AdminSupplier` has no `tier` column. `SuppliersPage` derives Featured (≥200) / Platinum (≥100) / Gold (≥25) / Silver (else) from `parts_count`.
- **Theme/route bug repro via SPA NavLink, NOT direct URL** — direct URL remounts everything.
- **`dict(query(Col1, Col2).all())` mis-types under Pyright** — use `{row[0]: row[1] for row in query.all()}`.
- **Parts→category attachment differs between seeds** — `conftest.py` attaches to subcategory (`child.id`); `db/seed.py` attaches to top-level (`matching_cat.id`). Aggregates must roll up `own + sum(children)`.
- **Branch workflow (post v7)**: `master` = deploy tip, `updates` = active dev. Sequence: commit on `updates` → push → `git checkout master && git merge --ff-only updates && git push origin master` → `./deploy.sh && ./deploy.sh --frontend` → `git checkout updates`. No squash; ff-only keeps history linear and avoids phantom conflicts.
- **`<input type="url|email|tel>` silently kills form submit** for HTML5-invalid values — browser refuses to fire `submit`, React `onSubmit` never runs, no `:invalid` styling visible, no console error. 2026-05-24 supplier-create bug. Use `type="text"` + `inputMode="url"` + JS validation + `noValidate` on form. Regression guard: `api/tests/test_no_type_url_form_input.py` scans `frontend/src/{admin,public}/**/*.tsx`.
- **`prependScheme` must be RFC-3986-aware** — naive `if (!startsWith('http'))` produces `https:////acme.com` (protocol-relative) or `https://mailto:…`. Use `^[a-z][a-z0-9+.-]*:` OR `^//` to skip already-schemed. See `SupplierFormPage.prependScheme`.
- **Phone formatter country-code paste** — `+1 (800) 555-0142` → `(180) 055-5014` if you just strip non-digits + slice(0,10). Strip leading `1` when input is 11 digits starting with `1`. See `SupplierFormPage.formatPhoneInput`.
- **Empty SCSS rule → undefined CSS module class** — `.foo {}` with just a comment makes `styles.foo === undefined`. Always include ≥1 declaration. Symptom: className renders as `_panel_xxx undefined`, selector `[class*="foo"]` misses.
- **CSS Modules can't host BEM `--`** — `qa-card--primary` becomes invalid. Use camelCase (`qaCardPrimary`) and compose at the call site: `${styles.qaCard} ${styles.qaCardPrimary}`.
- **Supplier-detail panel stretch (Grid+Flex two-tier)** — `.detailGrid { align-items: stretch }` (Grid default) makes outer panel chrome match the tallest column; inner `.panel { display: flex; flex-direction: column }` + `.panelBody { flex: 1 }` makes Description content backfill the new height. Sidebar opts out via `align-self: start` so mini-stats stay natural size.
- **Quick Actions hero strip lives at `pages/suppliers/detail/QuickActionsPanel.tsx`** — full-width 4-card grid directly below page head. Filled-color variants `qaCardPrimary` (green) / `qaCardBlue` / `qaCardGold` / `qaCardPurple` map to workflow categories (catalog/data/revenue/ops). Replaces both sidebar list AND the header "Add Part" button.
- **Prefill bus at `@admin/services/prefillBus.ts`** — typed module-singleton with one-shot `consumePrefill(kind)`. Survives SPA nav (module memory), dies on full reload. Used by Quick Actions to seed PartFormPage/SponsorFormPage/ImportPage initial state. Destination forms read in `useState(() => consumePrefill('part'))` lazy initializer so back-nav doesn't re-apply.
- **`POST /api/parts/` atomic create** — `body.initial_listing: { supplier_id, stock_quantity, unit_price } | null` creates Part + PartListing in one transaction. Used by Supplier-detail "Add Part" flow. Unknown supplier_id → rollback + 404.
- **`Part.sub_slug` auto-derive** — `create_part` stamps `sub_slug = child.slug` when `category_id` resolves to a Category with `parent_id IS NOT NULL` and caller didn't provide one. Keeps denormalization consistent across CSV/admin/API creates. Alembic 006 backfills existing rows via UPDATE-FROM JOIN (PostgreSQL-only; SQLite tests use `create_all` and skip the migration).
- **`featured_supplier_name` batch-query pattern** — `category_service.get_all_categories` does a single JOIN on CategorySupplier WHERE is_featured=true, ORDER BY rank DESC, then dict-comprehension last-write semantics → lowest-rank wins. No N+1. Mirror this for any future denormalized "winner across N rows" surfacing.
- **chrome-devtools-mcp programmatic form-fill** — React controlled inputs need the native value setter: `Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v)` then `el.dispatchEvent(new Event('input', {bubbles: true}))`. Setting `el.value = v` directly is ignored by React 18+. For silent-submit-block triage: attach `document.addEventListener('submit', ..., true)` BEFORE the click; if `click` fires but `submit` doesn't, suspect HTML5 constraint validation.
- **chrome-devtools-mcp `click(uid)` may not trigger React Router** on `<Link>` — for SPA-nav tests, use `evaluate_script` + `document.querySelector(...).click()`.
- **chrome-devtools-mcp looping (theme × route)**: open ONE page + `navigate_page`, NOT `new_page` per cell.
- **Source-line grep undercounts JSX rendered DOM** — `.map()` multiplies (CircuitTraces: 54 source `<rect>` → 193 rendered).
- **Structural-rename: grep `import.*\.scss` in TS/TSX**, not just `@use` in SCSS — side-effect SCSS imports (`main.tsx`'s `import './styles/global.scss'`) bypass `@use` readers.
- **Tree-row `1fr auto auto` jams slug behind name on long titles** — promote children to `repeat(auto-fill, minmax(220px, 1fr))` tiles.
- **Deleting a Supplier cascades through 6 surfaces** — `DELETE /api/suppliers/{id}` removes PriceBreak → PartListing → Sponsor (NOT NULL FK, can't NULL) → CategorySupplier → Revenue, NULLs `User.supplier_id`, then deletes. Order matters. Mirrors `delete_part` in `routes/parts.py`.
- **Bulk `query(...).delete()` + `lazy="selectin"` → `Dependency rule tried to blank-out primary key`** on parent delete. Fix: `db.expire(parent)` between bulk-deletes and `db.delete(parent)`.
- **`response_model=SchemaX` silently strips computed attrs not on schema** — stamping `obj.parts_count = N` works locally; Pydantic's `from_attributes=True` drops it. Symptom: list endpoint zeros, detail (dict) real values. Fix: drop `response_model=` or add the field with default.
- **SMTP creds in `/opt/circuits-com/.env` on prod EC2** (not committed): `SMTP_HOST=mail.hover.com`, `SMTP_PORT=587`, `SMTP_USERNAME=no-reply@circuits.com`, `SMTP_PASSWORD=...`. Without `SMTP_HOST`, `email._smtp_send` runs in demo mode. `NOTIFY_RECIPIENTS` accepts JSON or CSV.
- **n8n no longer in form path** — `routes/forms.py` uses aiosmtplib + Hover SMTP via FastAPI BackgroundTasks.
- **Pyright "Import app.services.email could not be resolved" is a false positive** (stdlib `email` shadows). Runtime fine.
- **ANY accent-colored text on a light card uses `var(--executive-blue)`** — `var(--theme-accent)` + `var(--theme-cta-bg)` fail WCAG-AA. Borders + chip backgrounds can keep `var(--theme-accent)`. `var(--fg2)` (#6b7280) passes on white (4.85:1) but fails on `var(--surface)` #eef1f5 (4.07:1). **Exception**: `/keyword` uses `var(--theme-accent)` for section-num + tier price per v2 design parity (a11y 91/100 documented).
- **Test fixtures must NOT pair a real-looking SMTP host with `SMTP_PASSWORD`** — GitGuardian pattern-matches host+user+password proximity. Use RFC 6761 reserved TLDs (`.invalid`/`.test`/`.example`) for hosts AND emails. Regression: `api/tests/test_no_smtp_credential_lookalikes.py`.
- **`EmailStr` rejects RFC 6761 reserved TLDs** — smoke tests need real-looking TLDs (`.com`/`.io`). Use `smoke-test+verify@circuits.com` (plus-tag self-route) for POSTs against `EmailStr` fields.
- **Claude Design handoffs are 4.2MB gzip** via `https://api.anthropic.com/v1/design/h/<hash>` — `WebFetch` saves to `<tmpdir>/tool-results/webfetch-*.bin`. Extract `tar -xzf <path>.bin -C design-handoff[-vN]/`. Versioned dirs gitignored.
- **Guided-tour wizard at `@admin/wizard/`** — Apple-style FAB + spotlight + 7 walkthroughs (`add-supplier`/`add-part-to-supplier`/`import-csv`/`add-sponsorship`/`reply-message`/`import-queue`/`add-part-general`). Mounts as sibling of `<Outlet/>` in AdminLayout so it gets React Router context for free. Anchors via `data-tour="..."` on JSX elements + `data-field="..."` on form wrappers + literal `[data-modal="confirm-delete"]` + `[data-modal-confirm="true"]` for hash-safe delete modal polling. Regression guard: `api/tests/test_wizard_data_anchors.py`.
- **Wizard `useAdvance` MUST keep route + polling effects separate** — route-based advance re-keys on `[stepKey, currentRoute]` and fires immediately (user just clicked the spotlighted nav link, expects instant feedback). Polling kinds (value/predicate/modal) keep a 450ms grace window guarding against stale-DOM false-positives from the previous step. DO NOT combine — the design's original wizard.jsx had one shared grace window and Step 1→2 hung when the user clicked too fast (handoff explicitly flagged this bug).
- **Wizard mobile-drawer auto-open** — sidebar is a slide-in drawer at viewports < 820px (`$bp-admin-mobile`). When the wizard spotlights a `[data-tour="side-*"]` anchor on mobile, `Spotlight.tsx` checks `sidebar.getBoundingClientRect().left < 0` and clicks `[data-tour="open-mobile-menu"]` to slide it in. Drawer closes itself on route change via AdminLayout's `location.pathname` effect — no symmetric close step needed.
- **Auto-feature endpoint `POST /api/admin/category-suppliers/feature`** — feature-only by design (no unfeature variant). Wizard's add-supplier "see it live" preview step POSTs `{supplier_id, category_slug, rank}` so the demo supplier shows up in the public Featured slot before the iframe loads. Cleanup is automatic — supplier-delete cascades the CategorySupplier row away. Idempotent upsert (re-feature OK).
- **Pattern-guard test for wizard anchors** — `api/tests/test_wizard_data_anchors.py` scans admin TSX for `data-tour="X"` literals AND `tour: 'X'` config-object props (SidebarLink uses dynamic `data-tour={link.tour}`). EXCLUDES `flows.tsx` because that file uses the same syntax inside CSS-selector strings (`querySelector('[data-tour="X"]')`) and would produce false positives.
- **Wizard `__auto_select__` for `<select>` fields** — category_id and other UUID-based selects can't have hardcoded `suggested` values. Use `suggested: '__auto_select__'` — `handleAutofill` picks the first non-empty `<option>`. Every form field targeted by a wizard step needs a `data-field="name"` wrapper div.
- **Wizard Next button clicks the spotlighted element** — CoachCard's Next handler: (1) `suggested` exists → `onAutofill`; (2) no suggested + has selector → programmatic `.click()` on the target (handles nav links, submit buttons, delete); (3) fallback → `onNext()`. Never renders "Skip".
- **Wizard demo entity cleanup via localStorage** — `demoCleanup.ts` tracks created supplier/part UUIDs in `wiz-demo-supplier`/`wiz-demo-part`. Fires on `exitFlow()` + `startFlow()`. Best-effort API delete (404/401 swallowed). `clearDemoEntity()` on normal flow completion prevents wasted 404 on next start.

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

Public + admin both render Phosphor Light data icons via `<Icon name={x.icon} />` at `@shared/components/Icon.tsx` (regex guard `/^[a-z][a-z0-9-]*$/` no-ops on non-Phosphor strings). Font self-hosted at `frontend/public/fonts/phosphor-light/` (CSS + woff2/woff/ttf, ~1.2MB), loaded once in `frontend/index.html`. Admin **sidebar nav** uses Phosphor (v5 2026-05-23); topbar controls (Search/Bell/Plus/Menu) stay Lucide.

Names live in `api/app/db/seed.py` (15 + 75 = 90 strings). New category: kebab-case Phosphor name from https://phosphoricons.com — no `ph-` prefix. `Category.icon` is `String(40)` (alembic 005); regression `test_category_icon_column_holds_phosphor_name_length` asserts column metadata length ≥24 (SQLite ignores VARCHAR len; metadata assertion is dialect-agnostic).

**Don't render `{x.icon}` as a raw text-node** — it'll display the literal name ("battery-charging") instead of a glyph. Pre-commit guard:
```bash
grep -rn ">{[a-zA-Z_]*\.icon}<\|>{[a-zA-Z_]*\.category_icon}<" frontend/src --include="*.tsx"
# Empty = clean. Sweep frontend/src (not just /public) — admin renders icons too.
```
`<option>` labels are HTML-text-only — drop any `${cat.icon}` prefix. When debugging icon rendering, screenshot — `getComputedStyle().content` is empty `""` for Phosphor's PUA glyphs (U+E000–F8FF) in Chromium serializer even though the glyph paints correctly.
