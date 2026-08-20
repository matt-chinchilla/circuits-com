# ADVERSARIAL SYNTHESIS — Manufacturers / Leads

All code claims below were re-verified by me in the repo; all data claims re-measured against the local DB and the two CSVs. Numbers I did not reproduce are marked.

---

## PART 1 — RULINGS WHERE THE REPORTS CONFLICT OR ARE WRONG

**R1 — Report 1's headline sponsor risk is factually false. Do not propagate it.**
Report 1: *"migration 016's partial unique indexes … are all supplier-keyed, so a manufacturer-sponsor and a supplier-sponsor can occupy the same Platinum slot."* Wrong. `api/alembic/versions/016_sponsor_single_slot_uniqueness.py:86-90,93-97`:
```
CREATE UNIQUE INDEX uq_active_platinum_per_category ON sponsors (category_id)
WHERE category_id IS NOT NULL AND lower(tier)='platinum' AND (status='Active' OR status IS NULL)
```
Keyed on `category_id` **alone** — the migration comment at `:81-84` says so explicitly. `_reject_if_slot_taken` (`api/app/routes/admin_sponsors.py:149-153`) filters `category_id` + `tier` + active, never `supplier_id`. Report 2 has this right. **A `sponsors.manufacturer_id` XOR would NOT breach single-slot.** What it *would* breach is `UniqueConstraint("supplier_id","category_id")` / `("supplier_id","keyword")` (`api/app/models/sponsor.py:71-72`) — the one-company-one-placement duplicate cap, a lesser guarantee.
**Ruling:** the conclusion (no `sponsors.manufacturer_id`) still stands, but on Report 2's grounds only. This matters because the false reason invites a later "I added the index, we're fine" — and that fix would be real, and would still leave the Stripe path broken.

**R2 — Report 1's `SupplierResponse` claim is half wrong; the real exposure surface is narrower and opt-in.**
`GET /api/suppliers/` (`api/app/routes/suppliers.py:133-134`) and `GET /api/suppliers/{id}` (`:188-189`) are unauthenticated and return **`supplier_to_dict()`** (`:116-131`), a hand-built dict — **not** `response_model=SupplierResponse`. `SupplierResponse` (`api/app/schemas/supplier.py:6`) is consumed only by `routes/search.py:15` and `schemas/category.py:87` (the Silver board).
**Ruling:** a new Supplier column is public only if someone adds it to `supplier_to_dict` **or** to `SupplierResponse` — two explicit opt-ins, not automatic. `suppliers.manufacturer_id` is safe to add provided it lands in neither, with a guard test asserting exactly that.
Report 1's `suppliers.py:610` citation is real but harmless: `GET /api/suppliers/{id}/parts` (`:585-591`, no `current_user`) is unauthenticated and emits `manufacturer_name` — public catalog data. The load-bearing fact it accidentally proves is different and important: **`routes/suppliers.py` is a MIXED router** (3 unauthenticated GETs + 8 authed routes). Cloning it wholesale for Manufacturers, and then hanging Leads off the same router family, is the single most likely path to a lead leak.

**R3 — Merge numbers: all four reports disagree. My re-measurement, using Report 1's lineage-aware canon, is the ruling set.**
Canon = NFKC + casefold + `&`/`+`→`and` + strip `.,'®™` + `-_/`→space + **parenthetical kept unless it is an acronym of the base / a repeat / in {manufacturing,mfg,group,holdings,the}** + repeatable trailing legal-suffix fold **excluding `usa`/`us`/`na`**.

| measure | value |
|---|---|
| MB rows → canon keys | 1,838 → **1,837** (1 collision: `Amphenol` / `Amphenol Ltd`) |
| live `parts.manufacturer_name` → canon keys | **994** → 984 (10 collisions, all benign spelling/lineage) |
| MB ∩ parts (canon) | **370 keys** → 377 live names → **58,341 parts (65.5% of 89,019)** |
| MB ∩ parts (exact raw) | 318 names / 48,486 parts |
| **UNION = manufacturer record count** | **2,451** |
| unmatched live | 614 keys / 617 names / 30,678 parts |
| + slash-head, unambiguous | +15 keys / 27 names / 3,451 parts |
| + longest-leading-prefix | +90 keys / 178 names / 18,201 parts |

Report 2's headline "590 names / 87.7%" is reachable **only with the prefix rule**, which is the unsafe one: it folds `Amphenol Commercial Products` + `Amphenol FCI` + `Amphenol SGX Sensortech` (2,807 parts) into `amphenol` while the breakdown deliberately lists 26 distinct Amphenol/TE brands on `te.com` alone.
**Ruling:** AUTO-MERGE = canon equality only (370 keys). Slash-head (15) and prefix (90) go to a review queue, never auto. Build the UI for ~2,451 rows.

**R4 — Lead↔Manufacturer pairing (my re-measurement).** 197 paren-stripped lead parents: **∩ manufacturer CSV = 8**, ∩ live catalog = 2, ∩ suppliers = 6, **matching nothing = 182 (92.4%)**. Reports said 176 / 10 / 6 / 11 — all in the same ballpark, none identical. Spec C's "paired to Manufacturers via Company" resolves for **≤10 of 197 companies**. Leads must be a first-class entity with an optional link. Non-negotiable.

**R5 — `ENRICHMENT NEEDED` is a clean partition, not a scatter.** 189/359 rows (52.6%), and I verified the sharper fact no report stated: those 189 rows are **189 distinct companies**, with **zero overlap** with the 52 companies that carry the 170 named people. So the file is *52 companies × 170 people* + *189 company-only rows*. Contact Title is filled on **170/170 named rows and 22 placeholder rows**. The checklist has two row types by construction.

**R6 — Lead table depth: Report 2's flat model wins, and Report 1's objection does not apply to it.**
Report 1 argues 3 tables because Ring is per-branch (Bisco spans all ten Rings across 21 branch rows — I confirmed 123 rows / 55 distinct branch-suffixed company strings, 241 raw → 197 parents). But Report 2's flat `leads` row keeps the **branch string verbatim** as `company_name` and its own `ring`, so nothing is collapsed and nothing is lost. `(Company, Contact Name)` is unique 359/359 — verified. Three tables for 359 rows is over-modelling.
**Ruling:** one `leads` table. Add `company_slug` (paren-STRIPPED canon, for grouping) **and** `branch_label` (the extracted parenthetical, so the branch is data not a substring).

**R7 — Alias/idempotency key: Report 1 right, Report 2 wrong.** Report 2 proposes `Index("uq_manufacturers_name_lower", func.lower(name), unique=True)`. That fails the actual job: `Amphenol Ltd` and `Amphenol` have different `lower(name)` and the *same* canon. **Unique index goes on `canonical_key`**; `lower(name)` gets a non-unique index. Declare on `__table_args__` so `create_all` reproduces it under SQLite (the `uq_users_email_lower` precedent).

**R8 — Outcome colors: the owner's literal trio is forbidden by the repo's own recorded constraint.**
`frontend/src/admin/components/charts/chartTheme.ts:16-19`: *"HARD CONSTRAINT: #2563eb (blue) and #7c3aed (purple) collapse under deuteranopia (dE 0.4). They may never be adjacent slots and never coexist in an all-pairs form."* Three simultaneous outcome states **is** an all-pairs form.
Report 3 is also right that blue/violet/red are **not** the site's ACT/NRND/EOL colors — those are green/amber/red (`pages/parts/list/PartsPage.module.scss:305-320`). The brief's premise is mistaken.
Report 4's substitution `#153f80` / `#4d189e` / `#b91c1c` preserves the owner's blue-violet-red *intent*, and all three hexes already exist in-repo (`components/PresenceBubbles.module.scss:98,104`; `PartsPage.module.scss:318`) and clear that file's stated ≤0.18333-luminance white-text contract (`PresenceBubbles.module.scss:77-83`).
**Blocking caveat I verified and no report resolved:** `chartTheme.ts:27,34` instructs you to re-run `node scripts/validate_palette.js` before changing any hex. **That file does not exist** — `frontend/scripts/` contains only `gen-seo-manifest.mjs` and `seoPrerender.ts`; a repo-wide `find` returns nothing. Report 4's ΔE figures came from a hand-written simulator that already disagrees with the recorded value (2.1 vs 0.4 for the forbidden pair). The palette cannot be validated by the repo's own gate today.

**R9 — Switch placement: Report 4 beats Report 3.** Report 3 says "middle child of the `.pageHead` flex row". `pages/suppliers/list/SuppliersPage.module.scss:16-23` is `display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap` — a third child in space-between is **not** centered when side tracks differ, and CLAUDE.md bans the `1fr auto 1fr` alternative. Use the navbar pinned-edge pattern: `.pageHead{position:relative}`, switch `position:absolute; left:50%; transform:translateX(-50%)`, **even** fixed width, `top:0;bottom:0;display:flex;align-items:center` (never `translateY(-50%)` — sub-pixel glyph blur), and demote to a normal wrapped flex child below `$bp-desktop`.

**R10 — Switch fill: Report 4's veil-not-fill reading is correct AND satisfies the owner's words.** `glass.scss:12-18` house law: *"ONE filled primary action per screen"*; `LIQUID-GLASS.md:174-175`: *"Destructive stays text-red until hover tint — danger never shouts"*; `:163-164`: *"`--a-primary` on a dark glass control is 3.11:1 — it is a fill color, never ink on glass."* Liquid glass in this repo **is** a low-alpha veil (`glass.scss:32-41`), not a fill. So "GREEN liquid-glass when selected" is literally satisfiable as: glass veil + ≤8% hue tint + 1px hue rim + 2px hue bar + label ink stays `--a-fg1` in both states/themes. Still an owner decision (see D6).

**R11 — Two routes, not `?view=`. Report 3's reasoning verified.** `TITLE_MAP` is pathname-keyed (`AdminLayout.tsx:82-97`, `pageTitle()` `:99-111`) and `<ErrorBoundary key={location.pathname}>` does not re-key on search. **Extra trap I found:** the fallback regex `^\/admin\/(\w+)\/[\w-]+$` matches `/admin/manufacturers/new` → renders **"Manufacturer Detail"**. Explicit `TITLE_MAP` entries for `/admin/manufacturers`, `/admin/manufacturers/new`, `/admin/leads` are mandatory, exactly as `/admin/suppliers/new` already is.

**R12 — Clone the SPONSORS table, not the Suppliers grid.** Verified: `pages/suppliers/list/index.tsx:147-193` renders `filtered.map` into `.supCard` articles with **no pagination and no virtualization** (62 suppliers today). 2,451 manufacturers through that path is a mobile-heap problem. Spec A's "cloned from Suppliers" is satisfiable as the list/detail/form *triad*, not the card grid — flag to owner (D4).

**R13 — Do NOT extract `ColumnHeader` in this PR.** Two inline copies verified (`pages/sponsors/list/index.tsx:184-~405`, `var(--a-*)`; `pages/parts/list/index.tsx:117-~240`, local `$a-*`). Report 3 wants extraction; Report 4 warns it touches shipped code. **Ruling: copy the sponsors variant into the new pages, file extraction as a separate follow-up.** The sponsors list itself was a copy, not an extraction — that is the house precedent, and a feature PR that breaks `/admin/sponsors` is worse than a fourth copy.

**R14 — Report 4 is right that the outcome chooser must be portaled, and reimplementing is allowed.** `grep -rn createPortal frontend/src/admin` returns **nothing** — the admin has no portaled popover anywhere, and the existing in-cell `position:absolute` panel has no viewport clamp, no flip-above, no close-on-scroll. The chooser trigger lives in a scrolling `<tbody>`; rows near the viewport bottom would open off-screen. `frontend/.eslintrc.json:31-35` forbids *importing* `@public`'s ColumnHeader, not porting its mechanics.

**R15 — Migration number: take 036. There is no coordination fork.** Head is **035** (verified: `alembic_version = 035`; `035_presence_fake_names.py` revision="035"/down_revision="034"). CLAUDE.md's "Alembic head = 033" is stale. Report 2 framed 036-vs-038 as a decision requiring a doc edit — but `docs/superpowers/specs/2026-08-20-bom-tool-design.md:67` already says *"Head is 035 at spec time; BOM takes the next two slots (**renumber if something lands first**)."* The spec grants it. Take 036; BOM becomes 037/038.

---

## PART 2 — THE CONSOLIDATED DESIGN

### 2.1 Three universes
1. **`manufacturers`** = MB CSV ∪ `parts.manufacturer_name` = **2,451** records. The call list is deliberately excluded (92.4% of it matches nothing).
2. **`suppliers`** = unchanged. Bridge is a nullable column **on suppliers**.
3. **`leads`** = 359 person-or-placeholder rows, first-class, optional manufacturer link.

### 2.2 FK direction is the whole `--reseed` answer (Report 2's §1, adopted)
`deploy.sh:134` runs `TRUNCATE sponsors, category_suppliers, categories, suppliers CASCADE`. TRUNCATE CASCADE follows the **referencing** direction and **ignores `ON DELETE SET NULL`** — proven in this repo, not just in the docs: `calendar_events → users` carries `confdeltype='n'` (verified via `pg_constraint`) and `deploy.sh:132-138` *still* has to `pg_dump`/restore it by hand.

So:
- `manufacturers`, `manufacturer_aliases`, `leads`, `lead_contacts` carry **zero FKs into {suppliers, users, categories, sponsors, parts, category_suppliers}**.
- The bridge is **`suppliers.manufacturer_id`** → manufacturers (nullable, `ON DELETE SET NULL`, partial-unique). Truncating suppliers wipes the *column*, never the manufacturer row.
- `leads.manufacturer_id` → manufacturers is safe **only while manufacturers stays outside the graph**. Guard it (below).
- `lead_contacts.recorded_by` is a free `String(120)` username — precedent `Sponsor.sold_by` (`models/sponsor.py:44-49`). **Never** an FK to `users`.

Consequences: **`deploy.sh` needs no change**, and the 8-step supplier delete cascade (`routes/suppliers.py:239-282`) gains **no 9th step** (the FK is on the row being deleted).

**Guard test (nobody proposed this; it is the thing that keeps the design true):** a pytest that walks `Manufacturer.__table__.foreign_keys`, `Lead.__table__.foreign_keys`, `LeadContact.__table__.foreign_keys` and fails if any target table is in the truncate set. Runs on SQLite metadata, following the column-metadata-assertion precedent.

**Reuse of `activity_events` for outcomes is disqualified**, confirmed: `activity_events.supplier_id → suppliers` exists with `confdeltype='a'` (`models/activity_event.py:41`). Outcome history would be destroyed by a routine reseed.

### 2.3 Schema (single migration 036)

```
manufacturers
  id UUID pk
  name             String(200) NOT NULL          # CSV max 45, catalog max ~40
  slug             String(220) NOT NULL UNIQUE
  canonical_key    String(220) NOT NULL          # UNIQUE  ← the idempotency key (R7)
  website          String(300) NULL
  logo_url         Text NULL                     # Text per migration 017; NOT seeded (R15/§2.6)
  description      Text NULL
  external_part_count Integer NULL               # CSV figure. NEVER named parts_count.
  external_part_count_source String(40) NULL     # 'breakdown_csv'
  external_part_count_as_of  Date NULL
  catalog_part_count Integer NOT NULL default 0  # materialized; recomputed by seed + feed-import
  source           String(20) NOT NULL default 'catalog'   # 'csv' | 'catalog' | 'manual'
  created_at / updated_at
  Index(lower(name))  -- non-unique
  NO ForeignKey anywhere.  Load-bearing.

manufacturer_aliases
  manufacturer_id UUID FK -> manufacturers ON DELETE CASCADE, index
  alias           String(200) NOT NULL
  alias_canon     String(220) NOT NULL
  source          String(20)  NOT NULL      # 'breakdown' | 'catalog' | 'slash-head' | 'prefix' | 'manual'
  confidence      String(10)  NOT NULL      # 'auto' | 'approved'
  first_seen_at   TIMESTAMPTZ server_default now()
  PK (manufacturer_id, alias_canon);  UniqueConstraint(alias_canon)

manufacturer_merge_candidates                # the review queue — NEVER auto-applied
  id, left_manufacturer_id, right_alias, rule, evidence Text, status, created_at

suppliers  (+1 column)
  manufacturer_id UUID NULL FK -> manufacturers ON DELETE SET NULL
  Index(manufacturer_id, unique=True, postgresql_where="manufacturer_id IS NOT NULL")
  ** absent from supplier_to_dict AND from SupplierResponse **   (R2)

parts (+1 column, +2 indexes)
  manufacturer_id UUID NULL FK -> manufacturers ON DELETE SET NULL, index
  manufacturer_name stays NOT NULL, raw as-imported
  CREATE INDEX ix_parts_manufacturer_name ON parts(manufacturer_name)
     ← verified absent today; parts has ONLY parts_pkey, ix_parts_category_id,
       ix_parts_sku, ix_parts_slug, ix_parts_sub_slug, over 89,019 rows.

leads
  id UUID pk
  source_key    String(300) NOT NULL UNIQUE   # canon("Company|Contact Name"); 359/359 unique (verified)
  company_name  String(200) NOT NULL          # branch string verbatim, e.g. "Bisco Industries (Bohemia)"
  branch_label  String(80)  NULL              # the extracted parenthetical
  company_slug  String(220) NOT NULL, index   # paren-STRIPPED canon → groups branches
  manufacturer_id UUID NULL FK -> manufacturers ON DELETE SET NULL
  tier   String(1) NULL                       # S/M/L  (M=202 S=134 L=23, verified)
  ring   String(12) NULL                      # STRING. 'UNVERIFIED' on 35 rows (verified). Never INTEGER.
  street/city/state(2)/postal_code(10)/main_phone(24)/website(200)/sales_email(200)
  contact_name String(120) NULL               # NULL when the CSV said ENRICHMENT NEEDED
  needs_enrichment Boolean NOT NULL default false
  contact_title/direct_phone/contact_email/linkedin_url/hours_tz/notes
  last_outcome String(12) NULL, index
  last_contacted_at TIMESTAMPTZ NULL
  contact_attempts Integer NOT NULL default 0

lead_contacts                                  # append-only
  id, lead_id FK->leads ON DELETE CASCADE index
  outcome String(12) NOT NULL                  # VARCHAR not enum (activity_event.py:35-37 precedent)
  sale_tier String(10) NULL                    # a LABEL. Writes no sponsor row. (§2.5)
  note String(500) NULL
  recorded_by String(120) NULL                 # free string, NOT an FK
  created_at TIMESTAMPTZ server_default now() NOT NULL, index
```

### 2.4 Sponsorship (spec B) — promote-to-supplier, unambiguously
Manufacturer detail gets **"Link existing supplier"** and **"Promote to supplier"** (`POST /api/admin/manufacturers/{id}/promote`) → creates a `Supplier`, sets `suppliers.manufacturer_id`, partial-unique so one company can never fork into two links. Sponsorship then runs through `/admin/sponsors` **completely unchanged**, via the existing prefill bus: `setPrefill('sponsor', {supplier_id, supplier_name, tier})` + `navigate('/admin/sponsors/new')` — `pages/sponsors/form/index.tsx:149` already consumes it. Manufacturer detail renders the linked supplier's sponsorships inline so the two objects read as one company.

Cost of the alternative (`sponsors.manufacturer_id`), from Report 2's enumeration which I spot-checked: `Sponsor.supplier_id` NOT NULL + a second XOR CheckConstraint; two more UniqueConstraints; **seven Supplier columns mirrored onto Manufacturer** because `SponsorResponse` pulls `logo_url/contact_role/coverage_hours/brand_*/phone/email/contact_name` off the joined supplier; four INNER JOINs in `category_service.py`; and **the entire Stripe path** — `admin_quotes.py` + `stripe_quotes.py` key the customer on `metadata.supplier_id` and `stripe_webhook.py` creates a Supplier and stamps `supplier_id`. A manufacturer-keyed sponsorship is unquotable and unbillable. Not close.

### 2.5 "Converted" writes a note, never a sponsorship
`lead_contacts.sale_tier` is a label. Platinum and Gold are single-slot and DB-enforced; a lead outcome must never attempt a `sponsors` row. Label the control **"Tier discussed"**, and put a separate **"Start a quote →"** affordance that routes into the existing prefill/quote flow. Otherwise the dashboard shows conversions with no revenue behind them and the two numbers disagree.

### 2.6 Logo: store `website`, not the Logo column
Verified: **1,758/1,838 (95.6%)** Logo values are `google.com/s2/favicons?domain=…&sz=128`, and **1,832/1,838** rows carry a usable domain in the URL column. Persisting Logo would (a) fire ~2,400 third-party requests to google.com **with a Referer** on every admin list render, (b) rot on the 74 direct CDN hotlinks, (c) bypass the established `validate_optional_image_url` (write) / `safeImageUrl` (read) boundary that already has four sponsor/supplier render sites and a documented history of the fourth being missed. Use `lettermark()` tiles; upload real logos via the existing `ImageUploadField` when someone cares.

### 2.7 `external_part_count` is never rendered as "parts"
The column sums to **72,400,411** across 1,838 rows against **89,019** live parts. On the matched subset it exceeds live in every case. Render it only as a labelled coverage stat ("6,760 of ~433,483 listed") or not at all.

### 2.8 Privacy (spec E) — three doors, and only one is already shut
1. **Writes: already covered, better than reported.** `_is_demo_blocked_write` (`auth_service.py:237-245`) is an **allowlist** — anything not in `DEMO_WRITE_EXEMPT_PATHS` is blocked automatically, so new lead routes are protected without an edit. Add a case to `test_demo_read_only.py` so it is asserted, not assumed.
2. **Reads: NOT covered.** GETs are "fully open" by design (`auth_service.py:191-192`) because the demo must see the whole console. `POST /api/auth/demo` hands any anonymous visitor a real admin session. Copy the calendar gate verbatim: a `require_leads_access` modelled on `routes/calendar.py:130-167`, refusing demo on reads with a **distinct** detail string (`demo_account_no_leads`) — `calendar.py:57-62` explains why distinctness matters. Apply it to every leads route **and to the dashboard leads endpoint**, which is the easy-to-miss second door.
3. **Public routers.** Leads get their **own** router (`routes/admin_leads.py`, prefix `/api/admin/leads`) — never a clone of the mixed `routes/suppliers.py`. `suppliers.manufacturer_id` goes in neither `supplier_to_dict` nor `SupplierResponse`. No lead data in `seo-manifest.json`, `seoRoutes.ts`, `scripts/seoPrerender.ts`, or `sitemap.py`.
4. **UI:** hide the Leads switch segment entirely when `demoSession.isDemo()`; the route renders "not available in demo" if reached directly. **Ship no `DEMO_LEADS` fixture** — the repo already hit the fabricated-contact problem with the Platinum pitch preview's `tel:1-800-555-0199`.
5. **Guard test `api/tests/test_leads_never_public.py`:** (i) no route lacking the leads gate returns a Lead shape; (ii) none of `routes/{categories,suppliers,search,forms,sponsors,sitemap,checkout,parts,analytics}.py` imports `Lead`; (iii) `manufacturer_id` absent from `supplier_to_dict` and `SupplierResponse`.

### 2.9 Frontend
- **Routes:** `/admin/manufacturers`, `/manufacturers/new`, `/manufacturers/:id`, `/manufacturers/:id/edit`, `/admin/leads`, `/admin/leads/:id`. **One** sidebar entry (Manufacturers, CATALOG group, `adminOnly`); Leads is reached only via the switch, whose halves are `<NavLink>`s so URL and switch can never disagree.
- **Switch:** per R9/R10. `<NavLink>` + `aria-current="page"`, `role="group" aria-label="Catalog view"` — not `role="tablist"` (it is navigation), not the `/join` `aria-pressed` precedent (that exists because tier cards have rich children; these are plain labels).
- **List:** sponsors-table clone + copied ColumnHeader (`var(--a-*)` variant) + `.panel{overflow:visible}` + `.tableWrap` **without** `overflow-x` + **server-side pagination**. Paginate with `?p=N` following the category-page precedent; do **not** put `setSearchParams` in effect deps (RR v7 identity churn), and write any default to localStorage synchronously before `setParams`.
- **Outcome disc:** simplified solid 28px disc reusing PresenceBubbles geometry + the `box-shadow 0 0 0 1.5px var(--a-card)` structural ring; drop the gradient (its lit stop is exactly the value that collapses under CVD). Dark theme swaps the surface ring for a lift-tint rim (deep fills read 1.5–2.6:1 on `--a-card` #171e2b).
- **The nameless 52.6%:** disc shows `&#183;` (centred dot), **never "E"**. `lettermark()` returns 1–2 chars and `'?'` for null — it is not a first-initial helper; write a pure `firstInitial()` in `pages/leads/outcome.ts` beside `OUTCOME_META`, with a vitest sibling.
- **Colour + text rule:** the disc's letter encodes *identity*, so colour alone carries outcome. Every surface renders the **word** — list cell, chooser, profile, dashboard row, rep mix bar — plus the glyph (`&#10003;` / `&#63;` / `&#10005;`, HTML entities per the JSX mangling gotcha).
- **Dashboard:** new `.aOne` between `EngagementPanel` (`pages/dashboard/index.tsx:320-322`) and the `.aTwo` Activity/ImportQueue row (`:324-327`). Fetch once at `limit=100` inside the existing `Promise.all`; See More is local state slicing 10→100 in place with `max-height` in **vh** and `overflow-y:auto` — no modal (the dashboard has no focus-trap/scroll-lock machinery anywhere).
- **Badge:** `DashboardStats += manufacturers_count?: number`. Safe from the `response_model` strip — verified `api/app/routes/dashboard.py` declares **zero** `response_model=` anywhere, and `/dashboard/stats` (`:324-328`) returns a plain dict.

---

## PART 3 — GOTCHA CROSS-CHECK (the adversarial pass)

| CLAUDE.md gotcha | verdict |
|---|---|
| single-slot sponsor machinery | **SAFE** — promote-to-supplier changes nothing. R1 corrects the false index claim. |
| `--reseed` TRUNCATE CASCADE | **SAFE by FK direction**, not by backup. Guard test required (§2.2). `deploy.sh` unchanged. |
| compose `environment:` is an ALLOWLIST; empty `${VAR:-}` destroys the code default | **ACTIVE RISK** — `SEED_MANUFACTURERS` / `SEED_LEADS` must be in **both** compose files with literal `true`/`false` mirrors, plus `test_compose_env_passthrough.py`. This is the 5th occurrence of this trap. |
| `response_model=` silently strips computed attrs | **NOT triggered** — dashboard.py uses none; build all new dicts by hand and add no `response_model=`. |
| `SupplierResponse` shared public/admin | **RE-SCOPED** by R2 — two opt-in surfaces (`supplier_to_dict`, `SupplierResponse`), guard both. |
| demo read-only | writes free (allowlist); **reads need the calendar gate** — the single largest privacy hole in the feature. |
| `?:` catches `undefined` not `null` | every nullable manufacturer/lead field is `T \| null` + `!= null`. `manufacturer_id` is NULL for ~95% of leads. |
| URL-param-absent ≠ default-intent | two routes make absence unrepresentable; pagination `?p=N` follows the category precedent. |
| `setSearchParams` in effect deps | filter-change effects depend on filter values only; functional setter form. |
| TS strict | no `_`-prefixed unused vars. |
| empty SCSS rule → undefined class | every new module class carries ≥1 declaration. |
| CSS Modules can't host BEM `--` | camelCase only. |
| non-ASCII JSX mangling | `&#10003;` / `&#63;` / `&#10005;` / `&#183;` / `&rarr;` as entities. |
| `Node.contains(window)` throws | `e.target instanceof Node` **before** `.contains()` in the portal's outside-click and scroll-close guards. |
| `type="url"` silent submit | manufacturer website field is `type="text"` + inputMode + JS validation + `noValidate`; `test_no_type_url_form_input.py` will otherwise fail. |
| `safeImageUrl` / `validate_optional_image_url` | applies at every manufacturer logo render site if logos are ever stored. §2.6 avoids the problem by not seeding them. |
| Sponsor tier casing | reuse `normalizeSponsorTier` / `isActiveSponsor` / `SPONSOR_TIER_RANK` for the manufacturer sponsorship badge — never a TitleCase literal. |
| `NUMERIC → string` | n/a; no money columns here. |
| SQLite ignores `String(N)` + CHECK | assert widths on `Model.__table__.c.col.type.length`. |
| functional unique index on `__table_args__` | `canonical_key` unique declared on the model so `create_all` reproduces it. |
| seed re-runs every container start (the Kennedy rule) | leads = INSERT-IF-ABSENT on `source_key`, **never UPDATE**; manufacturers get-or-create on `canonical_key`, refresh website only while `source != 'manual'`. |
| DDL + `--reseed` deadlock | ship 036 on its **own** deploy; 5 CREATE TABLEs + 2 ALTERs take AccessExclusiveLock. |
| `temp/` is outside the api build context | verified: `docker-compose.yml:19` context `./api`, `api/Dockerfile:30` `COPY . .`, `api/.dockerignore` excludes `tests`/`*.md` but no CSV pattern. Files must live under `api/app/db/`. |

---

## PART 4 — OWNER DECISIONS (numbered; we cannot make these)

1. **Seeding 260 real Main Phone numbers + 8 named salespeople's direct phones**, against the standing 2026-08-15 rule that blanket-nulled seeded phones in both DBs. No test enforces the rule either way, so it will ship silently whichever way you go. *Recommendation:* exempt the internal lead roster, and write the carve-out into CLAUDE.md rather than leaving it inferred.
2. **Committing 170 real people's names / 44 emails / 8 phones / 8 LinkedIn URLs into the API Docker image** on every build (they are already committed to git under `temp/`, so exposure is unchanged, but the *image* becomes a new distribution surface). Alternative: seed leads from a host-mounted file on first deploy only.
3. **Spec C's "Lead = a PERSON" covers 47.4% of the file.** 189 of 359 rows are company-only placeholders forming 189 distinct companies. Confirm the checklist is per-row (mixed person/company) — the design assumes yes and gives the nameless rows a dot instead of a letter.
4. **Spec A's "cloned from Suppliers."** The Suppliers list is an unpaginated card grid; 2,451 manufacturers cannot use it. Confirm "cloned" means the list/detail/form *triad*, rendered as the Sponsors-style paginated table.
5. **Spec C's "paired to Manufacturers via Company" resolves for ≤10 of 197 lead companies (measured).** Confirm leads stand alone with an optional, mostly-NULL manufacturer link, and that the Manufacturers detail "Leads" block is a quiet collapsed row (empty on ~99% of pages).
6. **The switch's green/red.** House law forbids two filled greens on one screen and forbids persistently shouting red. Recommended reading: veil + hue rim + hue bar, label ink `--a-fg1` (the only value that clears 4.5:1 on the dark glass control). Confirm, or overrule and accept the house-law exception in writing.
7. **Outcome colours.** `#2563eb`/`#7c3aed` are explicitly forbidden together by `chartTheme.ts:16-19`. Approve the deepened substitutes `#153f80` / `#4d189e` / `#b91c1c`, **and** decide who restores `scripts/validate_palette.js` (it does not exist; the file the codebase tells you to run before changing any hex is missing).
8. **"Converted (a tier sale)" side effects.** Recommended: writes a label only, with a separate "Start a quote →". Confirm it must not auto-create a Sponsor row.
9. **`external_part_count` (the 72.4M CSV figure) — show it at all?** Its provenance is inferred (Octopart), not confirmed. Recommended: show as a labelled coverage ratio or omit.
10. **Public manufacturer pages?** If manufacturers ever become a public route, the prerender count goes 3,709 → ~6,160 docs and `seo-manifest.json` regeneration joins the deploy path. Currently scoped admin-only.
11. **Access level for Leads:** `adminOnly` (like Sponsors/Expenses) or `owner`-only (like message deletion)? Real people's contact data argues for owner-only.
12. **`SEED_LEADS` default in prod:** `false` after the initial load, or `true` forever? `true` means a deploy can never lose the roster; `false` means an operator's deletion sticks (the Kennedy Electronics lesson).

---

## PART 5 — DELIVERABLES

### 5.1 Migration numbers
- **036 — `manufacturers_and_leads`** (`down_revision="035"`). Five CREATE TABLEs (`manufacturers`, `manufacturer_aliases`, `manufacturer_merge_candidates`, `leads`, `lead_contacts`), two ALTERs (`suppliers.manufacturer_id`, `parts.manufacturer_id`), two CREATE INDEXes (`ix_parts_manufacturer_name`, `ix_parts_manufacturer_id`). **Own deploy. Never alongside `--reseed`.**
- BOM renumbers **036/037 → 037/038** (its own spec at `docs/superpowers/specs/2026-08-20-bom-tool-design.md:67` authorises this: *"renumber if something lands first"*). Edit `:69`, `:79`, `:250`.

### 5.2 Consolidated file plan

**Data (permanent home)** — `api/app/db/seed_data/manufacturers.csv`, `api/app/db/seed_data/leads.csv`, mirroring `catalog_data/` (`seed.py:2056` reads `Path(__file__).parent / "catalog_data"`). Update CLAUDE.md's "`temp/` holds the committed sales data-collection sets" line, or the next person edits the dead copy. Note `git status` shows untracked `temp/outreach-kit.md` and `temp/outreach-queue-local.md` — check with the owner whether either supersedes the CSVs before moving.

**Backend — new**
`app/models/manufacturer.py`, `app/models/lead.py` · `app/schemas/manufacturer.py`, `app/schemas/lead.py` · `app/routes/admin_manufacturers.py` (`/api/admin/manufacturers`), `app/routes/admin_leads.py` (`/api/admin/leads`) · `app/services/manufacturer_canon.py` (the canon + alias resolver, single home, imported by seed **and** importer) · `app/services/leads.py` (the one function that writes `lead_contacts` + the `leads` denorm in one transaction) · `app/db/seed_manufacturers.py`, `app/db/seed_leads.py` · `alembic/versions/036_manufacturers_and_leads.py`
Tests: `test_manufacturer_canon.py`, `test_manufacturer_merge.py`, `test_leads_never_public.py`, `test_leads_demo_read_refusal.py`, `test_reseed_fk_isolation.py`, `test_lead_outcome_denorm.py`, + `test_compose_env_passthrough.py` and `test_demo_read_only.py` edits.

**Backend — edits**
`app/config.py` (+`SEED_MANUFACTURERS`, `SEED_LEADS`) · `app/main.py` (2 routers) · `app/db/seed.py` (call the two seeders, flag-gated) · `app/services/part_feed/importer.py` (resolve manufacturer on import; recompute `catalog_part_count` at run end) · `app/routes/dashboard.py` (`manufacturers_count` on `/stats`; `GET /api/dashboard/leads/recent`, gated, no `response_model`) · `docker-compose.yml` + `docker-compose.prod.yml` (both flags, literal mirrors).
**Explicitly NOT edited:** `deploy.sh`, `routes/suppliers.py:116-131` (`supplier_to_dict`), `schemas/supplier.py`, `models/sponsor.py`, `routes/admin_sponsors.py`, `services/stripe_*`.

**Frontend — new** (all under `src/admin/`, never `@shared/` — the eslint zone at `.eslintrc.json:31-35` is the mechanical privacy guarantee)
`types/manufacturers.ts`, `types/leads.ts` · `pages/manufacturers/CatalogSwitch.tsx` + `.module.scss` · `pages/manufacturers/{list,detail,form}/index.tsx` + 3 module.scss · `pages/manufacturers/detail/ManufacturerQuickActions.tsx` · `pages/manufacturers/supplierLink.ts` + test · `pages/manufacturers/ColumnHeader.tsx` (copied from the sponsors variant — **not** extracted) · `pages/leads/{list,detail}/index.tsx` + 2 module.scss · `pages/leads/OutcomeMenu.tsx` (portaled) · `pages/leads/outcome.ts` + `outcome.test.ts` (`OUTCOME_META`, `firstInitial`, with the CVD constraint written as a comment beside the hexes, mirroring `chartTheme.ts`) · `pages/dashboard/components/LeadsPanel.tsx`

**Frontend — edits**
`App.tsx` (6 lazy imports + 6 routes) · `components/AdminLayout.tsx` (BadgeKey union `:35`, `CATALOG_LINKS` `:48-58`, `DEMO_BADGES` `:71`, `TITLE_MAP` `:82-97` incl. `/admin/manufacturers/new`, the stats effect `:171-192`, `badgeValue` `:264-273`) · `services/adminApi.ts` (11 methods; `bustingAfter` on `promoteManufacturerToSupplier` only) · `types/admin.ts` (`manufacturers_count?`) · `pages/dashboard/index.tsx` (+1 `.aOne` between :322 and :324) · `pages/dashboard/DashboardPage.module.scss` (`.leads*` block) · optional `pages/sponsors/form/index.tsx:792` (`<optgroup>` split).
**Explicitly NOT edited:** `pages/sponsors/list/index.tsx`, `pages/parts/list/index.tsx`.

### 5.3 Seed / merge pipeline order (idempotent; every step get-or-create)
1. `manufacturers` from `manufacturers.csv`, keyed on `canonical_key`. 1,838 rows → 1,837 records (the Amphenol pair goes to the review queue, not a merge — the URL column disagrees: amphenol.com vs amphenol.co.uk).
2. Resolve every distinct `parts.manufacturer_name` (994 today) through the canon. 370 keys attach to an existing record; **614 keys create `source='catalog'` provisional rows** (30,678 parts).
3. Write one `manufacturer_aliases` row per accepted resolution, `confidence='auto'`.
4. Emit `manufacturer_merge_candidates` for the two suggest rules — slash-head unambiguous (15 keys / 3,451 parts) and longest-leading-prefix (90 keys / 18,201 parts). **Never applied by the seed.** Seed a hard never-merge pair from the CSV's own note: `Microchip USA` carries *"INDEPENDENT — not Microchip Technology"* (`temp/circuitcenter_master_call_list.csv:163`; note the **em dash**, not a hyphen).
5. Backfill `parts.manufacturer_id` from the alias table; recompute `manufacturers.catalog_part_count`.
6. Link suppliers by canon + domain **from a hand-reviewed list only**. The measured domain-only rule produces 4 wrong links in 7: Pro Signal→Farnell, TRU Components→Conrad, Cellevia→TME, Zoro Select→Zoro are distributor house brands on the distributor's domain. Also 63 breakdown domains are shared by >1 company (te.com 26, eaton.com 13, sensata.com 7 — measured), so domain is a **link/parent** signal, never a merge key.
7. `leads` from `leads.csv`, INSERT-IF-ABSENT on `source_key`. Map `"ENRICHMENT NEEDED"` → `contact_name=NULL, needs_enrichment=true` (189 rows). Extract `branch_label` from the parenthetical (123 rows / 55 distinct strings); `company_slug` = paren-stripped canon (241 raw → 197 parents).
8. Opportunistically set `leads.manufacturer_id` where `company_slug` resolves (~9 of 197).
9. Assert count stability on re-run in a test. `catalog_part_count` also recomputed at the end of every nightly `feed-import` run.

### 5.4 Honestly unverified
- **Every DB number is LOCAL** (89,019 parts, 994 distinct `manufacturer_name`, 62 suppliers, alembic 035). Prod defaults `SEED_DEMO_CATALOG=false` and has a different catalog; the brief's "832 distinct" may be the prod figure or a pre-feed-import snapshot. **Re-measure against prod before freezing the alias rules** — the 614-key provisional residue in particular will differ.
- I did **not** execute a `TRUNCATE … CASCADE` (even inside `BEGIN; … ROLLBACK;`) to empirically prove the four new tables survive — the task was SELECT-only. The claim rests on the `pg_constraint` FK-direction dump (13 FKs, listed above) plus the calendar precedent at `deploy.sh:132-138`, which proves `ON DELETE SET NULL` gave zero protection. **Prove it on a scratch DB before the first prod `--reseed` after this ships.**
- Report 4's deuteranopia ΔE figures came from a hand-written simulator that already disagrees with the repo's recorded value (2.1 vs 0.4 for the forbidden pair). `scripts/validate_palette.js` is **absent** — I confirmed by `find`. Every hex must be re-validated once that script is restored.
- The 1199px switch-collision band is estimated from font sizes and character counts, not measured in a browser. This is exactly how the navbar's 1200–1385px band was originally missed. Measure the rendered header.
- The Octopart provenance of `Number of parts` is inferred, not confirmed. What is certain: it exceeds the live count on every matched name.
- My classification of the residual canon collisions as benign (`Diodes Inc./Diodes Incorporated`, `Renesas (Dialog)/Renesas / Dialog`, `THAT/THAT Corporation`, …) is judgement from company knowledge, not an authoritative registry. The Amphenol call rests solely on the `.com`/`.co.uk` split.
- Whether the 6 lead↔supplier canon matches (hawk electronics, master electronics, pei genesis, powell electronics, rfmw, tsi solutions) are the same legal entities is unconfirmed. Note the call list gives **powell.com** for Powell Electronics while the supplier row uses **powellelectronics.com** — one of them is wrong, and domain-only matching would have mislinked it.
- I did not read the four sponsor board render components, `LIQUID-GLASS.md` in full, or `pages/parts/list/index.tsx`'s ColumnHeader body — the "copy the sponsors variant" ruling assumes the two copies have not diverged in props beyond the documented `$a-*` vs `var(--a-*)` token difference.
- Whether prod's `temp/` CSVs match the working tree, and whether the untracked `temp/outreach-*.md` files supersede them, was not checked.