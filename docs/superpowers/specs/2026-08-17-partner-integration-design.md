# Partner Integration: Feed Pull + Ingest Push

Approved direction (owner, 2026-08-17): partners connect BOTH ways — we pull
from their site, they push to ours — with key management as the backbone.
Decisions locked in chat: pushes create LISTINGS immediately on known parts;
unknown MPNs queue for admin review; docs live on a public site page AND a
ReadMe (readme.com) developer portal.

## 1. Key management (the backbone)

Two directions, two stores — deliberately not one table:

- **Our keys for THEIR APIs** (outbound pull): `provider_credentials`
  (shipped with the Settings "Distributor feeds" card, migration 031).
  Plaintext-at-rest (low blast radius: read-only catalog data), write-only
  through the API, env fallback.
- **Their keys for OUR API** (inbound push): NEW `partner_api_keys` —
  `id`, `supplier_id` FK (the identity the key IS), `key_hash` (SHA-256 of a
  `ccp_live_…` token; plaintext shown exactly ONCE at issuance), `label`,
  `created_at`, `revoked_at` nullable. Issued/revoked from the admin supplier
  detail page. Identity rule (the checkout lesson): a pushed payload is
  trusted only because of the key that authenticated it — it can only ever
  touch that supplier's own listings, never resolve identity from names in
  the payload.

## 2. The one shared core: `apply_partner_snapshot`

One importer function serves BOTH directions so pull and push cannot drift:

```
apply_partner_snapshot(db, supplier, rows, limit_caps) -> Iterator[event dict]
```

- Row matched by (mpn, manufacturer) against the catalog:
  - **Known part** → upsert this supplier's PartListing + replace price
    breaks; fill missing part media (image/datasheet) through the existing
    `_safe_image`/validator walls. Event `part_synced` / `updated` or
    `media_filled`.
  - **Unknown part** → INSERT into the review queue (§4); event `part_synced`
    with NEW action `queued` (not counted as synced).
- Event contract grows ONE action (`queued`) and one counts key — a planned
  contract change this time: importer `_finished()`, route persist rule
  (queued rows persist? NO — same transient class as no_data), TS union,
  console chip (violet tint, "queued for review"), and `sync_finished.detail`
  gains " · Q queued" when nonzero.
- Per-row commits, FeedFatal-equivalent abort semantics, same honesty rails.

## 3. Direction A — partner feed (pull)

- NEW `supplier_feeds` table: `supplier_id` pk/FK, `feed_url` (validated
  http(s)), `api_key` nullable (sent as `Authorization: Bearer` when set),
  `last_synced_at`. Managed on the admin supplier form.
- `FeedUrlProvider` joins the registry: `resolve_provider` prefers a
  `supplier_feeds` row over domain matching. It downloads the feed once per
  run (30s timeout, 10 MB cap, content-type json), validates the envelope,
  and hands rows to `apply_partner_snapshot`. The existing Sync button,
  live console, and Recent Activity work unchanged.
- Feed format (also the push body, §5): 
  ```json
  { "schema_version": 1,
    "parts": [ { "mpn": "...", "manufacturer": "...",
      "description": null, "image_url": null, "datasheet_url": null,
      "stock_quantity": 0, "lead_time_days": null, "currency": "USD",
      "price_breaks": [ {"min_quantity": 1, "unit_price": 0.52} ] } ] }
  ```
  Caps: ≤ 50,000 rows, strings clamped to column widths, URLs through the
  existing validators. Absent optional fields mean "no change".

## 4. Review queue (unknown MPNs)

- NEW `pending_parts` table: id, supplier_id FK, mpn, manufacturer,
  description, image_url, datasheet_url, payload snapshot (the price/stock
  data that arrived with it), status `pending|approved|rejected`,
  created_at, resolved_at. UNIQUE(supplier_id, mpn, manufacturer) — repeat
  pushes update the pending row, never stack duplicates.
- Admin surface: extend the existing **Import Queue** page (sidebar badge
  already exists) with a "Partner submissions" tab: approve = pick a
  category → creates the Part via the existing create path + materializes
  the held listing; reject = row marked, partner sees `rejected` in status.
- Events/Recent Activity: approvals emit an activity event ("Approved X into
  Y from <supplier>").

## 5. Direction B — ingest API (push)

- Public router `/api/partner/v1/*`, auth `Authorization: Bearer ccp_live_…`
  → hash lookup → supplier (revoked/unknown → 401; no timing oracle: hash
  then compare digest).
- `POST /api/partner/v1/inventory` — body = the §3 format, ≤ 500 rows per
  call (bulk loads use multiple calls), runs `apply_partner_snapshot`
  synchronously, returns per-row results + totals (mirrors the sync event
  summary). Rate limited per key via the shared `rate_limit` service.
- `GET /api/partner/v1/status` — key sanity check: supplier name, listing
  count, pending-review count, last push at. The "is my integration wired"
  endpoint every partner doc needs.
- Posture: router 404s entirely unless at least one active partner key
  exists? NO — always mounted (keys gate it); unauthenticated → 401 with no
  existence leaks.

## 6. Documentation

- **Public site page** `/partners/integration` (public scope, prerendered,
  linked from the Join flow + footer): the feed spec, the push API guide,
  and "get your key from the partners desk" onboarding.
- **ReadMe portal** (`circuitcenter.readme.io`): owner creates the ReadMe
  project (account creation is owner-side); we add a partner-scoped OpenAPI
  export (FastAPI already emits OpenAPI — a filtered spec containing only
  `/api/partner/v1/*`) and sync it with the `rdme` CLI using a ReadMe token
  stored like any other service key. Guides authored once in the repo
  (markdown), synced to both surfaces.

## 7. Security invariants

- Partner keys hashed at rest, shown once, revocable, per-key rate limits.
- A key writes ONLY its own supplier's listings; part creation NEVER happens
  directly from a push (queue only).
- All URLs through `validate_optional_image_url` / http(s)-scheme checks;
  all strings clamped; payload size caps enforced before parsing rows.
- No key material (ours or theirs) in logs, errors, responses, or tests.
- Demo account: partner router is key-auth (not admin JWT) — demo cannot
  reach it at all; admin key-management surfaces inherit demo read-only.

## 8. Sequencing

1. **Phase A** — `supplier_feeds` + `FeedUrlProvider` + `apply_partner_snapshot`
   + `queued` contract change + review queue (minimal: table + Import Queue tab).
2. **Phase B** — `partner_api_keys` + issuance UI + `/api/partner/v1/*`.
3. **Phase C** — `/partners/integration` page + OpenAPI export + ReadMe sync.

Each phase lands with the house gates (pytest/tsc/eslint/vitest), SDD-style
implementation with per-task review, and a deploy.
