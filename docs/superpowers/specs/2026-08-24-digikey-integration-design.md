# DigiKey Integration — Design Spec

**Date:** 2026-08-24 · **Status:** draft for owner approval · **Head at write time:** alembic **042**, branch `updates` @ `71a04d0`
**Research inputs (all measured, not assumed):** four briefs — DigiKey OpenAPI v4 (parsed literally from `developer.digikey.com/node/2357/oas-download`), local contract audit, inventory gap measurement, taxonomy measurement. Numbers below are from the local mirror, verified prod-faithful (175,087 parts / 169,775 listings / 852,195 price breaks / 62 suppliers / 189 subcategories).

## 1. What this is, and what problem it actually solves

> "The WHOLE POINT OF THE WEBSITE is to compare prices across all the offerings that different distributors have to offer." — owner

**Measured today: zero parts in the catalog have two real distributor prices.** 128,519 parts (73.4%) have exactly one listing and 128,518 of those are Mouser. 3,610 parts *appear* to show a comparison; all of them are fabricated, and 2,045 of them contain no real listing at all. A further 42,958 parts (24.5%) have **no price whatsoever**.

So this is not "add a second data source". It is the first delivery of the product's stated function. DigiKey is the vehicle; the deliverable is a part page where two real distributors disagree about a price.

DigiKey's terms were cleared with their rep. Licensing is settled and is not discussed further.

**The binding constraint is the rate limit, and it is stated in every phase below.** Product Information v4 allows **1,000 calls/day, 120/min**, pooled across all 14 endpoints — *not* per endpoint and *not* per application. Every design decision here is scored on **inventory per API call**, because that is the only currency this project spends.

The headline arithmetic, which reframes everything: **`POST /search/keyword` returns up to 50 FULLY HYDRATED products per call** — complete `StandardPricing[]` ladders, `Parameters[]`, `Classifications`, `DatasheetUrl`, `PhotoUrl`, `Category`. It is not a thin summary requiring a `productdetails` follow-up. So the practical ceiling is ~50,000 fully-priced parts/day, and the difference between a per-MPN design and a page design is **~37×: 128 days versus 3.5 days** to cover the catalog. Every phase below is built on the 50-per-call path; nothing in the plan spends a call on a single part unless a human asked for that part by name.

## 2. Decision record

Each row states the alternative rejected and why. Rows marked **[U]** rest on something a brief flagged UNCONFIRMED; §9 gives each one a decision that is safe under either answer.

| # | Decision | Rejected alternative, and why |
|---|---|---|
| D1 | Credentials: **nullable `api_secret` column** on `provider_credentials` (migration 043); bearer token NEVER stored | Packing `id:secret` into `api_key` — the delimiter becomes an invisible parsing contract that can legally occur inside a secret, and `last4` silently becomes "last4 of whichever half was packed last". JSON in `api_key` — creates a mixed-type column (live Mouser rows are plain strings) that every one of five readers must branch on forever, and breaks the column's stated invariant "present verbatim". Both alternatives introduce *parsing of a secret*, and every parse is a place a credential can reach an error message. |
| D2 | Phase 1 sweeps **by manufacturer**, ordered by our own catalog density | Sweeping by category name (what `grow_catalog` does for Mouser) — it optimises breadth, and breadth is distributor #1's objective. Distributor #2's objective is *overlap*: 50k new DigiKey-only parts grow the catalog and deliver zero comparisons, while 50k DigiKey listings on parts we already hold flip ~40% of the catalog into a real comparison. Per-MPN `lookup_mpn` also rejected: 128,519 parts × 1 call = 128 days. |
| D3 | Phase 2 addresses categories by **DigiKey `CategoryId`**, from a committed generated map with human pins | Keyword-on-display-name. Measured: 45 of our 189 subcategory names (24%) contain `(`, `/` or `,`; all 21 shelves Mouser marked EXHAUSTED are parentheticals or marketing phrases. `Programmable Logic (CPLDs / FPGAs)` got us 51 parts; the three matching DigiKey nodes hold 30,129 — a ~590× miss, on a shelf the sweep has permanently written off. Runtime name-matching also rejected: non-deterministic, unreviewable, and a DigiKey rename silently re-points a whole shelf. |
| D4 | **One listing per part**, from a deterministically chosen `ProductVariation` | One listing per variation — collides with `UNIQUE(part_id, supplier_id)` (migration 042); an IntegrityError mid-run at best. Root-level aggregate — there is no root-level DigiKey P/N or price in v4, they moved into `ProductVariations[]`; there is nothing to read. |
| D5 | **`MarketPlaceFilter: ExcludeMarketPlace`** on every request | Including third-party sellers. Showing a marketplace seller's price as "DigiKey stock" in a price comparison is a misrepresentation, and it is one word to prevent at the source. |
| D6 | The DigiKey provider **refuses to mint a provisional manufacturer**; unknown makers are skipped and queued | Letting `part_identity._create_provisional` run. That path silently mints a manufacturer → a new part → one DigiKey listing sitting *beside* the Mouser part with one Mouser listing. Two half-answers where one comparison belonged, and nothing errors. See §7 — this is the single most likely way this project silently fails. |
| D7 | Pin `X-DIGIKEY-Locale-Site: US` / `-Language: en` / `-Currency: USD`, and **verify the echoed `SearchLocaleUsed`** or abort | Accepting the default locale. Locale-Site and Locale-Currency decide which country's `StandardPricing` you get; a silently-EUR ladder written into a USD column is a false price, which is the exact failure this project exists to end. |
| D8 | `StandardPricing[]` only | `MyPricing[]` — that is 3-legged account pricing and would publish our own negotiated rates to the public site. |
| D9 | Per-provider call budgets, per-provider quota walls | One global `FEED_IMPORT_CALL_BUDGET`. Two independent quotas exist; an even split hands each supplier 425 of a number that models *one* key's daily allowance, and a Mouser 429 currently `break`s the whole nightly loop, cancelling every remaining DigiKey supplier. |
| D10 **[U]** | Token mints are **excluded from `calls_made`**, bounded by a per-run refresh cap, and the day's budget carries a 150-call reserve | Counting them (silently shrinks every budget) or ignoring the question (a pathological refresh loop becomes invisible to the runaway ceiling). The reserve makes the answer irrelevant either way. |
| D11 | Read `X-RateLimit-Remaining` on **every** response and wall on 0 | Waiting for the 429. DigiKey reports remaining on every response, not only on breach — a provider that walls proactively ends the night cleanly instead of burning a call to learn it had none left. |
| D12 | Add the **diacritic fold** to `manufacturer_canon.canon()` (NFKD + combining-mark strip) | Leaving it and aliasing `Würth`. Measured: the fold collides **zero** of the 2,519 live `canonical_key` values, and pre-fixes five accented keys already in the DB (`bürkert`, `isabellenhütte`, `schützinger`, `stäubli`, `telegärtner`) that would fork the instant DigiKey sends them. Two companies in this industry differing only by an umlaut do not exist. This IS a canon bug, and it is the only canon change in this spec. |
| D13 | Delete DigiKey's 1,284 fabricated listings **before** the first real call | Deleting after. `sync`/`import` refresh only the parts DigiKey actually returns; `not_found` deletes nothing. The row would become a visibly mixed set of invented `DIG-…` SKUs and real ones with no column distinguishing them — the "objectively false comparison" the pivot exists to end, now hiding inside the one supplier a user would most trust. |
| D14 | Sandbox (`sandbox-api.digikey.com`) is a **wiring test only** | Using it for acquisition. DigiKey's own FAQ: it returns "the correct response structure but the data itself may not match your request." |

## 3. Phases

Ordered so the earliest phase that spends a call already returns real inventory. Phase 0 spends **zero** calls and is a `DELETE` plus a schema column — it is separated only because shipping Phase 1 without it publishes a supplier row that is half invented (D13).

### Phase 0 — Ground truth and the credential seam · **0 calls/day** · shippable alone

Delivers: the site stops showing fabricated Digi-Key prices, and the schema can hold a two-value credential.

1. **Migration 043** — `ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS api_secret TEXT NULL` (raw DDL, 033's style). No backfill: existing Mouser rows keep `NULL`.
2. **Credential plumbing** (§4).
3. **Move `FeedFatalError` from `mouser.py` to `base.py`**, re-export from `mouser.py` so its own tests and the three provider-agnostic importers (`importer.py:33`, `jobs/feed_import_daily.py:80`, `routes/bom.py:25`) keep their imports. Structural: a second provider must raise *that* class or the quota wall stops being caught anywhere.
4. **Move `_parse_lead_time` to a new `part_feed/parse.py`**, re-exported from `mouser.py`. DigiKey's `ManufacturerLeadWeeks` is a **string** (`"6 Weeks"`), and Mouser's parser is already weeks-aware. One home, or the two providers drift on 6-vs-42.
5. **Delete the fabricated Digi-Key inventory**: 1,284 `part_listings` + their price breaks for `c5c83e9e-afea-4f5f-9c87-4ab2185baa93`. Verified non-resurrecting: `_seed_real_catalog` creates listings **only inside the new-part branch** (`if p["sku"].upper() in existing_skus: continue`, `seed.py:2133`), so a deleted listing on an existing part is not recreated by the next container start.
6. **Remove `DigiKey Marketplace` from BOTH of its seed sites** — the supplier block at `seed.py:1071-1076` AND the breadth map at `seed.py:1990` (`"DigiKey Marketplace": "broad"`), which a first draft of this spec missed — and delete the row + its 1,313 listings. Deleting in the DB alone is not durable — `get_or_create_supplier` keys on **name** and would recreate it on the next api start (the `SEED_DEMO_CATALOG` lesson). It must go from the seed, or D5 is defeated by a row that re-materialises overnight and matches the same `digikey` fragment.
7. **D12's diacritic fold** in `manufacturer_canon.canon()`, with the five accented keys added as contract pairs in `test_manufacturer_canon.py`. A canon edit is a design event; this is the record of it.
8. **Repoint two tests that will otherwise fail the moment `digikey` enters the registry**: `test_feed_credentials.py:302` uses `digikey` as its *unknown* slug (PUT/DELETE would start returning 200), and `test_supplier_sync_route.py:1112` asserts `get_feed_key(db, "digikey") is None` (passes only while the settings default to None; its *meaning* inverts). Both re-point to a slug that is genuinely unknown, e.g. `farnell`.

### Phase 1 — DigiKeyProvider + manufacturer-scoped overlap sweep · **≤850 calls/day → ≤42,500 records/day**

**This is the smallest thing that puts a real second price on a real part page, and it ships on its own.** It reuses the entire existing surface: the admin Sync/Import buttons, the NDJSON wire contract, `SyncConsole`, `FeedRun`/pause, the advisory lock, per-part commits, Recent Activity. Nothing in that machinery learns a brand name.

**Step 1 is the first live call and doubles as the smoke test (§10): `GET /search/manufacturers`** — one call, DigiKey's complete maker list with ids. `canon()` every name, diff against `SELECT canonical_key FROM manufacturers UNION SELECT alias_canon FROM manufacturer_aliases`, weight each miss by our `catalog_part_count`. That produces the exact, part-weighted fork list **before a single catalog row is written** (§7).

**Step 2, the sweep.** New `grow_overlap()` in `importer.py` — a sibling of `grow_catalog`, not a replacement. It iterates **our own manufacturers ordered by catalog part count descending** and, for each, calls the provider for pages of 50 filtered to that maker. Every returned MPN we already hold becomes a second real price on an existing part page; every one we don't becomes a new part carrying image, datasheet, package, mount, lifecycle and RoHS for free in the same payload.

Why manufacturer-first is the right ordering *and* the cheap one: our catalog is heavily concentrated — **39 manufacturers cover 50% of parts (87,220), 144 cover 80% (139,881)** — and the strings to drive it already exist in the DB (1,079 raw spellings, 2,519 canon rows). No taxonomy work is required to start.

Cost model, stated plainly: 139,881 parts at a perfect 50/call is **2,798 calls ≈ 4 nights** at an 850-call budget. That assumes DigiKey carries the same MPNs at the same density, which is **exactly what night one measures** — the `sync_finished` counts are the measurement. Do not plan past night one on the estimate.

**Free with this phase, at zero extra calls:** `package`, `mount` and `lifecycle_verified_at` are **100% NULL across the entire catalog** — 0 of 175,087 rows, verified — because Mouser's keyword payload never carried them, so two shipped columns and the BOM tool's "verified" badge have never once had a source. (`rohs` is the exception: 36,512 rows, 21%, do carry it. An earlier draft of this spec said all four were empty; it was wrong about that one.) DigiKey's `Parameters[]` and `Classifications` carry all four in the same 50-product page. This is the one place a second provider adds data the first has never given us at all.

### Phase 2 — Category-id taxonomy map · **+2 calls, once** · ongoing cost unchanged

Delivers: the 21 dead shelves, and real denominators for the allocator.

`GET /search/categories` returns the **entire tree in one call**, with `ProductCount` per node. That is the whole budget for this phase: one call for the tree, one already spent on manufacturers. Both are cached into committed JSON (the Docker build stage has no network or DB — same constraint as `seo-manifest.json`).

- `api/scripts/gen_digikey_category_map.py` → `api/app/services/part_feed/digikey_categories.json`, keyed on **our subcategory slug** (names are display strings; slugs are already canonical in `CATEGORY_DATA`), shape `{slug: {digikey_category_ids: [int], fetched_name, product_count_as_of, note}}`, with a human-pin `EXTRA` block that wins permanently. Exactly the pattern already running for `headerAliases.ts` and `signature-icon-slugs.php`.
- Several of ours have **no DigiKey node at all** (`ADAS Processing ICs`, `Display Timing Controllers (TCON)`, `Machine Fluids`). Map those to `null` **explicitly**, with the note field saying so — absent and "deliberately unmapped" must not look the same.
- Some of ours map to a *filtered subset* of DigiKey's ("Bluetooth ICs" is part of RF Transceiver ICs plus part of RF TxRx Modules). No automatic matcher produces that. The map is reviewed by a human; that is the point of it being data.
- Our own ambiguity gets written down here too: we have **two** shelves that want the same rows (`Oscillators` under Clock & Timing ICs, and `Crystals and Oscillators` under Passive Components). Category ids do not fix that — it is ours — but the map is where the decision gets made once, in reviewable data, instead of being settled by whichever shelf the sweep reaches first.

**Three rot gates, one per way it can go stale:**
1. **Our side changes** — a pytest asserting every `parent_id IS NOT NULL` slug in `CATEGORY_DATA` appears as a key. Add a subcategory, the suite goes red until someone maps it. Without this, a new shelf silently gets no DigiKey coverage and nothing says so.
2. **Their side changes** — re-running the generator *diffs* stored `fetched_name`/`ParentId`/`ProductCount` against live and reports renamed / moved / deleted / new ids rather than overwriting. A rename becomes a report, not a silent re-point.
3. **Runtime, zero call cost** — every returned `Product` carries its own `Category`. The importer counts what fraction of returned parts came from a mapped category and puts the ratio in the `sync_finished` detail. A rotted map shows up as a collapsing in-category ratio in the admin console, not as silence.

### Phase 3 — Coverage-driven allocator · **no new calls; redistributes the same 850**

Delivers: calls stop going where they cannot help.

- **Per-provider budgets.** `FEED_IMPORT_CALL_BUDGET` becomes a per-slug map. Today `run_once` computes `per_supplier = call_budget // len(targets)` across *all* eligible suppliers regardless of provider (`feed_import_daily.py:281-292`), and the click ceilings (`suppliers.py:458` limit 50, `:513` budget 900) are annotated with Mouser's tier arithmetic. None of this crashes; all of it stops meaning what its comments say.
- **A quota wall must be per provider.** `run_once:330-338` breaks the whole supplier loop on `fatal` because "the quota belongs to the KEY, which is account-wide" — true per provider, false across providers. A Mouser 429 must not cancel every remaining DigiKey supplier. Same shape at `routes/bom.py:112`, where `fatal = True` kills all remaining misses.
- **Value function**, recomputed each pass from denominators DigiKey hands us free:
  `value(subcat) = min(our_parts_in_subcat, digikey_ProductCount) × (1 − our_digikey_coverage)`
  At 1,000/day this sends calls to Power Management (227,566 DigiKey products) and zero to Machine Fluids (2 parts, no DigiKey node) — where today both get an equal share.
- **The cursor must key on `(our_slug, digikey_category_id)`, not on slug.** One of our subcategories maps to several DigiKey ids and each has its own offset. `_load_import_cursor`/`_save_import_cursor` store `{slug: offset}`; a composite key string is a small change, but it has to land **before** the first category-scoped run or that run writes a cursor that means nothing.
- **A shelf must be able to exit at parity, not only at exhaustion.** Today a category leaves `pending` only when the provider returns short. Against a 227k-product DigiKey category that never happens, so an unbounded sweep sits there forever. Add "coverage ≥ X% of what we hold here" as a second exit.
- **Do not fund**: Mouser re-syncs (0–7 days fresh; 130,083 listings, 66 updated yesterday), thin subcategories (17 of the 25 thinnest are already `IMPORT_CURSOR_EXHAUSTED` — Mouser has *told us* the shelf is empty; they are supply-limited, not budget-limited), or standalone media backfill (image + datasheet ride along free on every call in Phases 1–3).

### Phase 4 — DigiKey-only facts and BOM wiring · **no new calls**

Delivers: fields DigiKey hands us that have nowhere to land today.

- `Product.ProductUrl` — the canonical DigiKey product page. `distributorUrl()` currently *guesses* a search URL from `DISTRIBUTOR_SEARCH`; DigiKey hands us the exact deep link. Needs a `part_listings.product_url` column.
- `ProductVariations[k].MinimumOrderQuantity` — directly affects build-quantity pricing in the BOM tool, and today the tool cannot know a part has an MOQ of 2,500.
- `Product.OtherNames[]` — former part numbers changed through manufacturer acquisitions. Feeds `part_identity` and BOM MPN matching.
- **`bom_resolve.pick_feed_source` needs an explicit preference order.** It iterates `db.query(Supplier).all()` **unordered** (`bom_resolve.py:60`) and returns the first match. Its docstring says it "generalizes past Mouser the day a second provider lands" — it generalizes to *an arbitrary one of them*, decided by Postgres row order across restarts. And `BOM_RESOLVE_DAILY_BUDGET` is one counter for two independent quotas. Owner question §11.5.

## 4. The credential decision (D1), in full

DigiKey needs a `client_id` **and** a `client_secret`, plus a bearer token with a **599-second (~10 min)** lifetime and **no refresh token** in the two-legged flow. `ProviderCredential`'s docstring currently asserts "A provider has exactly one key" and "stored as given … present verbatim". Both statements become false; they are the design record, so Phase 0 **rewrites** them rather than leaving them contradicted.

```python
# part_feed/base.py
@dataclass(frozen=True)
class FeedCredential:
    key: str            # Mouser: the API key. DigiKey: the client id.
    secret: str | None = None
```

- **`registry.get_feed_credential(db, slug) -> FeedCredential | None`** — DB row first, env fallback (the existing precedence, unchanged: the admin card must not be shadowed by whatever the container started with).
- **`get_feed_key(db, slug)` survives as the `.key` accessor**, so the ~five pure-gate callers (`feed_configured`, `key_configured` via `suppliers.py:588`, `_eligible`, the 404/409 gates) need no edit — but it returns `None` unless the credential is **COMPLETE**. That is the load-bearing bit: a DigiKey row with an id and no secret must read as unconfigured, or the 409 `feed_not_configured` gate lets an operator enable a nightly run that can never authenticate, and the 404 `sync_unavailable` posture stops being honest.
- **Completeness is provider-declared, checked in one place**: `required_credential_fields: tuple[str, ...]` on the provider class — `("key",)` for Mouser, `("key", "secret")` for DigiKey.
- **Construction gets a classmethod**: `provider_cls.from_credential(cred, client=None)`, replacing `provider_cls(api_key=…)` at the **three** sites (`suppliers.py:341`, `feed_import_daily.py:212`, `bom_resolve.py:68`). Rejected: a `**kwargs` splat — it lets a provider silently ignore a configured secret.
- **`env_feed_key` becomes `env_feed_credential(slug)`**, same per-slug branch shape. New settings `DIGIKEY_CLIENT_ID` / `DIGIKEY_CLIENT_SECRET` after `config.py:237`.
- **`last4` is sourced from the SECRET half only**, field name and shape unchanged. The client id is an identifier rather than a rotating secret, but echoing it in full would be the only place this system reads a stored credential back, and the demo-redaction rule (`feed_credentials.py:80-96`) would then need a per-field exception. One rule, unchanged: four characters of the rotating half, nothing else, ever.
- **`_validated_key` (`feed_credentials.py:63-77`) validates both values and must reject a half-credential** — an id without a secret is something the card can store and the sync will 404 on.
- **The bearer token never touches the database.** It is machine state, not operator state: writing it would mean a DB write per refresh, would survive a credential rotation, and would put a live access token in `pg_dump`. It is cached **class-level on `DigiKeyProvider`**, lock-guarded, keyed by client id, with expiry minus a safety margin. Instance-level is wrong — a provider is built once per feed run *and once per public `/api/bom/resolve` request* (`bom_resolve.py:68`), so an instance cache re-authenticates on every one of those, across three concurrent contexts (feed-run daemon thread, Starlette threadpool, the separate `feed-import` process).

**Admin card**: the status payload grows `credential_fields: [{name, label}]`, derived from the provider class, so `FeedCredentialsCard.tsx` renders N inputs generically and saves them atomically. Otherwise "adding a distributor is one registry row" stops being true at the UI, which is exactly where it will rot unnoticed.

## 5. The provider (`api/app/services/part_feed/digikey.py`)

Satisfies the `base.py` Protocol plus three undeclared contract members the call sites actually use: a `client=` kwarg (**mandatory** — `bom_resolve.py:68` passes it unconditionally, so a provider without it raises `TypeError` inside the public BOM stream), `close()`, and `supplier_name`/`supplier_website` as **class attributes** (`FEED_PROVIDERS` reads `cls.supplier_name` off the class before any instance exists).

```
supplier_name     = "Digi-Key Electronics"   # byte-identical to the seeded row
supplier_website  = "digikey.com"
records_per_call  = 50                       # KeywordSearch Limit max
required_credential_fields = ("key", "secret")
```

**Auth.** `POST https://api.digikey.com/v1/oauth2/token`, form-encoded `client_id`/`client_secret`/`grant_type=client_credentials`. Every data call carries `Authorization: Bearer <token>` **and** `X-DIGIKEY-Client-Id` (marked `required: true` on every path — omitting it is a 401 that looks like a bad secret). Locale headers per D7. Do **not** implement `X-DIGIKEY-Customer-Id`; it was replaced by `X-DIGIKEY-Account-Id` on 2025-11-24, and neither is needed for two-legged reads.

**Three auth rules that fail silently if you get them wrong:**
1. **Single-flight token refresh**, class-level lock, or a stampede across the three concurrent contexts has two threads logging each other out.
2. **Refresh-once-then-fail on a data-call 401.** A 401 mid-run means "expired", not "bad credential" — refresh once, retry that one call, then `FeedFatalError`. Without the bound, a wrong secret becomes an infinite auth loop inside a run nobody is watching.
3. **A 401 from the TOKEN endpoint is `FeedFatalError`, never `RuntimeError`.** `sync_supplier_listings` and `grow_catalog` abort a run only on `FeedFatalError`; a `RuntimeError` escapes to the blanket handler and is filed as "Import failed", and in the nightly job it is caught *per supplier* (`feed_import_daily.py:231`) — so a dead credential would be retried against every remaining supplier.

**Throttle.** DigiKey allows 120/min → a `_CALL_GAP_SECONDS` of ~0.55 (vs Mouser's 2.1). Mouser's `_throttle_lock`/`_last_call` are **class-level on purpose** — the ceiling belongs to the API key, and two admins syncing at once are two instances in two threadpool threads. DigiKey needs **its own pair on its own class**. If a shared base class is factored out and it assigns through the *base* name the way `MouserProvider._throttle` does, the two distributors serialise against each other and each gets half the throughput it paid for. Declare the pair per subclass, or assign through `type(self)`. Note the wall-clock consequence: at 0.55 s/call an 850-call budget is spent in **~8 minutes**, not hours — the runbook's mental model of a night-long Mouser run does not transfer.

**Error map**, unchanged in shape from Mouser: 401/403/429 → `FeedFatalError`; other ≥400 → `RuntimeError`; **never** `raise_for_status` or chained httpx errors (their messages embed the request, and `sync_supplier_listings` yields `str(exc)` straight onto the operator's console). DigiKey's secret rides a POST body rather than a query string, which lowers the stakes but does not change the rule. Bodies are `DKProblemDetails`; log `title`/`detail`/`correlationId`, never the request.

**Quota, proactively (D11).** Read `X-RateLimit-Remaining` on every response into `self.quota_remaining`; raise `FeedFatalError("DigiKey daily quota exhausted")` when it reaches 0 rather than spending a call to earn the 429. On a real 429, honour `Retry-After` only for the **burst** window (`X-BurstLimit-*`); a daily wall is a `FeedFatalError` and ends the run.

**Counting.** `calls_made += 1` **before** the request (quota is spent when the call leaves; a run that counted only successes would loop on a failing key forever). Token mints excluded (D10). `last_raw_count` reset per `search()` and counting **raw** rows including undecodable ones — `grow_catalog` advances the cursor by this number, and counting parsed rows re-reads the junk forever.

**`search(keyword, limit, start_at)`** → `POST /search/keyword` with `{Keywords, Limit: min(50, …), Offset: start_at, FilterOptionsRequest: {MarketPlaceFilter: "ExcludeMarketPlace"}}`. Pagination happens *inside* the provider with a hard page cap of `ceil(limit / 50)`, exactly like Mouser: undecodable rows shorten the RESULT, they never raise the COST.

**`search_filtered(...)`** — the new method Phase 1 and Phase 3 actually use, taking optional `manufacturer_ids` / `category_ids`. Note `FilterId.Id` is typed **`string`** in the spec even though `CategoryId` is `int32`; stringify or get an opaque 400.

**`lookup_mpn(mpn)` must search by MPN, not by the DigiKey part number.** The caller passes `part.sku`, which by the `part_identity` contract is the MPN. Mouser's `partnumber` endpoint happens to accept both and the code then demands an exact MPN match. If DigiKey's equivalent keys on a `-ND` number, every sync returns `not_found` and the run looks perfectly healthy while doing nothing. Implement it as a keyword search on the MPN with an exact `ManufacturerProductNumber` match, same discipline as `mouser.py:267`.

### The variation collapse (D4)

`FeedPart` has one `supplier_sku`, one `stock_quantity` and one `price_breaks[]`. DigiKey returns N `ProductVariations`, each with its own DK part number, stock, price ladder, MOQ and standard-package size — a 0.1 µF cap typically has Cut Tape, Tape & Reel and Digi-Reel at genuinely different prices. Collapse **inside the provider, before a `FeedPart` is ever built**:

1. Drop variations where `MarketPlace` is true (belt-and-braces behind D5).
2. Pick the lowest `MinimumOrderQuantity`; tie-break highest `QuantityAvailableforPackageType`; tie-break lowest 1-unit `StandardPricing`. Deterministic, so two runs over the same data write the same row.
3. `supplier_sku` = **that variation's** `DigiKeyProductNumber`. `price_breaks` = that variation's `StandardPricing[]` (`BreakQuantity` → `min_quantity`, `UnitPrice` → `unit_price`).
4. **`stock_quantity` = that variation's `QuantityAvailableforPackageType`, NOT the root `QuantityAvailable`.** The root is the sum across all packagings; pairing it with one variation's ladder overstates what is buyable at the shown price. Rejected the root sum for exactly that reason — it is the mismatch that makes a comparison quietly false.
5. **`ManufacturerProductNumber` → `sku`. The `-ND` number must NEVER reach `sku`**, or every DigiKey part forks from its Mouser twin on the MPN half of the identity key too.

This undersells DigiKey on reel quantities and never lies. Owner question §11.4 flags the trade: DigiKey's real per-quantity best price can live on a variant we do not show.

### Field map

| `FeedPart` | DigiKey v4 path | Note |
|---|---|---|
| `mpn` | `ManufacturerProductNumber` | |
| `manufacturer` | `Manufacturer.Name` | `.Id` is a stable int — carry it into the alias work (§7) |
| `description` | `Description.ProductDescription` | nested object, not a string |
| `image_url` / `datasheet_url` | `PhotoUrl` / `DatasheetUrl` | through the existing `_safe_image`/validator walls |
| `supplier_sku` | chosen variation's `DigiKeyProductNumber` | no root-level DK P/N exists in v4 |
| `stock_quantity` | chosen variation's `QuantityAvailableforPackageType` | see above |
| `lead_time_days` | `ManufacturerLeadWeeks` × 7 | **it is a string** (`"6 Weeks"`) — parse via the shared `parse.py`, never cast |
| `currency` | `SearchLocaleUsed.Currency` | per-RESPONSE, not per-part; verify against D7 |
| `price_breaks[]` | chosen variation's `StandardPricing[]` | never `MyPricing` (D8) |
| `lifecycle` | `ProductStatus.Status` + `Discontinued`/`EndOfLife`/`Ncnr` | **[U]** no enum in the spec; `map_lifecycle` must default to NULL on anything unrecognised (§9.3) |
| `package` | `Parameters[]` where `ParameterText == "Package / Case"` → `ValueText` | **NOT** `PackageType.Name` — that is DigiKey's *packaging* (Tape & Reel / Tube), a different concept |
| `mount` | `Parameters[]` where `ParameterText == "Mounting Type"` | match on `ParameterText`; **[U]** no published `ParameterId` table |
| `rohs` | `Classifications.RohsStatus` | a string ("ROHS3 Compliant"), not a boolean — through `specmap.map_rohs` |

## 6. Files

**Create**
- `api/app/services/part_feed/digikey.py` — provider, token cache, `part_from_digikey`, variation collapse
- `api/app/services/part_feed/parse.py` — shared `_parse_lead_time` (Phase 0)
- `api/alembic/versions/043_provider_credential_secret.py` — verify `alembic heads` before numbering
- `api/scripts/preflight_digikey_manufacturers.py` — Phase 1 step 1 / smoke test
- `api/scripts/gen_digikey_category_map.py` + `api/app/services/part_feed/digikey_categories.json` — Phase 2
- `api/tests/test_digikey_provider.py`, `api/tests/test_digikey_manufacturer_forking.py`

**Modify**
- `part_feed/base.py` — `FeedCredential`, `FeedFatalError`, `required_credential_fields`, `from_credential` on the Protocol
- `part_feed/registry.py:32` — `("digikey", DigiKeyProvider)` in `_PROVIDERS`; `:42-52` `env_feed_credential`; `:55-65` `get_feed_credential` + completeness gate
- `part_feed/mouser.py` — re-export `FeedFatalError` and `_parse_lead_time`; add `from_credential`
- `part_feed/importer.py` — `grow_overlap` (Ph1); composite cursor key + parity exit (Ph3); in-category ratio in `sync_finished` (Ph2)
- `app/config.py` — `DIGIKEY_CLIENT_ID`/`_SECRET` after `:237`; per-provider budgets replacing `:264-265`
- `app/models/provider_credential.py` — the docstring is the design record; rewrite it, do not merely contradict it
- `app/routes/feed_credentials.py:52,63-77,80-113` — second field, half-credential rejection, `credential_fields`, `last4` source
- `app/routes/suppliers.py:341` — `from_credential`; `:458`/`:513` ceilings become per-provider
- `app/services/bom_resolve.py:60,68` — explicit provider preference; `from_credential`
- `app/routes/bom.py:25,112` — import from `base`; per-provider fatality
- `app/jobs/feed_import_daily.py:80,98-101,212,281-292,330-338` — import, `_Target`, construction, per-provider budget and wall
- `app/jobs/import_parts.py:29,51` — `--provider choices` is hardcoded `["mouser"]` and `:51` builds `MouserProvider()` directly; route it through the registry or mark it Mouser-only (today it silently ignores the flag)
- `app/services/manufacturer_canon.py` — D12 only
- `app/db/seed.py:1071-1076` **and `:1990`** — drop `DigiKey Marketplace` from the supplier block and from the breadth map (two sites, not one)
- `docker-compose.yml` **`api` :97 and `feed-import` :267**, `docker-compose.prod.yml` **`api` :147** — **three** insertion points per value, not four: the prod `feed-import` block (`:201`) carries only `logging: *default-logging` and inherits its whole environment from the base file by per-key merge. Defaults must be `${VAR:-}`, never a literal (`test_the_part_feed_key_is_never_pinned_in_a_compose_file`). Host name == container name here — Mouser's deliberate `MOUSER_SEARCH_API_KEY` ≠ `MOUSER_API_KEY` split exists only to dodge a dead legacy Order-API key; say so in the comment, because the next reader will assume it is a rule.
- `frontend/src/admin/pages/settings/FeedCredentialsCard.tsx:50-53,120-134`, `admin/types/admin.ts:490`, `admin/services/adminApi.ts:510-530`
- `api/tests/feed_helpers.py:22` — `FakeProvider.supplier_name` is hardcoded `"Mouser Electronics"` and is shared by two suites; **parameterise, do not fork**
- `api/tests/test_feed_credentials.py:302`, `test_supplier_sync_route.py:1112` (Phase 0 item 8), `test_compose_env_passthrough.py:397-445`, `test_manufacturer_canon.py`
- `docs/part-import-runbook.md` (Mouser-shaped at :8/:15/:32/:44/:121/:186), `CLAUDE.md` "Distributor feed surface"

**No frontend change beyond the credentials card.** `NightlyImportToggle.tsx:89` reads `provider` only as a truthiness check and never renders the slug; `SyncConsole`, `QuickActionsPanel` and `suppliers/detail/index.tsx` are provider-blind.

## 7. Duplicate forking — the first-class risk

**This is the way this project most plausibly fails, and it fails silently.**

`part_identity.resolve_manufacturer_id` consults `manufacturer_aliases.alias_canon` (globally UNIQUE) before `manufacturers.canonical_key`. On a miss it calls `_create_provisional` and **mints a new manufacturer row** — which mints a new part row, which gets one DigiKey listing, sitting next to the Mouser part with one Mouser listing. Two half-answers where one comparison belonged. Nothing errors. Nothing logs above INFO. The site grows a part count and delivers *less* of what it exists for.

Running the real `canon()` over 47 Mouser/DigiKey name pairs: **22 fork, covering 28,497 parts — 16% of the catalog.** (That set was chosen to probe likely failures, so it is not a population rate; the preflight below gets the real one for one call.) Four classes:

| Class | Example | Fix |
|---|---|---|
| Regional suffix | `Nexperia` vs `Nexperia USA Inc.` → `nexperia` / `nexperia usa` | **Alias.** `usa`/`us`/`na` are deliberately absent from `_LEGAL_SUFFIXES` because *Microchip USA* is a genuinely different company from *Microchip Technology* and the leads roster says so. The carve-out that protects the CRM is what breaks the feed. Do not relitigate it. |
| Divisional wording | `TE Connectivity / AMP` vs `TE Connectivity AMP Connectors` | **Alias.** The words genuinely differ; no rule folds them. |
| Diacritics | `Wurth Elektronik` vs `Würth Elektronik` | **Canon fix (D12)** — measured zero collisions. |
| Mid-string legal token | `Analog Devices / Maxim Integrated` vs `Analog Devices Inc./Maxim Integrated` — **2,290 parts** | **Alias**, or a narrow interior-token fold shipped only after the same zero-collision test as D12. `co`, `ag`, `sa` as interior tokens are real words in real company names. |

**Mitigation, in order:**

0. **Preflight, 1 call, before any import** (Phase 1 step 1). Every miss is a manufacturer the first import *will* silently mint, weighted by our part count. Measured, not estimated.
1. Same-company misses → `manufacturer_aliases`, `source='digikey'`, `confidence='review'`. `uq_manufacturer_aliases_canon` guarantees one canon string can only ever point at one maker.
2. Genuinely new makers → created normally, but only after review.
3. Ambiguous → `manufacturer_merge_candidates` (448 rows already; NEVER auto-applied — the discipline exists, use it).
4. **The structural guard (D6): the DigiKey provider refuses to mint a provisional manufacturer mid-import.** The path already exists — `get_or_create_part` raises `ValueError` on an unusable manufacturer and `grow_catalog` counts it as `skipped_elsewhere` and keeps going. Turning "unknown DigiKey maker" into a skip plus a merge-candidate row means the catalog **cannot** fork silently; worst case is a genuinely-new maker's parts waiting one review cycle. That is the right trade when price comparison is the entire product. This is a policy difference from Mouser, so it belongs on the provider class or the `supplier_feeds` row — **not hardcoded in the importer**.

**Trap, verified:** do **not** build the alias list from DigiKey's linecard page. Its display names differ from the API's `Manufacturer.Name` — the linecard reads `AMP Connectors/TE Connectivity` while the product page and the API read `TE Connectivity AMP Connectors`. `GET /search/manufacturers` is the only authority.

**The test that would catch it** (`api/tests/test_digikey_manufacturer_forking.py`):

```python
def test_a_digikey_spelling_of_a_maker_we_already_hold_does_not_fork_the_part(seeded_db):
    """Catalog holds Nexperia / 74HC00D with a Mouser listing. DigiKey returns
    the same MPN under 'Nexperia USA Inc.'. The ONLY correct outcome is one
    part with TWO listings — which is the entire product."""
    before = seeded_db.query(Manufacturer).count()
    run_import(fake_digikey([{"mfr": "Nexperia USA Inc.", "mpn": "74HC00D", ...}]))
    assert seeded_db.query(Manufacturer).count() == before      # nothing minted
    part = find_part_by_mpn("74HC00D")
    assert {l.supplier.name for l in part.listings} == {"Mouser Electronics",
                                                        "Digi-Key Electronics"}
```

plus a negative control — a genuinely unknown maker is **skipped**, lands in `manufacturer_merge_candidates`, and the run continues — and a canon contract test carrying the five accented keys and the 22 measured pairs. The assertion that matters is `Manufacturer.count()` **unchanged**: it is the only one that fails loudly for a defect whose natural symptom is a slightly larger, slightly less useful catalog.

## 8. Other tests

- `test_digikey_provider.py` — mirror `test_part_feed_specs.py`/`test_feed_part_facts.py`: `part_from_digikey` over a captured payload (lifecycle, package via `ParameterText`, mount, RoHS tri-state, currency, weeks→days lead time), variation collapse determinism, marketplace exclusion, and locale-mismatch abort.
- Token behaviour: refresh-once-on-401 then `FeedFatalError`; single-flight under two threads; a token-endpoint 401 is `FeedFatalError` not `RuntimeError`.
- `test_supplier_sync_route.py::TestProviderRegistry` — add the real DigiKey pair beside the existing monkeypatched `("digikey", _DigiKeyLike)` fixture. `test_each_provider_is_called_with_ITS_OWN_key` already proves the property a second provider needs; extend it to assert the *secret* travels too.
- `test_compose_env_passthrough.py` — the DigiKey vars at all three insertion points. This suite exists because `DEMO_LOGIN_ENABLED`, `CALENDAR_*` and `STRIPE_*` each shipped unreachable; the `feed-import` container is where a forgotten passthrough is invisible for a month.
- A completeness-gate test: a `provider_credentials` row with `api_key` set and `api_secret` NULL leaves `feed_configured(db, "digikey")` **False**, the sync route 404, and the nightly toggle PATCH 409.

## 9. What is UNCONFIRMED, and the decision that is safe either way

Each of these was flagged in research. None is silently assumed.

1. **Max `Offset` / paging depth** — no `maximum` in the spec, undocumented anywhere. **Decision:** treat a 400, an empty page, *or* a short page past any depth identically as `IMPORT_CURSOR_EXHAUSTED`. Safe whether the wall is at 1,000 or does not exist: if there is a wall, the cursor stops climbing past it (today it would climb forever and that category would silently stop producing); if there is none, the existing short-page rule is what ends the sweep anyway. Measure the real depth on night one and record it in the runbook.
2. **Whether an empty `Keywords` is accepted with only a `CategoryFilter`** — the field carries no `required` marker and no `minLength`, but the v4 keyword endpoint is known for bare 400s on thin bodies. **Decision:** Phase 2's first category-scoped call *probes* it; if it rejects, fall back to the category **name** as the keyword **plus** the id filter, which is still far tighter than keyword-only. Phase 1 does not depend on this at all — it filters by manufacturer with the manufacturer name as the keyword.
3. **`ProductStatus.Status` value set** — no enum in the spec. **Decision:** `map_lifecycle` defaults to **NULL** on anything unrecognised, and `lifecycle_verified_at` is stamped **only** when a value actually mapped. The BOM tool then renders hatched/unverified, which is honest. Never guess a lifecycle.
4. **Whether OAuth token mints count against the 1,000/day** — undocumented. **Decision (D10):** cache the token, exclude mints from `calls_made`, cap refreshes per run, and hold a **150-call daily reserve** (budget 850 of 1,000). Correct under either answer, and the reserve doubles as headroom for daytime admin clicks — which today have no shared counter with the nightly job by design.
5. **`includes` query param** — present on three endpoints with an *empty* description in the spec and no documentation anywhere reachable. Almost certainly a sparse-fieldset filter that would cut response bytes materially on 50-product pages. **Decision:** do not use it. Worth one experiment once a key exists; a bytes optimisation is not worth a silently-truncated payload.
6. **Whether v3 `BatchProductDetails` is still provisionable** — the product page is login-gated/403 and the endpoint is documented as needing explicit enablement. **Decision:** do not depend on it. Its ratio (50/call) is *identical* to KeywordSearch, so it buys nothing on throughput; its only advantage is exact-MPN-list resolution for the BOM `resolve_single` path. Ask the rep (§11.1); nothing in this plan blocks on the answer.
7. **`ProductChangeNotifications` shape** — its Swagger returns HTTP 500. It is per-product, not a bulk delta feed, so it does not solve incremental refresh regardless. Out of scope.
8. **Real overlap between DigiKey's catalog and ours** — unknowable without a key. This is the single number the plan is most sensitive to, and Phase 1 night one measures it directly from the `created` vs `updated` counts in `sync_finished`. Do not plan Phase 3's allocator before that number exists.

## 10. What cannot be verified without live credentials — and the first smoke test

Unverifiable today: the OAuth round trip, the exact `Parameters[]` text for package/mount as DigiKey actually spells them, whether `SearchLocaleUsed` echoes what we pinned, the paging depth wall, the real DigiKey↔our-catalog manufacturer diff, and the real overlap rate. Every one of those is measured by the same first run.

**First live smoke test, in order, total cost 2 calls:**

1. `POST /v1/oauth2/token` against **sandbox** first — proves the client id/secret pair and the form encoding without touching quota semantics. Sandbox data is untrustworthy (D14); only the token matters here.
2. Against **production**, `GET /products/v4/search/manufacturers` — **1 call**. Success proves: token minting, the `X-DIGIKEY-Client-Id` header requirement, and quota-header presence (`X-RateLimit-Limit` should read 1000, `X-RateLimit-Remaining` 999). Its *output* is the preflight fork list of §7 step 0. This is the highest-value first call available and it writes nothing.
3. Against production, one `POST /products/v4/search/keyword` with `{Keywords: "Texas Instruments", Limit: 50, Offset: 0, FilterOptionsRequest: {MarketPlaceFilter: "ExcludeMarketPlace"}}` — **1 call**, run through `part_from_digikey` in a dry-run script that **writes nothing**. Assert: 50 products returned; every one carries `ProductVariations[].StandardPricing[]`; `SearchLocaleUsed.Currency == "USD"`; at least one `Parameters[]` entry has `ParameterText == "Package / Case"`; `ManufacturerLeadWeeks` parses; and the collapsed `FeedPart` set contains at least one MPN we already hold (the first evidence a second price is real).

Only after step 3 reads clean does the registry row land and the first write-enabled import run.

## 11. Open questions for the owner

1. **Ask the DigiKey rep for a rate-limit raise.** DigiKey's FAQ says the 1,000/day cap is raised on sales-manager approval, and the only published route is the contact form (a forum thread has staff saying exactly that, with a user reporting two weeks of silence). The rep relationship already exists. **This is the single highest-leverage action available and it is not a code change** — at 50 records/call the standard tier caps a *perfect* day at 50,000 records, and the brief is "pull as much inventory as possible". Ask in the same message whether v3 `BatchProductDetails` can be enabled for the BOM path (§9.6).
2. **The other 37,095 fabricated listings.** DigiKey's 1,284 and Marketplace's 1,313 are non-optional (D13). The remaining ~55 suppliers hold 39,692 listings, every one stamped 2026-06-03 and invented. Deleting them removes 100% of the site's false comparisons at zero API cost — and drops the site's real supplier count from 62 to 2 until DigiKey lands. Delete now, delete with Phase 1, or keep?
3. **`DigiKey Marketplace`** — delete the row entirely, or keep it as a listing-less non-feed supplier? Note that even after Phase 0 the domain-fragment matcher cannot express "this row is a marketplace, not the distributor". The durable fix is an explicit nullable `supplier_feeds.provider_slug` that **wins** over `match_provider`, demoting the domain match to a suggestion. Worth doing now, or when distributor #3 arrives?
4. **Variation collapse (D4).** One honest listing per part means DigiKey's genuinely-cheapest per-quantity price can live on a reel variant we never show. Acceptable, or does the comparison need a per-packaging dimension (which is a schema decision against `UNIQUE(part_id, supplier_id)`)?
5. **BOM resolve preference.** A public BOM miss currently resolves against whichever supplier Postgres returns first. Mouser first, DigiKey first, or race both and keep the cheaper answer (which doubles the per-miss cost against two independent budgets)?
6. **Nightly scheduling.** Two independent quotas that do not compete. Keep both at 06:00 UTC, or stagger so an operator watching the console can tell them apart? Note DigiKey's 850 calls finish in ~8 minutes at 120/min, versus Mouser's hours at 30/min.
7. **The 42,958 priceless parts (24.5% of the catalog).** They exist because `_upsert_listing` returns False when a feed row carries no price breaks — "a listing without a price is not a comparison row". They are real, feed-born, long-lead NCNR/quote-only parts, spread ~475–500 per subcategory, so ~24% of *every* category page renders with no price at all. Keep the honest rule, or add an explicit "quote only — contact distributor" listing state? (DigiKey will produce the same class of row, so the answer applies to both providers.)
8. **Two new columns in Phase 4** — `part_listings.product_url` (DigiKey hands us the canonical deep link; `distributorUrl()` currently guesses one) and MOQ (affects BOM build-quantity pricing). Worth a migration, or defer?

## 12. Ceilings that arrive before "hundreds of distributors"

Not in scope, recorded because this work moves us toward them.

- **The connection pool is the untouched default 5 + 10 = 15**, and a feed-run thread holds one connection for the run's entire life. A DigiKey run alongside a Mouser run alongside the `feed-import` container is three long-lived holders. ~15 concurrent feeds stops the public site answering. That ceiling arrives long before hundreds of distributors.
- **`_RUNS` is an in-process dict and the advisory lock is not taken by the nightly job.** `jobs/feed_import_daily.py` calls `grow_catalog` directly from the `feed-import` **container** and never takes `feed_lock`; an admin Import click during the nightly sweep really does run two sweeps on one supplier, and `_save_import_cursor` overwrites the whole map from a run-start snapshot so the loser's depth is discarded. Adding a second provider adds a second concurrent writer per *provider*, not per supplier — so this does not get worse here, but Phase 3's composite cursor key makes the eventual Postgres advisory lock more urgent, not less.
- **`_stamp_feed_facts` sets `lifecycle_verified_at` outside its `!=` guard**, so every part a feed touches is UPDATEd even when nothing changed: measured 139,056 updates at 2.8% HOT, ~3 GB WAL per Mouser import. One line. DigiKey doubles the write volume that flows through it, and — because DigiKey is the *first* provider that actually populates lifecycle — fixing the guard is also what makes `lifecycle_verified_at` mean something.
