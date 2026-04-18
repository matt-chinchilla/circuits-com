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

### Claude Code Automations (.claude/)
- **Hooks** (settings.json): PreToolUse blocks .env/lock edits, warns on `api/app/admin.py` (SQLAdmin ≠ prod admin); PostToolUse auto-runs tsc on .ts/.tsx/.scss edits, pytest on .py edits
- **Agents**: `deploy-preflight` (verifies instance size, git state, DNS, disk before deploy), `seo-auditor` (audits pages for meta/schema.org/crawlability)
- **Skills**: `seo-writer` (generates title/meta/OG/JSON-LD bundles for category/supplier/part pages)

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
`App.tsx` uses `AnimatePresence mode="popLayout"` + `useLocation` for crossfade transitions.

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
- Never animate CSS `drop-shadow()` filters — causes severe scroll lag; use static shadows only
- `AnimatePresence mode="popLayout"` for crossfade page transitions (not `mode="wait"` which blocks)
- `/api/health` endpoint exists for health checks
- ProxyHeadersMiddleware trusts all hosts — required for admin panel HTTPS URL generation behind nginx
- FastAPI 307-redirects missing-trailing-slash paths: `/api/suppliers` → `/api/suppliers/`. `curl` tests need `-L`; axios on the frontend follows transparently.
- **Adding a new hostname** = (1) add to `server_name` in `nginx/nginx.ssl.conf`, (2) on EC2: stop nginx container → `sudo certbot certonly --standalone --expand --cert-name circuits.matthew-chirichella.com -d <every-hostname-the-cert-should-cover>` → start nginx. DNS must already resolve to the EIP before certbot runs (HTTP-01 challenge fetches over port 80).
- Cert directory is `/etc/letsencrypt/live/circuits.matthew-chirichella.com/` even though `circuits.com` is primary — browsers match on SAN (Subject Alt Name), not Subject CN. Renaming the directory is purely cosmetic and would require updating nginx cert paths too. Don't do it unless there's a functional reason.
- **Avoid `grid-template-columns: 1fr auto 1fr` with asymmetric side-track content** — `1fr` is secretly `minmax(auto, 1fr)`, so a fat min-content track on one side breaks the "centered" middle. Use `position: absolute` on a `position: relative` parent instead. Still latent in `pages/admin/ImportPage.module.scss:.mappingGrid`, `DashboardPage.module.scss`, `ReportsPage.module.scss`, `SupplierFormPage.module.scss:.reviewGrid`.
- **Admin login creds (local dev):** `matthew` / `mike` / `john` all with password `admin` (seeded by `api/app/db/seed.py:504`). The `ADMIN_USERNAME` / `ADMIN_PASSWORD` env vars in `docker-compose.yml` are for SQLAdmin (unreachable in prod), NOT the React admin panel login form.
- **Breakpoint `$bp-desktop: 1199px`** exists in `frontend/src/styles/_variables.scss` alongside `$bp-mobile: 768px` and `$bp-tablet: 1024px` — use `@include responsive($bp-desktop)` rather than hardcoding widths.

## Brand Colors

```
$executive-blue: #0a4a2e  (PCB dark green — headers, hero backgrounds)
$nav-blue: #44bd13        (bright green — nav strip, links, accents)
$sponsor-gold: #a88d2e    (sponsor blocks, premium CTAs)
$surface: #eef1f5         (page backgrounds)
$error-red: #c0392b       (form validation, required field markers)
$font-mono: JetBrains Mono stack  (designators, code-like labels)
```
