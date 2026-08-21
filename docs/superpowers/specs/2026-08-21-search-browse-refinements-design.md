# Search Experience & Browse Drawer Refinements — Design Spec

**Date:** 2026-08-21
**Source of truth for pixels:** `docs/design-briefs/search-browse-handoff-2026-08-21.md` (the committed
copy of the Claude Design handoff README) plus the live kit at
`design-handoff-v6/design_handoff_search_and_browse_refinements/` (gitignored, on-disk: JSX + CSS
prototypes). The handoff is **high-fidelity — recreate pixel-perfectly**; this spec pins the
*decisions, data contracts, and integration points* the kit cannot know about. Where this spec and
the brief disagree on a visual value, the brief wins. Where they disagree on data, behavior toward
the API, or a CLAUDE.md invariant, this spec wins.

## Goals

1. Rebuild the public **search results page** as a live search surface: spec-sheet parts table,
   manufacturer/distributor/category sections, fuzzy "did you mean" recovery, keyword-sponsor CTA
   at zero results.
2. Add a **Distributors** section and always-submit behavior to the **SearchBar** dropdown, with
   the `.dd-open` hero containment mechanism (no `:has()`).
3. Build the **BrowseDrawer** (rail + pane) and make it the site's only drawer at every viewport —
   the existing `navMobileDrawer` retires.
4. Add the **BOM Tool** pill to the homepage hero quick links (`/bom`'s first public entry point).
5. Backend: **migration 039** part spec fields + Mouser feed mapping; **search service v2** with
   batched pricing, a manufacturers section, and server-side fuzzy recovery; a **public derived
   manufacturers** source.

## Decisions (locked with the owner, 2026-08-21)

- **Spec fields = migration + feed mapping, no immediate backfill.** New columns fill organically
  via future syncs/imports; NULL renders "—". No Mouser quota is spent by this project.
- **One drawer.** BrowseDrawer replaces the mobile drawer at all viewports.
- Fuzzy recovery is **server-side**, computed only when a search has zero results.
- Public manufacturer data is **derived from `parts.manufacturer_name`** — the Leads-CRM tables
  (`manufacturers`, `manufacturer_aliases`, `leads`, `lead_contacts`) are never read by any public
  path. `test_leads_never_public.py` must pass unchanged.
- No deploy and no `circuits push` inside this project's scope. Work lands on `updates`.

---

## 1. Backend

### 1.1 Migration 039 — part spec fields

Three nullable columns on `parts` (model `api/app/models/part.py`, `__tablename__` untouched):

| Column | Type | Values | Fill source |
|---|---|---|---|
| `mount` | `String(8)` | `"SMT"` / `"THT"` / NULL | Feed attribute when present, else package-token lookup, else NULL |
| `rohs` | `Boolean` | `True` (compliant) / `False` (not) / NULL (unknown) | Mouser `ROHSStatus` |
| `lead_time_days` | `Integer` | days / NULL | Mouser `LeadTime` ("28 Days" → 28) |

- Alembic revision 039, `down_revision = "038"`. Pure `add_column` ×3; downgrade drops them.
- No backfill in the migration. No CHECK constraints (SQLite parity; values are normalized at the
  single write boundary, the feed mapper).
- `part_to_dict()` gains `mount`, `rohs`, `lead_time_days` (plain passthrough, `None` allowed).
  TS `Part`/`AdminPart` types gain `mount?: string | null`, `rohs?: boolean | null`,
  `lead_time_days?: number | null` — **`| null` explicitly** (the `?:`-catches-only-undefined
  gotcha). The admin parts form is *not* extended in this project (feed-owned facts, like
  `lifecycle_verified_at`); admin list columns unchanged.

### 1.2 Feed mapping (Mouser provider)

New pure functions in `api/app/services/part_feed/` (same module that owns `map_lifecycle`), each
with unit tests:

- `map_rohs(raw: str | None) -> bool | None` — `"RoHS Compliant"`-family → `True`; explicit
  non-compliant strings → `False`; empty/unknown → `None`.
- `map_lead_time(raw: str | None) -> int | None` — parse the leading integer of Mouser's
  `LeadTime` (`"28 Days"` → 28); weeks variants → ×7; unparseable → `None`.
- `map_mount(attrs, package: str | None) -> str | None` — feed mounting-style attribute first;
  else package-token table: SMT for chip sizes (`0201/0402/0603/0805/1206/1210/2010/2512`),
  `SOT*`, `SOIC*`, `SSOP/TSSOP/MSOP/QSOP`, `QFN/DFN/QFP/LQFP/TQFP`, `BGA/CSP/LGA`, `SOD*`,
  `DPAK/D2PAK/DO-214*`; THT for `DIP/PDIP`, `TO-92/TO-220/TO-247`, `DO-35/DO-41`, `radial/axial`.
  No match → `None` (never guess).

The importer/sync write path stamps these on the same update it already performs for
`package`/`lifecycle_status`. **Overwrite rule mirrors `package`:** a feed value replaces a stored
value; a feed *absence* leaves the stored value untouched. `lifecycle_verified_at` semantics are
not extended to these fields (no `mount_verified_at` — the "—" render is the unverified state).

### 1.3 Search service v2 — `GET /api/search/?q=`

Same route, richer response. `app/services/search_service.py` is rewritten; the fuzzy scorers live
in a new **`app/services/search_suggest.py`** (pure functions, no ORM, SQLite-testable).

**Response contract:**

```json
{
  "parts":         [SearchPart, …],       // ≤ 20
  "categories":    [CategoryHit, …],      // ≤ 12
  "suppliers":     [SupplierHit, …],      // ≤ 12
  "manufacturers": [ManufacturerHit, …],  // ≤ 12
  "total":         int,                   // sum of the four section lengths
  "took_ms":       float,                 // server-measured wall time
  "suggestions":   [Suggestion, …] | null, // only when total == 0, else null
  "closest_parts": [SearchPart, …] | null  // only when total == 0, ≤ 15, else null
}
```

- `SearchPart`: `id, sku, slug, description, manufacturer_name, package, mount, rohs,
  lead_time_days, moq, dist_count, best_price, stock, lifecycle_status, category_icon,
  category_slug, parent_category_slug`. `moq` = min `PriceBreak.min_quantity` across the part's
  listings; `dist_count` = listings count; `stock` = sum of listing stock. **All three derived
  fields come from three batched queries over the collected part ids** (`IN (…)`, GROUP BY
  part id) — never per-row (the seed-probe/CandidateStub lesson). Category icon/slug resolved via
  one `IN` query over the distinct category ids.
- `CategoryHit`: what the homepage cat-card needs — `id, name, slug, icon, parent_slug,
  parts_count, children: [{name, slug, matched: bool}]` with **matched subcategories ordered
  first** (brief §Screens 1.3). A subcategory-name match surfaces the *parent* card with that
  child flagged.
- `SupplierHit`: `id, name, slug?, website, logo_url, description, tier` where `tier` is the
  supplier's highest **active** sponsorship tier or `null` — computed server-side from one query
  over active `sponsors` rows (`status == 'Active' OR status IS NULL`, tier normalized lowercase;
  the tier-casing gotcha applies). `logo_url` passes through; the client runs it through
  `safeImageUrl` before render.
- `ManufacturerHit`: `{name, parts_count}` — derived, see §1.4.
- **`sponsor-index v.42` is mock flavor and does not exist in the API.** The meta line renders
  from `total` and `took_ms` only.

**Matching:** parts by `sku ILIKE %q%` / `description ILIKE %q%` / `manufacturer_name ILIKE %q%`
(unchanged semantics); categories by name ILIKE against both levels; suppliers by name ILIKE;
manufacturers by name ILIKE against the derived list (§1.4, in-memory filter — no SQL needed).
The current per-part N+1 (listings count, best price, category lookup) is **removed**.

**Perf note (accepted):** ILIKE `%q%` over 132k parts is a seq scan — this is today's behavior at
today's scale and is measured, not fixed, in this project (verification records the latency; a
pg_trgm GIN index is the named follow-up if it exceeds ~300 ms on prod hardware).

### 1.4 Derived public manufacturers

New module-level helper `get_public_manufacturers(db)` in `search_service.py`:

- `SELECT manufacturer_name, COUNT(*) FROM parts WHERE manufacturer_name IS NOT NULL AND
  manufacturer_name != '' GROUP BY manufacturer_name ORDER BY COUNT(*) DESC` → list of
  `{name, parts_count}`.
- Cached **in-process** with a 600 s TTL (single-worker precedent: `rate_limit.py`; the catalog
  changes by feed imports, not user actions — 10-minute staleness is fine). Cache key is global;
  the drawer, the search manufacturers section, and did-you-mean vocab all read this one list.
- New **public route** `GET /api/manufacturers/` (new `routes/manufacturers.py`, prefix
  `/api/manufacturers`) returning `{"manufacturers": [{name, parts_count}, …]}` with
  `?limit=` (default 60, cap 200). **Response carries names and counts only** — a guard test
  asserts the response never contains CRM fields (`id`, `email`, `phone`, `website`, alias/lead
  anything) and that the route imports nothing from the CRM models. Demo needs no refusal here —
  the data is public catalog aggregate.
- The admin CRM router keeps its own namespace untouched (it lives under the admin prefix; the
  plan confirms there is no path collision before creating the route).

### 1.5 Fuzzy recovery (`search_suggest.py`, server-side, zero-result-only)

Computed inside the search endpoint **only when `total == 0`** (hit queries never pay):

**Did-you-mean** — vocabulary = category names (both levels) + supplier names + derived
manufacturer names (≈ 2.5k strings, all already in memory via §1.4 + the two small tables).
Scoring per the brief §Screens 1 (kit parity):
- token containment → +3
- **word-level** Levenshtein: best per-query-token vs per-candidate-token distance ratio ≤ 0.5 →
  `+(1 − ratio) × 4` (word-level is required so `"Mauser"` reaches `"Mouser Electronics"`)
- entity tie-break +0.25 (distributor > manufacturer > category)
Return top 6 as `Suggestion = {term, kind: "distributor"|"manufacturer"|"category"|"part",
icon_or_pad}`; the client renders pads/icons per kind.

**Closest parts** — bounded candidate pool from SQL: parts sharing a ≥3-char uppercase SKU prefix
(`sku ILIKE 'PRE%'`) ∪ per-token `ILIKE %token%` hits (tokens ≥ 3 chars), pool cap 400. Score in
Python: character-trigram overlap ×2 + shared-prefix bonus, keep score ≥ 2, then backfill with
popular parts (stock-ordered, the existing popular-parts pattern) to **cap 15**. Result rows are
full `SearchPart`s (same batched enrichment).

Levenshtein and trigram implementations are dependency-free pure Python (no new packages).

### 1.6 Backend tests

- `test_search_v2.py`: response shape; batched derived fields correct against seeded listings;
  `total`/`took_ms` present; `suggestions`/`closest_parts` null on hits and populated on misses;
  the **"Mauser" → "Mouser Electronics"** case verbatim; suggestion cap; closest cap 15 with
  popular backfill; supplier tier normalization (lowercase `'platinum'` row still badges);
  category child-match ordering.
- `test_manufacturers_public.py`: derivation excludes NULL/empty; ordering; limit cap; **no CRM
  fields in response**; TTL cache returns same object within window (monkeypatched clock).
- `test_part_feed_specs.py`: `map_rohs`/`map_lead_time`/`map_mount` tables incl. no-guess NULLs;
  importer stamps the fields; feed-absence leaves stored values untouched.
- Migration guard: columns exist + nullable, via metadata (SQLite ignores lengths — assert
  `type.length` on `mount` per the established pattern).
- `test_leads_never_public.py` **unchanged and green**.

---

## 2. Search results page (`frontend/src/public/pages/search/`)

Rebuild to the brief's §Screens 1 spec. File structure (focused files):

```
pages/search/
  index.tsx                 — page shell, query state, API call, section layout
  SearchPage.module.scss    — header band, labels, empty state, CTA
  components/SrPartsTable.tsx + .module.scss    — spec-sheet table (used by results AND empty state)
  components/SrSupCards.tsx  + .module.scss     — manufacturer/distributor cards + suptile grid
  components/SrSuggestions.tsx                  — did-you-mean chip row
```

- **Header band:** exact brief values (PCB grid 24px @35%, eyebrow `QUERY · TERM`, the
  `code.search-page-title-q` selector requirement, meta line `N results · 0.0XX s` from
  `total`/`took_ms` — no fabricated index version; "Clear ↩" resets to the empty search state).
- **Parts table:** all 11 columns (Part w/ thumb · Manufacturer · Package · Mount · RoHS ✓ ·
  Lead · MOQ · Dist. · Best Price · Stock · Status). `lead_time_days` renders `"{ceil(d/7)}w"`;
  `rohs === true` → ✓, `false` → "No", `null` → "—"; every nullable spec field renders "—".
  `overflow-x: auto` wrap, `min-width: 960px`, mono tabular-nums for numeric cells, row click →
  `/part/{slug}` (guard `closest('a')` per the established row-click pattern). Status chips:
  NRND `#fdf3e0/#946200`, Obsolete `#fdeaea/#b3261e`.
- **Manufacturer cards** re-run the search with the manufacturer name on click; **distributor
  cards** link to the supplier's site via `safeHttpUrl` where present (never raw), tier badge via
  the server-normalized `tier`. Logos: `safeImageUrl(logo_url)` with lettermark fallback (the
  CsLogo/SbLogo onError pattern).
- **Categories section** reuses the homepage cat-card markup/styling in the tightened grid;
  matched subcategories first (server already orders them).
- **Empty state:** did-you-mean chips (white fill, **dark ink `--fg1`** — never accent text on a
  light card, the standing a11y rule), closest-matches `SrPartsTable`, `.sr-suptile` distributor
  grid (from the suppliers API, tier-badged), keyword-sponsor CTA card **only at 0 results**
  (reuse the existing CTA; datasheet motif unchanged).
- Loading state reserves real heights (the banner-snap rule). Fetch is cancel-flagged. API error →
  a quiet error card with a retry link, never a blank page.
- SEO: page stays `noindex, follow`; no seoRoutes/manifest changes.

## 3. SearchBar (`components/layout/SearchBar.tsx`)

- Dropdown sections become **Parts → Distributors → Categories**. Distributor rows: 30px
  `dd-mark` lettermark pad (accent-10% fill, dashed accent-45% border, heading font) + name +
  `{tier} distributor · {website}` sub-line. Data comes from the same debounced search call
  (`suppliers` section of v2).
- **Enter/submit always navigates to `/search?q=<query>`** — the direct part jump is removed.
- **`.dd-open` mechanism:** SearchBar gains an optional `onDropdownOpenChange?: (open: boolean) =>
  void` prop, fired on dropdown mount/unmount (cleanup on unmount is mandatory). `HeroSection`
  passes it and toggles a `ddOpen` class on the hero root:
  `.hero { contain: layout style paint; }` /
  `.hero.ddOpen { contain: layout style; overflow: visible; z-index: 60; }`.
  **No `:has()`** anywhere near the hero (animated-SVG selector-invalidation thrash — brief
  requirement). The navbar instance passes nothing and is unaffected.

## 4. BrowseDrawer (new; replaces `navMobileDrawer`)

New `components/layout/BrowseDrawer/{index.tsx, BrowseDrawer.module.scss}`.

- **Structure per the brief §Screens 3:** 264px white rail split into two 50% flex halves
  (`.bd-rail-top { flex: 1 0 auto; min-height: calc(50% - 11px); }`, dashed divider at the exact
  midpoint), BROWSE group (Categories / Manufacturers / Distributors pane switchers with neon
  count pills), SITE group (Home / About / Join / Contact / **Login** with white Phosphor icons
  on near-black pads — house, info, handshake, envelope-simple, sign-in), pinned utility footer;
  pane `min(340px, 100vw − 264px)` with the PCB-grid wash, acrylic `.bd-tile` category tiles
  (rest/hover neon ramp, spring `cubic-bezier(.34,1.56,.64,1)`, `prefers-reduced-motion`
  disables), manufacturer rows, distributor rows with gold FEATURED badge for active gold+
  sponsors. Collapse X (`.bd-close`) at the burger's exact position. All hover motion is
  compositor-only (transform/opacity); scrim `backdrop-filter: blur(2px)` **only** while open
  **and** ≥769px.
- **Footer honesty:** line 1 = real counts from the categories payload
  (`{N} CATEGORIES · {M}+ PARTS`, parts rounded down to the nearest 100 with "+"); line 2 =
  `[ESC] CLOSES` keycap + `CIRCUITCENTER.AI` in the same mono style. The kit's
  `SPONSOR-INDEX v.42` is mock and is not shipped.
- **Data:** categories via the existing categories API (SW-cached; already carries counts +
  children); distributors via the existing public suppliers listing — the drawer's FEATURED badge needs
  the same normalized active-sponsor `tier` the search v2 supplier hit carries, so that listing
  endpoint gains the identical tier computation (one shared helper in `search_service.py`, both
  call sites; mind the `response_model=` stripping gotcha — the field must exist on the schema
  with a default, or the endpoint drops `response_model=`); manufacturers via
  `GET /api/manufacturers/?limit=60`. Each pane fetches lazily on first activation,
  cancel-flagged, cached for the drawer's mounted lifetime; a failed fetch renders a quiet
  "couldn't load — retry" row, never an empty pane pretending success.
- **Navbar integration:** the burger button mounts at the far left of `.topStrip` at **all**
  viewports (`left: 14px`); the brand shifts right (`left: 56px` — the pinned-edge absolute
  scheme is preserved, only the offset changes; nothing switches to Grid/space-between). The
  existing `navMobileDrawer` markup, styles, and its `menuOpen` state machine are **deleted**;
  BrowseDrawer owns the standard 3-effect drawer state machine (body-scroll-lock, Esc-while-open,
  route-change close) plus scrim click and the X. `pane` state resets to `"cats"` on every open.
- **Code-splitting:** the drawer body is `lazy()`-imported on first burger interaction
  (`onMouseEnter` prefetch + on-click import, `.catch(() => {})` per the standing rule) so the
  every-page navbar chunk stays flat. The burger itself is plain markup in Navbar.
- **A11y:** drawer container `role="dialog"` `aria-modal="true"` `aria-label="Browse"`;
  `aria-hidden` when closed; focus moves to the X on open and returns to the burger on close;
  pane switchers are buttons with `aria-current`; count pills `aria-hidden` (counts repeated in
  accessible labels). Overflow hardening verbatim from the brief (`minmax(0,1fr)`, `min-width: 0`,
  `overflow-wrap: break-word` — **not** `anywhere`; ≤760px rail 224px; ≤480px rail 185px).
- The drawer contains exactly the kit's groups. BOM/KiCad/tool entries are a future extension,
  not this project.

## 5. Homepage hero

`HeroSection.tsx` quick links become `Find Parts · Top Distributors · BOM Tool` — the new pill is
an `AnimatedLink to="/bom"`, identical styling. This is `/bom`'s first public entry point; no
navbar link is added (the 1200–1385px search-collision constraint stands).

## 6. Error handling summary

- Search API failure → error card + retry on the page; dropdown silently shows nothing new
  (existing behavior).
- Drawer pane fetch failure → inline retry row (per-pane, independent).
- All external hrefs through `safeHttpUrl`; all logo `src` through `safeImageUrl`; nulls hide the
  element (never a broken image).
- Feed mapper never guesses: unparseable feed values → NULL → "—".

## 7. Testing & verification

- Backend: §1.6 suites; full `pytest tests/ -q` green.
- Frontend: `npx tsc -b`, `npx eslint --ext .ts,.tsx src/`, `npm test` green. Unit tests
  (vitest) for the lead-time "Nw" formatter and any client-side pure logic that emerges.
- Runtime: chrome-devtools pass over home (dropdown open/close on the animated hero — verify no
  long frames via async rAF sampling, not busy-wait), search results with a real query, a typo
  query ("Mauser"), a zero-result garbage query, drawer open/pane-switch/Esc/route-close at
  1440/1024/760/480/375 widths. **mobile-layout-guard** agent runs on the drawer and the search
  table (the two overflow-prone surfaces). **theme-persistency-guard** across the 4 themes (the
  drawer and search page are theme-token consumers).
- Regression: `/` hero animations still pause/resume (IO wiring untouched); navbar search still
  hidden on `/`; admin untouched.

## 8. Rollout

- Branch `updates`; standard commit cadence; **no deploy, no `circuits push`** in this scope.
- `frontend/seo-manifest.json` untouched (no new indexable routes; search is noindex).
- After a future deploy: `circuits pull --reporting` per the standing post-deploy rule; the
  seo-auditor run already queued for the BOM deploy covers this too.

## Out of scope

Public Manufacturers/Distributors *pages* (separate upcoming project), KiCad/PCB-viewer
placeholders, drawer entries beyond the kit's groups, any Mouser backfill spend, pg_trgm search
indexing (named follow-up), admin surfaces.
