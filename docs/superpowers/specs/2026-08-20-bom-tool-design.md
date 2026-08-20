# BOM Tool — Design Spec

**Date:** 2026-08-20 · **Status:** approved by owner (all sections) · **Scope:** one implementation plan
**Owner decisions in this spec are settled** — re-litigate only with the owner.

## 1. What this is

A public, no-login BOM pricing tool at `/bom` — PCPartPicker's *idea* (paste your build,
see real prices, buy) applied to electronic components. A visitor drops a BOM
(CSV/XLSX/paste), every line is matched against the catalog, priced at their build
quantity, and pointed at a recommended distributor — sponsors first within a price band.
Unmatched lines are looked up LIVE via the existing Mouser feed pipeline and become
permanent catalog rows, so the tool heals its own gaps.

Why it earns its place: a BOM is a purchase list. Every matched line is a sponsor
click-through opportunity; every miss is demand data no other surface can capture.

**Sibling projects, explicitly out of scope here** (each gets its own spec later):
KiCad schematic viewer, PCB viewer (kicad_pcb + Gerber input, one tool), 3D board view
(offline `kicad-cli` GLB precompute — measured NOT feasible on the t3.small in-request),
public user accounts. The BOM table pre-wires seams for them (see §7.6, §4).

## 2. Decision record (owner-approved, with evidence)

| # | Decision | Evidence behind it |
|---|---|---|
| D1 | BOM tool first; CSV/XLSX/paste input; viewers later | catalog+pricing data already live; viewers earn nothing alone |
| D2 | Unmatched line → capped live Mouser lookup, persisted | 33%→ exact-match floor measured on a realistic BOM; part_feed exists |
| D3 | Browser-only file; opt-in share link; `user_id` seam for future accounts | BOMs are confidential design IP |
| D4 | Recommended = highest sponsor tier within **+20%** of best price, else cheapest | measured: sponsors cheapest only 18.5% of contested parts; +20% honors sponsor on 68.8% |
| D5 | Substitution safety in scope, **warn-only** (`package differs: X → Y`) | 0805→0603 is a real, checkable failure; parts.package new column |
| D6 | Lifecycle bar shows **unverified (hatched)** unless feed-verified | 99.7% of parts carry the column DEFAULT, not a checked fact |
| D7 | Identity fields (MPN, mfr, value, footprint, desc) go to the API; **qty + designators + file never leave the browser** | most KiCad BOMs carry NO MPN (KiCad reserves no MPN field; KLC S6.2) — matching needs value/footprint |
| D8 | KiCanvas licensing concern noted; owner ruled proceed (viewers phase) | vendor kicanvas.js as separate file + license + source link |

Research artifacts (committed): `docs/design-briefs/bom-kicad-research-2026-08-19.md`
(13-agent verified packet; §5 lists refuted claims — corrections WIN over memory),
`docs/design-briefs/bom-header-aliases-2026-08-20.md` (+ raw JSON; 301 citation-verified
header spellings), `docs/design-briefs/pcb-viewer-stackup-reference.md` (viewer phase).
Design canvas (approved): claude.ai artifact "BOM Tool Design" — 4 artboards; visual
source of truth for §7.

## 3. Architecture (approved Section 1)

```
Browser                                   API                           External
drop file → papaparse/SheetJS (lazy)
  column auto-map (attested aliases)
  → explicit mapper fallback (remembered)
  extract {mpn?, value?, footprint?, desc?}   [qty+refs stay client-side]
        │ POST /api/bom/match  (identity fields only)
        ▼                                exact + approx match, listings,
        ◄── phase 1: all known rows ──   price breaks, recommendation
        │ POST /api/bom/resolve (misses only, capped)
        ▼                                per-miss part_feed lookup ───► Mouser
        ◄── phase 2: NDJSON stream ──    persists Part+Listing+package+lifecycle
```

- Two phases because ~50 misses × 300–800ms/Mouser call = 15–40s; phase 1 answers
  instantly, phase 2 streams rows in as they land (SyncConsole/`sync_event` discipline).
- The privacy claim is STRUCTURAL: quantities, designators and the file are never in any
  request. Pricing math (qty × break) runs client-side from returned break tables.
- All caps live server-side (see §9) — client caps are advisory only.

## 4. Data model & migrations

Head is 035 at spec time; BOM takes the next two slots (renumber if something lands first).

**Migration 036 — parts columns**
- `parts.package VARCHAR(60) NULL` — normalized package token ("0805", "SOIC-8").
  Populated by the live-resolve path and nightly feed; backfill is opportunistic, absence
  degrades to "no warning", never a false all-clear.
- `parts.lifecycle_verified_at TIMESTAMPTZ NULL` — NULL ⇒ UI shows hatched/unverified.
  Stamped ONLY when a feed actually returned a lifecycle value. `lifecycle_status` keeps
  its enum; the timestamp is the truth-bit. (Implementation must confirm the Mouser
  response field name for lifecycle — UNVERIFIED in research; if absent from search
  responses, resolve stamps package only and lifecycle stays honest-unverified.)

**Migration 037 — bom_shares**
- `slug VARCHAR(32) PK` (22-char base64url of 16 random bytes), `payload JSONB` (≤1MB,
  422 above), `user_id UUID NULL FK users` (future-accounts seam; nothing writes it yet),
  `created_at`, `expires_at` (default now()+180d). Expired rows pruned opportunistically
  on each create (DELETE WHERE expires_at < now(); no new cron).

## 5. Matcher (`app/services/bom_match.py`)

Ladder per line (first hit wins):
1. **EXACT** — `upper(sku) = upper(:mpn)` via new functional index `upper(parts.sku)`
   (inside migration 036; declare in `__table_args__` so SQLite tests reproduce it).
2. **APPROX** — bidirectional prefix family, min 5 chars: catalog sku startswith mpn
   (`1N4148` → `1N4148WS-HG3_A-08`) OR mpn startswith catalog sku (user pasted long
   ordering code). Rank: shortest length delta, then verified lifecycle, then max stock.
   Response includes `approx_reason` ("suffix differs", "successor/base part") and the
   package warning when both packages known and differ. Never silently upgraded to EXACT.
3. **No MPN** (normal KiCad case) — no catalog guessing. Build resolve query
   `"{value} {package_token} {tolerance?}"` (e.g. `10k 0805 1%`); footprint token =
   substring after first `:` of a `LIB:FOOTPRINT` value, else the raw footprint cell.
4. **MISS** → phase-2 resolve.

**Recommendation — `recommend(listings, line_qty, tier_rank)` is a PURE function**
(no DB/HTTP; table-driven tests; the one place the sponsor-preference number lives):
- `line_qty = bom_qty × build_qty` exists ONLY client-side (D7: quantities never
  reach the server). Consequence: the +20% rule has TWO MIRRORED HOMES, exactly like
  the password policy — `recommend()` in `bom_match.py` computes the server's DEFAULT
  pick (at the break ladder's base qty) and `lib/priceBreaks.ts` re-runs the IDENTICAL
  rule at the real line_qty whenever build-qty changes (no refetch). Both homes are
  table-tested against the same fixture cases; edit one and the other's test fails.
- Per listing: applicable break = largest `min_quantity ≤ line_qty` (below smallest
  min ⇒ the base `unit_price`).
- Candidates = listings with `stock_quantity > 0`.
- Sponsor pick: active sponsorship tiers via the same active-semantics as the boards
  (`Active OR NULL`; tier normalized `.strip().lower()` — the tier-casing gotcha).
  Highest tier (platinum > gold > silver), tie → oldest active sponsorship. Wins iff
  `unit_price_at_break ≤ 1.20 × min(unit_price_at_break over candidates)`.
- Else cheapest candidate. Ties → sponsor, then higher stock.
- Response: chosen + ALL candidates sorted by price (dropdown), each with stock,
  breaks table, supplier tier badge, `price_stale` flag.

**Row indicator rules** (render contract):
- Left rail (part lifecycle): `lifecycle_verified_at NULL` ⇒ UNVERIFIED (hatched);
  else ACT/NRND/EOL by enum. Colors/textures per the canvas.
- Right rail (offer availability): blue `stock ≥ line_qty`; violet `0 < stock <
  line_qty`; red no in-stock candidate; hatched `listing.last_updated > 30 days`
  (`price_stale`) — staleness beats blue/violet.
- Match badge texture: EXACT solid · APPROX hatched · NO MATCH outline (hue carries
  status, texture carries confidence — never both on one channel).

**DNP lines** (default chosen, owner may override in review): rows whose DNP cell is
non-empty are shown greyed, excluded from totals and from resolve, with a per-BOM
"include DNP" toggle. Attribute cells are STRING-OR-EMPTY ("DNP"/""), never booleans.

## 6. Resolve pipeline (`POST /api/bom/resolve`)

- Body: list of misses `{query, mpn?}` (≤50, 422 above). Streams NDJSON events reusing
  the `sync_event()` 5-key contract (single constructor rule): one event per miss —
  `resolved` (part payload, same shape as match rows, flagged `EXACT · LIVE`),
  `not_found`, or `resolve_unavailable`.
- Engine: existing `part_feed` registry/providers/importer — resolve is a THIN caller;
  per-row persistence identical to daytime clicks (part+listing+breaks+image), plus
  `package` + `lifecycle_verified_at` stamping (§4). Created parts appear in the catalog
  and (note) need the seo-manifest regen at next deploy like any import.
- Budget: `BOM_RESOLVE_DAILY_BUDGET` (default 100) — in-process daily counter beside
  `FEED_IMPORT_CALL_BUDGET=850`'s accounting; per-worker (single worker today; same
  documented posture as the login rate limiter). Exhausted or `FeedFatalError` 403 →
  emit `resolve_unavailable` for ALL remaining misses and stop (the quota wall is
  Mouser-wide; further calls are wasted).
- Rate limits: `/match` 20/min/IP, `/resolve` 4/min/IP via the SHARED
  `rate_limit.client_ip` (IPv6 /64 semantics) — never a fork.
- COMPOSE ALLOWLIST (the recurring trap): `BOM_RESOLVE_DAILY_BUDGET` added to BOTH
  compose files' `environment:` blocks, default MIRRORING the code default, guarded in
  `test_compose_env_passthrough.py` in the same commit.

## 7. The page (`frontend/src/public/pages/bom/`)

Visual source of truth: the approved canvas (4 artboards). Standard page recipe:
lazy route in App.tsx, `PageHeaderBand`, `seoRoutes.ts` entry (indexable), prerender
covers it as a static route.

### 7.1 Intake
- Dropzone (react-dropzone) + browse + paste-rows (one `PART[ ,|]QTY` per line —
  Mouser grammar). CSV/TSV via papaparse; XLS/XLSX via `xlsx` loaded through
  `lib/xlsx.ts` dynamic import ONLY when such a file lands (manualChunks entry;
  `.catch(() => {})` per prefetch convention on the preload path).
- Caps: 2,000 lines; 200 designators/line (JLCPCB-attested rule); duplicate designator
  across rows → warning banner, not a block.

### 7.2 Parser (`lib/parseBom.ts` — pure functions + fixtures)
Attested requirements (each has a fixture in `lib/fixtures/`):
1. Metadata preamble — header row is NOT row 0 (two legacy KiCad exporters emit a
   5-line preamble). Scan first ~10 rows for the best header-alias hit count.
2. Delimiter sniff: `,` `;` `\t`.
3. Both quoting regimes: unquoted (kicad-cli default) and QUOTE_ALL (legacy scripts).
4. Unquoted multi-ref hazard: grouped refs with no quoting make `R1-R3,R7` two cells —
   detect `cells > headers`, re-join overflow into the refs column (only signal).
5. Ref parsing: split on `,` AND `", "`; expand prefix-aware ranges (`R1-R3`).
6. Header aliases: case-insensitive, punctuation/whitespace-trimmed, from
   `lib/headerAliases.ts` — GENERATED from the attested table (301 verified spellings;
   `Comment` maps to VALUE — JLCPCB convention; `Designator` AND `Refs`/`Reference(s)`
   both live; `Qnty`, `Cmp name`, `#` are real). Plus two PATTERN rules:
   `<distributor>#` and `{LCSC|JLCPCB} × {Part #|Part|PN|P/N|Part No.|Part Number}`.
7. DNP/attribute columns: string-or-empty semantics.
8. Anything unmapped → the mapper (7.3). Never guess silently.

### 7.3 Column mapper
Mouser-style explicit mapping step (their most-praised feature): appears only when
auto-map is incomplete/ambiguous; per-column dropdowns; "Continue" disabled until a
part-identity column (MPN or Value) is mapped; mapping REMEMBERED in localStorage
keyed by the header-row signature.

### 7.4 Table
The canvas, 1:1: coverage strip FIRST with the honest number ("N of M lines priced"
+ segmented exact/approx/live/not-found), build-qty control (drives break re-pick
client-side), channel-rail rows, 8 columns, totals footer "totals cover the N priced
lines". Row states: EXACT / APPROX(+warning) / resolving… (streamed) / EXACT·LIVE /
NOT FOUND → "Request a quote" (prefills /contact partner desk with THAT LINE only).
Alternates dropdown: portaled listbox (ColumnHeader/IconSelect patterns; scroll-close
guards incl. `e.target instanceof Node`). Honesty rules bind: never render a price the
server didn't compute; unverified never renders as Active.

### 7.5 Export & share
- Export = client-side CSV of the priced table (no server).
- Share = explicit button → `POST /api/bom/share` (the ONLY path any BOM content
  reaches the server; payload = full table state incl. qty/refs — that is the user's
  deliberate choice) → `/bom/s/:slug` read-only render, "shared BOM" banner + expiry.

### 7.6 Seams (build now, fill later)
- Row model carries `viewerHref: string | null` (null today) — the designator-jump
  seam for the viewer projects; chips render as text until non-null.
- `bom_shares.user_id` nullable — future accounts claim shares by UPDATE, no migration.

### 7.7 Design tokens
The canvas's material system lands as REAL tokens in `_variables.scss`/`_themes.scss`
(glass control recipe, rail gradients, badge textures, tinted-card surface), including
a tinted-surface secondary-text token — measured: `#6b7076` = 4.24:1 on the tinted
card (FAILS); use the derived `#676c71`-class values from the measured pass. Mobile:
card reflow ≤768px per `mobile-layout-guard` rules — **prices are never hidden**.

## 8. SEO
`seoRoutes.ts` entry (title/desc/canonical for `/bom`); share pages `noindex, follow`;
sitemap: `/bom` only (not `/bom/s/*`).

## 9. Limits, failure, security

| Concern | Rule |
|---|---|
| File errors | wrong type → named error; unparseable header → mapper, not spinner; empty → invitation |
| Mouser down/quota | remaining rows → quote-request state, copy "lookups exhausted for today" |
| Streaming client | canonical cancel-flag on unmount; NDJSON line-buffered parse |
| XSS | React escaping; supplier links via `safeHttpUrl` + `rel="sponsored noopener noreferrer"`; images via `safeImageUrl` |
| Share abuse | 1MB payload cap; slug 128-bit; create rate-limited 5/min/IP; TTL 180d |
| Server caps | §6 budgets; all enforced server-side |

## 10. Testing

- **pytest**: matcher ladder (exact/approx/bidirectional/min-length); `recommend()`
  table tests (sponsor-within-band, outside-band, tie, no-sponsor, no-stock, stale,
  break boundaries incl. below-smallest-min); resolve caps + daily budget + quota-wall
  degradation (fake Mouser transport that FILTERS on query params — the FakeStripe
  lesson); share TTL/size/slug; compose passthrough.
- **vitest** (`*.test.ts` colocated): parseBom fixtures — kicad-cli unquoted, KiBoM
  grouped, legacy `Qnty`/`Cmp name` + preamble, TSV, semicolon, overflow multi-ref
  repair, ref-range expansion; headerAliases pattern rules; priceBreaks picker;
  build-qty re-pick.
- **Agents**: `mobile-layout-guard` at 320/360/390/414/768/1024/1280;
  `visual-regression-guard` after tokens land; `seo-auditor` after the route ships.

## 11. File plan

As approved in-conversation (≈20 new files, 9 edits): routes/bom.py,
services/bom_match.py, schemas/bom.py, models/bom_share.py, migrations 036+037,
3 pytest files; pages/bom/{index,BomPage.module.scss,lib/*,components/*} with
colocated vitest fixtures; edits to App.tsx, seoRoutes.ts, _variables/_themes,
vite.config.ts (manualChunks), main.py, part_feed/importer.py (stamping), both
compose files + passthrough guard test.

## 12. Adjacent fixes (bundled or immediately after; not scope-creep, measured)

1. `search_service.py` N+1 — 2 queries/part in a loop; batch like
   `featured_supplier_name` does. One-file fix.
2. 17 catalog parts stuck with demo-era data + `sub_slug NULL` (demo/catalog SKU
   collision) — one-time repair script or accept until next reseed.
3. `UNIQUE(sku)` — UNBLOCKED (catalog_load key unified 2026-08-20) but ships as its
   OWN migration/deploy, never alongside `--reseed` (DDL/TRUNCATE deadlock gotcha),
   after a prod dry-run via the BEGIN/ROLLBACK psql pattern.

## 13. Build order (for the implementation plan)

1. Migrations 036/037 + models + matcher service + `recommend()` — pure-backend, TDD.
2. `/api/bom/match` + schemas + tests.
3. Resolve pipeline + budget + streaming + tests.
4. parseBom + headerAliases + fixtures (pure TS, TDD — no UI yet).
5. Page shell + intake + mapper.
6. Table + states + streaming client.
7. Tokens + polish + share + export.
8. Agent passes (mobile, visual, seo) + full-suite gate.
