# Circuits.com

Electronic components directory prototype — Vite React SPA + FastAPI + PostgreSQL + n8n, all in Docker.

## Commands

### Development
```bash
docker compose up --build          # Start all 5 services (db, api, frontend, n8n, nginx)
docker compose down -v             # Stop and remove volumes
```

### API (from api/)
```bash
cd api && pip install -e ".[dev]"  # Install deps locally
pytest tests/ -v                   # Run all 9 tests (SQLite in-memory)
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

## Architecture

5 Docker containers orchestrated by docker-compose.yml:

```
Browser → Nginx(:80)
  ├── /        → Frontend(:3000) — Vite React SPA
  └── /api/*   → API(:8000)     — FastAPI
                    ↕
              PostgreSQL(:5432)
                    ↕
                n8n(:5678)       — Workflow automation
```

### API (api/)
- FastAPI app in `app/main.py`, mounts 5 routers (categories, suppliers, search, forms, sponsors)
- Models: Category (self-referential tree), Supplier, CategorySupplier (join), Sponsor (XOR constraint: category_id OR keyword)
- Services layer: `category_service.py`, `search_service.py`
- Config via pydantic-settings: `DATABASE_URL`, `N8N_WEBHOOK_BASE_URL`, `CORS_ORIGINS`
- Entrypoint runs: alembic migrate → seed → uvicorn

### Frontend (frontend/)
- React 19 + TypeScript + Vite + SCSS Modules + Framer Motion
- Pages: Home, CategoryPage, Search, Join, Contact, About, KeywordSponsor
- Components organized by domain: `layout/`, `home/`, `category/`, `shared/`
- API client: `frontend/src/services/api.ts` (axios, typed methods)
- SCSS design system: `_variables.scss` (colors, spacing), `_animations.scss` (keyframes), `_mixins.scss`

### Data Flow
- Categories use self-referential `parent_id` for tree structure (3 levels deep)
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
transition={{ duration: 0.3, ease: 'easeInOut' as const }}
```
`App.tsx` uses `AnimatePresence` + `useLocation` for exit animations.

### API Route Convention
All API routes prefixed with `/api/`. Router prefix set in each route file.

### Seed Data (idempotent)
14 categories, ~67 subcategories, 7 suppliers, 2 sponsors. Seed checks for existing data before inserting.

## Gotchas

- Framer Motion v12 requires `as const` on ease values (e.g., `'easeInOut' as const`) or tsc errors with string vs Easing type
- Supplier `phone`/`website`/`email` are nullable (`str | None`) — templates must handle null
- SQLite tests don't enforce CHECK constraints — the XOR sponsor constraint only works in PostgreSQL
- `global.scss` uses deprecated Sass `darken()`/`lighten()` — use `@use 'sass:color'` + `color.adjust()` in new code
- n8n workflows need SMTP credentials at runtime for email nodes; they have `continueOnFail: true` for demo mode
- Frontend Dockerfile has 3 stages: `dev` (Vite), `build`, `prod` (nginx) — docker-compose.yml targets dev by default
- Frontend prod stage serves on port 80 (nginx), dev stage on port 3000 (Vite)

## Brand Colors

```
$executive-blue: #274C77  (headers, hero backgrounds)
$nav-blue: #0F78A9        (nav strip, links, accents)
$sponsor-gold: #a88d2e    (sponsor blocks, premium CTAs)
$surface: #eef1f5         (page backgrounds)
```
