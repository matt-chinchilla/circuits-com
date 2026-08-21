# Handoff: Search Experience & Browse Drawer Refinements

## Overview
One working session of refinements to the Circuits.com public site, in two areas:
1. **Search** — the results page went from a mocked empty-state-only screen to a live search surface: parts render in a spec-sheet table with thumbnails, plus manufacturer / distributor / category result sections, a fuzzy "did you mean" empty state, and a keyword-sponsor CTA.
2. **Browse drawer** — the hamburger-launched browse sidebar was de-flattened to match the rest of the app: icon pads, neon count pills, acrylic category tiles, a utility footer, a mid-rail divider, a collapse button, and responsive/overflow hardening.

## About the Design Files
The files in this bundle are **design references created in HTML/JSX for a static UI kit** (React 18 via Babel-standalone, plain CSS files, mock data in `data.js`). They are prototypes showing intended look and behavior — **not production code to copy directly**. The task is to **recreate these designs in the production codebase** (`frontend/` — React 19 + TypeScript + Vite + SCSS Modules, FastAPI backend) using its established patterns: SCSS modules with `@use variables/mixins`, theme CSS custom properties on `[data-theme]`, Phosphor Light icons via the shared `<Icon>` component, lazy-loaded pages under `src/public/pages/`.

## Fidelity
**High-fidelity.** Colors, spacing, typography, and interaction states are final intent. Recreate pixel-perfectly, but substitute kit-only mock data (part specs, counts, "sponsor-index v.42") with real API data.

---

## Statement of Modified Files (this session)

| Kit file | What changed | Production target |
|---|---|---|
| `components/Search.jsx` | Full rewrite: live matching over parts/categories/suppliers/manufacturers; `SrPartsTable` spec table; `SrSupCard`/`SrSupTile` distributor cards; typed fuzzy "did you mean" (word-level Levenshtein + trigram closest-matches); empty state with up-to-15-part table + distributor tile grid; sponsor CTA only when 0 results | New/updated `src/public/pages/search/` page + components |
| `components/SearchBar.jsx` | Dropdown gained a **Distributors** section (lettermark tile `dd-mark`); submit always navigates to the search page (no direct part jump); toggles `.dd-open` on `.hero` while the dropdown is mounted (perf: replaces a `:has()` approach that thrashed style invalidation against the animated hero SVG) | `src/public/components/SearchBar` |
| `components/Navbar.jsx` (BrowseDrawer) | Rail split into two 50% halves so the divider sits at the exact vertical midpoint; Site group gained **Login** and per-link icons (house/info/handshake/envelope-simple/sign-in); pinned utility footer (counts + ESC keycap hint); pane heads carry item counts; collapse **X button** positioned exactly where the nav burger sits | `src/public/components/layout/Navbar` drawer |
| `components/Home.jsx` | Hero pill links gained **BOM Tool** (`Find Parts · Top Distributors · BOM Tool`) | HomePage hero |
| `data.js` | Every part gained spec fields: `mount` ("SMT"/"THT"), `rohs` ("Compliant"), `leadTime` ("4w"…), `moq`, `distCount` | `api` Part model/seed + `part_to_dict` + TS types |
| `styles.css` | Browse-drawer restyle (`.bd-*`), `.hero.dd-open` containment lift, `.bd-close` X, `.bd-foot`/`.bd-kbd`, responsive drawer rules, neon `.bd-head`/`.bd-meta` pills, acrylic `.bd-tile` | `Navbar.module.scss` / drawer SCSS |
| `sponsor.css` | Search-results v2 CSS (`.sr-*`: table, thumbs, sup cards/tiles, tier badges), suggestion-chip contrast fix, header title-chip specificity fix, header meta no-wrap | `SearchPage.module.scss` |
| `index.html` | Stylesheet cache-bust query strings only | n/a |

---

## Screens / Views

### 1. Search results page (`Search.jsx`)
**Purpose**: land every searchbar submit; show all matching entities or a recovery-rich empty state.

**Header band** (unchanged layout, fixed styling):
- Dark band: `var(--executive-blue)` (#0a4a2e) / `var(--theme-nav-bg)` per theme, 24px PCB grid overlay at 35% opacity, padding 36px 20px 28px.
- Eyebrow chip `QUERY · <TERM>`: mono 0.7rem, letter-spacing .18em, accent border `color-mix(accent 45%)`, accent 10% fill, `white-space: nowrap`.
- Title: "Results for" (500, rgba(255,255,255,.65), 1.05rem) + query chip — **must use selector `code.search-page-title-q`** (white text, `rgba(255,255,255,.12)` fill, dashed `rgba(255,255,255,.32)` border) to outrank the grouped `.search-page code` rule.
- Meta line: real result count (`N results · 0.034 s · sponsor-index v.42`), flex space-between, gap 16px, children `white-space: nowrap` + ellipsis, "Clear ↩" link `flex-shrink: 0`.

**Result sections** (each: mono label `.sr-label` — 0.68rem, .18em tracking, uppercase, `--fg2`, count in bold `--fg1`):
1. **PARTS — `SrPartsTable`**: white card wrap (1px rgba(0,0,0,.08) border, radius 10, `overflow-x: auto`), table min-width 960px, font 0.84rem.
   - Columns: Part (thumb + SKU + description) · Manufacturer · Package · Mount · RoHS (✓) · Lead · MOQ · Dist. · Best Price (right) · Stock (right) · Status.
   - `th`: mono 0.62rem uppercase .14em on `var(--surface)` (#eef1f5), bottom border rgba(0,0,0,.08).
   - `td`: 10px 12px padding, `--fg1`, nowrap; mono cells tabular-nums; row hover `var(--theme-accent-soft)` bg, cursor pointer → part page.
   - Thumbnail `.sr-thumb`: 56px (36px `.sr-thumb-sm` in table), radius 8/6, fill `color-mix(accent 10%)`, **1px dashed** `color-mix(accent 45%)` border, Phosphor icon in `var(--executive-blue)`.
   - Status chip: neutral surface; NRND = #fdf3e0/#946200; Obsolete = #fdeaea/#b3261e.
2. **MANUFACTURERS / DISTRIBUTORS — `.sr-sup` cards**: auto-fit minmax(280px,1fr) grid, gap 12; white card radius 10; lettermark pad `.sr-pad` (46px, radius 8, accent-10% fill, dashed accent-45% border, heading font 700, `--fg1`); name 0.94rem/600; desc 0.78rem `--fg2`; tier badge `.sr-tier` mono 0.62rem uppercase — variants: `featured`/`gold` = #a88d2e tint on #7a651e, `platinum` = #e8eef7/#3b5a82, `silver` = surface/`--fg2`. Hover: translateY(-2px), accent border, `0 6px 18px rgba(0,0,0,.10)`.
3. **CATEGORIES**: reuse the homepage `cat-card` verbatim (white card, 24px grid wash, icon + name head, frosted-acrylic sub chips) in a tightened grid `repeat(auto-fit, minmax(250px,1fr))`; matched subcategories ordered first.

**Empty state** (0 results):
- Centered white card; heading `No exact match for <code>term</code>`.
- **DID YOU MEAN** chips: white fill, **dark ink `--fg1`** (never `--theme-cta-bg` — near-white in steel), 1.5px dashed accent-40% border, radius 20; each chip carries a 24px lettermark pad (distributor/manufacturer) or Phosphor icon (part/category) + tiny mono kind tag (0.58rem, `--fg3`). Matching: token containment (+3) → word-level Levenshtein ratio ≤ .5 (+(1−r)×4) → entity tie-break (+0.25). **Word-level is required** so "Mauser" reaches "Mouser Electronics".
- **CLOSEST MATCHES & POPULAR PARTS**: same `SrPartsTable`, closest fuzzy matches (trigram overlap ×2 + shared SKU prefix, min score 2) first, backfilled with popular parts, cap 15 rows.
- **BROWSE DISTRIBUTORS — `.sr-suptile` grid** (admin supplier-card layout): auto-fill minmax(240px,1fr); column card radius 10 padding 16: header (46px lettermark pad + name with tier badge below), desc 0.8rem/1.45 `--fg2`, mono meta `website · phone` 0.7rem.
- ~~Browse Categories~~ removed (redundant).
- **Keyword-sponsor CTA** card below (unchanged datasheet motif), only at 0 results.

### 2. Searchbar dropdown (`SearchBar.jsx`)
- Sections: Parts → **Distributors** (new) → Categories.
- Distributor row: `.dd-mark` 30px lettermark pad (accent-10% fill, dashed accent-45% border, heading font) + name 600/.85rem + sub-line `{tier} distributor · {website}` .72rem `--fg2`.
- Submit (Enter) always routes to the search page with the query.
- **Perf-critical**: while the dropdown is mounted on the homepage, add class `dd-open` to `.hero` → `.hero.dd-open { contain: layout style; overflow: visible; z-index: 60; }`. Do **not** use `:has()` (the animated hero SVG forces continuous selector invalidation). Default hero keeps `contain: layout style paint`.

### 3. Browse drawer (`Navbar.jsx` + `.bd-*` in `styles.css`)
- **Rail** (264px, white): two flex halves — `.bd-rail-top { flex:1 0 auto; min-height: calc(50% - 11px); padding-top: 32px }` so the dashed divider (`border-top: 1px dashed #d3dae2; margin: 10px 20px`) sits at the exact vertical midpoint; `.bd-rail-bottom` holds Site + footer, footer `margin-top: auto`.
- **Collapse button `.bd-close`**: absolute left 14px top 5px, 26×26, three 16×2px bars pre-rotated into an X (±5px translate, 45°), ink #1a222c, hover accent-soft bg + `--executive-blue` bars — sits exactly where the nav burger renders.
- Section labels `.bd-head` ("BROWSE"/"SITE") and count pills `.bd-meta`: **neon quantity-indicator style** — mono, `background: var(--theme-accent)`, text #1a1f23, radius 10, tabular-nums, `white-space: nowrap` on pills.
- Nav items: 46px min-height; icons **always white** on a 30px near-black pad (#1a1f23, radius 7, 1px rgba(255,255,255,.14) rim, `0 1px 2px rgba(16,24,32,.18)` shadow — matches the brand logo). Site links (Home/About/Join/Contact/**Login**) use 26px pads: house, info, handshake, envelope-simple, sign-in. Hover: accent-soft bg + inset 3px accent-45% bar; active: full accent bar + `--executive-blue` text.
- **Utility footer `.bd-foot`**: dashed top border, mono 9px .12em uppercase `#6b7280`, two lines: `28 CATEGORIES · 2,400+ PARTS` and `SPONSOR-INDEX v.42 · [ESC] CLOSES`; `.bd-kbd` keycap (white, 1px #d3dae2 border + 1px drop, `--executive-blue`). Esc already closes the drawer.
- **Pane** (min(340px, 100vw−264px), #f7f9fb + 24px PCB grid at rgba(10,74,46,.035)): pane heads mono .18em with count in `.bd-pane-sub`; **category tiles `.bd-tile`** wear the homepage sub-chip acrylic: rest = `linear-gradient(rgba(255,255,255,.86),rgba(255,255,255,.66))` over `linear-gradient(112deg, rgba(0,188,177,.22), rgba(128,199,39,.26) 48%, rgba(224,227,66,.3))`, border rgba(12,26,5,.1), inset highlight; hover = full neon ramp `112deg rgb(0,188,177) → rgb(65,255,72) 58% → rgb(224,227,66)` + `0 4px 14px rgba(30,233,50,.32)` glow + `translateY(-1px) scale(1.02)` with spring `cubic-bezier(.34,1.56,.64,1)`; active `scale(.97)`; `prefers-reduced-motion` disables. Tile icons: white on 26px black pad. Tile counts: translucent white pill. Distributor rows: swatch with bevel shadows, hover lift, gold FEATURED badge (#a88d2e-16% / #7a651e).
- **Overflow/responsive (required)**: rail & pane `overflow-x: hidden`; grids `minmax(0,1fr)`; `.bd-tile { min-width: 0 }`; names `overflow-wrap: break-word` (**not** `anywhere` — causes mid-word breaks); `.bd-drawer { max-width: 100vw }`; ≤760px rail 224px, pane `calc(100vw−224px)`; ≤480px rail 185px, pane `calc(100vw−185px)`, tighter padding. Scrim: `backdrop-filter: blur(2px)` **only** on `.is-open` and ≥769px.

### 4. Homepage hero
- Pill links: Find Parts · Top Distributors · **BOM Tool** (routes to the BOM page).

## Interactions & Behavior
- Search submit (nav, hero, results page) → results page; result rows/cards navigate (part page, category page, distributors → Join).
- Suggestion chip click re-runs the search with that term; manufacturer card click re-searches its name.
- All card hovers: 160–180ms transform/border/shadow transitions; tile spring uses `cubic-bezier(.34,1.56,.64,1)`.
- Drawer: burger opens; X (same position), scrim click, or Esc closes; route change closes.
- Perf guardrails: no `:has()` against subtrees with running animations; no always-on `backdrop-filter`; keep hero `contain: layout style paint` except while the dropdown is open.

## State Management
- Search page: `q` (input), `submitted` (executed query); derived memos: results {parts, cats, sups, mfrs, total}, suggestions, closest — recompute on `submitted`.
- SearchBar: `q`, `open`, outside-click close; `showDD` drives the `.dd-open` hero class (cleanup on unmount).
- Drawer: `open`, `pane` ("cats" | "mfrs" | "dists", resets to "cats" on open).
- Production: replace client-side matching with the search API; keep fuzzy suggestion logic server- or client-side as preferred.

## Design Tokens (used this session)
- Brand: `--executive-blue` #0a4a2e · `--nav-blue`/accent #44bd13 · `--sponsor-gold` #a88d2e · `--surface` #eef1f5 · ink `--fg1` #1a1f23 / `--fg2` #6b7076 / `--fg3` #9ca3af · pad black #1a1f23.
- Neon chip ramp: rgb(0,188,177) / rgb(128,199,39) / rgb(224,227,66) / hover mid rgb(65,255,72); glow rgba(30,233,50,.32); chip ink #14300a → #0c1a05.
- Tier badges: gold #a88d2e-tint/#7a651e · platinum #e8eef7/#3b5a82 · silver surface/#6b7076; status warn #fdf3e0/#946200 · bad #fdeaea/#b3261e.
- Type: native SF Pro stack headings/body; `--font-mono` for SKUs, labels, counts (always tabular-nums). Radii: 10 cards, 8 tiles/thumbs, 6–7 pads, 10 pills. PCB grid texture: 24px cells (12px on 56px thumbs).
- **A11y rule**: accent-colored *text* on light cards is forbidden (steel theme) — use `--executive-blue` or `--fg1`; accent is for fills, borders, and dark-band text only.

## Assets
No new binary assets. Icons are Phosphor Light (self-hosted font in production; kebab-case names in data). Distributor "logos" are lettermark fallbacks — production should use real supplier logo images where available (admin already has them).

## Files
- `Search.jsx`, `SearchBar.jsx`, `Navbar.jsx`, `Home.jsx` — components (JSX, Babel-standalone)
- `data.js` — mock data incl. new part spec fields
- `styles.css` — global kit styles (drawer `.bd-*`, hero, cat-card/cat-sub reference)
- `sponsor.css` — search page styles (`.search-page*`, `.sr-*`, `.search-empty*`)
- `index.html` — kit entry (script/stylesheet order reference)

Live kit: open `index.html`, use the searchbar (try `stm32`, `texas`, `digi-key`, or typo `Mauser`) and the hamburger drawer.
