# Live Distributor Price-Feed & Catalog Expansion — Design Spec

- **Date:** 2026-05-28
- **Status:** Draft for review
- **Owner:** Matthew

## Goal

Replace synthetic part prices with **live, accurate prices from real distributor APIs**, and **grow the catalog** with real parts pulled from those same APIs. Displayed prices must match what a user sees when they click through to the distributor — reliability is the core value proposition. No synthetic or fabricated price is ever shown to the public.

circuits.com is positioned as an **Octopart competitor**, so data is sourced from **primary distributors**, never from Octopart/Nexar.

## Decisions (locked with Matthew, 2026-05-28)

- **Source = FREE primary distributor APIs:** Digi-Key (OAuth2), Mouser (key), element14/Newark/Farnell (key). NOT Octopart/Nexar.
- **Discovery = pricing:** one search call returns price breaks + stock + product URL. Digi-Key + element14 are the discovery backbone (category browse); Mouser is MPN enrichment (adds a second real listing to a known part).
- **Ingestion = Python CLI** (`python -m app.pricing.refresh`) on a **cron sidecar** (not n8n) — all logic in tested Python.
- **Cadence:** nightly at **00:00 America/New_York** (tz-aware for DST), configurable; rotates across subcategories within the daily quota; **rate-limit-adaptive** (honor remaining-quota headers, back off, resume next night).
- **Cutover model = full-sync-then-flip:** the public site keeps showing current data until the initial full discovery + price sweep completes across the whole catalog; then a single switch flips the public read path to real-only and retires synthetic listings. No mixed/transitional state. Parts that no fed distributor carries will legitimately show "no live listing" even post-flip — never a fabricated price.
- **Category scope = all 75 subcategories mapped up front** before the first sync (complete coverage from day one), not a phased slice.
- **Currency/region = USD / US distributors:** Digi-Key US, Mouser (USD), element14 → Newark (US). One currency across every listing.
- **Visibility:** an admin "Price Sync" page (run history + what changed) instead of n8n's dashboard.
- **Failure handling:** API down / part-not-found → keep last-known price WITH an explicit staleness flag; never silent, never fabricated.

## Grounding (verified 2026-05-28 against vendor docs)

| Distributor | Price + stock + URL in one call | Category browse | Per call | Key |
|---|---|---|---|---|
| Digi-Key | ✓ StandardPricing (BreakQuantity/UnitPrice), QuantityAvailable, ProductUrl | ✓ `CategoryId` filter + Categories endpoint | 50, offset-paged | OAuth2, free |
| element14 | ✓ "prices" + "inventory" response groups (real-time) | ✓ category search | paged | free 24-char key |
| Mouser | ✓ PriceBreaks (Qty/Price/Currency), Availability, ProductDetailUrl | limited (keyword/MPN) | 50 | free key |

Exact free-tier rate limits were not surfaced by the (SPA) portals; community ballpark ~1,000 calls/day. The sync is designed to **adapt to the real limit** rather than hardcode it. Confirm precise numbers at key signup.

## Data-model changes (Alembic migration)

- **Dedupe existing duplicate `parts.sku` first**, then add a `UniqueConstraint` on `parts.sku` (enables `ON CONFLICT` upsert; today only a non-unique index + Python check).
- `UniqueConstraint` on `part_listings (part_id, supplier_id)`.
- `UniqueConstraint` on `price_breaks (listing_id, min_quantity)`.
- Add `part_listings.price_source` `String(40)` nullable (e.g. `digikey` / `mouser` / `element14` / `seed`).
- Add `part_listings.last_synced_at` `DateTime` nullable (distinct from existing `last_updated`).
- New table `price_sync_runs`: `id, started_at, finished_at, source, mode (discover|refresh), categories_swept, parts_seen, parts_created, listings_upserted, price_changes, errors, status, notes`. Drives the admin page + churn metrics. Start with run-level rows + a capped recent-changes log; per-part delta table can come later.

## Backend components (`api/app/pricing/`)

- `clients/base.py` — `DistributorClient` interface: `search_category(query, offset) -> list[NormalizedListing]`, `lookup_mpn(mpn) -> NormalizedListing | None`, plus rate-limit state.
- `clients/digikey.py`, `clients/mouser.py`, `clients/element14.py` — per-vendor impl + auth.
- `normalize.py` — vendor response → `NormalizedListing` (mpn, manufacturer, description, datasheet_url, lifecycle, product_url, stock, price_breaks[], currency, source).
- `upsert.py` — `INSERT ... ON CONFLICT DO UPDATE` for Part / PartListing / PriceBreak (bulk, bypass ORM lazy-load); records price deltas into the run.
- `categorymap.py` — our 75 subcategory slugs → per-distributor category ids / queries.
- `refresh.py` — CLI entry: select categories by rotation + priority, fetch within quota, normalize, upsert, write a `PriceSyncRun`. Modes: `discover` (grow) and `refresh` (existing).
- `app/config.py` additions: `DIGIKEY_CLIENT_ID/SECRET`, `MOUSER_API_KEY`, `ELEMENT14_API_KEY`, `PRICE_SYNC_ENABLED`, `PRICE_SYNC_PUBLIC` (cutover gate), `PRICE_SYNC_CADENCE`, freshness TTL.

## Scheduler

Cron sidecar container (reuse the api image) runs `python -m app.pricing.refresh` at **05:00 UTC ≈ midnight EST** (tz-aware in code for DST). On-demand invocation for testing. **Single-worker** to avoid upsert races.

## Frontend

- **Part page distributor table:** per-listing freshness indicator ("Updated 4h ago" from `last_synced_at`); listings only for fed distributors; deep-link uses the API-returned `product_url` (upgrade from MPN-search).
- **Public read-path launch gate:** a config flag `PRICE_SYNC_PUBLIC` controls whether public price queries return seed data (pre-flip) or real-only data (post-flip, `price_source != 'seed'`). Flipping it is the cutover.
- **Admin "Price Sync" page** (`@admin/pages/price-sync/`): table of recent runs (when, source, parts created/updated, price changes, errors). Sidebar nav entry. Charts later.
- **Analytics fix (prep, independent):** top-parts resolves UUID → part (name/SKU) and drops paths that don't resolve to a real part.

## Failure handling (reliability gates)

- Vendor error/timeout: log, `errors++` on the run, **leave existing rows untouched** (their `last_synced_at` ages → UI shows staleness). Never delete-on-error.
- Part not found at a distributor: no listing for that distributor (don't fabricate).
- Stale beyond TTL: UI shows explicit "as of `<date>`" — staleness is never hidden. Enforced by `pr-review-toolkit:silent-failure-hunter`.

## Secrets

Keys live in prod `/opt/circuits-com/.env` + local `.env`; never committed. Add a `hookify` PreToolUse hook blocking commits of `.env` / key patterns (GitGuardian already covers the remote).

## Testing

- **Fixture-replay:** record real API responses (sample MPNs/categories) into `api/tests/fixtures/pricing/*.json`; pytest parametrizes normalization + upsert + **idempotency** (run twice → no dupes, `ON CONFLICT` updates). No live API calls in CI.
- Rate-limit-adaptive logic unit-tested with simulated quota headers.
- Analytics fix: pytest asserts top-parts returns names and excludes unresolved paths.

## Build phases

1. **Prep:** analytics top-parts fix (UUID→name + filter) — independent quick win.
2. **Schema migration:** dedupe SKUs → unique constraints → `price_source` + `last_synced_at` → `price_sync_runs`; add `PRICE_SYNC_PUBLIC` flag (default off) (+ reseed).
3. **Full category map:** curate all 75 subcategory→distributor-category queries (`categorymap.py`) for Digi-Key + element14, plus the Mouser keyword/MPN strategy.
4. Client interface + **Digi-Key** against fixtures, fully tested.
5. Normalize + `ON CONFLICT` upsert + churn logging, tested.
6. Refresh CLI + rotation + rate-limit adaptation (`discover` + `refresh` modes).
7. **[HUMAN GATE]** Matthew registers Digi-Key + Mouser + element14 keys → first live validation on sample MPNs (price matches website).
8. **Mouser + element14** clients.
9. Admin Price-Sync page + freshness indicator UI (built while public price display stays gated off).
10. Cron sidecar + cadence.
11. **Initial full sweep:** discovery + pricing across all 75 categories with all 3 distributors (runs over several nights within rate limits); validate coverage + spot-check prices vs. distributor sites.
12. **Cutover:** flip `PRICE_SYNC_PUBLIC` on → public shows real-only; retire synthetic seed listings.
13. Review (silent-failure-hunter, type-design-analyzer, /simplify, /code-review) → deploy-preflight → deploy.

## Open items (resolve at the relevant phase)

- **Exact free-tier rate limits** — confirm at key signup; pipeline adapts regardless.
- **ToS for displaying prices** — verify each vendor's API terms permit third-party display before launch (these APIs exist for partners to surface data, so generally permitted; confirm explicitly).
- **Popularity-based priority** — deferred until real traffic data exists and is clean.
