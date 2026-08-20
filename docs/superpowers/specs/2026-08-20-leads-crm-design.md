# Manufacturers + Leads CRM — Design Spec

**Date:** 2026-08-20 · **Status:** approved by owner · **Priority:** ahead of the BOM build
**Detail authority:** `docs/design-briefs/leads-crm-synthesis-2026-08-20.md` (adversarially
verified; its rulings R1–R15 and measurements are binding). This spec is the decision
record + build contract; where it is silent, the synthesis governs.

## 1. What this is

An admin-only sales CRM: a **Manufacturers** directory (CATALOG sidebar, Suppliers-style
triad) merged from `manufacturer_breakdown.csv` + the live catalog, and a **Leads** call
checklist from `circuitcenter_master_call_list.csv`, with per-person outcome tracking
(Converted / Maybe / Rejected), per-rep pages, and a Dashboard "Leads" panel beneath
Social & ad engagement (10 most recent attempts, See More → 100 in place).

## 2. Owner decisions (settled)

| # | Decision |
|---|---|
| L1 | Outcome attribution auto-stamps the signed-in admin (`recorded_by` free-string, `sold_by` precedent) |
| L2 | Manufacturer sponsorship via **promote/link to supplier row** — sponsor machinery untouched |
| L3 | Leads visible to **all admins**; demo refused on READS (calendar-gate pattern, `demo_account_no_leads`) and writes (allowlist) |
| L4 | Seed carries the real contact data; the 2026-08-15 no-phones-in-seed rule gets a **documented internal-roster carve-out** (CLAUDE.md edit ships in the same commit) |
| L5 | Switch + outcomes use the **house-law-compliant** visuals: glass veil + hue rim + underline bar (green/red); outcome hexes `#153f80`/`#4d189e`/`#b91c1c` (CVD-safe; `#2563eb`+`#7c3aed` are forbidden together by chartTheme.ts) with word + glyph on every surface |
| L6 | `SEED_LEADS` **true** on prod permanently — CSV is the source of truth, roster always restored |
| L7 | Converted records `sale_tier` as a **label only** + separate "Start a quote →" (prefill/Stripe flow); an outcome never writes a `sponsors` row |
| L8 | List = paginated Sponsors-style **table** (2,451 rows; the Suppliers card grid is explicitly not cloned) |
| L9 | Leads stand alone; `manufacturer_id` optional and ~95% NULL (measured ≤10/197 companies match) |
| L10 | Company-only rows (189/359, `ENRICHMENT NEEDED`) are first-class checklist rows; disc shows a centered dot, never a fake initial |
| L11 | `external_part_count` renders only as a labelled coverage ratio, never as "parts" |
| L12 | Admin-only; no public manufacturer routes in this phase (no prerender/sitemap/seo impact) |

## 3. Binding invariants

1. **Reseed survival by FK direction**: no new table carries an FK into
   {suppliers, users, categories, sponsors, parts, category_suppliers}. The only bridge
   is `suppliers.manufacturer_id` (nullable, ON DELETE SET NULL, partial-unique).
   Guard: `test_reseed_fk_isolation.py`. Prove on a scratch DB before the first prod
   `--reseed` post-ship (synthesis: TRUNCATE CASCADE was not empirically run).
2. **Leads never public**: own router `/api/admin/leads` (never the mixed suppliers
   router); `manufacturer_id` in neither `supplier_to_dict` nor `SupplierResponse`;
   nothing lead-shaped in seo/sitemap/prerender; frontend code only under `src/admin/`
   (eslint zone = mechanical guarantee); no `DEMO_LEADS` fixture ever.
   Guard: `test_leads_never_public.py` (3 assertions per synthesis §2.8.5).
3. **Merge safety**: auto-merge = canonical equality ONLY. Slash-head + prefix rules
   emit `manufacturer_merge_candidates` for human review; domain is a link signal,
   never a merge key (63 shared domains measured; 4-of-7 wrong-link rate measured).
   `Microchip USA` seeded as never-merge.
4. **Idempotency keys**: manufacturers on `canonical_key` (UNIQUE, in `__table_args__`
   for SQLite parity); leads on `source_key = canon(Company|Contact Name)` (359/359
   unique, verified).
5. Compose allowlist: `SEED_MANUFACTURERS` + `SEED_LEADS` in BOTH compose files with
   literal code-default mirrors + passthrough guard test (5th occurrence of this trap).
6. Outcome history is append-only (`lead_contacts`); `leads.last_outcome/last_contacted_at/
   contact_attempts` are denorms written in the same transaction by ONE service function.

## 4. Schema — migration 036 (BOM spec renumbers to 037/038)

Tables `manufacturers`, `manufacturer_aliases`, `manufacturer_merge_candidates`,
`leads`, `lead_contacts` + `suppliers.manufacturer_id` + `parts.manufacturer_id`
+ `ix_parts_manufacturer_name`. Full column-level definition: synthesis §2.3 (binding).
Own deploy; never alongside `--reseed` (DDL/TRUNCATE deadlock gotcha).

## 5. Seed & merge pipeline

Synthesis §5.3 verbatim (9 steps): CSVs move to `api/app/db/seed_data/{manufacturers,leads}.csv`
(git mv from temp/ + CLAUDE.md temp/-line update); canon service is a single home
(`app/services/manufacturer_canon.py`) imported by seed AND part_feed importer (which
resolves `parts.manufacturer_id` on every future import and recomputes
`catalog_part_count` at run end). Expected first-run numbers (local): 1,837 + 614
provisional = 2,451 manufacturers; 370 auto-attached keys (58,341 parts); 105 review
candidates; 359 leads (170 named / 189 enrichment). Re-run = zero new rows (tested).

## 6. Surfaces

- **Sidebar**: one CATALOG entry "Manufacturers" (adminOnly) + badge; TITLE_MAP entries
  incl. `/admin/manufacturers/new` (fallback-regex trap, R11).
- **Switch**: centered absolute in `.pageHead` (pinned-edge pattern, R9); two NavLink
  halves → `/admin/manufacturers` | `/admin/leads`; green/red per L5; hidden for demo
  sessions; demoted to normal flex child < $bp-desktop; measure the collision band in
  a browser (synthesis flagged the 1199px estimate as unverified).
- **Manufacturers list/detail/form**: sponsors-table pattern + copied ColumnHeader
  (var(--a-*) variant; NOT extracted, R13); server-side pagination `?p=N`; detail shows
  linked supplier + its sponsorships inline + "Link existing supplier" / "Promote to
  supplier" (`POST .../promote`, `bustingAfter`); review queue UI for merge candidates.
- **Leads checklist**: sortable/filterable table; checkbox → portaled OutcomeMenu
  (admin's first portal — clamp, flip, close-on-scroll, `instanceof Node` guard);
  post-outcome disc = solid 28px, PresenceBubbles geometry + structural ring, first
  initial (or dot) in outcome color + word + glyph; re-contact allowed (history rows);
  lead detail page = profile + full contact history + "Start a quote →" when converted.
- **Rep pages**: per-rep activity view (their logged calls, outcome mix), fed by
  `lead_contacts.recorded_by`; linked from SalesRepsPanel names.
- **Dashboard**: `LeadsPanel` in a new `.aOne` between Engagement and Activity rows;
  one `limit=100` fetch in the existing `Promise.all`; 10 shown, See More expands
  in place (vh-capped, overflow-y auto); gated endpoint `GET /api/dashboard/leads/recent`;
  `manufacturers_count` joins `/dashboard/stats` (no `response_model` — verified safe).

## 7. File plan & not-to-touch

Synthesis §5.2 verbatim, including the **explicitly NOT edited** lists (deploy.sh,
supplier_to_dict, schemas/supplier.py, sponsor model/routes, stripe services;
sponsors/parts list pages). Tests enumerated there ship with their lanes.

## 8. Build order (implementation-plan input; lanes parallelize after step 3)

1. Canon service + tests (pure) → 2. Migration 036 + models → 3. Seeds + flags +
compose + guard tests → then PARALLEL lanes: (a) manufacturers API+pages, (b) leads
API+checklist+outcome+profile+rep pages, (c) dashboard panel+badges+switch chrome →
4. Integration pass + full suite + mobile-layout-guard + visual-regression-guard.

## 9. Open items (non-blocking, tracked)

- Re-measure alias residue against PROD catalog before freezing alias rows there.
- Restore `scripts/validate_palette.js` (referenced by chartTheme.ts, absent) — separate task.
- Powell domain discrepancy (powell.com vs powellelectronics.com) — resolve during the
  hand-reviewed supplier-link list.
- `temp/outreach-*.md` untracked files: confirm they don't supersede the CSVs before git mv.
