# Search & Browse Refinements — Implementation Plan

> **For agentic workers:** executed via parallel subagents (superpowers:dispatching-parallel-agents),
> one agent per ownership domain below. Every task argues from the spec — read it first.

**Goal:** Ship the search results rebuild, SearchBar dropdown v2, BrowseDrawer, hero BOM pill, and
the backing search-v2/spec-fields backend, per the reviewed spec.

**Spec:** `docs/superpowers/specs/2026-08-21-search-browse-refinements-design.md` (rev 2 — binding)
**Pixel source:** `docs/design-briefs/search-browse-handoff-2026-08-21.md` + kit files at
`design-handoff-v6/design_handoff_search_and_browse_refinements/` (Navbar.jsx, Search.jsx,
SearchBar.jsx, styles.css, sponsor.css — read them; they are the fidelity authority)

## Global constraints (every task)

- Branch `updates`. Commit per completed unit. **No `Co-Authored-By` lines in any commit** (owner
  rule — overrides any default). No deploy, no `circuits push`.
- Frontend gates: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`.
  Backend gate: `cd api && pytest tests/ -q`. TDD where a pure contract exists.
- CLAUDE.md gotchas are law: `| null` on nullable TS fields; no charting libraries; SCSS modules
  with `@use variables/mixins`; accent text never on light cards; safeImageUrl/safeHttpUrl;
  compositor-only animation; no `:has()` near the hero; entities for non-ASCII glyphs in JSX.
- **File ownership is exclusive** — if you need a change in a file you don't own, note it in your
  final report instead of editing it. `frontend/src/public/services/api.ts` and
  `frontend/src/public/types/search.ts` are FROZEN (pre-landed contract): consume
  `api.searchV2(q, {suggest})` and `api.getManufacturers(limit)`; do not edit.
- Alembic revision ids are literal strings: **039 belongs to Task A** (spec fields). (040 is
  reserved by the concurrent analytics workstream — do not create it here.)

## Task A — Backend (owns `api/**`)

Spec §1.1–§1.6 in full. Files: `models/part.py`, `alembic/versions/039_part_spec_fields.py`,
`services/part_feed/base.py` + `mouser.py` (+ optional `specmap.py`), `services/part_feed/importer.py`,
`services/search_service.py` (rewrite), new `services/search_suggest.py`, new
`routes/manufacturers.py`, `routes/search.py` (suggest param), `routes/suppliers.py` (+schema
`tier`, §1.4a), `main.py` (mount manufacturers router — confirm no prefix collision first),
`part_to_dict`, `tests/conftest.py` (cache-reset autouse fixture), tests per §1.6 incl. folding
`test_search.py` into `test_search_v2.py`, and adding `manufacturers` to
`test_leads_never_public.py::PUBLIC_ROUTERS`.

Produces (consumed by B/C/D): the §1.3 response contract verbatim; `GET /api/manufacturers/` →
`{manufacturers: [{name, parts_count}], total}`; suppliers listing rows carry `tier: string|null`.

## Task B — Search results page (owns `frontend/src/public/pages/search/**`)

Spec §2 + brief §Screens 1 + kit `Search.jsx`/`sponsor.css`. URL-driven `?q=`; in-band form;
11-column `SrPartsTable`; manufacturer→re-search, distributor→`/join`; categories reuse cat-card;
empty state (chips dark-ink, closest table, suptile grid tier-ranked cap 12 website-only,
CTA at 0 results). Consumes `api.searchV2(q)` (suggest defaults on). May read the existing page
for the CTA component to reuse. vitest for the `"{ceil(d/7)}w"` formatter.

## Task C — SearchBar + hero (owns `components/layout/SearchBar.{tsx,module.scss}`,
`pages/home/components/HeroSection.{tsx,module.scss}`)

Spec §3 + §5 + kit `SearchBar.jsx`. Dropdown on both variants; Parts(5)/Distributors(3)/
Categories(3); parts rows → `/part/{slug}` with hover prefetch; distributor rows → `/join`,
null-tier sub-line rules; debounced calls pass `suggest: 0`; `ddOpen` = z-index lift only,
toggled in the same state commit (spec's corrected mechanism — no containment, no `:has()`);
hero quick links gain `BOM Tool` → `/bom`.

## Task D — BrowseDrawer + Navbar (owns new `components/layout/BrowseDrawer/**`,
`Navbar.{tsx,module.scss}`)

Spec §4 + kit `Navbar.jsx`/`styles.css` `.bd-*`. Five rail items with pinned destinations/pills;
eager 3-source fetch on open; panes (tiles/tile-grid/rows, clicks pinned); full-height overlay
z-110 above header; scrim blur ≥769px, skipped on `/`; burger at all viewports, brand offsets
28→56 and 16→52 (verify 320px); `navMobileDrawer` deleted; lazy body with non-swallowed click
import; a11y block verbatim (inert closed, focus trap open, always-mounted aria-controls node).

## Task E — Integration & verification (orchestrator, after A–D)

Remove the legacy `api.search` + `SearchResults` once consumers are gone; full gates both sides;
chrome-devtools runtime matrix (spec §7 widths incl. 1385/1250); mobile-layout-guard,
theme-persistency-guard, visual-regression-guard (expect navbar drift — deliberate);
/simplify + /code-review on the combined diff.
