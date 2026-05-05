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
./deploy.sh                # Full deploy (push key + pull + rebuild)
./deploy.sh --frontend     # Frontend-only (faster)
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
- Services layer: `category_service.py`, `search_service.py`
- SQLAdmin panel mounted at `/admin` on the API (only reachable in local dev — nginx routes `/admin` → frontend in prod)
- **Real prod admin** lives in `frontend/src/admin/pages/` (React SPA): suppliers/{list,form,detail}, parts/{list,form,detail}, sponsors/{list,form}, dashboard, categories, reports, settings, import
- React admin auth: JWT in `localStorage.admin_token` via `frontend/src/admin/services/adminApi.ts`; SQLAdmin auth (dev only): session via `AdminAuth` in `app/admin.py`
- Config via pydantic-settings: `DATABASE_URL`, `N8N_WEBHOOK_BASE_URL`, `CORS_ORIGINS`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_SECRET_KEY`
- Entrypoint runs: alembic migrate → seed → uvicorn

### Frontend (frontend/)
- React 19 + TypeScript + Vite + SCSS Modules + Framer Motion. **Bounded-context structure** (post-2026-05-03 restructure):
  - `src/public/` — public site: `pages/<name>/{index.tsx, <Name>Page.module.scss, components/}`; `components/layout/` (chrome); `components/widgets/` (CircuitTraces, GlowButton, AnimatedLink, SkeletonLoader, HeroColorTuner); `hooks/`; `services/api.ts`; `types/`
  - `src/admin/` — admin SPA: `pages/<name>/` for standalone (login/dashboard/categories/reports/settings/import); `pages/<entity>/{list,form,detail}/` Plan B nesting for CRUD (suppliers, parts; sponsors has only list+form); `components/`; `contexts/`; `services/adminApi.ts`; `styles/_variables.scss`; `types/admin.ts`
  - `src/shared/` — cross-scope only: `styles/{_themes,_variables,_mixins,_animations,global}.scss`; `services/constants.ts` (exports `API_BASE_URL`, consumed by both public api.ts and admin adminApi.ts)
- **Per-scope path aliases** (`vite.config.ts` + `tsconfig.app.json`): `@public/*`, `@admin/*`, `@shared/*`. The pre-2026-05-03 unused `@/*` alias was removed.
- **ESLint boundary enforcement** (`frontend/.eslintrc.json`, `eslint-plugin-import` v8): admin/ may not import `@public/*`; public/ may not import `@admin/*`; shared/ may not import either. Run `cd frontend && npx eslint src/` (exit 0 = clean).
- **Customer portal forecast**: `UserInfo.role: 'admin' | 'company'` + `supplier_id?: string` already exist in `admin/types/admin.ts`. When the customer-portal SPA lands, mirror `admin/`'s structure as `src/portal/` with `@portal/*` alias. Chrome in `admin/components/` may migrate to `shared/components/` per ≥2-consumer rule.
- **All routes except `HomePage` lazy-load** via `React.lazy()` with alias-path strings (e.g., `lazy(() => import("@public/pages/category"))`). Public routes nest under `<Route element={<PublicLayout />}>` — PublicLayout is a thin `<Suspense><Outlet/></Suspense>` wrapped in `.outletWrap { position: relative; z-index: 1 }` (stacks pages above the persistent `<BackdropLayer />` at z-index: 0). AnimatePresence was REMOVED 2026-04-26 — each page handles its own entrance via its own motion.div. The persistent `<CircuitTraces />` lives inside `<BackdropLayer />` mounted at `App.tsx` level (ABOVE `<Routes>`) — single instance, never remounts on public nav. Admin routes use a separate Suspense boundary in `App.tsx`'s early-return. Main bundle ~277 KB; heavy vendor deps go in `vite.config.ts` → `build.rollupOptions.output.manualChunks` (framer/router isolated; recharts dropped 2026-04-25). Keep Home eager for LCP.
- **`lucide-react`** powers admin chrome (sidebar + topbar) — public site still uses emoji for category/glyph slots.
- **No charting library** — `DashboardPage` and `ReportsPage` inline native SVG (`Sparkline`, `RevenueChart`/`RevenueDonut`, `SponsorRing`, `HBarChart`). Recharts was removed 2026-04-25 (saved ~400 KB + 40 transitive packages); do NOT reintroduce.
- **Dependency graph**: `docs/architecture/dependency-graph.dot` (render via `dot -Tsvg` if Graphviz installed). 71 src files / 256 import edges across the 3 scopes; only 1 file in `shared/` proves the bounded contexts genuinely don't overlap.
- **Adding a new public page**: create `src/public/pages/<name>/{index.tsx, <Name>Page.module.scss}`; add `lazy(() => import("@public/pages/<name>"))` to App.tsx; add `<Route path="/<name>" ...>` inside the public Routes block.
- **Adding a new admin entity-CRUD set**: create `src/admin/pages/<entity>/{list, form, detail}/index.tsx` (3 sibling pages); add 3 lazy imports + 4 `<Route>` entries (`/<entity>`, `/<entity>/new`, `/<entity>/:id`, `/<entity>/:id/edit`).

### Admin layout (`frontend/src/admin/components/AdminLayout.tsx`)
Owns the 240px Lucide-iconed sidebar (Catalog group: Dashboard / Parts / Suppliers / Categories / Sponsors / Reports — System group: Import Queue / Settings) + 64px sticky topbar (collapsible search w/ ⌘K + Demo Data toggle pill + Notifications + "+ New Part" CTA + Sign-Out confirm modal). Page components render the content area ONLY — never their own sidebar/topbar. The Demo Data toggle lives in the topbar — `<DemoToggle />` is NO LONGER rendered separately in `App.tsx` (was floating bottom-right pre-2026-04-25). Admin scope is intentionally un-themed (light surface, DM Sans chrome) per `reference_theme_system` memory.

### Claude Code Automations (.claude/)
- **Hooks** (settings.json):
  - **PreToolUse**: blocks `.env`/lock edits, warns on `api/app/admin.py` (SQLAdmin ≠ prod admin), and — on every `Bash` tool call — runs `migration-safety-check.sh` to `ask` for confirmation when a `git commit` includes a new `api/alembic/versions/*.py` file with no matching `api/app/models/*.py` change in the same commit (catches drifted `--autogenerate` runs)
  - **PostToolUse**: (1) `tsc --noEmit` on .ts/.tsx/.scss edits, (2) `pytest` on .py edits, (3) **`ruff format` + `ruff check --fix`** on .py edits (excluding alembic/versions — autogenerated), (4) `scss-lint.sh` (CLAUDE.md gotcha grep — 10 anti-patterns from this list, non-blocking warnings), (5) `frontend-rebuild.sh` (background-detached `docker compose up -d --build frontend` on SCSS/TSX edits; flock-deduped so rapid edits coalesce)
- **Scripts** (`.claude/scripts/`): `scss-lint.sh`, `frontend-rebuild.sh`, `migration-safety-check.sh` — chmod'd executable, called from hooks
- **Ruff config** lives in `api/pyproject.toml` `[tool.ruff]`: line-length 100, target py312, selects E/F/W/I/UP/B, ignores E501 + B008 (FastAPI's `Depends()` pattern uses function-call defaults). Excludes `alembic/versions/*.py` (autogenerated). Install via `cd api && pip install -e ".[dev]"` (ruff>=0.8.0 is now in dev deps).
- **Agents**: `deploy-preflight` (instance size/git/DNS/disk check before deploy), `seo-auditor` (meta/schema.org/crawlability), `visual-regression-guard` (screenshots 4 themes × 2 viewports, diffs against `tests/visual/baselines/` with ImageMagick `compare`; flags drift ≥1% of pixels — invoke after SCSS/component/theme changes), `frontend-perf-auditor` (Lighthouse + rAF frame sampling + `LongAnimationFrame` detection on steel+mobile — catches 2026-04-19-class SVG-filter regressions before ship), `theme-persistency-guard` (navigates every public route at every alt theme, verifies `--theme-*` tokens resolve and hero backdrops render correctly on ALL 8 pages — catches the cross-page theme-gap bug class; also audits per-page DOM count + JS/CSS/image byte budgets for resource regressions)
- **Skills**: `seo-writer` (title/meta/OG/JSON-LD bundles), `/add-model-field` (scaffolds the 6-file chain for adding a SQLAlchemy model field end-to-end: model + Alembic migration + Pydantic Response/Create/Update + `to_dict` + `types/admin.ts` + `<Model>sPage` + `<Model>FormPage` — with the `admin_only` flag to keep sensitive fields off public `<Model>Response`)
- **MCP servers** (project-scope): `context7` (live docs lookup for React 19 / Framer Motion 12 / Vite 6 / FastAPI / SQLAlchemy — preempts training-data drift on bleeding-edge library APIs); plus globally-installed `chrome-devtools-mcp` and `playwright`
- **HeroColorTuner** (`frontend/src/public/components/widgets/HeroColorTuner.tsx`) — dev-only floating slider panel (bottom-right) gated by `import.meta.env.DEV`. Lets you tune the 3 IC opacity tokens (`--ic-body-fill`, `--ic-body-stroke`, `--ic-pad-fill`) live and read off `color-mix()` strings to paste into SCSS. Sibling of `NavVariantPicker`. Persists to `localStorage.circuits.tuner.*`. Does NOT render in prod (returns `null`).

### Data Flow
- Categories use self-referential `parent_id` for tree structure (2 levels deep)
- `CategorySupplier` join table links suppliers to categories with `is_featured` + `rank`
- Sponsors have XOR constraint: either `category_id` (category sponsor) or `keyword` (keyword sponsor)
- Forms POST to API → API fires async webhook to n8n → n8n processes (email, logging)

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
`PublicLayout.tsx` uses `AnimatePresence mode="popLayout"` + `useLocation` for the public-route crossfade (was in `App.tsx` pre-cbdb556). Admin routes short-circuit at `App.tsx:52` with their own Suspense boundary — no PublicLayout, no AnimatePresence.

**Navbar is hoisted OUT of `AnimatePresence`** — it's a sibling of `AnimatePresence` in `App.tsx`, not a descendant of any page's `motion.div`. Keeping the navbar inside a transforming ancestor caused sub-pixel text blur during the 150ms `x: 20 → 0` slide (especially on the PCB theme's monospace nav). Do not add `<Navbar />` inside a page component.

### Theme System
4 themes (`base`, `steel`, `schematic`, `pcb`) defined in `frontend/src/shared/styles/_themes.scss` as CSS custom properties (`--theme-*`) scoped to `[data-theme]` on `<html>`. `ThemeBridge.tsx` resolves theme from (URL `?nav=A|B|C` → `localStorage.circuits.nav.theme` → `"base"`) and writes `data-theme`. `NavVariantPicker.tsx` is the floating preview pill; clicking a variant writes the URL param AND localStorage synchronously. Adding a theme = new block in `_themes.scss` + entry in `KEY_TO_THEME` (ThemeBridge) + `VARIANTS` (picker). The theme cascades site-wide because every site-level accent uses `var(--theme-accent)` / `var(--theme-cta-bg)` instead of `$nav-blue` / `$executive-blue` directly.

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

## Gotchas

- TypeScript strict mode: `noUnusedLocals` + `noUnusedParameters` — remove unused vars, don't prefix with `_`
- **`/admin` in prod = React SPA, not SQLAdmin** — `nginx.ssl.conf` routes `/admin*` → frontend. Updating `app/admin.py` SQLAdmin views does NOT change what users see. Update `frontend/src/admin/pages/` instead.
- **Adding a Supplier field requires 6 files**: model (`models/supplier.py`) + Alembic migration + `SupplierResponse`/`SupplierCreate`/`SupplierUpdate` + `supplier_to_dict` (`routes/suppliers.py`) + `AdminSupplier` TS type (`types/admin.ts`) + `SuppliersPage` COLUMNS + `SupplierFormPage` form/payload/review.
- **`SupplierResponse` is shared by public AND admin endpoints** — fields added there appear in the unauthenticated `/api/suppliers/`. Use a separate auth-gated endpoint if a field must stay admin-only.
- **EC2 t3.micro OOMs during `docker compose up --build`** — peak build memory (npm + pip + Docker layers) > 1 GB. Stay on t3.small (1.9 GB) or pre-build images off-host. If the box hangs, stop+start (not reboot) to clear the thrash.
- Tests use SQLite via `Base.metadata.create_all` — schema generated from SQLAlchemy models, not Alembic. Adding a model column makes tests pass without a migration; the migration is only needed for prod Postgres.
- After deploys, hard-refresh the browser (Ctrl+Shift+R) to pick up new Vite bundle — the JS bundle filename is hashed, but `index.html` itself can be cached.
- Vite dev server proxies `/api` → `http://api:8000` — only works inside Docker network; for local dev without Docker, change proxy target
- Framer Motion v12 requires `as const` on ease values (e.g., `'easeInOut' as const`) or tsc errors with string vs Easing type
- Supplier `phone`/`website`/`email` are nullable (`str | None`) — templates must handle null
- SQLite tests don't enforce CHECK constraints — the XOR sponsor constraint only works in PostgreSQL
- `global.scss` uses deprecated Sass `darken()`/`lighten()` — use `@use 'sass:color'` + `color.adjust()` in new code
- n8n workflows need SMTP credentials at runtime for email nodes; they have `continueOnFail: true` for demo mode
- **Frontend Dockerfile has 4 stages (`base`, `dev`, `build`, `prod`) and docker-compose.yml defaults to `prod`** (no `target:` → last stage). The container serves the hashed Vite bundle via nginx on container:80 (mapped to host:3000). No HMR — every SCSS/TSX edit requires `docker compose up --build -d frontend` (~20s) before it's visible at `localhost/`. To get HMR locally, add `target: dev` under the frontend service.
- **Docker cache can silently serve stale frontend code** — `docker compose up -d --build frontend` occasionally hits cached layers and doesn't rebuild even with source changes (the bundle hash stays identical across builds). If a rebuild looks like it didn't take effect (new behavior not visible), run `docker compose build --no-cache frontend && docker compose up -d frontend` to force a clean rebuild. Especially bites after rapid successive edits where the flock-deduped `frontend-rebuild.sh` hook coalesces multiple source changes into one in-flight build.
- Never animate CSS `drop-shadow()` filters — causes severe scroll lag; use static shadows only
- **SVG `<filter>` on a `<g>` whose children animate = CPU raster on mobile** — Blink/WebKit don't GPU-accelerate SVG filter rasterization while SourceGraphic is dirty. `feGaussianBlur` on `.traceGroup` was the 2026-04-19 mobile-lag bug. Mitigation: `@media (max-width: 768px) { .traceGroup { filter: none; } }`. Keep `stdDeviation` ≤ 0.5 and filter region tight where the filter IS applied.
- **Dev-only components gate at the CALL SITE, not inside the component** — `if (!import.meta.env.DEV) return null` before `useState` violates Rules of Hooks. Use `{import.meta.env.DEV && <HeroColorTuner />}` at the `App.tsx` mount site; Vite tree-shakes the component in prod bundles.
- `AnimatePresence mode="popLayout"` for crossfade page transitions (not `mode="wait"` which blocks)
- `/api/health` endpoint exists for health checks
- ProxyHeadersMiddleware trusts all hosts — required for admin panel HTTPS URL generation behind nginx
- FastAPI 307-redirects missing-trailing-slash paths: `/api/suppliers` → `/api/suppliers/`. `curl` tests need `-L`; axios on the frontend follows transparently.
- **Adding a new hostname** = (1) add to `server_name` in `nginx/nginx.ssl.conf`, (2) on EC2: stop nginx container → `sudo certbot certonly --standalone --expand --cert-name circuits.matthew-chirichella.com -d <every-hostname-the-cert-should-cover>` → start nginx. DNS must already resolve to the EIP before certbot runs (HTTP-01 challenge fetches over port 80).
- Cert directory is `/etc/letsencrypt/live/circuits.matthew-chirichella.com/` even though `circuits.com` is primary — browsers match on SAN (Subject Alt Name), not Subject CN. Renaming the directory is purely cosmetic and would require updating nginx cert paths too. Don't do it unless there's a functional reason.
- **`./deploy.sh` (no flag) does NOT restart nginx** — it rebuilds api/frontend/n8n containers but nginx keeps a stale DNS cache for the recreated upstream → 502 Bad Gateway on `circuits.com` after a successful build. Workaround: chase a full deploy with `./deploy.sh --frontend` (cached rebuild + nginx restart). The `--frontend` path explicitly does `compose up -d --build frontend && compose restart nginx`. Until `deploy.sh` is fixed to add an `nginx restart` on the full path, always run both.
- **Avoid `grid-template-columns: 1fr auto 1fr` with asymmetric side-track content** — `1fr` is secretly `minmax(auto, 1fr)`, so a fat min-content track on one side breaks the "centered" middle. Use `position: absolute` on a `position: relative` parent instead. Still latent in `pages/admin/ImportPage.module.scss:.mappingGrid`, `DashboardPage.module.scss`, `ReportsPage.module.scss`, `SupplierFormPage.module.scss:.reviewGrid`.
- **Admin login creds (local dev):** `matthew` / `mike` / `john` all with password `admin` (seeded by `api/app/db/seed.py:504`). The `ADMIN_USERNAME` / `ADMIN_PASSWORD` env vars in `docker-compose.yml` are for SQLAdmin (unreachable in prod), NOT the React admin panel login form.
- **Breakpoint `$bp-desktop: 1199px`** exists in `frontend/src/shared/styles/_variables.scss` alongside `$bp-mobile: 768px` and `$bp-tablet: 1024px` — use `@include responsive($bp-desktop)` rather than hardcoding widths.
- **Buttons inherit `line-height: 1.6`** from `body` in `global.scss`. In a height-constrained row (navbar, toolbar) this makes buttons overflow the row. Fix: explicit `line-height: 1` on the button + control height via padding. Caught the LOGIN pill rendering at 37px inside a 36px navbar.
- **Sub-pixel text blur from `transform: translate*(-50%)` centering** — elements positioned via `top: 50%; transform: translateY(-50%)` land at fractional pixels when parent/child heights are odd, and the transform promotes them to a GPU composite layer that re-rasterizes glyphs at the subpixel boundary. Use `top: 0; bottom: 0; display: flex; align-items: center` for integer-pixel vertical centering.
- **`filter: hue-rotate(0deg)` is NOT free** — the filter property promotes the element to its own compositor layer and runs the pipeline every frame even at 0deg. Gate theme-hue filters behind non-default themes via `[data-theme="steel"] { filter: ... }`, not unconditionally on the base selector.
- **URL-param-absent ≠ explicit-default intent** — a picker that clears a URL param to signal "go back to default" will be shadowed by stale localStorage if localStorage is used for persistence. On the default-button click, synchronously write the default value to localStorage BEFORE `setParams`. Otherwise ThemeBridge reads "no URL param → localStorage had `pcb` → apply `pcb`" and the click appears dead.
- **Apply SVG `<filter>` at a `<g>` wrapper, not per-element** — `filter="url(#glow)"` on each of 140 `<path>` elements = 140 CPU filter rasterizations per paint. Same filter on ONE wrapping `<g>` = 1 rasterization of the merged output. See `CircuitTraces.tsx` `.traceGroup` for the pattern.
- **Inner-page light surface-bg goes on a body WRAPPER inside motion.div, NOT on motion.div itself** (2026-04-26 inversion of the c5eb07f rule). The persistent `<BackdropLayer />` (z-index: 0, top: $nav-height, height: 420px) needs to be visible through the band area on inner pages. Pattern: motion.div has no bg (or a class like `.aboutPage` with no bg); an inner `<div className={styles.aboutBody | contactPage | page}>` carries `background: var(--theme-surface-bg)`. The body wrapper starts in document flow AFTER PageHeaderBand, so it covers only the lower portion of the backdrop — the band area stays transparent. PageHeaderBand and HeroSection are now both transparent layout-only components. New inner pages MUST follow this pattern or the backdrop will be hidden.
- **Framer Motion 12: `AnimatePresence` + `Suspense` + lazy routes leaves the SECOND-transition entering motion.div stuck at the previous child's exit-state values** (op: 0, x: -20). Reproduces with `mode="wait"` AND `mode="popLayout"`. The pre-2026-04-26 persistent backdrop SVG masked this (always-visible SVG hid the stuck wrapper); with the per-section SVG architecture briefly tried in the same session the bug surfaced as fully blank inner pages. Fix: removed AnimatePresence from PublicLayout entirely. Don't reintroduce AnimatePresence around `<Suspense><Outlet/></Suspense>` with `key={location.pathname}` — verify the SECOND nav's entering state if you do.
- **`PublicLayout.module.scss .outletWrap { position: relative; z-index: 1 }` is load-bearing** — without it, CSS painting order (CSS 2.1 §9.9.1: in-flow non-positioned descendants paint at step 3, positioned z=0 at step 6) puts `<BackdropLayer />` (positioned, z-index: 0) ON TOP of static page descendants. The z-index: 1 establishes a stacking context for the Outlet that hoists all rendered pages above the backdrop. Don't remove this rule.
- **Verify SVG persistence across SPA nav with the session-marker pattern, not visual comparison** — stamp `svg.dataset.sessionMarker = 'tag-' + Date.now()` before clicking a NavLink, then `evaluate_script` after to check the marker survived. Stronger than visual diff: catches remounts that re-render an identical-looking instance. Used 2026-04-26 to prove BackdropLayer's CircuitTraces is genuinely persistent.
- **Don't gate visible content on JS-added classes when inside AnimatePresence** — `IntersectionObserver` callbacks fire unreliably while the entering `motion.div` is mid-transform; `opacity: 0` defaults waiting for a `.seen` class can stay invisible forever (stats stuck at "0", why-grid blank until a theme switch forces a repaint). Default content to visible; trigger entrance animations on mount via `setTimeout` or Framer's `whileInView`. Caught in AboutPage's `useInView` 2026-04-25 (commit 86dd541).
- **Admin sponsors are localStorage-persisted, NOT API-backed** — key `circuits.admin.sponsors`. No admin sponsor CRUD endpoints in `adminApi.ts` yet. `SponsorsPage` list + `SponsorFormPage` both write to localStorage; demo-mode hydrates from seed. When backend endpoints land, swap the persistence layer — UI is already split into list + form pages.
- **Sponsor XOR constraint must be enforced client-side** — backend `Sponsor.__table_args__` has `CheckConstraint(category_id IS NOT NULL XOR keyword IS NOT NULL)`. `SponsorFormPage` enforces this in both `validate()` AND `buildSponsor()` before submit. NEVER let both fields be set or both empty — backend will 422.
- **Admin Supplier tier is derived client-side** — `AdminSupplier` type has no `tier` column. `SuppliersPage` derives Featured (≥200 parts) / Platinum (≥100) / Gold (≥25) / Silver (else) from `parts_count`. When a real `tier` column is added to the model, swap the derivation for the column read.
- **`design-import/` is local-only** — extracted 2026-04-25 Claude Design bundle (`circuits-com-design-system/` tree with `ui_kits/website/` + `ui_kits/admin/`), listed in `.git/info/exclude`. Reference material; don't commit. Useful for future design-port work — original JSX components, CSS, and chat-history rationale all live there.
- **For theme/route bug repro: navigate via SPA (NavLink click), NOT direct URL** — direct URL load remounts everything fresh and hides transition-related bugs (the AnimatePresence + IO bug above only surfaced on SPA nav from home). When debugging "page X looks wrong on theme Y", load `/?nav=A|B|C` first, then click the nav link via JS or click. Direct URL is a different test (full reload).
- **`dict(query(Col1, Col2).all())` mis-types under Pyright** — overload resolution lands on `Iterable[list[bytes]]` and emits "Column[UUID] not assignable to bytes". Use `{row[0]: row[1] for row in query.all()}` instead — unambiguous to the type checker, identical at runtime. Hits every `GROUP BY` aggregate the service layer does (e.g., `category_service.get_all_categories` parts_count rollup).
- **Parts→category attachment differs between seeds** — `tests/conftest.py` attaches parts to the *subcategory* (`child.id`); `db/seed.py` attaches to the *top-level* (`matching_cat.id`). Aggregates must key by `category_id` and roll up `own + sum(children)` on the consumer to be correct in both worlds — e.g., the totalParts subtitle on `CategoriesPage`. Don't hardcode "parts live on top-level" or you'll silently report 0 in tests.
- **`CategoryResponse` is shared by public AND admin endpoints** — the admin Categories page reads `/api/categories/` (no auth) via `adminApi.getCategories`. Fields added to `CategoryResponse` (e.g., `parts_count`) appear on the unauthenticated public endpoint. For admin-only category attributes, add a separate auth-gated endpoint — same rule that applies to `SupplierResponse`.
- **`design-import/.../admin/pages.jsx` hardcodes `<a target="_blank" href="/category/${parent}/${child}">` for "View →" links** — both wrong: (1) URL doesn't match the actual `/category/:slug` public route (single segment); (2) `target="_blank"` opens a new tab → browser back-button greyed out. When porting *any* navigation from `design-import/`, audit URL patterns against `App.tsx` Routes and use `<Link>` for in-app SPA nav. **Greyed-out back button is the diagnostic signal** — means new tab OR `window.location.href` (full reload).
- **Squash-merge "phantom" conflicts on `updates → master` extend beyond CLAUDE.md** — both branches can have identical trees post-squash but diverged histories (merge-base resolves to the pre-squash parent). CLAUDE.md, App.tsx, page index.tsx, and any file modified on BOTH branches will conflict. Cleanest resolution: `git merge --squash -X theirs updates` (auto-resolves UU conflicts in favor of `theirs`, the active-dev branch). Then handle leftovers manually: UD (master modified old-path, updates renamed) → `git rm <old-path>`; AA (both added at new-path) → `git checkout --theirs <new-path>` + `git add`. Always favor `theirs` for these merges since updates carries the post-restructure truth.
- **chrome-devtools-mcp `click(uid)` may not trigger React Router on `<Link>`** — the synthetic click event occasionally doesn't reach React's bound handler, leaving the URL unchanged. For SPA-nav verification, run `evaluate_script` with `document.querySelector('a[href="..."]').click()` — calls the real DOM `HTMLElement.click()` which React Router intercepts via its capture-phase listener. Same pattern works for any framework that listens via delegated events.
- **Hybrid tile-tree pattern beats cramped tree-row layouts** — when `grid-template-columns: ... 1fr auto auto` jams slug behind name on long titles, promote children to `repeat(auto-fill, minmax(220px, 1fr))` where each tile *is* the `<Link>` and stacks icon/name/slug/view vertically. Solves slug-overlap AND per-row "View" link in one move. See `pages/admin/CategoriesPage` `.subGrid` / `.subTile`.
- **Bundle hash differences after structural refactors are expected.** Vite's Rollup hashes by content AND import-graph order. A pure-rename refactor (file moves + alias-path rewrites) produces different bundle hashes (e.g., `index-CEl4tkVM.js` vs `index-8OoM1x2a.js`) but byte-identical rendered output. Verify with `git diff <pre-sha> HEAD -- <file>` before assuming visual regression — `0 insertions(+), 0 deletions(-)` proves the rendered output can't have changed.
- **chrome-devtools-mcp agents: prefer `navigate_page` over `new_page` per cell.** Agents looping over (theme × route) matrices that call `new_page` for each cell accumulate tabs in the user's browser (saw 14 from one visual-diff agent in the 2026-05-04 restructure session). Cleaner pattern: open ONE page, `navigate_page` between URLs in the loop. Use `new_page` only when truly parallel browser contexts are required (e.g., per-theme isolation that can't be reset).
- **JSX `.map()` loops inflate rendered DOM counts vs source-line grep counts.** `<rect className={styles.trace}>` appears 54 times in `CircuitTraces.tsx` source but produces 193 rendered rects because most are inside `.map()` over arrays of length 4–16. `document.querySelectorAll('[class*="trace"]')` returns **297**, not 158. When debugging "why are there more elements than I expected?", always check for `.map()` loops in the JSX before suspecting a bug.
- **Cartography blind spot for pure-rename cycles**: SCSS-`@use`-only readers miss TS side-effect imports of SCSS files (e.g., `main.tsx`'s `import './styles/global.scss'`). Cycle 1 of the 2026-05-03 bounded-context restructure missed this and `vite build` failed at the verification gate. For future structural-rename cycles, readers must grep BOTH `@use` paths in .scss AND `import.*\.scss` patterns in .ts/.tsx. The Cycle 1 fix is documented in `docs/superpowers/specs/cycle-1-transform-table.yaml`'s `post_execute_additions` block.

## Brand Colors

```
$executive-blue: #0a4a2e  (PCB dark green — headers, hero backgrounds)
$nav-blue: #44bd13        (bright green — nav strip, links, accents)
$sponsor-gold: #a88d2e    (sponsor blocks, premium CTAs)
$surface: #eef1f5         (page backgrounds)
$error-red: #c0392b       (form validation, required field markers)
$font-mono: JetBrains Mono stack  (designators, code-like labels)
```
