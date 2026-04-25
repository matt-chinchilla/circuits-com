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
- **Real prod admin** lives in `frontend/src/pages/admin/` (React SPA): SuppliersPage, SupplierFormPage, Parts, Categories, Sponsors, Reports, Import
- React admin auth: JWT in `localStorage.admin_token` via `frontend/src/services/adminApi.ts`; SQLAdmin auth (dev only): session via `AdminAuth` in `app/admin.py`
- Config via pydantic-settings: `DATABASE_URL`, `N8N_WEBHOOK_BASE_URL`, `CORS_ORIGINS`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_SECRET_KEY`
- Entrypoint runs: alembic migrate → seed → uvicorn

### Frontend (frontend/)
- React 19 + TypeScript + Vite + SCSS Modules + Framer Motion
- Pages: Home, CategoryPage, Search, Join, Contact, About, KeywordSponsor
- Components organized by domain: `layout/`, `home/`, `category/`, `shared/`
- API client: `frontend/src/services/api.ts` (axios, typed methods)
- SCSS design system: `_variables.scss` (colors, spacing), `_animations.scss` (keyframes), `_mixins.scss`
- **All routes except `HomePage` lazy-load** via `React.lazy()`. Public routes nest under `<Route element={<PublicLayout />}>` (cbdb556) — `<Suspense fallback={<RouteFallback />}>` + `<AnimatePresence mode="popLayout">` live inside `frontend/src/components/layout/PublicLayout.tsx` wrapping `<Outlet />`, so PublicLayout (and its persistent CircuitTraces backdrop) never unmounts on public navigation. Admin routes use a separate Suspense boundary in `App.tsx`'s early-return at line 52. Main bundle is 263 KB; Recharts (~400 KB) lives in the admin chunk only, never ships to public visitors. New heavy vendor deps go in `vite.config.ts` → `build.rollupOptions.output.manualChunks` (recharts/framer/router already isolated). Keep Home eager for LCP.

### Claude Code Automations (.claude/)
- **Hooks** (settings.json):
  - **PreToolUse**: blocks `.env`/lock edits, warns on `api/app/admin.py` (SQLAdmin ≠ prod admin), and — on every `Bash` tool call — runs `migration-safety-check.sh` to `ask` for confirmation when a `git commit` includes a new `api/alembic/versions/*.py` file with no matching `api/app/models/*.py` change in the same commit (catches drifted `--autogenerate` runs)
  - **PostToolUse**: (1) `tsc --noEmit` on .ts/.tsx/.scss edits, (2) `pytest` on .py edits, (3) **`ruff format` + `ruff check --fix`** on .py edits (excluding alembic/versions — autogenerated), (4) `scss-lint.sh` (CLAUDE.md gotcha grep — 10 anti-patterns from this list, non-blocking warnings), (5) `frontend-rebuild.sh` (background-detached `docker compose up -d --build frontend` on SCSS/TSX edits; flock-deduped so rapid edits coalesce)
- **Scripts** (`.claude/scripts/`): `scss-lint.sh`, `frontend-rebuild.sh`, `migration-safety-check.sh` — chmod'd executable, called from hooks
- **Ruff config** lives in `api/pyproject.toml` `[tool.ruff]`: line-length 100, target py312, selects E/F/W/I/UP/B, ignores E501 + B008 (FastAPI's `Depends()` pattern uses function-call defaults). Excludes `alembic/versions/*.py` (autogenerated). Install via `cd api && pip install -e ".[dev]"` (ruff>=0.8.0 is now in dev deps).
- **Agents**: `deploy-preflight` (instance size/git/DNS/disk check before deploy), `seo-auditor` (meta/schema.org/crawlability), `visual-regression-guard` (screenshots 4 themes × 2 viewports, diffs against `tests/visual/baselines/` with ImageMagick `compare`; flags drift ≥1% of pixels — invoke after SCSS/component/theme changes), `frontend-perf-auditor` (Lighthouse + rAF frame sampling + `LongAnimationFrame` detection on steel+mobile — catches 2026-04-19-class SVG-filter regressions before ship), `theme-persistency-guard` (navigates every public route at every alt theme, verifies `--theme-*` tokens resolve and hero backdrops render correctly on ALL 8 pages — catches the cross-page theme-gap bug class; also audits per-page DOM count + JS/CSS/image byte budgets for resource regressions)
- **Skills**: `seo-writer` (title/meta/OG/JSON-LD bundles), `/add-model-field` (scaffolds the 6-file chain for adding a SQLAlchemy model field end-to-end: model + Alembic migration + Pydantic Response/Create/Update + `to_dict` + `types/admin.ts` + `<Model>sPage` + `<Model>FormPage` — with the `admin_only` flag to keep sensitive fields off public `<Model>Response`)
- **MCP servers** (project-scope): `context7` (live docs lookup for React 19 / Framer Motion 12 / Vite 6 / FastAPI / SQLAlchemy — preempts training-data drift on bleeding-edge library APIs); plus globally-installed `chrome-devtools-mcp` and `playwright`
- **HeroColorTuner** (`frontend/src/components/shared/HeroColorTuner.tsx`) — dev-only floating slider panel (bottom-right) gated by `import.meta.env.DEV`. Lets you tune the 3 IC opacity tokens (`--ic-body-fill`, `--ic-body-stroke`, `--ic-pad-fill`) live and read off `color-mix()` strings to paste into SCSS. Sibling of `NavVariantPicker`. Persists to `localStorage.circuits.tuner.*`. Does NOT render in prod (returns `null`).

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
4 themes (`base`, `steel`, `schematic`, `pcb`) defined in `frontend/src/styles/_themes.scss` as CSS custom properties (`--theme-*`) scoped to `[data-theme]` on `<html>`. `ThemeBridge.tsx` resolves theme from (URL `?nav=A|B|C` → `localStorage.circuits.nav.theme` → `"base"`) and writes `data-theme`. `NavVariantPicker.tsx` is the floating preview pill; clicking a variant writes the URL param AND localStorage synchronously. Adding a theme = new block in `_themes.scss` + entry in `KEY_TO_THEME` (ThemeBridge) + `VARIANTS` (picker). The theme cascades site-wide because every site-level accent uses `var(--theme-accent)` / `var(--theme-cta-bg)` instead of `$nav-blue` / `$executive-blue` directly.

**Hero SVG token cascade** — `CircuitTraces.module.scss` defines 6 CSS custom properties on `.circuitTraces` (`--trace-color`, `--trace-glow`, `--electron-color`, `--ic-body-fill`, `--ic-body-stroke`, `--ic-pad-fill`) derived via `color-mix()` from existing theme tokens. Tokens are defined ONCE at the `.circuitTraces` root, not per child — the ~140 animated paths would otherwise trigger ~50k var() re-resolutions during the 6s draw animation. The base theme has a carve-out block that restores pre-refactor hardcoded rgba values AND suppresses the shared glow filter via `.traceGroup { filter: none; }` (CSS beats SVG presentation attributes). The `<g className={styles.traceGroup} filter="url(#traceGlow)">` wrapper in `CircuitTraces.tsx` applies the glow ONCE to the group's merged output — NEVER apply `filter="url(#…)"` per-path (140× cost). New themes only need to set `--theme-pcb-trace`, `--theme-pcb-dot-glow`, and `--theme-nav-text-hover` — all 6 hero tokens track automatically via `color-mix`.

The `<defs>` glow filter was REMOVED 2026-04-19 (Tier 2 perf): at `stdDeviation=0.5` it was visually negligible but re-rasterized the electron subtree per frame. Since cbdb556, `<CircuitTraces />` is mounted ONCE in `frontend/src/components/layout/PublicLayout.tsx` and persists across all 8 public routes — pages no longer mount it themselves. The `variant` prop flips between `'full'` (home — animated electrons + draw-in) and `'static'` (every other path — no electrons, no animation, no useEffect, zero GPU in steady state) via `useLocation().pathname === '/'` inside PublicLayout. Variant swap is a prop change on the SAME SVG instance, NOT a remount — IntersectionObserver/data-paused/SMIL pause wiring stays intact across navigation. **To enable electrons site-wide, change one line in PublicLayout.tsx:** `const variant = 'full'` (the SVG is persistent so the cost is paid once on first mount, regardless of how many pages display electrons). Themed backdrop bg (`$executive-blue` base + per-theme `:global([data-theme=…]) .backdrop` overrides) lives in `PublicLayout.module.scss`, NOT HeroSection — every page inherits the same backdrop by construction (this closed the cross-page theme-gap bug). Pause wiring in CircuitTraces.tsx useEffect: `IntersectionObserver` + `visibilitychange` pause animations when off-screen or tab-hidden (`svg.pauseAnimations()` for SMIL + `data-paused="true"` attribute for CSS, handled by `.circuitTraces[data-paused="true"] .trace` selector); an `animationend` handler releases completed `draw-circuit` animations via `el.style.animation = 'none'` (after pinning `stroke-dashoffset: 0`).

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
- **`/admin` in prod = React SPA, not SQLAdmin** — `nginx.ssl.conf` routes `/admin*` → frontend. Updating `app/admin.py` SQLAdmin views does NOT change what users see. Update `frontend/src/pages/admin/` instead.
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
- **Breakpoint `$bp-desktop: 1199px`** exists in `frontend/src/styles/_variables.scss` alongside `$bp-mobile: 768px` and `$bp-tablet: 1024px` — use `@include responsive($bp-desktop)` rather than hardcoding widths.
- **Buttons inherit `line-height: 1.6`** from `body` in `global.scss`. In a height-constrained row (navbar, toolbar) this makes buttons overflow the row. Fix: explicit `line-height: 1` on the button + control height via padding. Caught the LOGIN pill rendering at 37px inside a 36px navbar.
- **Sub-pixel text blur from `transform: translate*(-50%)` centering** — elements positioned via `top: 50%; transform: translateY(-50%)` land at fractional pixels when parent/child heights are odd, and the transform promotes them to a GPU composite layer that re-rasterizes glyphs at the subpixel boundary. Use `top: 0; bottom: 0; display: flex; align-items: center` for integer-pixel vertical centering.
- **`filter: hue-rotate(0deg)` is NOT free** — the filter property promotes the element to its own compositor layer and runs the pipeline every frame even at 0deg. Gate theme-hue filters behind non-default themes via `[data-theme="steel"] { filter: ... }`, not unconditionally on the base selector.
- **URL-param-absent ≠ explicit-default intent** — a picker that clears a URL param to signal "go back to default" will be shadowed by stale localStorage if localStorage is used for persistence. On the default-button click, synchronously write the default value to localStorage BEFORE `setParams`. Otherwise ThemeBridge reads "no URL param → localStorage had `pcb` → apply `pcb`" and the click appears dead.
- **Apply SVG `<filter>` at a `<g>` wrapper, not per-element** — `filter="url(#glow)"` on each of 140 `<path>` elements = 140 CPU filter rasterizations per paint. Same filter on ONE wrapping `<g>` = 1 rasterization of the merged output. See `CircuitTraces.tsx` `.traceGroup` for the pattern.

## Brand Colors

```
$executive-blue: #0a4a2e  (PCB dark green — headers, hero backgrounds)
$nav-blue: #44bd13        (bright green — nav strip, links, accents)
$sponsor-gold: #a88d2e    (sponsor blocks, premium CTAs)
$surface: #eef1f5         (page backgrounds)
$error-red: #c0392b       (form validation, required field markers)
$font-mono: JetBrains Mono stack  (designators, code-like labels)
```
