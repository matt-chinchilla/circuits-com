# Circuit Center

Electronic components directory prototype — Vite React SPA + FastAPI + PostgreSQL, all in Docker. Live at [circuitcenter.ai](https://circuitcenter.ai). Built as a functional demo of a modern, animated redesign with category browsing, distributor price comparison, sponsor tier boards, keyword sponsorships, and an admin console with charts, expenses and a guided onboarding wizard.

## Architecture

```
                            Browser (HTTPS / HTTP/2)
                                     |
                              Nginx (:80 :443)
                              SSL terminate · HSTS
                              /          |           \
                             /           |            \
                  /          /api/*     /admin*
                 ↓             ↓           ↓
          Frontend (:3000)   API (:8000)   Frontend (:3000)
          Vite React SPA     FastAPI       React admin SPA (JWT)
                                ↓
                         PostgreSQL (:5432)
                                ↕
                            n8n (:5678)
                       (in compose, NOT in form path)
```

Five Docker containers orchestrated by Docker Compose:

| Service      | Image / Build       | Port            | Purpose                                  |
|--------------|---------------------|-----------------|------------------------------------------|
| **nginx**    | nginx:alpine        | 80 / 443        | Reverse proxy, HTTP/2 + HSTS in prod     |
| **frontend** | ./frontend          | 3000            | React 19 SPA (public + admin)            |
| **api**      | ./api               | 8000            | FastAPI · JWT auth · alembic + seed on boot |
| **db**       | postgres:16-alpine  | 5432            | Persistent data store                    |
| **n8n**      | ./n8n               | 5678            | Workflow automation (kept for future, no live workflows) |

Production: t3.small EC2 (`i-0d456bd12719e2176`) **with a 2 GB swapfile**, EIP `100.55.235.167`, SAN cert covers `circuitcenter.ai`, `www.circuitcenter.ai`. The swapfile and `deploy.sh`'s **sequential** frontend-then-api build both exist because a concurrent build OOM-killed the box on 2026-07-30.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (v20+) and [Docker Compose](https://docs.docker.com/compose/) (v2+)
- Python ≥3.12 (only for local-outside-docker API work)
- Node.js ≥18 (only for local-outside-docker frontend work)

## Quick Start

```bash
docker compose up --build
```

Open [http://localhost](http://localhost). On first launch the api container automatically runs Alembic migrations and seeds the database (idempotent).

Sign in at [http://localhost/admin/login](http://localhost/admin/login). **Login is by email**, e.g. `matthew@circuitcenter.ai`. Local seed passwords come from `SEED_PW_*` env vars with dev fallbacks (`matthew` → `admin`, the rest → `changeme-dev`); real values live only in `/opt/circuits-com/.env` on prod. To look around without credentials, use the **See Demo →** button on the sign-in screen — it calls `POST /api/auth/demo`, which mints a token server-side, so no password ships in the JS bundle.

### Production stack locally

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build
```

Multi-stage frontend build (nginx serves the static Vite bundle), uvicorn with 4 workers, SSL nginx config (needs certs mounted).

## Admin Access & Auth

Reworked 2026-07-31 (alembic **022**); see `docs/superpowers/specs/2026-07-31-mail-server-and-auth-design.md`.

| Aspect | Reality |
|---|---|
| **Login key** | **Email**, case-insensitive (`lower(email)` unique index `uq_users_email_lower`). No username fallback for any account. |
| **Accounts** | `matthew` (role **owner**), `Anthony`, `Daniel`, `Ronald` (role `admin`), `demo`. All `<name>@circuitcenter.ai`. |
| **Password policy** | 8-24 characters, ≥1 uppercase, ≥1 number, ≥1 symbol. One backend home (`app/services/password_policy.py`) mirrored in `frontend/src/admin/services/passwordPolicy.ts`; a 422 returns the failed rule keys as `detail.unmet`. |
| **Forced first-login reset** | Migration 022 flagged the four staff rows `must_change_password`. A flagged session gets `403 password_change_required` on every admin route and is routed to `/admin/change-password`. (A *fresh* local DB seeds after migrations, so the flag — and the `owner` promotion — apply to the prod rows, not to newly seeded ones.) |
| **Session invalidation** | Changing a password stamps `password_changed_at`; every token minted before it 401s. No revocation table. The change endpoint returns a fresh token. |
| **Rate limiting** | In-process (`app/services/rate_limit.py`), separate `login:` / `recovery:` namespaces, keyed per-IP **and** per-account: 5 failures arm a 60s lock that doubles to a 15-minute ceiling, cleared by a success, forgotten after 15 quiet minutes. Counters are per-worker. |
| **Demo account** | Exempt from the forced reset, and **has no credential login** — `POST /api/auth/demo` is its only door (404s, never 403s, when `DEMO_LOGIN_ENABLED=false`). |
| **Anti-enumeration** | An unknown address burns a dummy bcrypt hash, records the same failure and returns the same generic 401; recovery endpoints always answer OK. Nothing reveals whether an account exists. |
| **Recovery** | `POST /api/auth/forgot-password` → emailed reset link (origin is always `settings.APP_BASE_URL`, never the request Host). `forgot-username` is retired — **410 Gone** — because the login key *is* the address. |

## Public Routes

| Route                             | Page                | Description                                                |
|-----------------------------------|---------------------|------------------------------------------------------------|
| `/`                               | HomePage            | Hero with animated circuit traces + category grid          |
| `/category/:slug`                 | CategoryPage        | Top-level category: parts table, sort/filter, sponsor tier boards, subcategory pills |
| `/category/:parentSlug/:childSlug`| CategoryPage        | Canonical subcategory URL (flat child slugs redirect here) |
| `/search`                         | SearchPage          | Global search across parts, suppliers, categories          |
| `/part/:id`                       | PartPage            | Part detail with distributor comparison + deep-links       |
| `/keyword`                        | KeywordLandingPage  | Keyword sponsorship marketing landing (tiers + FAQ)        |
| `/keyword/:keyword`               | KeywordSponsorPage  | Per-keyword sponsor profile + request modal                |
| `/about`                          | AboutPage           | Company overview / value proposition                       |
| `/join`                           | JoinPage            | Supplier signup / partnership inquiry form                 |
| `/contact`                        | ContactPage         | Contact form (founder datasheet motif)                     |
| `/privacy`, `/terms`              | PrivacyPage         | Consolidated legal page (same component, two routes)       |
| `*`                               | NotFoundPage        | 404 inside the public layout chrome                        |

## Admin Routes (JWT-gated)

| Route                              | Page                | Description                                       |
|------------------------------------|---------------------|---------------------------------------------------|
| `/admin/login`                     | LoginPage           | Email + password → JWT · "See Demo" · recovery    |
| `/admin/reset-password`            | ResetPasswordPage   | Consume an emailed reset token                    |
| `/admin/change-password`           | ChangePasswordPage  | Forced/self-service change with a live rule checklist |
| `/admin`                           | DashboardPage       | ECharts KPIs, revenue vs. expenses, sponsors, book of business |
| `/admin/suppliers`                 | SuppliersPage       | Supplier list with sponsorship badges             |
| `/admin/suppliers/new`             | SupplierFormPage    | Create supplier                                   |
| `/admin/suppliers/:id`             | SupplierDetailPage  | Detail + Quick Actions hero strip                 |
| `/admin/suppliers/:id/edit`        | SupplierFormPage    | Edit supplier                                     |
| `/admin/parts`                     | PartsPage           | Parts list with column-header sort/filter         |
| `/admin/parts/new`                 | PartFormPage        | Create part                                       |
| `/admin/parts/:id`                 | PartDetailPage      | Part detail                                       |
| `/admin/parts/:id/edit`            | PartFormPage        | Edit part                                         |
| `/admin/parts/:id/listings/new`    | AttachListingPage   | Attach an existing part to a supplier as a listing |
| `/admin/categories`                | CategoriesPage      | Category taxonomy management                      |
| `/admin/sponsors`                  | SponsorsPage        | Sponsor list (column sort/filter, tier chips)     |
| `/admin/sponsors/new`              | SponsorFormPage     | Create sponsor (category OR keyword, XOR)         |
| `/admin/sponsors/:id/edit`         | SponsorFormPage     | Edit sponsor                                      |
| `/admin/expenses`                  | ExpensesPage        | Operating-expense list (the cost side of the P&L) |
| `/admin/expenses/new`              | ExpenseFormPage     | Create expense                                    |
| `/admin/expenses/:id/edit`         | ExpenseFormPage     | Edit expense                                      |
| `/admin/messages`                  | MessagesListPage    | Inbox: Contact, Join, Keyword-Request messages    |
| `/admin/messages/:id`              | MessageDetailPage   | Message detail with type-branched layout          |
| `/admin/import`                    | ImportPage          | CSV bulk import for parts / suppliers             |
| `/admin/reports`                   | ReportsPage         | Revenue + site analytics dashboards               |
| `/admin/settings`                  | SettingsPage        | Admin settings                                    |

Admin also includes a guided-tour **Wizard FAB** with 8 walkthroughs (`add-supplier`, `add-part-to-supplier`, `import-csv`, `add-sponsorship`, `reply-message`, `import-queue`, `add-part-general`, `add-part-supplier`).

## Notable Surfaces

- **Sponsor tier boards** on category pages, all fed from one `sponsors` table: **Platinum** `<canvas>` tile field (top-level categories), **Gold** flashlight PCB card (subcategory), **Silver** partner directory (subcategory, multi-occupant). Sold boards repaint in the sponsor's brand colors ("brand takeover"); unsold ones render a designed open-placement pitch.
- **Logo cropper + image proxy** — admin uploads run through a pan/zoom square cropper and are stored as base64 data-URLs (the api container has no volume mount, the DB does). Pasted image URLs are fetched via `GET /api/admin/image-proxy` (SSRF-guarded, private/link-local ranges rejected) so the canvas isn't tainted for cropping and brand-color extraction.
- **ECharts admin dashboard** — revenue and expense month-over-month comparators, category spend breakdown, active-sponsor donut, and a force-directed "book of business" graph of sponsorships per sales rep.
- **Admin light/dark mode** and **topbar presence bubbles** (15s heartbeat to `POST /api/admin/presence/ping`, 40s TTL) showing who else has the console open.
- **Site analytics** — an inline SPA tracker posts to `/api/track`; `/api/dashboard/analytics` aggregates traffic, pages, referrers, devices and browsers.

## API Endpoints

All endpoints are prefixed with `/api`. Interactive docs at [http://localhost:8000/docs](http://localhost:8000/docs) (Swagger UI). `(auth)` = requires `Authorization: Bearer <JWT>` header.

### Public

| Method | Path                                | Description                                          |
|--------|-------------------------------------|------------------------------------------------------|
| GET    | `/api/categories/`                  | List all categories with featured-supplier rollups   |
| GET    | `/api/categories/{slug}`            | Category detail: children, parent, suppliers, sponsor, parts, popular parts |
| GET    | `/api/categories/{slug}/partners`   | Tier boards for a category: platinum / gold / silver  |
| GET    | `/api/suppliers/`                   | List all suppliers with parts_count + category names |
| GET    | `/api/suppliers/{id}`               | Supplier detail with revenue + categories            |
| GET    | `/api/suppliers/{id}/parts`         | Paginated parts carried by a supplier                |
| GET    | `/api/search/`                      | Unified search across categories + suppliers + parts |
| GET    | `/api/parts/`                       | Paginated parts list with filters                    |
| GET    | `/api/parts/{id}`                   | Part by UUID, includes listings + price breaks       |
| GET    | `/api/parts/by-slug/{slug}`         | Part by URL slug                                     |
| GET    | `/api/sponsors/keyword/{keyword}`   | Sponsor info for a keyword landing page              |
| GET    | `/api/sitemap.xml`                  | Dynamic SEO sitemap (~3,700 URLs)                    |
| POST   | `/api/track`                        | Record a PageView (rate-limited 30/min/session)      |
| POST   | `/api/contact`                      | Contact form → Message row + admin email             |
| POST   | `/api/join`                         | Join form → Message row + admin email + autoreply    |
| POST   | `/api/keyword-request`              | Keyword sponsorship request → Message + admin email  |

### Auth

Login and demo access are rate-limited (see **Admin Access & Auth**).

| Method | Path                                | Description                                          |
|--------|-------------------------------------|------------------------------------------------------|
| POST   | `/api/auth/login`                   | Authenticate **email** + password → JWT + `must_change_password` |
| POST   | `/api/auth/demo`                    | One-click demo session — no body, no credentials      |
| POST   | `/api/auth/change-password`         | Change password; clears a forced reset, returns a fresh token (auth) |
| POST   | `/api/auth/forgot-password`         | Email a reset link — always a generic OK              |
| POST   | `/api/auth/reset-password`          | Consume a reset token, set a policy-compliant password |
| POST   | `/api/auth/forgot-username`         | Retired — always **410 Gone**                         |
| POST   | `/api/auth/logout`                  | No-op (client discards token)                         |
| GET    | `/api/auth/me`                      | Current authenticated user (auth)                     |

### Dashboard (auth)

| Method | Path                                | Description                                          |
|--------|-------------------------------------|------------------------------------------------------|
| GET    | `/api/dashboard/demo-status`        | Whether demo data is loaded (unauthenticated)        |
| GET    | `/api/dashboard/stats`              | Aggregate counts: parts/suppliers/revenue/sponsors   |
| GET    | `/api/dashboard/trends`             | Five day-indexed series for the KPI sparklines       |
| GET    | `/api/dashboard/revenue`            | Trailing-12-month revenue by month/type              |
| GET    | `/api/dashboard/revenue-compare`    | Month-over-month revenue, one point per day-of-month |
| GET    | `/api/dashboard/expenses`           | Same shape as revenue-compare, over Expense rows     |
| GET    | `/api/dashboard/expenses/breakdown` | Current-month spend grouped by category              |
| GET    | `/api/dashboard/sales-reps`         | Book of business per rep, from active `sold_by` sponsorships |
| GET    | `/api/dashboard/activity`           | Recent activity feed                                 |
| GET    | `/api/dashboard/popular`            | Top 10 categories + top 10 suppliers                 |
| GET    | `/api/dashboard/analytics`          | Site analytics: traffic, top pages, referrers, devices |

### Admin write surface (auth)

| Method | Path                                        | Description                                  |
|--------|---------------------------------------------|----------------------------------------------|
| POST   | `/api/suppliers/`                           | Create supplier                              |
| PUT    | `/api/suppliers/{id}`                       | Update supplier                              |
| DELETE | `/api/suppliers/{id}`                       | Cascade-delete supplier + dependents         |
| POST   | `/api/parts/`                               | Create part (+ optional initial listing)     |
| PUT    | `/api/parts/{id}`                           | Update part                                  |
| DELETE | `/api/parts/{id}`                           | Delete part + cascade                        |
| POST   | `/api/parts/{id}/listings`                  | Attach an existing part to a supplier        |
| DELETE | `/api/parts/{id}/listings/{listing_id}`     | Detach a listing                             |
| POST   | `/api/parts/batch`                          | Bulk import parts under one supplier         |
| GET    | `/api/admin/messages/`                      | List inbox messages                          |
| GET    | `/api/admin/messages/{id}`                  | Message detail                               |
| PATCH  | `/api/admin/messages/{id}`                  | Update status/assignment/reply               |
| GET    | `/api/admin/sponsors/`                      | List sponsors with joined info               |
| POST   | `/api/admin/sponsors/`                      | Create sponsor — XOR(category, keyword)      |
| PATCH  | `/api/admin/sponsors/{id}`                  | Update sponsor                               |
| DELETE | `/api/admin/sponsors/{id}`                  | Delete sponsor                               |
| GET    | `/api/admin/expenses/`                      | List operating expenses                      |
| POST   | `/api/admin/expenses/`                      | Create expense                               |
| PATCH  | `/api/admin/expenses/{id}`                  | Update expense                               |
| DELETE | `/api/admin/expenses/{id}`                  | Delete expense                               |
| GET    | `/api/admin/sales-reps`                     | Admin usernames — the `sold_by` options       |
| POST   | `/api/admin/presence/ping`                  | Presence heartbeat → everyone currently active |
| GET    | `/api/admin/image-proxy`                    | Server-side fetch of a remote image (SSRF-guarded) |

## CLI Commands

### Dev stack

| Command | Purpose |
|---|---|
| `docker compose up --build` | Build + start all 5 services in foreground |
| `docker compose up -d --build` | Same, detached |
| `docker compose up -d --build api` | Rebuild + restart only api (no volume mount → required after Python edits) |
| `docker compose up -d --build frontend` | Rebuild + restart only frontend (~20s; no HMR in compose) |
| `docker compose up -d --force-recreate <svc>` | Re-evaluate `.env` vars (plain restart doesn't) |
| `docker compose build --no-cache frontend && docker compose up -d frontend` | Bust Docker layer cache when stale frontend served |
| `docker compose down` | Stop services, keep volumes |
| `docker compose down -v` | Stop + DROP `postgres-data` + `n8n-data` (destructive) |
| `docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build` | Prod stack locally |
| `docker compose logs --tail=50 -f` | Tail logs from all containers |
| `docker compose exec -T api <cmd> < /dev/null` | Exec without consuming heredoc stdin (deploy.sh trap) |
| `docker compose restart <svc>` | Restart a container — note: does **not** rebuild the image or re-read `.env` |

### API tooling

| Command | Purpose |
|---|---|
| `cd api && pip install -e ".[dev]"` | Install editable with dev extras (pytest, ruff, httpx) |
| `pytest tests/ -q` | Run the ~710-test API suite (SQLite in-memory; ~7 min) |
| `pytest tests/test_<file>.py -v` | Single test file |
| `pytest tests/test_<file>.py::test_<name>` | Single test |
| `pytest tests/ -k <expr>` | Filter by name expression |
| `pytest tests/ -x` | Stop at first failure |
| `alembic upgrade head` | Apply all migrations (auto-runs in prod api boot) |
| `alembic downgrade -1` | Revert one migration |
| `alembic revision --autogenerate -m "<msg>"` | Autogenerate migration from model diffs |
| `alembic current` / `alembic history` | Show current revision / full history |
| `python -m app.db.seed` | Idempotent seed (15 cats / 75 subs / 57 suppliers / 3,600 parts) |
| `uvicorn app.main:app --reload` | Dev hot-reload (local, outside Docker) |
| `ruff format .` / `ruff format --check .` | Format / verify format (line 100, py312) |
| `ruff check .` / `ruff check --fix .` | Lint (E/F/W/I/UP/B, ignore E501+B008) / auto-fix |

### Frontend tooling

| Command | Purpose |
|---|---|
| `cd frontend && npm install` | Install deps |
| `npm run dev` | Vite dev server on `:3000` with HMR |
| `npm run build` | `tsc -b && vite build` — type-check + prod bundle |
| `npx tsc -b` | **The type gate.** `tsc --noEmit` is a NO-OP here (solution tsconfig, `files: []`) — never use it |
| `npm test` | Vitest run (unit-logic only, `*.test.ts`) |
| `npm run preview` | Serve `dist/` locally for smoke tests |
| `npx eslint --ext .ts,.tsx src/` | Enforce boundary rules (admin↛public, public↛admin, shared↛either) |
| `npx eslint --ext .ts,.tsx src/ --fix` | Auto-fix lint issues |

### Deploy (run from repo root)

Requires AWS CLI configured, `~/.ssh/id_ed25519`, and `origin/master` pushed.

| Command | Purpose |
|---|---|
| `./deploy.sh` | Full deploy: git pull → build frontend → build api → up -d → **restart nginx** → prune → verify domains |
| `./deploy.sh --frontend` | Frontend-only rebuild + nginx restart + verify (skips the api rebuild/seed, avoiding the ~1-2 min `/api` 502 window) |
| `./deploy.sh --reseed` | Full deploy + TRUNCATE + reseed (destructive; messages survive) |
| `./deploy.sh --status` | Container status snapshot on EC2 |
| `./deploy.sh --logs` | Tail combined compose logs on EC2 |
| `./deploy.sh --cert-renew` | Stop nginx → certbot renew → start nginx → verify |
| `./deploy.sh --help` (or `-h`) | Print the usage header |

**How it works:** every command (except `--status` / `--logs` / `--help`) first runs `check_prerequisites` (AWS CLI auth, SSH key present, git clean + pushed to `origin/master`), then pushes a temporary SSH key to the box via **EC2 Instance Connect** and runs the prod compose stack (`docker compose -f docker-compose.yml -f docker-compose.prod.yml`) remotely over SSH. Builds are deliberately scoped to `frontend` and `api` — the `n8n` service is skipped to avoid re-extracting its ~313 MB base image — and run **one after the other**, because building both at once OOM-killed the t3.small. Nginx is restarted as part of the deploy (since 2026-06-02) so it re-resolves the new container IPs; the old `--frontend` chase is obsolete. Each deploy finishes with `docker image prune -f`, then `verify_site` curls the domains and reports their HTTP status.

### Git workflow

`master` = deploy tip · `updates` = active dev · ff-only merges, no squash.

```bash
# 1. Commit on updates
git add <files>          # specific files; avoid -A (.env / .playwright-mcp/ leakage)
git commit -m "..."      # no Co-Authored-By lines
git push origin updates

# 2. Promote to master + deploy
git checkout master && git merge --ff-only updates && git push origin master
./deploy.sh              # full deploy (frontend + api + nginx restart)
# OR
./deploy.sh --frontend   # frontend-only changes

# 3. Back to dev
git checkout updates
```

### Production diagnostics (ssh to EC2)

| Command | Purpose |
|---|---|
| `sudo docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'` | Container status |
| `sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml logs api --tail=200` | API logs (look for `Seeding database...` to confirm reseed) |
| `sudo docker exec -it circuits-com-db-1 psql -U circuits -d circuits` | Interactive psql |
| `sudo docker exec circuits-com-api-1 python -m app.db.seed` | Reseed (idempotent, non-destructive) |
| `sudo docker exec circuits-com-api-1 alembic current` | Current migration revision |
| `sudo docker exec -T circuits-com-api-1 python -c "from app.config import settings; print(settings.SMTP_HOST)" < /dev/null` | Verify env vars |
| `free -h` | Confirm the 2 GB swapfile is active before a heavy build |
| `curl -sI --http2 https://circuitcenter.ai/ -w '%{http_version}\n'` | Confirm HTTP/2 negotiation |
| `curl -sS -o /dev/null -w "%{http_code}" https://circuitcenter.ai` | Health check |

EC2 recovery: if a deploy hangs extracting layers, kill the orphaned `ssh ...ec2...` process; if it persists, **stop+start** the instance via AWS console (NOT reboot).

## Tech Stack

**Frontend** — React 19 · TypeScript 5.7 (strict) · Vite 6 · SCSS Modules · Framer Motion · React Router 7 · Axios · ECharts · react-helmet-async · react-dropzone · PapaParse · Workbox PWA (SW + SWR on `/api/categories`) · Phosphor Light icon font (self-hosted) · Vitest

**Backend** — Python 3.12 · FastAPI · SQLAlchemy 2.0 · Alembic · Pydantic (pydantic-settings) · Uvicorn · httpx · aiosmtplib · JWT auth (PyJWT + bcrypt)

**Database** — PostgreSQL 16 (Alpine)

**Infrastructure** — Docker + Compose · Nginx (HTTP/2, HSTS, SSL terminate) · AWS EC2 (t3.small + 2 GB swap, Amazon Linux) · Let's Encrypt SAN cert · **AWS SES** for outbound mail (domain verified, out of the sandbox) · n8n (in compose, not in form path)

**Static analysis** — Ruff (api) · TypeScript strict + ESLint boundary rules (frontend) · pytest · vitest

## Project Structure

```
.
├── api/                          # FastAPI backend
│   ├── alembic/                  #   Database migrations (head: 022)
│   ├── app/
│   │   ├── db/
│   │   │   ├── catalog_data/     #   15 JSON files, 3,600 real parts
│   │   │   └── seed.py           #   Idempotent seed
│   │   ├── models/               #   SQLAlchemy models
│   │   ├── routes/               #   FastAPI routers (categories, suppliers, parts, auth, dashboard, admin_*, forms, analytics, sitemap)
│   │   ├── schemas/              #   Pydantic schemas
│   │   ├── services/             #   Business logic (category, search, auth, password_policy, rate_limit, email, aws_cost)
│   │   ├── utils/                #   Shared validators (image_url, color)
│   │   ├── config.py             #   pydantic-settings
│   │   └── main.py
│   └── tests/                    #   ~710 tests, SQLite in-memory
├── frontend/                     # React 19 SPA (Vite 6)
│   └── src/
│       ├── public/               #   Public site (pages, components, hooks, services, types)
│       ├── admin/                #   Admin SPA (pages, components, services, wizard, contexts)
│       ├── shared/               #   Cross-scope only (≥2-consumer rule)
│       ├── App.tsx
│       └── main.tsx
├── nginx/
│   ├── nginx.conf                # Dev (HTTP only)
│   └── nginx.ssl.conf            # Prod (HTTPS + HTTP/2 + HSTS)
├── docs/
│   ├── superpowers/              # Design specs + implementation plans (the written record)
│   ├── architecture/
│   └── design-briefs/
├── scripts/
│   └── agents                    # Live viewer for Claude subagent transcripts (`./scripts/agents -f`)
├── n8n/                          # n8n image build (kept for future workflows)
├── k8s/                          # Kubernetes manifests (legacy reference; prod uses EC2 + deploy.sh)
├── tests/visual/                 # Visual regression baselines (chrome-devtools-mcp)
├── deploy.sh                     # Prod deploy entrypoint
├── docker-compose.yml            # Dev compose
└── docker-compose.prod.yml       # Production overrides (HTTP/2 nginx, prod frontend stage, 4 uvicorn workers)
```

ESLint boundary rules (in `frontend/.eslintrc.json`): `admin/` ↛ `public/`, `public/` ↛ `admin/`, `shared/` ↛ either. Path aliases `@public/*`, `@admin/*`, `@shared/*`.

## Seed Data

The seed is idempotent. `./deploy.sh --reseed` truncates and re-runs (destructive).

- **15 top-level categories** (Microcontrollers, Analog ICs, Audio/Video, Sensors, RF/Wireless, PMICs, Power Management, …) with 5 subcategories each = **75 subcategories**
- **57 suppliers** — 7 demo (Avnet, Arrow, Digi-Key, Future, Kennedy, Mouser, TTI) + 50 real distributors (element14, RS Components, TME, Newark, Farnell, Pasternack, Richardson RFPD, Heilind, Conrad, Distrelec, …)
- **~3,600 parts** across all subcategories (real SKUs, manufacturers, datasheet URLs)
- **~41,000 PartListings** (~8–15 distributor listings per part)
- **~164,000 PriceBreaks** (qty 10 / 100 / 1K / 5K tiers per listing)
- **13 sponsorships** — 2 Platinum (Kennedy on two flagship top-level categories), 5 Gold (subcategory), 5 Silver (subcategory directory), 1 Silver keyword (`capacitors`). The other 13 top-level categories are deliberately left unsold so the open-placement pitch renders. *(Prod carries more — sponsorships sold through the admin console are not seed rows.)*
- **12 months of revenue** rows + **3 months of operating expenses**
- **5 admin users** — `matthew`, `Anthony`, `Daniel`, `Ronald`, `demo`, each with an `@circuitcenter.ai` address (the login key). Staff passwords come from `SEED_PW_*` env vars; `demo` has no credential login.

## Environment Variables

Set via `.env` at repo root (gitignored). Defaults work for local dev.

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | `postgresql://circuits:circuits@db:5432/circuits` |
| `CORS_ORIGINS` | JSON or CSV of allowed origins | `["http://localhost:3000", "http://localhost"]` |
| `APP_BASE_URL` | Trusted origin for links in recovery emails — never derived from the request Host | `https://circuitcenter.ai` |
| `DEMO_LOGIN_ENABLED` / `DEMO_LOGIN_EMAIL` | One-click demo access (`POST /api/auth/demo`); disabling makes the route 404 with no frontend redeploy | `true` / `demo@circuitcenter.ai` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD` / `SMTP_FROM` | Outbound relay for form + recovery mail (AWS SES in prod) | unset → demo mode (logs only) |
| `NOTIFY_RECIPIENTS` | JSON or CSV of admin notify emails | owner inbox |
| `SEED_PW_MATTHEW` / `SEED_PW_ANTHONY` / `SEED_PW_DANIEL` / `SEED_PW_RONALD` | Seed passwords for the staff accounts | `admin` / `changeme-dev` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | SQLAdmin credentials (unreachable in prod) | `admin` / `admin` |
| `ADMIN_SECRET_KEY` | JWT signing key — **required** in prod (`docker-compose.prod.yml` fails fast without it) | dev-only placeholder |

In prod, real SMTP creds and `ADMIN_SECRET_KEY` live in `/opt/circuits-com/.env` on the EC2 box (not committed).

## n8n

The `n8n` container is still in `docker-compose.yml` for potential future workflow use, but **is no longer in the form-submission path**. Forms POST to FastAPI, which persists a `Message` row to Postgres and schedules SMTP sends via `BackgroundTasks` → `app.services.email.send_*_notification` (aiosmtplib → the configured relay).

## Roadmap

**P2 — self-hosted mail (designed, not built).** `docker-mailserver` on a dedicated t4g.micro, relaying outbound through SES; per-person mailboxes that share the site password via a push-sync (only the derived hash leaves the web box); admin **Messages** promoted into a shared company inbox. Design: `docs/superpowers/specs/2026-07-31-mail-server-and-auth-design.md`.

## Kubernetes (legacy reference)

`k8s/` contains deployment manifests for `namespace`, `db`, `api`, `frontend`, `n8n`, and an nginx ingress. **Prod actually runs on EC2 via `./deploy.sh`** — the manifests are kept as reference and may not reflect the latest models / migrations / auth surface.
