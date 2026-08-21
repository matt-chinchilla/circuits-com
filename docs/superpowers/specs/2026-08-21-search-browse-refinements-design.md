# Search Experience & Browse Drawer Refinements — Design Spec

**Date:** 2026-08-21 (rev 2 — post five-lens review, 56 findings adjudicated)
**Source of truth for pixels:** `docs/design-briefs/search-browse-handoff-2026-08-21.md` (the committed
copy of the Claude Design handoff README) plus the live kit at
`design-handoff-v6/design_handoff_search_and_browse_refinements/` (gitignored, on-disk: JSX + CSS
prototypes — implementers MUST read the kit files for exact values; `Navbar.jsx`, `Search.jsx`,
`SearchBar.jsx`, `styles.css`, `sponsor.css`). The handoff is **high-fidelity — recreate
pixel-perfectly**. This spec pins the *decisions, data contracts, and integration points*. Where
this spec and the brief disagree on a visual value, the brief wins — **except the explicit
overrides recorded below** (each marked "OVERRIDE"). On data, behavior toward the API, or a
CLAUDE.md invariant, this spec always wins.

## Goals

1. Rebuild the public **search results page** as a live search surface: spec-sheet parts table,
   manufacturer/distributor/category sections, fuzzy "did you mean" recovery, keyword-sponsor CTA
   at zero results.
2. **SearchBar** dropdown gains Parts + Distributors sections on both variants, with the
   `ddOpen` hero mechanism (no `:has()`).
3. Build the **BrowseDrawer** (rail + pane) and make it the site's only drawer at every viewport —
   the existing `navMobileDrawer` retires.
4. Add the **BOM Tool** pill to the homepage hero quick links.
5. Backend: **migration 039** part spec fields + Mouser feed mapping; **search service v2** with
   batched pricing, a manufacturers section, and server-side fuzzy recovery; a **public derived
   manufacturers** source.

## Decisions (locked)

- **Spec fields = migration + feed mapping, no immediate backfill.** New columns fill organically
  via future syncs/imports; NULL renders "—". No Mouser quota is spent by this project.
- **One drawer.** BrowseDrawer replaces the mobile drawer at all viewports.
- Fuzzy recovery is **server-side**, computed only when a zero-result **page-level** search asks
  for it (`suggest=1`); the dropdown's debounced calls pass `suggest=0` and never pay.
- Public manufacturer data is **derived from `parts.manufacturer_name`** — the Leads-CRM tables
  are never read by any public path.
- **OVERRIDE (public-phone ban):** the brief's `.sr-suptile` meta line `website · phone` renders
  **website only** — a phone number never renders on any public surface (owner rule 2026-08-15).
  No dangling `·` separator.
- **Distributor click surfaces route to `/join`** everywhere in this project (brief Interactions:
  "distributors → Join") — search-result distributor cards, empty-state suptiles, dropdown
  distributor rows, drawer distributor rows. No external-website links on these surfaces (that
  affordance arrives with the future public Distributors pages).
- **Did-you-mean never suggests part SKUs** — deliberate divergence from the kit (its mock data
  put SKUs in the vocabulary; 132k SKUs cannot be). `kind` union has no `"part"` member.
- No deploy and no `circuits push` inside this project's scope. Work lands on `updates`.

---

## 1. Backend

### 1.1 Migration 039 — part spec fields

Three nullable columns on `parts` (model `api/app/models/part.py`):

| Column | Type | Values | Fill source |
|---|---|---|---|
| `mount` | `String(8)` | `"SMT"` / `"THT"` / NULL | Feed mounting-style attribute, else package-token lookup, else NULL |
| `rohs` | `Boolean` | `True` / `False` / NULL (unknown) | Mouser `ROHSStatus` |
| `lead_time_days` | `Integer` | days / NULL | Mouser `LeadTime` via the (upgraded) shared parser |

- Alembic revision 039, `down_revision = "038"`. Pure `add_column` ×3; downgrade drops them. No
  backfill, no CHECK constraints (SQLite parity; values are normalized at the single write
  boundary, the feed mapper).
- `part_to_dict()` gains the three fields (plain passthrough, `None` allowed). TS types: public
  `PublicPart` (`frontend/src/public/types/part.ts`) and admin `Part`
  (`frontend/src/admin/types/admin.ts`) gain `mount?: string | null`,
  `rohs?: boolean | null`, `lead_time_days?: number | null` — **`| null` explicitly** (the
  `?:`-catches-only-undefined gotcha). Admin form/list unchanged (feed-owned facts).

### 1.2 Feed mapping (Mouser provider + FeedPart boundary)

The provider boundary must carry the new facts — today `part_from_mouser` never extracts
`ROHSStatus` or a mounting attribute, and `LeadTime` crosses the boundary already parsed:

- **`FeedPart`** (`part_feed/base.py`) gains `mount: str | None = None`,
  `rohs: bool | None = None` (its existing `lead_time_days` is reused for the part-level value —
  the listing write keeps consuming the same field).
- **`part_from_mouser`** (`mouser.py`) populates them: `rohs = map_rohs(raw.get("ROHSStatus"))`;
  `mount = map_mount(product_attributes, package)` where the attribute match is any
  `ProductAttribute` whose `AttributeName` contains `"mounting"` case-insensitively;
  `lead_time_days` continues through `_parse_lead_time`.
- **`_parse_lead_time` is upgraded in place to be weeks-aware** (single home): `"28 Days"` → 28,
  `"6 Weeks"` → 42, bare number → days, unparseable → None. **This deliberately changes
  `PartListing.lead_time_days` for week-denominated feed values** (6 was wrong; 42 is right) —
  both the listing write and the new part column consume the one parser.
- Mapper functions (pure, unit-tested, in `mouser.py` or a shared `specmap.py`):
  - `map_rohs(raw) -> bool | None` — strings containing `"rohs compliant"` (case-insensitive)
    family → True; explicit non-compliant forms → False; empty/unknown → None.
  - `map_mount(attrs, package) -> str | None` — feed attribute value containing
    `surface mount`/`smd`/`smt` → "SMT"; `through hole`/`tht` → "THT"; else package-token table:
    SMT for chip sizes (`0201/0402/0603/0805/1206/1210/2010/2512`), `SOT*`, `SOIC*`,
    `SSOP/TSSOP/MSOP/QSOP`, `QFN/DFN/QFP/LQFP/TQFP`, `BGA/CSP/LGA`, `SOD*`,
    `DPAK/D2PAK/DO-214*`; THT for `DIP/PDIP`, `TO-92/TO-220/TO-247`, `DO-35/DO-41`,
    `radial/axial`. No match → None (never guess).
- **Importer stamp rule: write when `mapped is not None` — never truthiness.** `rohs=False` is a
  value and must be stored; a later feed *absence* (None) leaves any stored value untouched.
  This mirrors `package`'s update-on-feed-value semantics but with the explicit
  `is not None` test.

### 1.3 Search service v2 — `GET /api/search/?q=&suggest=`

Same route, richer response. `app/services/search_service.py` rewritten; fuzzy scorers in a new
**`app/services/search_suggest.py`** (pure functions, no ORM, SQLite-testable).
`suggest` query param: `1` (default) | `0`.

**Response contract:**

```json
{
  "parts":         [SearchPart, …],       // ≤ 20
  "categories":    [CategoryHit, …],      // ≤ 12
  "suppliers":     [SupplierHit, …],      // ≤ 12
  "manufacturers": [ManufacturerHit, …],  // ≤ 12
  "total":         int,                   // sum of the four section lengths
  "took_ms":       float,
  "suggestions":   [Suggestion, …] | null, // only when total == 0 AND suggest=1, else null
  "closest_parts": [SearchPart, …] | null  // same gate, ≤ 15, else null
}
```

- `SearchPart`: `id, sku, slug, description, manufacturer_name, package, mount, rohs,
  lead_time_days, moq, dist_count, best_price, stock, lifecycle_status, category_icon,
  category_slug, parent_category_slug`. Derived fields from **three batched queries over the
  collected part ids** (never per-row): `moq` = min `PriceBreak.min_quantity` across the part's
  listings; **`dist_count` = `COUNT(DISTINCT PartListing.supplier_id)`** (a (part, supplier)
  pair can hold two listing rows — raw count would double-count); `stock` = sum of listing
  stock. Category icon/slugs via one `IN` query over distinct category ids.
- `CategoryHit`: `id, name, slug, icon, parent_slug, parts_count,
  children: [{name, slug, matched}]` — matched subcategories ordered first; a
  subcategory-name match surfaces the *parent* card with the child flagged.
  **`parts_count` = own + sum(children)** (matches `get_all_categories`).
- `SupplierHit`: `id, name, website, logo_url, description, tier` — **no `slug`** (nothing
  consumes one; the Distributors pages are out of scope). `tier` = highest **active**
  sponsorship tier lowercase or `null` (`status == 'Active' OR status IS NULL`, casing
  normalized server-side — one shared helper, also used by §1.4a). Client runs `logo_url`
  through `safeImageUrl`.
- `ManufacturerHit`: `{name, parts_count}` (§1.4).
- `sponsor-index v.42` is kit mock and does not exist in the API; the meta line renders from
  `total`/`took_ms` only.

**Matching:** parts by `sku/description/manufacturer_name ILIKE %q%` (unchanged semantics);
categories by name ILIKE on both levels; suppliers by name ILIKE; manufacturers by in-memory
filter over the §1.4 cached list. The current per-part N+1 is removed.

**Existing test suite:** `api/tests/test_search.py` (v1 shape) is **folded into the new
`test_search_v2.py` and deleted** — no v1 field name (`listings_count`) survives in the response.

**Perf note (accepted):** ILIKE `%q%` over 132k parts is a seq scan — today's behavior, measured
in verification (pg_trgm GIN is the named follow-up if prod latency exceeds ~300 ms).

### 1.4 Derived public manufacturers

`get_public_manufacturers(db)` in `search_service.py`:

- `SELECT manufacturer_name, COUNT(*) FROM parts WHERE manufacturer_name IS NOT NULL AND
  manufacturer_name != '' GROUP BY 1 ORDER BY count DESC` → `[{name, parts_count}, …]`.
- Cached in-process, 600 s TTL, single global key. **A `clear_public_manufacturers_cache()`
  reset function ships with it, wired into an autouse conftest fixture** (the `rate_limit`/
  `reset_feed_runs` precedent) — without it the cache leaks one test's catalog into the next
  suite's vocabulary.
- New public route **`GET /api/manufacturers/`** (new `routes/manufacturers.py`):
  `{"manufacturers": [{name, parts_count}, …], "total": int}` — **`total` = full derived-list
  length** (free from the cache; the drawer pills need it), list capped by `?limit` (default
  60, cap 200). Names + counts only.
- **Guards:** `test_manufacturers_public.py` asserts no CRM fields in the response and that the
  route module imports nothing from the CRM models. **`test_leads_never_public.py` passes with
  no weakening, and `routes/manufacturers.py` is ADDED to its `PUBLIC_ROUTERS` enumeration**
  (the sweep must keep enumerating every public router — "unchanged" would exempt exactly the
  new one).
- The plan confirms no path collision with the admin manufacturers router prefix before mounting.

### 1.4a Supplier tier on the public suppliers listing

The drawer needs the FEATURED badge without a bespoke route: the public suppliers listing gains
the same normalized active-tier value via the shared helper from §1.3. Mind the
`response_model=` stripping gotcha — the field exists on the schema with a `None` default, or
the endpoint drops `response_model=`. (`SupplierResponse` is shared public/admin; `tier` is
public information — it is painted on the boards.)

### 1.5 Fuzzy recovery (`search_suggest.py`)

Computed only when `total == 0` **and** `suggest=1`:

**Did-you-mean** — vocabulary = category names (both levels) + supplier names + derived
manufacturer names (≈ 2.5k strings; **no part SKUs** — see Decisions). Kit-parity scoring:
- token containment, **tokens ≥ 3 chars only**, cumulative per token → +3 each
- word-level Levenshtein: best ratio among (whole query vs whole candidate) and (whole query vs
  each candidate word); ratio ≤ 0.5 → `+(1 − ratio) × 4`
- flat **+0.25 for any non-category kind** (kit parity — not a graded ladder)
- **floor: keep only score > 0.9; cap 4** (kit parity — garbage like "xzqv9" yields zero chips)
`Suggestion = {term, kind: "distributor" | "manufacturer" | "category", icon: string | null}` —
`icon` is the category's Phosphor name for `kind="category"`, `null` otherwise (the client
derives lettermark pads from `term`).

**Closest parts** — bounded SQL candidate pool: shared ≥3-char uppercase SKU prefix
(`sku ILIKE 'PRE%'`) ∪ per-token `ILIKE %token%` (tokens ≥ 3 chars), pool cap 400. Python
scoring: character-trigram overlap ×2 + shared-prefix bonus, keep score ≥ 2, backfill with
popular parts (stock-ordered) to cap 15. Rows are full `SearchPart`s (same batched enrichment).

Levenshtein/trigram are dependency-free pure Python.

### 1.6 Backend tests

- `test_search_v2.py` (absorbs and replaces `test_search.py`): response shape; batched derived
  fields (incl. `dist_count` distinct-supplier semantics against a two-listings-one-supplier
  fixture); `suggestions`/`closest_parts` null on hits, null when `suggest=0`, populated on
  zero-result `suggest=1`; **"Mauser" → "Mouser Electronics"** verbatim; score floor (garbage →
  0 chips); cap 4; closest cap 15 with popular backfill; supplier tier normalization (lowercase
  `'platinum'` still badges); category child-match ordering; `parts_count` rollup.
- `test_manufacturers_public.py`: derivation excludes NULL/empty; ordering; `total` vs capped
  list; no CRM fields; TTL cache + reset seam (monkeypatched clock).
- `test_part_feed_specs.py`: `map_rohs`/`map_mount` tables incl. no-guess NULLs;
  `_parse_lead_time` weeks-aware cases; **feed says non-compliant → stored `rohs is False`;
  later feed absence leaves `False` untouched** (the truthiness trap); importer stamps all
  three onto the Part.
- Migration guard: columns exist + nullable via metadata (`type.length` on `mount`).
- `test_leads_never_public.py` green with `manufacturers` added to `PUBLIC_ROUTERS`.

---

## 2. Search results page (`frontend/src/public/pages/search/`)

Rebuild to the brief §Screens 1. Files:

```
pages/search/
  index.tsx                — page shell, URL-driven query state, API call, section layout
  SearchPage.module.scss   — header band, in-band form, labels, empty state, CTA
  components/SrPartsTable.tsx + .module.scss   — spec-sheet table (results AND empty state)
  components/SrSupCards.tsx + .module.scss     — manufacturer/distributor cards + suptile grid
  components/SrSuggestions.tsx                 — did-you-mean chip row
```

- **Query state is URL-driven (`?q=`)** — every in-page re-query (in-band form submit,
  suggestion chip, manufacturer card) does `navigate('/search?q=<term>')`, so results are
  shareable and back-button-correct. "Clear ↩" navigates to `/search` with no `q` and empties
  the in-band input. The header band renders the **kit's dedicated in-band form**
  (`.search-page-form/-input/-submit` styling), not the shared `<SearchBar>`.
- **Header band:** exact brief values (PCB grid 24px @35%, `QUERY · TERM` eyebrow, the
  `code.search-page-title-q` selector requirement, meta `N results · 0.0XX s` from
  `total`/`took_ms`).
- **Parts table:** all 11 columns (Part w/ thumb · Manufacturer · Package · Mount · RoHS ·
  Lead · MOQ · Dist. · Best Price · Stock · Status). `lead_time_days` → `"{ceil(d/7)}w"`;
  `rohs` true → ✓, false → "No", null → "—"; every nullable spec field → "—".
  `overflow-x: auto`, `min-width: 960px`, mono tabular-nums, row click → `/part/{slug}`
  (guard `closest('a')`). Status chips: NRND `#fdf3e0/#946200`, Obsolete `#fdeaea/#b3261e`.
- **Manufacturer cards** → `navigate('/search?q=<name>')`. **Distributor cards → `/join`**
  (Decisions; brief-faithful — the earlier external-link idea is dropped). Logos:
  `safeImageUrl(logo_url)` with lettermark fallback (CsLogo/SbLogo onError pattern); tier badge
  from server-normalized `tier`.
- **Categories section** reuses the homepage cat-card in the tightened grid; matched
  subcategories first (server-ordered).
- **Empty state:** did-you-mean chips (white fill, dark ink `--fg1` — never accent text on a
  light card), closest-matches `SrPartsTable`, `.sr-suptile` distributor grid — **tier-ranked
  first (platinum > gold > silver > untiered) then name, cap 12 tiles**, meta line **website
  only** (OVERRIDE above), tile click → `/join` — and the keyword-sponsor CTA card **only at 0
  results** (reuse the existing CTA, datasheet motif unchanged).
- Loading skeletons reserve real heights; fetch cancel-flagged; API error → quiet error card
  with retry, never a blank page.
- SEO: stays `noindex, follow`; no seoRoutes/manifest changes.

## 3. SearchBar (`components/layout/SearchBar.tsx`)

- **The hero-only dropdown gate is lifted: the dropdown renders on both hero and navbar
  variants** (kit parity). Only the hero instance wires `onDropdownOpenChange`.
- Sections and caps (kit parity): **Parts (5) → Distributors (3) → Categories (3)**.
  - **Parts rows are NEW** (production's dropdown has none today): 24px category-icon pad +
    mono SKU + truncated description; click → `/part/{slug}` (slug from the v2 `SearchPart`);
    hover prefetches the part chunk (existing hover-prefetch pattern).
  - Distributor rows: 30px `dd-mark` lettermark pad + name + sub-line — tier present:
    `{tier} distributor · {website}`; **null tier: `distributor · {website}`; both absent:
    `distributor`** (no dangling separator, no "null"). Click → **`/join`** (Decisions).
  - Category rows: existing behavior, `categoryPath`.
- **Submit already navigates to `/search?q=` in production and stays that way** — do not add a
  direct part jump when the Parts section lands (the kit's part-jump is kit-only history).
- The dropdown's debounced fetch passes **`suggest=0`** (§1.3) so zero-result keystrokes never
  pay the fuzzy pipeline.
- **`ddOpen` mechanism (corrected from the kit's premise):** production's hero has **no
  `contain` today** and the animated SVG is a *sibling* (BackdropLayer), not a hero descendant —
  so no rest-state containment is added (it would newly risk clipping the subtitle-glow pseudos
  and buys nothing). While the dropdown is open in the hero instance, the hero root gains
  `ddOpen`: `{ position: relative; z-index: 60; }` so the popover stacks above subsequent
  content. The class toggles **from the same state commit that opens the dropdown** (never an
  after-paint effect). **No `:has()`** anywhere near the hero. Navbar instance: no hero wiring.

## 4. BrowseDrawer (new; replaces `navMobileDrawer`)

New `components/layout/BrowseDrawer/{index.tsx, BrowseDrawer.module.scss}`.

- **Rail contents (pinned — the kit's five, verbatim from `Navbar.jsx`):**
  1. **All Categories** — pane switcher; pill = top-level category count.
  2. **Parts** — link → `/search`; pill = total parts (categories-payload rollup, rounded down
     to the nearest 100 with "+").
  3. **BOM Tool** — link → `/bom` (kit parity; supersedes rev-1's "future extension" line).
  4. **Manufacturers** — pane switcher; pill = `total` from `GET /api/manufacturers/`.
  5. **Distributors** — pane switcher; pill = suppliers count.
  SITE group: Home / About / Join / Contact / **Login → `/admin/login`** (mirrors the navbar
  LOGIN, which survives unchanged), white Phosphor icons on near-black pads. Rail geometry,
  divider-at-midpoint flex halves, `.bd-close` X, neon pills, footer — all per brief/kit.
- **Footer honesty:** line 1 `{N} CATEGORIES · {M}+ PARTS` — **N = top-level category count**,
  M = parts rollup rounded down to the nearest 100; line 2 `[ESC] CLOSES` keycap +
  `CIRCUITCENTER.AI` mono. The kit's `SPONSOR-INDEX v.42` is mock and is not shipped.
- **Panes:** categories = acrylic `.bd-tile` grid (tile pill = **children count**, kit parity;
  click → `categoryPath(slug)`); **manufacturers = `.bd-tile` grid with lettermark pads**
  (NOT rows — kit parity; click → `navigate('/search?q=<name>')`); distributors = `.bd-row`
  list, gold FEATURED badge for active gold+ tiers, click → **`/join`**. Spring hover
  (`cubic-bezier(.34,1.56,.64,1)`), `prefers-reduced-motion` disables, compositor-only motion.
- **Data: all three sources fetch eagerly in parallel on drawer open** (they are small:
  categories payload already SW-cached, 57 suppliers, 60 manufacturers + total) — replaces
  rev-1's lazy-per-pane rule so the rail pills are truthful at open. Pills render "—" until
  loaded. Cancel-flagged; cached for the session; a failed source renders a quiet
  "couldn't load — retry" row in its pane and an em-dash pill, never fake numbers.
- **Geometry (deliberate divergence from the old below-strip drawer):** full-height overlay
  from the viewport top, **z-index 110 (above the header's 100)**, scrim covers the nav strip —
  required for the X to sit at the burger's exact position. Scrim `backdrop-filter: blur(2px)`
  only while open **and** ≥769px, **and skipped on `/`** (it would re-filter the continuously
  animating hero backdrop every frame; drawer-open-on-home joins the rAF sampling checklist).
- **Navbar integration:** burger at all viewports at the far left (~14px); **both brand offsets
  change** — base `left: 28px → 56px` and the ≤768px override `16px → 52px` (verify the 320px
  fit; the burger leaves `.navRight` untouched). Pinned-edge absolute scheme preserved.
  `navMobileDrawer` markup, styles, and state machine **deleted**; BrowseDrawer owns the
  3-effect state machine (body-scroll-lock, Esc-while-open, route-change close) + scrim click +
  X. `pane` resets to `"cats"` on every open.
- **Code-splitting:** drawer body lazy-loads; hover/idle prefetch keeps `.catch(() => {})`, but
  the **on-click import must not swallow failure** — on rejection the burger stays functional
  (import retried on next click); no permanently dead control.
- **A11y:** container `role="dialog" aria-modal="true" aria-label="Browse"`. **Closed: `inert`
  + `aria-hidden` on the drawer root** (no tabbable content in a hidden subtree). **Open: focus
  trap** (Tab/Shift-Tab loop inside), initial focus on the X, focus returns to the burger on
  close. Burger: `aria-expanded` from the open state; `aria-controls="browse-drawer"` points at
  an always-mounted wrapper node (the lazy chunk renders inside it, so the reference is never
  dangling). Pane switchers are buttons with `aria-current`; pills `aria-hidden` with counts in
  the accessible labels. Overflow hardening verbatim from the brief (`minmax(0,1fr)`,
  `min-width: 0`, `overflow-wrap: break-word` — not `anywhere`; ≤760px rail 224px; ≤480px rail
  185px).

## 5. Homepage hero

Quick links become `Find Parts · Top Distributors · BOM Tool` — new `AnimatedLink to="/bom"`,
identical styling. No navbar link is added (the 1200–1385px search-collision constraint stands).

## 6. Error handling summary

- Search API failure → error card + retry on the page; dropdown shows nothing new.
- Drawer source failure → per-pane inline retry row + em-dash pill.
- External hrefs (none remain on these surfaces — distributor clicks go to `/join`) would use
  `safeHttpUrl`; all logo `src` through `safeImageUrl`; nulls hide the element.
- Feed mapper never guesses: unparseable → NULL → "—". `rohs=False` is stored, not dropped.

## 7. Testing & verification

- Backend: §1.6 suites; full `pytest tests/ -q` green.
- Frontend: `npx tsc -b`, `npx eslint --ext .ts,.tsx src/`, `npm test` green; vitest for the
  lead-time "Nw" formatter and any extracted pure logic.
- Runtime (chrome-devtools): home dropdown open/close over the animated hero (async rAF
  sampling, not busy-wait); real query; typo query ("Mauser"); garbage query (expect zero
  chips); drawer open/pane-switch/Esc/route-close at **1440 / 1385 / 1250 / 1024 / 760 / 480 /
  375** (the 1200–1400 band is the documented `.navSearch` squeeze — the +28px brand shift may
  need the ≤1400px clamp retuned); drawer-open-on-`/` frame sampling.
- **mobile-layout-guard** on the drawer + search table; **theme-persistency-guard** across the
  4 themes; **visual-regression-guard** (the navbar changes on every baselined page — expect
  and re-capture baselines deliberately).
- Regression: hero animations still pause/resume; navbar search still hidden on `/`; admin
  untouched; `test_leads_never_public.py` green.

## 8. Rollout

- Branch `updates`; no deploy, no `circuits push` in this scope.
- `frontend/seo-manifest.json` untouched (search is noindex; no new indexable routes).
- After a future deploy: `circuits pull --reporting` per the standing rule; seo-auditor run
  already queued.

## Out of scope

Public Manufacturers/Distributors *pages*, KiCad/PCB-viewer placeholders, external-website
links on distributor surfaces, part-SKU did-you-mean suggestions, any Mouser backfill spend,
pg_trgm indexing (follow-up), admin surfaces.
