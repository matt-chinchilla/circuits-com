# CircuitCenter

Electronic components directory prototype — Vite React SPA + FastAPI + PostgreSQL, all in Docker. Live at [circuitcenter.ai](https://circuitcenter.ai). Built as a functional demo of a modern, animated redesign with category browsing, distributor price comparison, keyword sponsorships, and an admin console with a guided onboarding wizard.

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

Production: t3.small EC2 (`i-0d456bd12719e2176`), EIP `100.55.235.167`, SAN cert covers `circuitcenter.ai`, `www.circuitcenter.ai`.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (v20+) and [Docker Compose](https://docs.docker.com/compose/) (v2+)
- Python ≥3.12 (only for local-outside-docker API work)
- Node.js ≥18 (only for local-outside-docker frontend work)

## Quick Start

```bash
docker compose up --build
```

Open [http://localhost](http://localhost). On first launch the api container automatically runs Alembic migrations and seeds the database (idempotent).

**Default admin credentials** (all password `admin`): `matthew`, `mike`, `john`. Sign in at [http://localhost/admin/login](http://localhost/admin/login).

### Production stack locally

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build
```

Multi-stage frontend build (nginx serves the static Vite bundle), uvicorn with 4 workers, SSL nginx config (needs certs mounted).

## Public Routes

| Route                  | Page                | Description                                                |
|------------------------|---------------------|------------------------------------------------------------|
| `/`                    | HomePage            | Hero with animated circuit traces + category grid          |
| `/category/:slug`      | CategoryPage        | Parts table, sort/filter, sponsor block, supplier list     |
| `/search`              | SearchPage          | Global search across parts, suppliers, categories          |
| `/part/:id`            | PartPage            | Part detail with distributor comparison + deep-links       |
| `/keyword`             | KeywordLandingPage  | Keyword sponsorship marketing landing (tiers + FAQ)        |
| `/keyword/:keyword`    | KeywordSponsorPage  | Per-keyword sponsor profile + request modal                |
| `/about`               | AboutPage           | Company overview / value proposition                       |
| `/join`                | JoinPage            | Supplier signup / partnership inquiry form                 |
| `/contact`             | ContactPage         | Contact form (founder datasheet motif)                     |
| `/privacy`, `/terms`   | PrivacyPage         | Consolidated legal page (same component, two routes)       |

## Admin Routes (JWT-gated)

| Route                              | Page                | Description                                       |
|------------------------------------|---------------------|---------------------------------------------------|
| `/admin/login`                     | LoginPage           | Username + password → JWT                         |
| `/admin`                           | DashboardPage       | KPIs, sparklines, recent activity                 |
| `/admin/suppliers`                 | SuppliersPage       | Supplier list with derived tiers                  |
| `/admin/suppliers/new`             | SupplierFormPage    | Create supplier                                   |
| `/admin/suppliers/:id`             | SupplierDetailPage  | Detail + Quick Actions hero strip                 |
| `/admin/suppliers/:id/edit`        | SupplierFormPage    | Edit supplier                                     |
| `/admin/parts`                     | PartsPage           | Parts list with Excel-pattern sort/filter         |
| `/admin/parts/new`                 | PartFormPage        | Create part                                       |
| `/admin/parts/:id`                 | PartDetailPage      | Part detail                                       |
| `/admin/parts/:id/edit`            | PartFormPage        | Edit part                                         |
| `/admin/categories`                | CategoriesPage      | Category taxonomy management                      |
| `/admin/sponsors`                  | SponsorsPage        | Sponsor list                                      |
| `/admin/sponsors/new`              | SponsorFormPage     | Create sponsor (category OR keyword, XOR)         |
| `/admin/sponsors/:id/edit`         | SponsorFormPage     | Edit sponsor                                      |
| `/admin/messages`                  | MessagesListPage    | Inbox: Contact, Join, Keyword-Request messages    |
| `/admin/messages/:id`              | MessageDetailPage   | Message detail with type-branched layout          |
| `/admin/import`                    | ImportPage          | CSV bulk import for parts / suppliers             |
| `/admin/reports`                   | ReportsPage         | Revenue + site analytics dashboards               |
| `/admin/settings`                  | SettingsPage        | Admin settings                                    |

Admin also includes a guided-tour **Wizard FAB** with 7 walkthroughs (`add-supplier`, `add-part-to-supplier`, `import-csv`, `add-sponsorship`, `reply-message`, `import-queue`, `add-part-general`).

## API Endpoints

All endpoints are prefixed with `/api`. Interactive docs at [http://localhost:8000/docs](http://localhost:8000/docs) (Swagger UI). `(auth)` = requires `Authorization: Bearer <JWT>` header.

### Public

| Method | Path                                | Description                                          |
|--------|-------------------------------------|------------------------------------------------------|
| GET    | `/api/categories/`                  | List all categories with featured-supplier rollups   |
| GET    | `/api/categories/{slug}`            | Category detail: children, parent, suppliers, sponsor, parts, popular parts |
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

### Auth + Dashboard

| Method | Path                                | Description                                          |
|--------|-------------------------------------|------------------------------------------------------|
| POST   | `/api/auth/login`                   | Authenticate username/password → JWT                 |
| POST   | `/api/auth/logout`                  | No-op (client discards token)                        |
| GET    | `/api/auth/me`                      | Current authenticated user (auth)                    |
| GET    | `/api/dashboard/demo-status`        | Whether demo data is loaded                          |
| GET    | `/api/dashboard/stats`              | Aggregate counts: parts/suppliers/revenue/sponsors (auth) |
| GET    | `/api/dashboard/activity`           | Recent activity feed (auth)                          |
| GET    | `/api/dashboard/revenue`            | Trailing-12-month revenue by month/type (auth)       |
| GET    | `/api/dashboard/popular`            | Top 10 categories + top 10 suppliers (auth)          |
| GET    | `/api/dashboard/analytics`          | Site analytics: traffic, top pages, referrers, devices (auth) |

### Admin write surface

| Method | Path                                        | Description                                  |
|--------|---------------------------------------------|----------------------------------------------|
| POST   | `/api/suppliers/`                           | Create supplier (auth)                       |
| PUT    | `/api/suppliers/{id}`                       | Update supplier (auth)                       |
| DELETE | `/api/suppliers/{id}`                       | Cascade-delete supplier + dependents (auth)  |
| POST   | `/api/parts/`                               | Create part (+ optional initial listing) (auth) |
| PUT    | `/api/parts/{id}`                           | Update part (auth)                           |
| DELETE | `/api/parts/{id}`                           | Delete part + cascade (auth)                 |
| POST   | `/api/parts/batch`                          | Bulk import parts under one supplier (auth)  |
| GET    | `/api/admin/messages/`                      | List inbox messages (auth)                   |
| GET    | `/api/admin/messages/{id}`                  | Message detail (auth)                        |
| PATCH  | `/api/admin/messages/{id}`                  | Update status/assignment/reply (auth)        |
| GET    | `/api/admin/sponsors/`                      | List sponsors with joined info (auth)        |
| POST   | `/api/admin/sponsors/`                      | Create sponsor — XOR(category, keyword) (auth) |
| PATCH  | `/api/admin/sponsors/{id}`                  | Update sponsor (auth)                        |
| DELETE | `/api/admin/sponsors/{id}`                  | Delete sponsor (auth)                        |
| POST   | `/api/admin/category-suppliers/feature`     | Upsert CategorySupplier as featured (auth)   |

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
| `pytest tests/ -v` | Run the ~165-test API suite (SQLite in-memory) |
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
| `npm run preview` | Serve `dist/` locally for smoke tests |
| `npx tsc --noEmit` | Type-check only (strict + noUnused*) |
| `npx eslint src/` | Enforce boundary rules (admin↛public, public↛admin, shared↛either) |
| `npx eslint src/ --fix` | Auto-fix lint issues |

### Deploy (run from repo root)

Requires AWS CLI configured, `~/.ssh/id_ed25519`, and `origin/master` pushed.

| Command | Purpose |
|---|---|
| `./deploy.sh` | Full deploy: git pull → build api+frontend → up -d → prune → verify 3 domains. **Does NOT restart nginx** (chase with `--frontend`) |
| `./deploy.sh --frontend` | Frontend rebuild + nginx restart + verify. **Single-step sufficient for FE-only changes** |
| `./deploy.sh --reseed` | Full deploy + TRUNCATE + reseed (destructive; messages survive) |
| `./deploy.sh --status` | Container status snapshot on EC2 |
| `./deploy.sh --logs` | Tail combined compose logs on EC2 |
| `./deploy.sh --cert-renew` | Stop nginx → certbot renew → start nginx → verify |
| `./deploy.sh --help` (or `-h`) | Print the usage header |

**How it works:** every command (except `--status` / `--logs` / `--help`) first runs `check_prerequisites` (AWS CLI auth, SSH key present, git clean + pushed to `origin/master`), then pushes a temporary SSH key to the box via **EC2 Instance Connect** and runs the prod compose stack (`docker compose -f docker-compose.yml -f docker-compose.prod.yml`) remotely over SSH. Builds are deliberately scoped to `api frontend` — the `n8n` service is skipped to avoid re-extracting its ~313 MB base image, which would OOM the t3.small. Each deploy finishes with `docker image prune -f` to clear dangling layers, then `verify_site` curls all three domains and reports their HTTP status.

### Git workflow

`master` = deploy tip · `updates` = active dev · ff-only merges, no squash.

```bash
# 1. Commit on updates
git add <files>          # specific files; avoid -A (.env / .playwright-mcp/ leakage)
git commit -m "..."      # no Co-Authored-By lines
git push origin updates

# 2. Promote to master + deploy
git checkout master && git merge --ff-only updates && git push origin master
./deploy.sh              # API changes (chase with --frontend)
# OR
./deploy.sh --frontend   # frontend-only changes (single step)

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
| `sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml restart nginx` | Recover from 502 after bare `./deploy.sh` |
| `curl -sI --http2 https://circuitcenter.ai/ -w '%{http_version}\n'` | Confirm HTTP/2 negotiation |
| `curl -sS -o /dev/null -w "%{http_code}" https://circuitcenter.ai` | Health check |

EC2 recovery: if a deploy hangs extracting layers, kill the orphaned `ssh ...ec2...` process; if it persists, **stop+start** the instance via AWS console (NOT reboot).

## Tech Stack

**Frontend** — React 19 · TypeScript 5.7 (strict) · Vite 6 · SCSS Modules · Framer Motion · React Router 7 · Axios · react-helmet-async · Workbox PWA (SW + SWR on `/api/categories`) · Phosphor Light icon font (self-hosted)

**Backend** — Python 3.12 · FastAPI · SQLAlchemy 2.0 · Alembic · Pydantic · Uvicorn · aiosmtplib (Hover SMTP) · JWT auth (PyJWT + passlib + bcrypt)

**Database** — PostgreSQL 16 (Alpine)

**Infrastructure** — Docker + Compose · Nginx (HTTP/2, HSTS, SSL terminate) · AWS EC2 (t3.small, Amazon Linux) · Let's Encrypt SAN cert · n8n (in compose, not in form path)

**Static analysis** — Ruff (api) · TypeScript strict + ESLint boundary rules (frontend) · pytest

## Project Structure

```
.
├── api/                          # FastAPI backend
│   ├── alembic/                  #   Database migrations (010+)
│   ├── app/
│   │   ├── db/
│   │   │   ├── catalog_data/     #   15 JSON files, 3,600 real parts
│   │   │   └── seed.py           #   Idempotent seed
│   │   ├── models/               #   SQLAlchemy models
│   │   ├── routes/               #   FastAPI routers (categories, suppliers, parts, admin_*, auth, dashboard, forms, ...)
│   │   ├── schemas/              #   Pydantic schemas
│   │   ├── services/             #   Business logic (category, search, email)
│   │   ├── config.py             #   pydantic-settings
│   │   └── main.py
│   └── tests/                    #   ~165 tests, SQLite in-memory
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
- **2 sponsors** — Kennedy Electronics (gold category) + Avnet (silver keyword)
- **3 admin users** — `matthew`, `mike`, `john`, all password `admin`

## Environment Variables

Set via `.env` at repo root (gitignored). Defaults work for local dev.

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | `postgresql://circuits:circuits@db:5432/circuits` |
| `CORS_ORIGINS` | JSON or CSV of allowed origins | `["http://localhost"]` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD` | Outbound SMTP for form notifications | unset → demo mode (logs only) |
| `NOTIFY_RECIPIENTS` | JSON or CSV of admin notify emails | `[]` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | SQLAdmin credentials (unreachable in prod) | `admin` / `admin` |
| `JWT_SECRET_KEY` | JWT signing key | random per-boot in dev |

In prod, real SMTP creds live in `/opt/circuits-com/.env` on the EC2 box (not committed).

## n8n

The `n8n` container is still in `docker-compose.yml` for potential future workflow use, but **is no longer in the form-submission path**. Forms POST to FastAPI, which persists a `Message` row to Postgres and schedules SMTP sends via `BackgroundTasks` → `app.services.email.send_*_notification` (aiosmtplib + Hover SMTP).

## Kubernetes (legacy reference)

`k8s/` contains deployment manifests for `namespace`, `db`, `api`, `frontend`, `n8n`, and an nginx ingress. **Prod actually runs on EC2 via `./deploy.sh`** — the manifests are kept as reference and may not reflect the latest models / migrations / auth surface.
