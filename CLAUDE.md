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
- Parts attach to subcategory in `seed.py` `_PART_CATALOG` (NOT top-level). Aggregates must roll up `own + sum(children)`.
- Parent-category "Popular Parts" rollup: `category_service._build_popular_parts(db, parent_id, page, per_page)` — `WHERE category_id IN (self + children)`, GROUP BY part, ORDER BY SUM(stock) DESC. URL `?p=N` paginates. `<Pagination>` widget at `@public/components/widgets/Pagination.tsx`. Default `POPULAR_PER_PAGE=12`.

## Key Patterns

### SCSS Modules
```scss
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;
@use '../../styles/animations';
```

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
- `html, body { overflow-x: clip }` in `global.scss`. Use `clip` NOT `hidden` (`clip` doesn't disturb `position: sticky` ancestors). Companion: `pages/category/CategoryPage.module.scss .content { min-width: 0; width: 100% }` breaks the flex min-content chain.

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
- **EC2 t3.micro OOMs on `docker compose up --build`** — stay on t3.small. If thrash: stop+start (not reboot).
- **Tests use SQLite via `Base.metadata.create_all`** — schema from models, not Alembic. SQLite ignores `String(N)` length AND CHECK constraints. For schema-length contracts assert on metadata: `Model.__table__.c.col.type.length >= N`.
- **After deploys, hard-refresh** (Ctrl/Cmd+Shift+R) — `index.html` cache.
- **Framer Motion v12 requires `as const` on ease**.
- **Sponsor XOR Postgres-only** (SQLite skips CHECK). Enforce client-side in SponsorFormPage `validate()` AND `buildSponsor()`. Never both fields set or both empty.
- **`global.scss` uses deprecated Sass `darken()`/`lighten()`** — new code uses `@use 'sass:color'` + `color.adjust()`.
- **Frontend Dockerfile has 4 stages** (base/dev/build/prod); compose defaults to `prod`. Container serves hashed Vite bundle via nginx, no HMR. SCSS/TSX edits need `docker compose up --build -d frontend` (~20s). For local HMR, add `target: dev`.
- **API container has `build: ./api` with NO volume mount** — same trap. Edits don't reach a running container via `restart`. Use `up -d --build api`. Symptom: seed reports success but data reflects OLD code.
- **`./deploy.sh --reseed` destructive scope** — TRUNCATEs `sponsors, category_suppliers, categories, suppliers CASCADE` → cascades to `users, parts, part_listings, price_breaks, revenue`. `messages` SURVIVES. Admin-UI rows outside seed.py ARE wiped.
- **Category slug changes need `--reseed`** — `get_or_create_category` keys on slug. Renaming a slug in `CATEGORY_DATA` (e.g. `motor-motion-control-ics` → `motor-motion-ics`) makes the new entry MISS the existing row → seed CREATEs a duplicate alongside the old one (30 top-level cats instead of 15). Plain `./deploy.sh` won't fix it — must `--reseed`.
- **Docker cache can serve stale frontend** — if behavior not visible: `docker compose build --no-cache frontend && docker compose up -d frontend`.
- **Never animate CSS `drop-shadow()`** — scroll lag. Use static shadows.
- **SVG `<filter>` on `<g>` whose children animate = CPU raster on mobile** — `feGaussianBlur` was the 2026-04-19 lag cause. `@media (max-width: 768px) { .traceGroup { filter: none; } }`. Apply at `<g>` wrapper, NEVER per-path.
- **Dev-only components gate at the CALL SITE** — `{import.meta.env.DEV && <X />}` at App.tsx mount. Don't `if (!DEV) return null` before hooks (Rules of Hooks).
- **ProxyHeadersMiddleware trusts all hosts** — required for admin HTTPS URL gen behind nginx. FastAPI 307-redirects missing-trailing-slash (`curl -L`; axios follows).
- **Adding a new hostname**: add to `server_name` in `nginx/nginx.ssl.conf` → on EC2 stop nginx → `sudo certbot certonly --standalone --expand --cert-name circuits.matthew-chirichella.com -d <every>` → start nginx. DNS must resolve first.
- **Cert dir is `circuits.matthew-chirichella.com`** even though `circuits.com` is primary (SAN match). Renaming is cosmetic + requires nginx path updates.
- **`./deploy.sh` (no flag) does NOT restart nginx** → 502 (stale upstream DNS). Always chase with `./deploy.sh --frontend`.
- **`docker compose restart` does NOT re-evaluate `${VAR:-}` from `.env`** — env-only changes need `up -d --force-recreate <svc>`. Verify: `exec -T api python -c "from app.config import settings; print(...)"`.
- **`docker compose exec -T <svc> <cmd>` consumes stdin** of wrapping `ssh ... <<HEREDOC` — rest of heredoc never reaches remote. Always `... exec -T < /dev/null`.
- **Avoid `grid-template-columns: 1fr auto 1fr` with asymmetric side-track content** — `1fr` = `minmax(auto, 1fr)`. Use `position: absolute` on a relative parent.
- **Admin login creds (local dev)**: `matthew`/`mike`/`john` all password `admin` (seeded in `api/app/db/seed.py`, admin-user block). `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars are for SQLAdmin only (unreachable in prod).
- **Breakpoints in `_variables.scss`**: `$bp-mobile: 768px`, `$bp-tablet: 1024px`, `$bp-desktop: 1199px`, `$bp-admin-mobile: 820px`, `$bp-admin-compact: 420px`. Use `@include responsive(...)`.
- **Mobile drawer state-machine** (Navbar.tsx + AdminLayout.tsx): `useState(menuOpen)` + 3 effects on `[menuOpen]` — body-scroll-lock (capture+restore `prev`), Esc keydown (attach only while open), `[location.pathname]` for auto-close. Drawer link `onClick` calls `setMenuOpen(false)` BEFORE NavLink navigates. Compositor-only animations (transform+opacity).
- **Admin `<aside>` needs conditional `aria-hidden`**: `aria-hidden={!menuOpen ? undefined : false}` (no attr when closed, `"false"` when open). Public drawer's `aria-hidden={!menuOpen}` would set `"true"` at desktop where the admin sidebar IS visible.
- **`backdrop-filter: blur(2px)` on a full-viewport scrim is OK on mobile** when scrim only animates opacity. Don't add to elements that translate/scale.
- **Mobile data tables**: `display: block; overflow-x: auto` + `thead, tbody { display: table; min-width: <px> }`. Public PartsTable hides Manufacturer + Distributors + Description via `.thMobileHide` / `.tdMobileHide` at <768px so SKU + Price + Status fit 430px viewport.
- **Buttons inherit `line-height: 1.6`** from body — overflows height-constrained rows. Fix: explicit `line-height: 1` + control height via padding.
- **Sub-pixel text blur from `transform: translate*(-50%)`** — fractional pixels + GPU layer = subpixel glyph raster. Use `top: 0; bottom: 0; display: flex; align-items: center`.
- **`filter: hue-rotate(0deg)` is NOT free** — promotes to compositor layer even at 0deg. Gate behind non-default themes.
- **URL-param-absent ≠ default-intent** — a default-button click that clears a URL param is shadowed by stale localStorage. Write the default to localStorage SYNCHRONOUSLY before `setParams`.
- **Inner-page surface-bg goes on a body WRAPPER inside motion.div, NOT on motion.div** — `<BackdropLayer />` (z-index: 0, top: $nav-height, height: 420px) needs visibility through the band on inner pages. motion.div has no bg; an inner `<div>` carries `background: var(--theme-surface-bg)`. PageHeaderBand + HeroSection are TRANSPARENT.
- **Don't reintroduce `AnimatePresence` around `<Suspense><Outlet/></Suspense>`** — FM12 leaves the second-nav entering motion.div stuck at the previous child's exit-state (both `mode="wait"` and `"popLayout"`).
- **`.outletWrap { position: relative; z-index: 1 }` is load-bearing** — without it, painting order puts BackdropLayer (z-index: 0) ON TOP of static page descendants.
- **Verify SVG persistence across SPA nav with session-marker pattern** — `svg.dataset.sessionMarker = 'tag-' + Date.now()` before NavLink click, then `evaluate_script` after. Stronger than visual diff.
- **Don't gate visible content on JS-added classes inside `AnimatePresence`** — IO callbacks fire unreliably mid-transform, leaving `opacity: 0` stuck. Default visible; trigger entrance via `setTimeout`.
- **Admin sponsors localStorage-persisted, NOT API-backed** — key `circuits.admin.sponsors`. Use `@admin/services/sponsorStore.ts` (`loadSponsors / findSponsor / upsertSponsor / deleteSponsor`). Seed-sponsor fake `category_id` values (`cat-pmic`, `cat-sensors`) never match live API category UUIDs — seeds carry their own `category_icon` field for the v5 Phosphor render.
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
