# Circuits.com

Electronic components directory prototype — Vite React SPA + FastAPI + PostgreSQL + n8n, all in Docker.

## Prerequisites

- Docker & Docker Compose
- Python >= 3.12 (for local API dev)
- Node.js (for local frontend dev)

## Commands

### Development
```bash
docker compose up --build          # Start all 5 services (db, api, frontend, n8n, nginx)
docker compose down -v             # Stop and remove volumes
```

### Visual baselines (from /)
```bash
# Baselines at tests/visual/baselines/ — captured via chrome-devtools-mcp,
# 4 PNGs (one per theme at desktop viewport). Refresh when theme visuals
# change by navigating each URL (?nav=A|B|C|(none)) and using the MCP
# take_screenshot tool, saving into tests/visual/baselines/<theme>-post-<taskN>.png.
```
> No pytest suite — verification is agent-driven via chrome-devtools-mcp.

### API (from api/)
```bash
cd api && pip install -e ".[dev]"  # Install deps locally
pytest tests/ -v                   # Run all tests (SQLite in-memory, ~108 tests)
pytest tests/test_categories.py -v # Run single test file
alembic upgrade head               # Run migrations
python -m app.db.seed              # Seed database (idempotent)
```

### Frontend (from frontend/)
```bash
cd frontend && npm install         # Install deps
npm run dev                        # Vite dev server on :3000
npm run build                      # Production build
npx tsc --noEmit                   # Type check
```

### Deployment
```bash
./deploy.sh                # Full deploy (backend + frontend + n8n) — must chase with --frontend (nginx)
./deploy.sh --frontend     # Frontend-only: rebuilds frontend container + restarts nginx in ONE step.
                           # USE THIS for any commit that only touches frontend/** (no api/, no compose changes).
./deploy.sh --reseed       # Full deploy + clear & reseed DB
./deploy.sh --status       # Check container status
./deploy.sh --logs         # Tail container logs
./deploy.sh --cert-renew   # Renew Let's Encrypt certificate
```
> Requires: AWS CLI configured, SSH key at ~/.ssh/id_ed25519, changes committed and pushed. Uses EC2 Instance Connect (no VPN needed; ephemeral key has ~60s window so push+ssh runs as one command).
> Production: t3.small EC2 (`i-0d456bd12719e2176`) with Elastic IP `100.55.235.167` (permanent across stop/start). Migrations + seed run automatically on api container startup via `docker-compose.prod.yml` entrypoint.
> Domains: `circuits.com` is primary (John owns via Hover — A record `@` → EIP). `www.circuits.com` and legacy `circuits.matthew-chirichella.com` both 301 to apex. One Let's Encrypt SAN cert covers all three names; on-disk path is `/etc/letsencrypt/live/circuits.matthew-chirichella.com/` (kept via `--cert-name` during expand). Cert auto-renews via certbot systemd timer.

> No ESLint or Prettier configured. TypeScript strict mode (`noUnusedLocals`, `noUnusedParameters`) is the only static analysis. Frontend has no tests — only the API has a pytest suite.

## Architecture

5 Docker containers orchestrated by docker-compose.yml:

```
Browser → Nginx(:80/:443)
  ├── /        → Frontend(:3000) — Vite React SPA
  ├── /api/*   → API(:8000)     — FastAPI
  └── /admin*  → Frontend(:3000) — React admin SPA (in prod nginx)
                    ↕
              PostgreSQL(:5432)
                    ↕
                n8n(:5678)       — Workflow automation
```
> SQLAdmin still exists in `api/app/admin.py` and mounts at `/admin` on the API,
> but is unreachable in prod since nginx routes `/admin` → frontend. Local dev only.

### API (api/)
- FastAPI app in `app/main.py`, mounts 5 routers (categories, suppliers, search, forms, sponsors)
- Models: Category (self-referential tree), Supplier, CategorySupplier (join), Sponsor (XOR constraint: category_id OR keyword)
- Services layer: `category_service.py`, `search_service.py`, `email.py` (aiosmtplib + Hover SMTP, demo-mode-aware, called from `routes/forms.py` BackgroundTasks)
- SQLAdmin panel mounted at `/admin` on the API (only reachable in local dev — nginx routes `/admin` → frontend in prod)
- **Real prod admin** lives in `frontend/src/admin/pages/` (React SPA): suppliers/{list,form,detail}, parts/{list,form,detail}, sponsors/{list,form}, messages/{list,detail}, dashboard, categories, reports, settings, import
- React admin auth: JWT in `localStorage.admin_token` via `frontend/src/admin/services/adminApi.ts`; SQLAdmin auth (dev only): session via `AdminAuth` in `app/admin.py`
- Config via pydantic-settings: `DATABASE_URL`, `N8N_WEBHOOK_BASE_URL`, `CORS_ORIGINS`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_SECRET_KEY`
- Entrypoint runs: alembic migrate → seed → uvicorn

### Frontend (frontend/)
- React 19 + TypeScript + Vite + SCSS Modules + Framer Motion. **Bounded-context structure** (post-2026-05-03 restructure):
  - `src/public/` — public site: page bundles in `pages/<name>/`, chrome in `components/layout/`, reusable widgets in `components/widgets/` (CircuitTraces, GlowButton, AnimatedLink, SkeletonLoader, HeroColorTuner); `hooks/`, `services/api.ts`, `types/`
  - `src/admin/` — admin SPA: standalone pages under `pages/<name>/`, CRUD bundles under `pages/<entity>/{list,form,detail}/` (Plan B nesting); messages inbox + type-branched detail in `pages/messages/`; chrome in `components/`, messages widgets in `components/messages/`; `services/adminApi.ts` + `sponsorStore.ts` + `messageStore.ts` (API-backed via `/api/admin/messages` w/ sync-read cache + async refresh — Phase 4 swap from localStorage seed on 2026-05-14); `types/admin.ts` + `types/messages.ts`
  - `src/shared/` — cross-scope only: `styles/{_themes,_variables,_mixins,_animations,global}.scss`; `services/constants.ts` (exports `API_BASE_URL`, used by both `api.ts` and `adminApi.ts`); `components/ErrorBoundary.tsx` (site-wide render-crash safety net — see Key Patterns). The **≥2-consumer rule** applies: only add a component here if BOTH public and admin import it.
- **Per-scope path aliases** (`vite.config.ts` + `tsconfig.app.json`): `@public/*`, `@admin/*`, `@shared/*`. The pre-2026-05-03 unused `@/*` alias was removed.
- **ESLint boundary enforcement** (`frontend/.eslintrc.json`, `eslint-plugin-import` v8): admin/ may not import `@public/*`; public/ may not import `@admin/*`; shared/ may not import either. Run `cd frontend && npx eslint src/` (exit 0 = clean).
- **Customer portal forecast**: `UserInfo.role: 'admin' | 'company'` + `supplier_id?: string` already exist in `admin/types/admin.ts`. When the customer-portal SPA lands, mirror `admin/`'s structure as `src/portal/` with `@portal/*` alias. Chrome in `admin/components/` may migrate to `shared/components/` per ≥2-consumer rule.
- **All routes except `HomePage` lazy-load** via `React.lazy()` with alias-path strings (e.g., `lazy(() => import("@public/pages/category"))`). Public routes nest under `<Route element={<PublicLayout />}>` — thin `<Suspense><Outlet/></Suspense>` in `.outletWrap { position: relative; z-index: 1 }` stacks pages above persistent `<BackdropLayer />` at z-index: 0. Each page owns its own motion.div entrance — no AnimatePresence at the layout level. Persistent `<CircuitTraces />` lives inside `<BackdropLayer />` mounted ABOVE `<Routes>` — single instance, never remounts. Admin routes use a separate Suspense boundary. Main bundle ~277 KB; heavy vendor deps split via `build.rollupOptions.output.manualChunks`. Keep Home eager for LCP.
- **`lucide-react`** powers admin chrome (sidebar + topbar) — public site still uses emoji for category/glyph slots.
- **No charting library** — `DashboardPage` and `ReportsPage` inline native SVG (`Sparkline`, `RevenueChart`/`RevenueDonut`, `SponsorRing`, `HBarChart`). Recharts was removed 2026-04-25 (saved ~400 KB + 40 transitive packages); do NOT reintroduce.
- **Dependency graph**: `docs/architecture/dependency-graph.dot` (render via `dot -Tsvg` if Graphviz installed). 71 src files / 256 import edges across the 3 scopes; only 1 file in `shared/` proves the bounded contexts genuinely don't overlap.
- **Adding a new public page**: create `src/public/pages/<name>/{index.tsx, <Name>Page.module.scss}`; add `lazy(() => import("@public/pages/<name>"))` to App.tsx; add `<Route path="/<name>" ...>` inside the public Routes block. **Inner pages should use `<PageHeaderBand page="X" title="..." subtitle="..." />` as the top element** for the standard dark hero band (`REV-A · /X` tag + white H1 + subtitle on the BackdropLayer PCB). About/Join/Contact/Privacy/NotFound/Keyword all use this — DO NOT invent a one-off header treatment. Home is the exception (its own HeroSection). **One component can serve multiple routes** — `/privacy` and `/terms` both render `PrivacyPage` (two `<Route>` entries pointing at the same lazy import); use this pattern when distinct URLs should share content. For doc-style pages with anchored sections, namespace the DOM ids (e.g. `id="privacy-scope"`, not `id="scope"`) to avoid SPA-wide collision, and use `scrollIntoView({ behavior: "smooth", block: "start" })` + `scroll-margin-top: 100px` in the SCSS as the single source of truth for the anchor-landing offset (don't compute scroll-Y manually).
- **Adding a new admin entity-CRUD set**: create `src/admin/pages/<entity>/{list, form, detail}/index.tsx` (3 sibling pages); add 3 lazy imports + 4 `<Route>` entries (`/<entity>`, `/<entity>/new`, `/<entity>/:id`, `/<entity>/:id/edit`).
- **`/keyword` (landing) vs `/keyword/:keyword` (detail)** (Wave 2, shipped 2026-05-14; v2 design parity 2026-05-16): no-slug `/keyword` is the in-site discoverability surface (datasheet motif, 6 sections — **01 availability check / 02 spec card / 03 IC chip pin-out / 04 tiers / 05 FAQ / 06 closing CTA** — lives at `pages/keyword-landing/` w/ sub-components `AvailabilityCheck`, `HowItWorksChip`, `SponsorFAQ`). The slug route `/keyword/:keyword` is the sponsor profile or "available" state (`pages/keyword/`). Both reuse the extracted `<RequestModal>` widget at `components/widgets/RequestModal.tsx` — don't inline modal logic back. Tier prices ($99/$299/$899) + FAQ copy are PLACEHOLDERS in `keyword-landing/constants.ts` pending product/sales sign-off. **Section 01 (availability) sits OUTSIDE `.sponsorPageBody`** so the BackdropLayer's PCB traces show through behind the smaller top section — preserves the local PCB signature; the bigger spec card (02+) lives inside the body wrapper. ALL tier buttons use the primary variant + uniform "Choose {Name}" label — Gold is distinguished by the ★ MOST CHOSEN ribbon + soft outer ring, NOT a different button style.
- **Phase 4 form-message persistence** (shipped 2026-05-14): `routes/forms.py` handlers write a `Message` row to Postgres (model `app/models/message.py`, alembic 004) BEFORE scheduling email via `BackgroundTasks`. Admin Messages page is API-backed via `GET /api/admin/messages/` + `PATCH /api/admin/messages/{id}`. Bell badge unread count derives from cache. `messageStore.ts` keeps sync signatures so consumer pages don't break; `refreshMessages()` is called on mount + on route change.

### Admin layout (`frontend/src/admin/components/AdminLayout.tsx`)
Owns the 240px Lucide-iconed sidebar (Catalog: Dashboard / Parts / Suppliers / Categories / Sponsors / Reports — **Communications: Messages** with live unread badge — System: Import Queue / Settings) + 64px sticky topbar (collapsible search w/ ⌘K + Demo Data toggle pill + **Notifications bell with counted red badge + 380px dropdown** + "+ New Part" CTA + Sign-Out confirm modal). Bell-badge + sidebar-Messages-badge stay synced via a `useEffect` keyed on `location.pathname` that re-reads `unreadCount()` after every route change. Page components render the content area ONLY — never their own sidebar/topbar. The Demo Data toggle lives in the topbar — `<DemoToggle />` is NO LONGER rendered separately in `App.tsx` (was floating bottom-right pre-2026-04-25). Admin scope is intentionally un-themed (light surface, DM Sans chrome) per `reference_theme_system` memory.

### Claude Code Automations (.claude/)
- **Hooks** (settings.json):
  - **PreToolUse**: blocks `.env`/lock edits, warns on `api/app/admin.py` (SQLAdmin ≠ prod admin), and — on every `Bash` tool call — runs `migration-safety-check.sh` to `ask` for confirmation when a `git commit` includes a new `api/alembic/versions/*.py` file with no matching `api/app/models/*.py` change in the same commit (catches drifted `--autogenerate` runs)
  - **PostToolUse**: (1) `tsc --noEmit` on .ts/.tsx/.scss edits, (2) `pytest` on .py edits, (3) **`ruff format` + `ruff check --fix`** on .py edits (excluding alembic/versions — autogenerated), (4) `scss-lint.sh` (CLAUDE.md gotcha grep — 10 anti-patterns from this list, non-blocking warnings), (5) `frontend-rebuild.sh` (background-detached `docker compose up -d --build frontend` on SCSS/TSX edits; flock-deduped so rapid edits coalesce)
- **Scripts** (`.claude/scripts/`): `scss-lint.sh`, `frontend-rebuild.sh`, `migration-safety-check.sh` — chmod'd executable, called from hooks
- **Ruff config** lives in `api/pyproject.toml` `[tool.ruff]`: line-length 100, target py312, selects E/F/W/I/UP/B, ignores E501 + B008 (FastAPI's `Depends()` pattern uses function-call defaults). Excludes `alembic/versions/*.py` (autogenerated). Install via `cd api && pip install -e ".[dev]"` (ruff>=0.8.0 is now in dev deps).
- **Agents**: `deploy-preflight` (instance size/git/DNS/disk check before deploy), `seo-auditor` (meta/schema.org/crawlability), `visual-regression-guard` (screenshots 4 themes × 2 viewports, diffs against `tests/visual/baselines/` with ImageMagick `compare`; flags drift ≥1% of pixels — invoke after SCSS/component/theme changes), `frontend-perf-auditor` (Lighthouse + rAF frame sampling + `LongAnimationFrame` detection on steel+mobile — catches 2026-04-19-class SVG-filter regressions before ship), `theme-persistency-guard` (navigates every public route at every alt theme, verifies `--theme-*` tokens resolve and hero backdrops render correctly on ALL 8 pages — catches the cross-page theme-gap bug class; also audits per-page DOM count + JS/CSS/image byte budgets for resource regressions)
- **Skills**: `seo-writer` (title/meta/OG/JSON-LD bundles), `/add-model-field` (scaffolds the 6-file chain for adding a SQLAlchemy model field end-to-end: model + Alembic migration + Pydantic Response/Create/Update + `to_dict` + `types/admin.ts` + `<Model>sPage` + `<Model>FormPage` — with the `admin_only` flag to keep sensitive fields off public `<Model>Response`)
- **MCP servers** (project-scope): `context7` (live docs lookup for React 19 / Framer Motion 12 / Vite 6 / FastAPI / SQLAlchemy — preempts training-data drift on bleeding-edge library APIs); plus globally-installed `chrome-devtools-mcp` and `playwright`
- **HeroColorTuner** (`frontend/src/public/components/widgets/HeroColorTuner.tsx`) — dev-only floating slider panel (bottom-right) gated by `import.meta.env.DEV`. Lets you tune the 3 IC opacity tokens (`--ic-body-fill`, `--ic-body-stroke`, `--ic-pad-fill`) live and read off `color-mix()` strings to paste into SCSS. Persists to `localStorage.circuits.tuner.*`. Does NOT render in prod (returns `null`).

### Data Flow
- Categories use self-referential `parent_id` for tree structure (2 levels deep)
- `CategorySupplier` join table links suppliers to categories with `is_featured` + `rank`
- Sponsors have XOR constraint: either `category_id` (category sponsor) or `keyword` (keyword sponsor)
- Forms POST to API → FastAPI `BackgroundTasks` schedule `app.services.email.send_*_notification` (and `send_join_autoreply` for Join) → `aiosmtplib` delivers via Hover SMTP. n8n container is still in compose for future workflows but no longer in the form path. Demo-mode default when `SMTP_HOST` unset (logs at WARNING level instead of sending) so prod is safe to deploy without the password.

## Key Patterns

### SCSS Modules
All components use CSS Modules. Import pattern:
```scss
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;
@use '../../styles/animations';
```

### Framer Motion Page Transitions
All pages wrap content in `motion.div` with consistent transition:
```tsx
initial={{ opacity: 0, x: 20 }}
animate={{ opacity: 1, x: 0 }}
exit={{ opacity: 0, x: -20 }}
transition={{ duration: 0.15, ease: 'easeInOut' as const }}
```
`PublicLayout.tsx` is a thin `<Suspense><Outlet/></Suspense>` — `AnimatePresence` was removed 2026-04-26 (it left entering pages stuck at the prior exit-state for the second nav); each page now owns its own motion.div entrance. Admin routes short-circuit at `App.tsx` with their own Suspense boundary. `AnimatePresence` still appears in `keyword/index.tsx` for chip-stagger animations — that's local UI, not page transitions; don't reintroduce it at the layout/Outlet level.

**Navbar must be a sibling of `<Routes>` in `App.tsx`**, not inside a page. Putting it inside a transforming ancestor caused sub-pixel text blur during the 150ms slide (especially on the PCB theme's monospace nav).

### Theme System
4 themes (`base`, `steel`, `schematic`, `pcb`) defined in `frontend/src/shared/styles/_themes.scss` as CSS custom properties (`--theme-*`) scoped to `[data-theme]` on `<html>`. **Steel is the prod default** — `ThemeBridge.tsx` hardcodes `theme = "steel"` in prod (URL params + localStorage ignored so stale state can't strand users on a non-steel theme). In dev, full resolution: URL `?nav=A|B|C` → `localStorage.circuits.nav.theme` → `DEFAULT_THEME` constant (`"steel"`). `localStorage.setItem` is also dev-only in ThemeBridge so prod never writes the theme key. Adding a theme = new block in `_themes.scss` + entry in `KEY_TO_THEME` (ThemeBridge). The theme cascades site-wide because every site-level accent uses `var(--theme-accent)` / `var(--theme-cta-bg)` instead of `$nav-blue` / `$executive-blue` directly.

**Hero SVG token cascade** — `CircuitTraces.module.scss` defines 6 CSS custom properties on `.circuitTraces` (`--trace-color`, `--trace-glow`, `--electron-color`, `--ic-body-fill`, `--ic-body-stroke`, `--ic-pad-fill`) derived via `color-mix()` from existing theme tokens. Tokens are defined ONCE at the `.circuitTraces` root, not per child — the ~140 animated paths would otherwise trigger ~50k var() re-resolutions during the 6s draw animation. The base theme has a carve-out block that restores pre-refactor hardcoded rgba values AND suppresses the shared glow filter via `.traceGroup { filter: none; }` (CSS beats SVG presentation attributes). The `<g className={styles.traceGroup} filter="url(#traceGlow)">` wrapper in `CircuitTraces.tsx` applies the glow ONCE to the group's merged output — NEVER apply `filter="url(#…)"` per-path (140× cost). New themes only need to set `--theme-pcb-trace`, `--theme-pcb-dot-glow`, and `--theme-nav-text-hover` — all 6 hero tokens track automatically via `color-mix`.

The `<defs>` glow filter was REMOVED 2026-04-19 (Tier 2 perf): at `stdDeviation=0.5` it was visually negligible but re-rasterized the electron subtree per frame. Since 2026-04-26, `<CircuitTraces variant="full" />` is wrapped in `<BackdropLayer />` mounted at `App.tsx` (above `<Routes>`) — single SVG instance for the session, animations run continuously across all public routes (electrons keep their state, draw-in only fires once on first mount). Variant is pinned to `'full'` everywhere — the previous `'full'`/`'static'` flip was removed because variant changes re-applied `.trace { animation: draw-circuit }` on home re-entry, visibly restarting the 6-second draw-in. Themed backdrop bg (`$executive-blue` base + per-theme overlays) lives in `BackdropLayer.module.scss`. HeroSection and PageHeaderBand are TRANSPARENT layout-only components — the band/hero area is a "window" onto the persistent backdrop. Pause wiring in CircuitTraces.tsx useEffect: `IntersectionObserver` + `visibilitychange` pause animations when off-screen or tab-hidden (`svg.pauseAnimations()` for SMIL + `data-paused="true"` attribute for CSS, handled by `.circuitTraces[data-paused="true"] .trace` selector); an `animationend` handler releases completed `draw-circuit` animations via `el.style.animation = 'none'` (after pinning `stroke-dashoffset: 0`).

### API Route Convention
All API routes prefixed with `/api/`. Router prefix set in each route file.

### Relative API URLs
Frontend calls (`services/api.ts`, `services/adminApi.ts`) use relative paths — `/api/categories`, never `https://<host>/api/categories`. This is what let the circuits.com cutover be a 2-file change (nginx + deploy.sh) instead of sweeping every component. Don't introduce absolute URLs in frontend code.

### Contact Page — Datasheet Card Motif
The info panel deliberately mimics electronic datasheet styling: each founder is labeled U1/U2 in monospace (schematic component designators), cards have crop-mark corners (datasheet reference box framing), and the panel sits on a faint PCB grid (24px cells, $nav-blue at 3.5%). Don't flatten this to a generic card layout — the motif is the brand statement.

### Navbar — Pinned-Edge Layout
Brand (`left: 20px`) and nav+LOGIN group (`right: 20px`) are `position: absolute` on `.topStrip` — they escape `.inner`'s container max-width to stay pinned 20px from viewport edges at every width. Search bar (when rendered) is absolutely centered via `left: 50%; transform: translateX(-50%)`, hidden on `/` via `useLocation().pathname === '/'` (the hero search covers that). Do NOT reintroduce Grid or flex `space-between` for navbar horizontal positioning — the pin pattern is load-bearing.

### Seed Data (idempotent)
15 categories, 75 subcategories (5 per category, 2 levels deep), 7 suppliers, 2 sponsors. Seed checks for existing data before inserting.

### Sticky-footer site-wide
`<Footer />` is mounted **once** inside `PublicLayout.tsx` as a sibling of `<Outlet />`. PublicLayout root is `display: flex; flex-direction: column; min-height: calc(100vh - $nav-height)`; Footer has `margin-top: auto; flex-shrink: 0`. Every public route inherits sticky-bottom behavior automatically. **Adding a new public page = do NOT import or render `<Footer />`** — the layout already provides it. Putting Footer inside a page's `<motion.div>` pulls it up with the transforming content when page height < viewport (the 441px-empty-below-footer bug we shipped a fix for on 2026-05-14, deleting 15 inline `<Footer />` renders across 12 page files).

**Footer is theme-aware** (2026-05-16): `background: var(--theme-nav-bg)` + per-theme overrides for steel (dark-graphite gradient `#0e1113`), schematic (engineering-paper hairlines), pcb (copper-trace top edge + 24px silkscreen grid). Mirrors the Navbar substrate so header and footer read as a matched pair. Old hardcoded `$footer-dark` (#1a1a2e) is gone — do not reintroduce.

### Site-wide render-crash safety net (ErrorBoundary)
`<ErrorBoundary key={location.pathname}>` wraps both the public Outlet (in `PublicLayout.tsx`) and the admin Routes (in `App.tsx`). When ANY page throws during render, the boundary surfaces a recoverable fallback card with a "Back" button (history.back) and "Try again" button (reset state) instead of a blank white screen. Lives at `frontend/src/shared/components/ErrorBoundary.tsx` — first component in the `shared/` scope (the customer-portal forecast in this CLAUDE.md anticipated cross-scope shared components landing here). **Keying on pathname is load-bearing**: it auto-clears the error state when the user routes away, so a broken route doesn't poison subsequent navigation. Without this key, the user would see the fallback persist even on working pages. Layout chrome (Navbar/Footer for public, sidebar/topbar for admin) stays visible during a crash because the boundary sits INSIDE the layout, around `<Outlet />` / `<Routes>` — not at the App root.

### Parent-category "Popular Parts" rollup (2026-05-16)
Parent category pages (e.g., `/category/power-management-ics-pmics`) render a "Popular Parts" section that rolls up parts from ALL their subcategories, ranked by aggregate listing stock (popularity proxy until click-count metrics ship). Pattern:
- Backend: `category_service._build_popular_parts(db, parent_id, page, per_page)` queries `Part WHERE category_id IN (self + immediate children)`, GROUP BY part, ORDER BY SUM(listings.stock_quantity) DESC, with offset/limit pagination. Response shape is `PopularPartsPage = {items, total, page, pages, per_page}` — schema lives at `api/app/schemas/category.py`.
- Frontend: `CategoryPage` reads `category.popular_parts` and renders `<PartsTable>` inside a scrollable wrapper (`.popularScroll { max-height: 600px desktop / 420px mobile; overflow-y: auto }`), with `<Pagination>` controls below. URL query param `?p=N` drives pagination — deep-linkable, back/forward browser nav works, and SPA scroll-to-top is overridden inside `handlePopularPageChange` to scroll to `#popular-parts` so the user lands on the section heading instead of the document top.
- Reusable `<Pagination>` widget at `frontend/src/public/components/widgets/Pagination.tsx`: Google-style numbered links (Prev | 1 | 2 … N | Next) with `windowSize` prop for the ±N window around current, ellipsis between gaps; mobile (≤768px) collapses to "Prev | Page X of Y | Next". Uses `aria-current="page"` on the active button + `aria-label` on each.
- Default `POPULAR_PER_PAGE = 12` (curated highlight section semantic, not a full catalog grid).

### Parts data placement: subcategory, not top-level (2026-05-16)
`api/app/db/seed.py` `_PART_CATALOG` is keyed by **exact subcategory name** (e.g., `"Battery Management ICs (BMS)"`), NOT by a top-level keyword. The pre-2026-05-16 seed placed all 59 parts on top-level categories, leaving every subcategory page empty. The `cats` dict resolves names for both parent and child rows, so the fix was a one-line lookup change: `cats.get(subcategory_name)` with a fail-fast `raise RuntimeError` on typos. When adding a new part to seed: pick the most specific subcategory match — never top-level — or `_build_popular_parts` rollup will undercount (parent's own `parts_count` won't include children unless the rollup helper is queried).

### Part API surfaces full category lineage (2026-05-16)
`part_to_dict()` in `api/app/routes/parts.py` returns `category_name`, `category_slug`, `parent_category_name`, `parent_category_slug`. Lets the `PartPage` breadcrumb render `Home / Parent / Subcategory / SKU` with both middle segments as real `<Link>` (not `<span>`) so the user can pivot up the tree. Top-level parts have `parent_category_*` = `null` — breadcrumb gracefully falls back to `Home / Category / SKU`. TS type at `types/part.ts` mirrors this with `| null` on the parent fields.

### Category API exposes sibling list (2026-05-16)
`ParentCategoryResponse` (in `api/app/schemas/category.py`) carries its own `children` array — that's the parent's full sibling list, eager-loaded via SQLAlchemy's `lazy="selectin"` relationship on `Category.children`. The frontend uses this on subcategory (leaf) pages: `SubcategoryChips` accepts `activeSlug` from the URL and renders `parent.children` with the current page marked `aria-current="page"`. The chips component is purely URL-driven now — no local state. Don't reintroduce the old `parentSlug + activeSlug` local-state pattern (the pre-2026-05-16 hash-link bug came from there: `navigate('/category/${parentSlug}#${sub.slug}')` instead of real-route `navigate('/category/${sub.slug}')`).

### SPA scroll-to-top on route change
`App.tsx` runs `useEffect(() => { if (location.hash) return; window.scrollTo({ top: 0, left: 0 }); }, [location.pathname])` after the `useLocation` call. React Router v6 doesn't reset scroll on `<Link>` nav by default — without this effect, users landed mid-page when navigating from a scrolled position (the 2026-05-16 user complaint). The `location.hash` skip preserves anchor navigation (`/privacy#some-section` still uses the page's `scrollIntoView`). Effect lives BEFORE the admin/public early-return so it fires on both code paths.

## Gotchas

- TypeScript strict mode: `noUnusedLocals` + `noUnusedParameters` — remove unused vars, don't prefix with `_`
- **`?:` in TypeScript catches only `undefined`, NOT `null`** — Python `None` serializes to JSON `null`, which slips through a `field?: number` declaration. The 2026-05-16 `/admin/messages/:id` blank-screen bug was `m.spam_score !== undefined && m.spam_score.toFixed(2)` — the check passed for `null`, then `.toFixed()` crashed. Rule: any backend-nullable field MUST type as `field?: T | null` AND guard with `!= null` (loose-equality catches both `null` and `undefined`). Use `??` (nullish coalescing) for defaults: `(m.spam_score ?? 0) > 0.6`. The `ErrorBoundary` safety net (above) now catches future render crashes of this shape, but the root fix is to type the field correctly and use `!= null`.
- **`/admin` in prod = React SPA, not SQLAdmin** — `nginx.ssl.conf` routes `/admin*` → frontend. Updating `app/admin.py` SQLAdmin views does NOT change what users see. Update `frontend/src/admin/pages/` instead.
- **Adding a Supplier field requires 6 files**: model (`models/supplier.py`) + Alembic migration + `SupplierResponse`/`SupplierCreate`/`SupplierUpdate` + `supplier_to_dict` (`routes/suppliers.py`) + `AdminSupplier` TS type (`types/admin.ts`) + `SuppliersPage` COLUMNS + `SupplierFormPage` form/payload/review.
- **`SupplierResponse` is shared by public AND admin endpoints** — fields added there appear in the unauthenticated `/api/suppliers/`. Use a separate auth-gated endpoint if a field must stay admin-only.
- **EC2 t3.micro OOMs during `docker compose up --build`** — peak build memory (npm + pip + Docker layers) > 1 GB. Stay on t3.small (1.9 GB) or pre-build images off-host. If the box hangs, stop+start (not reboot) to clear the thrash.
- Tests use SQLite via `Base.metadata.create_all` — schema generated from SQLAlchemy models, not Alembic. Adding a model column makes tests pass without a migration; the migration is only needed for prod Postgres.
- After deploys, hard-refresh (Ctrl+Shift+R) — `index.html` can be cached even though Vite bundles are hashed.
- Vite dev server proxies `/api` → `http://api:8000` — only works inside Docker; change the proxy target for non-Docker dev
- Framer Motion v12 requires `as const` on ease values (e.g., `'easeInOut' as const`) or tsc errors with string vs Easing type
- Supplier `phone`/`website`/`email` are nullable (`str | None`) — templates must handle null
- SQLite tests don't enforce CHECK constraints — the XOR sponsor constraint only works in PostgreSQL
- `global.scss` uses deprecated Sass `darken()`/`lighten()` — use `@use 'sass:color'` + `color.adjust()` in new code
- **Frontend Dockerfile has 4 stages (`base`/`dev`/`build`/`prod`); docker-compose defaults to `prod`** — the container serves the hashed Vite bundle via nginx, so there's no HMR. Every SCSS/TSX edit needs `docker compose up --build -d frontend` (~20s). For HMR locally, add `target: dev` under the frontend service.
- **Docker cache can silently serve stale frontend code** — `docker compose up -d --build frontend` sometimes hits cached layers and the bundle hash is unchanged. If new behavior isn't visible, force a clean rebuild: `docker compose build --no-cache frontend && docker compose up -d frontend`. Hits hardest after rapid edits coalesced by `frontend-rebuild.sh`'s flock.
- Never animate CSS `drop-shadow()` filters — causes severe scroll lag; use static shadows only
- **SVG `<filter>` on a `<g>` whose children animate = CPU raster on mobile** — Blink/WebKit don't GPU-accelerate SVG filter rasterization while SourceGraphic is dirty. `feGaussianBlur` on `.traceGroup` was the 2026-04-19 mobile-lag bug. Mitigation: `@media (max-width: 768px) { .traceGroup { filter: none; } }`. Keep `stdDeviation` ≤ 0.5 and filter region tight where the filter IS applied.
- **Dev-only components gate at the CALL SITE, not inside the component** — `if (!import.meta.env.DEV) return null` before `useState` violates Rules of Hooks. Use `{import.meta.env.DEV && <HeroColorTuner />}` at the `App.tsx` mount site; Vite tree-shakes the component in prod bundles.
- `/api/health` endpoint exists for health checks
- ProxyHeadersMiddleware trusts all hosts — required for admin panel HTTPS URL generation behind nginx
- FastAPI 307-redirects missing-trailing-slash paths: `/api/suppliers` → `/api/suppliers/`. `curl` tests need `-L`; axios on the frontend follows transparently.
- **Adding a new hostname**: (1) add to `server_name` in `nginx/nginx.ssl.conf`; (2) on EC2: stop nginx → `sudo certbot certonly --standalone --expand --cert-name circuits.matthew-chirichella.com -d <every-hostname>` → start nginx. DNS must resolve to the EIP first (HTTP-01 challenge over port 80).
- Cert directory is `/etc/letsencrypt/live/circuits.matthew-chirichella.com/` even though `circuits.com` is primary — browsers match on SAN, not Subject CN. Renaming is cosmetic and would also require updating nginx cert paths.
- **`./deploy.sh` (no flag) does NOT restart nginx** → 502 on `circuits.com` after the rebuild because nginx keeps a stale DNS cache for the recreated upstream. Workaround: chase a full deploy with `./deploy.sh --frontend` (which does `compose up -d --build frontend && compose restart nginx`). Run both until `deploy.sh` is fixed.
- **Avoid `grid-template-columns: 1fr auto 1fr` with asymmetric side-track content** — `1fr` is secretly `minmax(auto, 1fr)`, so a fat min-content track on one side breaks the "centered" middle. Use `position: absolute` on a `position: relative` parent instead.
- **Admin login creds (local dev):** `matthew` / `mike` / `john` all with password `admin` (seeded by `api/app/db/seed.py:504`). The `ADMIN_USERNAME` / `ADMIN_PASSWORD` env vars in `docker-compose.yml` are for SQLAdmin (unreachable in prod), NOT the React admin panel login form.
- **Breakpoints live in `frontend/src/shared/styles/_variables.scss`** — `$bp-mobile: 768px`, `$bp-tablet: 1024px`, `$bp-desktop: 1199px`, plus admin-only `$bp-admin-mobile: 820px` (sidebar→drawer flip) and `$bp-admin-compact: 420px` (further compaction). Use `@include responsive(...)`, not hardcoded widths. Don't introduce `$bp-website-mobile` / `$bp-admin-tablet` — reuse `$bp-mobile` and `$bp-tablet`.
- **Mobile drawer state-machine pattern** (`Navbar.tsx` + `AdminLayout.tsx`): `useState(menuOpen)` + three effects on `[menuOpen]` for body-scroll-lock (capture `prev`, restore on cleanup), Esc keydown (attach only while open), and `[location.pathname]` for route-change auto-close. Drawer link `onClick` calls `setMenuOpen(false)` BEFORE `<NavLink>` navigates. Apply `.isOpen` on burger/scrim/drawer/aside; add `aria-expanded` + `aria-controls` on burger. Animations are compositor-only (`transform`+`opacity`, no filter); `@media (prefers-reduced-motion: reduce)` resets transitions. No shared hook extraction yet — would consolidate the 4 Esc-handlers (drawer×2, ConfirmDialog, Cmd+K) if a third drawer ever lands.
- **Admin sidebar `<aside>` needs conditional `aria-hidden`, not unconditional** — at desktop the `<aside>` is a visible sticky sidebar; at mobile it's an off-canvas drawer. Pattern: `aria-hidden={!menuOpen ? undefined : false}` renders no attribute when closed (correct for desktop visible state) and explicit `"false"` when open. Don't mirror the public Navbar's `aria-hidden={!menuOpen}` for the admin aside — that would set `aria-hidden="true"` at desktop where the sidebar IS visible.
- **`backdrop-filter: blur(2px)` on a full-viewport scrim is acceptable on mobile** when the scrim only animates `opacity` (no transform, no resize). Static blur regions get rasterized once at composite time and cached. The admin drawer scrim (`AdminLayout.module.scss .sideScrim`) does this. The public drawer scrim uses plain `rgba(0,0,0,0.45)` (no blur) since it sits below the nav strip and doesn't need depth separation. Don't add `backdrop-filter` to elements that translate/scale — the rasterized blur layer redraws every frame.
- **Mobile data tables: `display: block; overflow-x: auto` + `thead, tbody { display: table; min-width: <px> }`** turns a `<table>` into a horizontal-scroll container without DOM changes. Used 2026-05-13 on `PartsPage`/`MessagesListPage`/`ImportPage` at `@media (max-width: $bp-admin-mobile)`. Always pair with `-webkit-overflow-scrolling: touch` for iOS momentum.
- **Buttons inherit `line-height: 1.6`** from `body` in `global.scss`. In a height-constrained row (navbar, toolbar) this makes buttons overflow the row. Fix: explicit `line-height: 1` on the button + control height via padding. Caught the LOGIN pill rendering at 37px inside a 36px navbar.
- **Sub-pixel text blur from `transform: translate*(-50%)` centering** — elements positioned via `top: 50%; transform: translateY(-50%)` land at fractional pixels when parent/child heights are odd, and the transform promotes them to a GPU composite layer that re-rasterizes glyphs at the subpixel boundary. Use `top: 0; bottom: 0; display: flex; align-items: center` for integer-pixel vertical centering.
- **`filter: hue-rotate(0deg)` is NOT free** — the filter property promotes the element to its own compositor layer and runs the pipeline every frame even at 0deg. Gate theme-hue filters behind non-default themes via `[data-theme="steel"] { filter: ... }`, not unconditionally on the base selector.
- **URL-param-absent ≠ explicit-default intent** — a picker that clears a URL param to signal "go back to default" will be shadowed by stale localStorage if localStorage is used for persistence. On the default-button click, synchronously write the default value to localStorage BEFORE `setParams`. Otherwise ThemeBridge reads "no URL param → localStorage had `pcb` → apply `pcb`" and the click appears dead.
- **Apply SVG `<filter>` at a `<g>` wrapper, not per-element** — `filter="url(#glow)"` on each of 140 `<path>` elements = 140 CPU filter rasterizations per paint. Same filter on ONE wrapping `<g>` = 1 rasterization of the merged output. See `CircuitTraces.tsx` `.traceGroup` for the pattern.
- **Inner-page light surface-bg goes on a body WRAPPER inside motion.div, NOT on motion.div itself** (2026-04-26 inversion of the c5eb07f rule). The persistent `<BackdropLayer />` (z-index: 0, top: $nav-height, height: 420px) needs to be visible through the band area on inner pages. Pattern: motion.div has no bg (or a class like `.aboutPage` with no bg); an inner `<div className={styles.aboutBody | contactPage | page}>` carries `background: var(--theme-surface-bg)`. The body wrapper starts in document flow AFTER PageHeaderBand, so it covers only the lower portion of the backdrop — the band area stays transparent. PageHeaderBand and HeroSection are now both transparent layout-only components. New inner pages MUST follow this pattern or the backdrop will be hidden.
- **Don't reintroduce `AnimatePresence` around `<Suspense><Outlet/></Suspense>`** — Framer Motion 12 leaves the SECOND-nav entering motion.div stuck at the previous child's exit-state (`opacity:0, x:-20`) for both `mode="wait"` and `mode="popLayout"`. Removed from PublicLayout 2026-04-26 — see `PublicLayout.tsx:14`.
- **`PublicLayout.module.scss .outletWrap { position: relative; z-index: 1 }` is load-bearing** — without it, CSS painting order (CSS 2.1 §9.9.1: in-flow non-positioned descendants paint at step 3, positioned z=0 at step 6) puts `<BackdropLayer />` (positioned, z-index: 0) ON TOP of static page descendants. The z-index: 1 establishes a stacking context for the Outlet that hoists all rendered pages above the backdrop. Don't remove this rule.
- **Verify SVG persistence across SPA nav with the session-marker pattern, not visual comparison** — stamp `svg.dataset.sessionMarker = 'tag-' + Date.now()` before clicking a NavLink, then `evaluate_script` after to check the marker survived. Stronger than visual diff: catches remounts that re-render an identical-looking instance. Used 2026-04-26 to prove BackdropLayer's CircuitTraces is genuinely persistent.
- **Don't gate visible content on JS-added classes inside an `AnimatePresence` subtree** — `IntersectionObserver` callbacks fire unreliably mid-transform, leaving `opacity: 0` defaults stuck. Default visible; trigger entrance via `setTimeout` on mount. Full rationale: `about/index.tsx:62-76`.
- **Admin sponsors are localStorage-persisted, NOT API-backed** — key `circuits.admin.sponsors`. No admin sponsor CRUD endpoints in `adminApi.ts` yet. `SponsorsPage` list + `SponsorFormPage` both write to localStorage; demo-mode hydrates from seed. When backend endpoints land, swap the persistence layer — UI is already split into list + form pages.
- **Sponsor XOR constraint must be enforced client-side** — backend `Sponsor.__table_args__` has `CheckConstraint(category_id IS NOT NULL XOR keyword IS NOT NULL)`. `SponsorFormPage` enforces this in both `validate()` AND `buildSponsor()` before submit. NEVER let both fields be set or both empty — backend will 422.
- **Admin Supplier tier is derived client-side** — `AdminSupplier` type has no `tier` column. `SuppliersPage` derives Featured (≥200 parts) / Platinum (≥100) / Gold (≥25) / Silver (else) from `parts_count`. When a real `tier` column is added to the model, swap the derivation for the column read.
- **For theme/route bug repro: navigate via SPA (NavLink click), NOT direct URL** — direct URL remounts everything and hides transition-related bugs. Load `/?nav=A|B|C` first, then click the nav link. Direct URL is a different test (full reload).
- **`dict(query(Col1, Col2).all())` mis-types under Pyright** — overload resolution lands on `Iterable[list[bytes]]` and emits "Column[UUID] not assignable to bytes". Use `{row[0]: row[1] for row in query.all()}` instead — unambiguous to the type checker, identical at runtime. Hits every `GROUP BY` aggregate the service layer does (e.g., `category_service.get_all_categories` parts_count rollup).
- **Parts→category attachment differs between seeds** — `tests/conftest.py` attaches parts to the *subcategory* (`child.id`); `db/seed.py` attaches to the *top-level* (`matching_cat.id`). Aggregates must key by `category_id` and roll up `own + sum(children)` on the consumer to be correct in both worlds — e.g., the totalParts subtitle on `CategoriesPage`. Don't hardcode "parts live on top-level" or you'll silently report 0 in tests.
- **`CategoryResponse` is shared by public AND admin endpoints** — the admin Categories page reads `/api/categories/` (no auth) via `adminApi.getCategories`. Fields added to `CategoryResponse` (e.g., `parts_count`) appear on the unauthenticated public endpoint. For admin-only category attributes, add a separate auth-gated endpoint — same rule that applies to `SupplierResponse`.
- **Squash-merge `updates → master`: resolve phantom conflicts with `-X theirs`** — diverged histories mean any file touched on both branches conflicts even when trees match. Use `git merge --squash -X theirs updates`; for leftovers: UD → `git rm <old-path>`, AA → `git checkout --theirs <new-path>`.
- **chrome-devtools-mcp `click(uid)` may not trigger React Router on `<Link>`** — for SPA-nav tests, use `evaluate_script` with `document.querySelector('a[href="..."]').click()` instead (real DOM click is intercepted by React's capture-phase listener).
- **Tree-row with `1fr auto auto` jams slug behind name on long titles** — promote children to `repeat(auto-fill, minmax(220px, 1fr))` tiles. See `pages/admin/CategoriesPage .subGrid`.
- **Different Vite bundle hashes ≠ visual regression after a rename refactor** — Rollup hashes by content AND import-graph order; a pure file move still produces a new hash. `git diff <pre-sha> HEAD -- <file>` is the authoritative check.
- **chrome-devtools-mcp agents looping (theme × route): open ONE page + `navigate_page`, not `new_page` per cell** — otherwise the user accumulates dozens of stray browser tabs. Use `new_page` only when truly parallel contexts are required.
- **Source-line grep undercounts JSX rendered DOM** — `.map()` loops multiply elements (CircuitTraces.tsx: 54 source `<rect>` tags → 193 rendered). Check `.map()` before suspecting a bug.
- **Structural-rename cycles must grep `import.*\.scss` in TS/TSX, not just `@use` in SCSS** — side-effect SCSS imports (e.g., `main.tsx`'s `import './styles/global.scss'`) bypass `@use` readers and break `vite build`.
- **Deleting a Supplier cascades through 6 dependent surfaces.** `DELETE /api/suppliers/{id}` (added 2026-05-05) removes: `PriceBreak` (via owning `PartListing`) → `PartListing` → `Sponsor` (NOT NULL FK so must delete, not NULL) → `CategorySupplier` → `Revenue`, then NULLs `User.supplier_id` (preserves admin/company-user accounts), then deletes the supplier. Order matters — FK constraints would block any other order. Pattern mirrors `delete_part` in `routes/parts.py:199`.
- **Bulk `query(...).delete()` + `lazy="selectin"` relationship → `Dependency rule ... tried to blank-out primary key` on parent delete** — selectin pre-loads rows into the session; bulk-delete strips DB rows but not session state; `db.delete(parent)` then tries to NULL a composite-PK FK on stale objects. Fix: call `db.expire(parent)` (or `db.expire_all()`) between the bulk-deletes and `db.delete(parent)`. Canonical example: `routes/suppliers.py:delete_supplier`.
- **Admin sponsor store: use `frontend/src/admin/services/sponsorStore.ts`** — `loadSponsors / findSponsor / upsertSponsor / deleteSponsor` only; no page-local store helpers. `loadSponsors()` materializes `SEED_SPONSORS` into localStorage on first read so deleting a seed sponsor removes one row instead of wiping the seed list.
- **`response_model=SchemaX` silently strips computed attributes not declared on SchemaX** — stamping `obj.parts_count = N` on ORM rows works locally but Pydantic's `from_attributes=True` drops anything not in the schema. Symptom: list endpoint shows zeros while detail endpoint (returns plain dict) shows real values. Fix: drop `response_model=` and return dicts, or add the field to the schema with a default. Regression guard: `tests/test_suppliers_extended.py::TestListSuppliersAggregates`.
- **SMTP creds for forms live in `/opt/circuits-com/.env` on the prod EC2 host** (not committed) — set `SMTP_HOST=mail.hover.com`, `SMTP_PORT=587`, `SMTP_USERNAME=no-reply@circuits.com`, `SMTP_PASSWORD=...`. Without `SMTP_HOST`, `app.services.email._smtp_send` runs in demo mode (logs instead of sends) — local dev works credless. `NOTIFY_RECIPIENTS` accepts JSON or CSV; defaults to `["no-reply@circuits.com"]`.
- **n8n is no longer in the form-submission path** — `routes/forms.py` sends email directly via `app.services.email` (aiosmtplib + Hover SMTP) using FastAPI `BackgroundTasks`. The n8n container stays in compose for future workflows. If you re-add it, import workflows via the n8n CLI on first boot — copying JSON to `/home/node/.n8n/workflows/` does not auto-load.
- **Pyright complains `Import "app.services.email" could not be resolved`** — false positive caused by the stdlib `email` module shadowing the package import in some Pyright resolution paths. Runtime works fine (pytest passes); the import is correctly absolute. Ignore the warning or suppress with `# pyright: ignore[reportMissingImports]` per import site if it becomes noisy. Same pattern affects `from app.services import email as email_service` in test files.
- **ANY accent-colored text on a light card uses `var(--executive-blue)` (#0a4a2e, WCAG-AA across all 4 themes)** — `var(--theme-accent)` (bright green / copper) and `var(--theme-cta-bg)` (near-white under steel) fail contrast for text at every size. The earlier "small text" qualifier was too narrow: v2 design upsized a section-num badge from 0.7rem → 0.92rem and it still failed AA (Lighthouse dropped 95→91 until swapped). Rule: text colored `var(--theme-accent)` on `var(--theme-surface-bg)` / white / 10%-tint backgrounds → swap to `var(--executive-blue)`. Borders and chip backgrounds can keep `var(--theme-accent)`. Sub-gotcha: `var(--fg2)` (#6b7280) passes on white (4.85:1) but fails on `var(--surface)` #eef1f5 (4.07:1) — Lighthouse a11y catches it. **Conscious exception**: `/keyword` (keyword-landing) intentionally uses `var(--theme-accent)` for section-num badge text + tier price text per v2 design 1-for-1 parity (2026-05-16 user mandate). A11y dropped to 91/100 — color-contrast is the lone WCAG failure besides the pre-existing SearchBar aria-allowed-attr. Trade-off documented in `KeywordLandingPage.module.scss`. Do not propagate this exception to other pages without an explicit design-parity mandate.
- **Test fixtures must NOT pair a real-looking SMTP host with a `SMTP_PASSWORD` assignment** — even when the password is an obvious placeholder like `"secret"` or `"pw"`. GitGuardian's SMTP-credential detector pattern-matches host+username+password triplets in proximity; on 2026-05-08 the original `test_email_service.py` paired `SMTP_HOST="mail.hover.com"` + `SMTP_USERNAME="no-reply@circuits.com"` + `SMTP_PASSWORD="secret"` adjacently and got flagged. Fix: use RFC 6761 reserved TLDs (`.invalid` / `.test` / `.example`) for hosts and emails in test fixtures — secret scanners universally ignore them. Regression guard at `api/tests/test_no_smtp_credential_lookalikes.py` scans the test dir for the pattern; runs in the existing pytest suite.
- **`docker compose restart <svc>` does NOT re-evaluate `${VAR:-}` substitutions from `.env`** — restart sends SIGTERM/SIGSTART to the existing container; env vars stay frozen at create-time. Env-only changes (new `.env` line, password rotation, NOTIFY_RECIPIENTS update) need `sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate <svc>` (or `up -d --no-deps <svc>`). Hit twice on 2026-05-14 (SMTP_PASSWORD landed empty in-container after `restart`, then NOTIFY_RECIPIENTS landed unchanged) — `up -d --force-recreate api` was the fix both times. Verification pattern: `docker compose exec -T api python -c "from app.config import settings; print(len(settings.SMTP_PASSWORD or ''), settings.NOTIFY_RECIPIENTS)"` confirms what the app actually sees without echoing secrets.
- **Forms router prefix is `/api`, NOT `/api/forms`** — `routes/forms.py:23` declares `APIRouter(prefix="/api")`. Endpoints are `POST /api/contact`, `POST /api/join`, `POST /api/keyword-request`. Easy to mis-curl if you grep for `forms.py` and assume the prefix matches the filename. There is no `/api/forms/*` route — it returns 404.
- **`EmailStr` (pydantic + email-validator) rejects RFC 6761 reserved TLDs** (`.invalid` / `.test` / `.example` / `.localhost`) with HTTP 422 — smoke-test payloads need real-looking TLDs (`.com` / `.io` / etc.). The same email-validator library that makes those TLDs "safe" for the SMTP-credential regression guard makes them fail validation on incoming POST bodies. Use `smoke-test+verify@circuits.com` (plus-tag self-route) for forms that POST against an EmailStr-validated field, OR use a real-looking-but-fictitious TLD.
- **`docker compose exec -T <svc> <cmd>` consumes stdin** of any wrapping `ssh user@host 'bash -s' <<HEREDOC` block — the rest of the heredoc body silently never reaches the remote shell after the `exec -T` line. **Always redirect**: `sudo docker compose ... exec -T api python -c "..." < /dev/null`. Caught when a remote smoke-test script aborted after the first marker echo with no error message — stdin was being eaten by the docker exec.
- **Claude Design handoffs arrive as 4.2MB gzip** via `https://api.anthropic.com/v1/design/h/<hash>` — `WebFetch` returns binary, saves to `<conversation-tmpdir>/tool-results/webfetch-*.bin`. Extract with `tar -xzf <path>.bin -C design-handoff[-vN]/`. Diff iterations with `diff -u design-handoff/.../sponsor.css design-handoff-v2/.../sponsor.css` to see what changed between Claude Design revisions. Versioned dirs (`design-handoff*/`) are gitignored (line 49 of `.gitignore`).

## Brand Colors

```
$executive-blue: #0a4a2e  (PCB dark green — headers, hero backgrounds)
$nav-blue: #44bd13        (bright green — nav strip, links, accents)
$sponsor-gold: #a88d2e    (sponsor blocks, premium CTAs)
$surface: #eef1f5         (page backgrounds)
$error-red: #c0392b       (form validation, required field markers)
$font-mono: JetBrains Mono stack  (designators, code-like labels)
```
