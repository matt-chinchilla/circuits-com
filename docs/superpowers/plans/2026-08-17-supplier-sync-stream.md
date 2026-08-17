# Supplier Sync Stream + Quick-Action Button Restore

Approved design (user, 2026-08-17): (A) restore the original filled-color Quick Action
cards; (B) make "Sync inventory" real — a provider-agnostic live import stream
(thumbnail + part name + category per event), persisted so the dashboard's Recent
Activity can replay it.

## Global Constraints

- Branch: work directly on `updates` (house workflow; running dev stack serves this
  checkout). Commit per task. **Never add Co-Authored-By lines to commits.**
- The Mouser API key NEVER appears in code, logs, error text, tests, or commits.
  Container env var is `MOUSER_API_KEY`; the HOST `.env` variable is
  `MOUSER_SEARCH_API_KEY` (the host's own `MOUSER_API_KEY` line is a known-invalid
  Order-API key — never reference it). Compose passthrough MUST therefore be
  `MOUSER_API_KEY: ${MOUSER_SEARCH_API_KEY:-}` in BOTH compose files.
- TS strict; `?: T | null` for any field a Python `None` can reach; no unused vars.
- ESLint boundaries: admin code may import `@admin/*` and `@shared/*` only — NEVER
  `@public/*`.
- Every frontend mutation of parts data busts caches: call `bustSponsorCaches()`
  (`@admin/services/swCache`) after a sync stream completes.
- Backend: per-event commits (an abort must lose nothing). FeedFatalError ends a sync
  gracefully — it is the quota/auth wall, not a bug.
- Admin colors: `var(--a-*)` tokens, never inline hex (except the pre-existing hover
  hexes restored verbatim in Task 1).
- No empty SCSS rules (`.x {}` → undefined class).
- Gates before each commit: `cd api && python -m pytest tests/ -q` (must be green),
  `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`.
- Event dict contract (Tasks 3–6 all depend on it, verbatim):
  ```json
  {"kind": "sync_started|part_synced|sync_error|sync_finished",
   "supplier_id": "<uuid str>",
   "title": "<string>",
   "detail": "<string or null>",
   "image_url": "<http(s) url or null>",
   "action": "updated|media_filled|not_found|null (part_synced only)",
   "counts": {"synced": 0, "media_filled": 0, "not_found": 0} }
  ```
  `counts` present ONLY on `sync_finished`. NDJSON wire format: one
  `json.dumps(event) + "\n"` per event, media type `application/x-ndjson`.

---

## Task 1 — Restore filled Quick Action card styles

File: `frontend/src/admin/pages/suppliers/detail/QuickActionsPanel.module.scss` only.

Replace the current tonal `.qaCardBlue`, `.qaCardGold`, `.qaCardPurple` blocks (they
currently set `--qa-accent` + a tinted icon chip) with the original FILLED blocks
below, verbatim. Remove any now-unused `--qa-accent` consumption that only served
those three variants (read the whole file first; `.qaCardPrimary` stays as-is — it
already matches). Do not touch layout, sizing, or the glass styling of anything else.

```scss
.qaCardBlue {
  background: var(--a-blue);
  border-color: var(--a-blue);
  color: #ffffff;

  &:hover:not(:disabled) {
    background: #1d4ed8;
    border-color: #1d4ed8;
    box-shadow: 0 6px 16px rgba(37, 99, 235, 0.22);
  }

  .qaCardIcon {
    background: rgba(255, 255, 255, 0.16);

    :global(i.ph-light) {
      color: #ffffff;
    }
  }

  .qaCardTitle { color: #ffffff; }
  .qaCardHint  { color: rgba(255, 255, 255, 0.78); }
  .qaCardChev  { color: rgba(255, 255, 255, 0.7); }

  &:hover .qaCardChev { color: #ffffff; }
}

.qaCardGold {
  background: var(--a-warn);
  border-color: var(--a-warn);
  color: #ffffff;

  &:hover:not(:disabled) {
    background: #b45309;
    border-color: #b45309;
    box-shadow: 0 6px 16px rgba(217, 119, 6, 0.22);
  }

  .qaCardIcon {
    background: rgba(255, 255, 255, 0.18);

    :global(i.ph-light) {
      color: #ffffff;
    }
  }

  .qaCardTitle { color: #ffffff; }
  .qaCardHint  { color: rgba(255, 255, 255, 0.82); }
  .qaCardChev  { color: rgba(255, 255, 255, 0.7); }

  &:hover .qaCardChev { color: #ffffff; }
}

.qaCardPurple {
  background: var(--a-purple);
  border-color: var(--a-purple);
  color: #ffffff;

  &:hover:not(:disabled) {
    background: #6d28d9;
    border-color: #6d28d9;
    box-shadow: 0 6px 16px rgba(124, 58, 237, 0.22);
  }

  .qaCardIcon {
    background: rgba(255, 255, 255, 0.16);

    :global(i.ph-light) {
      color: #ffffff;
    }
  }

  .qaCardTitle { color: #ffffff; }
  .qaCardHint  { color: rgba(255, 255, 255, 0.78); }
  .qaCardChev  { color: rgba(255, 255, 255, 0.7); }

  &:hover .qaCardChev { color: #ffffff; }
}
```

If the current file's disabled state (used while syncing) visually depended on the
tonal style, verify the filled purple card still reads clearly when `disabled` (the
original design shipped this way; keep whatever generic `.qaCard:disabled` rule
exists). Gate: `npx tsc -b` + eslint + a `npm run build` type pass is NOT required for
SCSS-only, but run `npx tsc -b` anyway (cheap) and confirm no SCSS compile error via
`npm run build`. Commit: `style(admin): restore filled quick-action card variants`.

## Task 2 — ActivityEvent model + migration 030

Files: `api/app/models/activity_event.py` (new), `api/app/models/__init__.py`,
`api/alembic/versions/030_activity_events.py` (new),
`api/app/routes/suppliers.py` (delete cascade), test.

Model `ActivityEvent`, table `activity_events` (follow existing model file style,
e.g. `api/app/models/part.py`):
- `id` UUID pk default uuid4 (same column pattern as other models)
- `kind` String(40) not null
- `supplier_id` UUID, ForeignKey("suppliers.id"), nullable
- `title` String(255) not null
- `detail` String(500) nullable
- `image_url` String(500) nullable
- `created_at` DateTime(timezone=True), server_default=func.now(), not null
- Index `ix_activity_events_created_at` on created_at; index on supplier_id.

Register in `api/app/models/__init__.py` (BOTH the import and `__all__` — tests'
SQLite `create_all` won't see it otherwise).

Migration `030_activity_events.py`: `revision = "030"`, `down_revision = "029"`,
idempotent-DDL house style (`CREATE TABLE IF NOT EXISTS` via op.execute, or
op.create_table guarded — match 029's op.execute style with IF NOT EXISTS; downgrade
drops IF EXISTS).

Supplier delete: in `api/app/routes/suppliers.py` delete flow, NULL out
`ActivityEvent.supplier_id` for the supplier before the delete (mirrors the existing
`User.supplier_id` NULL-out step in the documented cascade order). 

Test (new `api/tests/test_activity_events.py`): model round-trips on SQLite (create,
query by created_at desc); deleting a supplier with events NULLs supplier_id rather
than erroring (use `auth_header` fixture from conftest + seeded_db).
Commit: `feat(api): activity_events table + model (migration 030)`.

## Task 3 — `sync_supplier_listings` generator in the importer

Files: `api/app/services/part_feed/importer.py`, `api/tests/test_part_feed.py`.

1. Extract the part-media fill logic currently inlined in `fill_category`
   (image only-if-NULL via `_safe_image`, datasheet only-if-falsy AND len ≤ 500) into
   `_fill_part_media(part: Part, fp: FeedPart) -> bool` (returns True if it changed
   anything). `fill_category` uses it; behavior identical (existing tests must stay
   green unmodified).
2. New GENERATOR:
   ```python
   def sync_supplier_listings(
       db: Session,
       provider: PartFeedProvider,
       supplier: Supplier,
       limit: int = 25,
   ) -> Iterator[dict]:
   ```
   Yields event dicts per the Global Constraints contract. Semantics:
   - Candidates: parts having a PartListing for THIS `supplier` row (join), ordered
     missing-`image_url`-first, then `Part.sku`, LIMIT `limit`. IMPORTANT identity
     rule: listings attach to the PASSED supplier row; never call
     `_get_or_create_supplier` here (a differently-named clicked row must not spawn a
     twin supplier).
   - Yield `sync_started` (title = supplier.name, detail = f"{n} parts queued").
   - Per part: `provider.lookup_mpn(part.sku)`.
     - `None` → yield `part_synced` with action `"not_found"` (title = part.sku,
       detail = category name via part relationship or a joined value, image_url None).
     - Found → `_upsert_listing(db, part, supplier, fp)`; `media = _fill_part_media(part, fp)`;
       `db.commit()` (PER PART); yield `part_synced`, action `"media_filled"` if media
       else `"updated"`, title `f"{part.sku} — {fp.manufacturer}"`, detail = category
       name, image_url = part.image_url (post-fill).
   - `FeedFatalError as e` → `db.rollback()`; yield `sync_error`
     (title `"Feed unavailable"`, detail `str(e)`) then `sync_finished` with counts so
     far; return. (str(e) never contains the key — mouser.py guarantees it.)
   - End: yield `sync_finished`, counts `{"synced": X, "media_filled": Y, "not_found": Z}`.
3. Tests (extend `test_part_feed.py`, follow its FakeProvider style): 
   - full happy stream event sequence + counts; per-part commit observable
   - identity test: supplier row named "Mouser" (≠ provider.supplier_name) gains the
     listings; NO new supplier row created
   - media fill only when missing; price breaks replaced
   - not_found path
   - FeedFatalError mid-stream: earlier parts persisted, `sync_error` +
     `sync_finished` both yielded, no raise out of the generator
   - `_fill_part_media` unit coverage (image >500 chars rejected).
Commit: `feat(api): provider-agnostic sync_supplier_listings stream`.

## Task 4 — Streaming route + provider registry + compose passthrough

Files: `api/app/routes/suppliers.py`, `api/app/services/part_feed/__init__.py` (or a
new `registry.py`), `docker-compose.yml`, `docker-compose.prod.yml`,
`api/tests/test_supplier_sync_route.py` (new),
`api/tests/test_compose_env_passthrough.py`.

1. Registry in part_feed package:
   ```python
   def resolve_provider(supplier: Supplier) -> PartFeedProvider | None
   ```
   Matches `supplier.website` (lowercased, None-safe) against registered domain
   fragments: `"mouser"` → `MouserProvider()`. Constructed LAZILY (constructor raises
   RuntimeError without a key — resolve must not be called before the key check).
2. Route in `routes/suppliers.py`:
   ```python
   @router.post("/{supplier_id}/sync")
   def sync_supplier(supplier_id: str, limit: int = 25, db=Depends(get_db),
                     current_user: User = Depends(get_current_user)):
   ```
   SYNC `def` (provider blocks/sleeps; Starlette runs sync generators in a
   threadpool). Order of checks:
   - `os.environ.get("MOUSER_API_KEY")` falsy → **404** (feature-off posture, same as
     Stripe; body detail `"sync_unavailable"`). NOTE: this check is deliberately
     provider-agnostic-enough for v1; future providers move key checks into the
     registry.
   - `_to_uuid` + supplier lookup → 404 unknown.
   - `resolve_provider(supplier)` None → **409** detail `"no_feed_for_supplier"`.
   - clamp `limit` to 1..50.
   - Return `StreamingResponse(gen, media_type="application/x-ndjson",
     headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})` where `gen`
     wraps `sync_supplier_listings(...)`: for each event dict → persist an
     `ActivityEvent` row (kind/supplier_id/title/detail/image_url; its own commit —
     reuse the same db session; skip persisting `sync_started`? NO — persist ALL
     kinds; Recent Activity filtering happens read-side) → `yield json.dumps(event) + "\n"`.
   - `X-Accel-Buffering: no` + non-JSON media type keeps nginx (default
     proxy_buffering on; gzip_types includes application/json but not x-ndjson) from
     buffering; no nginx config change needed.
3. Compose: add `MOUSER_API_KEY: ${MOUSER_SEARCH_API_KEY:-}` to the api service
   `environment:` block in BOTH `docker-compose.yml` and `docker-compose.prod.yml`
   (empty default = feature off; MUST read the HOST var `MOUSER_SEARCH_API_KEY` — see
   Global Constraints).
4. Tests:
   - `test_supplier_sync_route.py`: 401 unauthenticated; 404 when env key unset
     (monkeypatch.delenv); 404 bad uuid; 409 for a supplier whose website matches no
     provider (with key set via monkeypatch.setenv to a dummy value that never leaves
     the test); happy path with a monkeypatched `resolve_provider` returning a
     FakeProvider → response parses as NDJSON lines matching the event contract, and
     ActivityEvent rows exist afterward; demo account gets 403 (mint demo token via
     existing demo flow if seeded, else skip with comment).
   - `test_compose_env_passthrough.py`: new test asserting BOTH compose api blocks
     contain `MOUSER_API_KEY: ${MOUSER_SEARCH_API_KEY:-}` (regex per that file's
     house pattern), AND a guard test asserting neither compose file passes the raw
     host `MOUSER_API_KEY` through (the invalid-key trap).
Commit: `feat(api): POST /suppliers/{id}/sync NDJSON stream + provider registry`.

## Task 5 — Recent Activity gains sync events + thumbnails

Files: `api/app/routes/dashboard.py`, `api/tests/test_dashboard.py` (or the file that
covers `/dashboard/activity`), `frontend/src/admin/types/admin.ts`,
`frontend/src/admin/services/adminApi.ts` (only if the activity type needs it),
`frontend/src/admin/pages/dashboard/components/ActivityPanel.tsx` + its styles.

Backend: `GET /api/dashboard/activity` merges the newest `activity_events` rows
(kind `part_synced` and `sync_finished` only — read-side filter; `sync_started`/
`sync_error` rows stay in the table but out of the feed) into the existing activity
list: map to the existing item shape + NEW optional field `image_url` (None for
legacy items). `part_synced` description: `f"Synced {title} into {detail}"`;
`sync_finished` description: `f"Inventory sync — {counts-ish detail}"` (detail column
already carries the human string; do NOT invent a counts JSON column). Keep overall
list sorted by recency, same length cap the endpoint uses today.

Frontend: `ActivityItem` gains `image_url?: string | null`. ActivityPanel renders a
28px rounded thumbnail before the text when `image_url` is present — guard through
`safeImageUrl` from `@shared/utils/url`, `onError` hides the img (state or
`e.currentTarget.style.display='none'`). Demo mode path (`DEMO_ACTIVITY`) unchanged.
Tests: backend — activity endpoint returns event-derived rows with image_url; 
frontend — none required beyond tsc/eslint (panel is presentational).
Commit: `feat(admin): sync events surface in dashboard Recent Activity`.

## Task 6 — Frontend: stream client + Sync Console + wiring

Files: `frontend/src/admin/services/syncStream.ts` (new),
`frontend/src/admin/services/syncStream.test.ts` (new, vitest),
`frontend/src/admin/pages/suppliers/detail/SyncConsole.tsx` (new) + a module.scss,
`QuickActionsPanel.tsx`, `frontend/src/admin/pages/suppliers/detail/index.tsx`.

1. `syncStream.ts`:
   - `export interface SyncEvent { kind: 'sync_started'|'part_synced'|'sync_error'|'sync_finished'; supplier_id: string; title: string; detail?: string | null; image_url?: string | null; action?: 'updated'|'media_filled'|'not_found' | null; counts?: { synced: number; media_filled: number; not_found: number } | null }`
   - `export function parseNdjson(buffer: string): { events: SyncEvent[]; rest: string }`
     — pure, unit-testable: splits on `\n`, JSON.parses complete lines, returns
     remainder (possibly-partial last line). Malformed line → skipped (never throws).
   - `export async function syncSupplier(supplierId: string, onEvent: (e: SyncEvent) => void): Promise<void>`
     — `fetch(\`${API_BASE_URL}/suppliers/${supplierId}/sync?limit=25\`, { method: 'POST', headers: { Authorization: \`Bearer ${localStorage.getItem('admin_token') ?? ''}\` } })`.
     Non-OK → throw a typed error carrying status + best-effort parsed `detail`
     (404 → 'sync_unavailable' | 'not_found', 409 → 'no_feed_for_supplier'); callers
     branch on it. OK → read `res.body.getReader()`, TextDecoder, feed `parseNdjson`,
     emit events. After the stream ends call `bustSponsorCaches()` (parts mutated).
     `res.body` null → treat as error. Import API_BASE_URL from the same constants
     module adminApi uses.
   - vitest for `parseNdjson`: complete lines, split-across-chunks line, malformed
     line skipped, empty buffer.
2. `SyncConsole.tsx` — presentational admin panel (tokens `var(--a-*)` only; house
   panel look, no glass dependency): header row "Inventory sync — {supplier name}"
   + live counters (synced / media filled / not found); scrollable feed
   (`max-height ~320px, overflow-y auto`) of event rows: 28–32px thumbnail
   (`safeImageUrl`-guarded `<img>`, `onError` → swap to a `<Icon name="package" />`
   chip via state), mono SKU/title, muted category detail, small action chip
   (updated = blue tint, media_filled = green tint, not_found = muted). `sync_error`
   renders an amber/red row with the detail text. Terminal state: a footer line
   "Done — N synced · M images filled · K not found" or the error/quota message
   ("Feed unavailable — Mouser quota or auth wall; safe to retry after reset").
   New rows appear at the BOTTOM; auto-scroll to newest only when the user hasn't
   scrolled up (track via scrollTop distance check; `e.target instanceof Node` guard
   not needed here — element ref scroll only). Respect the no-new-heavy-motion rules:
   opacity-only entrance on rows, no drop-shadow animation, no whileHover.
3. Wiring: `index.tsx` owns `syncState: { running: boolean; events: SyncEvent[]; error: string | null }`.
   Replace the fake `syncDelta`/`lastSyncStamp` state and their render sites with the
   real console: `handleRealSync` calls `syncSupplier(id, ev => setSyncState(...))`;
   on completion bump a `refreshNonce` included in the load-effect deps so
   `getSupplier` + `getSupplierParts` refetch (real counts). While running, pass
   `syncing` down to QuickActionsPanel (its card shows the existing spinner). 404
   'sync_unavailable' → console area shows a single quiet hint: "No live feed
   connected — set the Mouser key on the API container to enable." 409 → "No feed
   integration for this supplier yet." `QuickActionsPanel.tsx`: `handleSync` becomes
   a call to a new `onSync?: () => void` prop (delete the setTimeout/random block and
   the `onAfterSync` prop entirely — grep for other `onAfterSync` consumers first;
   recon says supplier detail is the only mount). Keep `data-tour` attributes
   untouched (wizard anchors are guarded by `api/tests/test_wizard_data_anchors.py` —
   run it).
4. Gates: `npx tsc -b`, eslint, `npm test`, full pytest still green. Manual smoke is
   Task 7 (final).
Commit: `feat(admin): live sync console — real Mouser stream replaces the fake timer`.

---

Interfaces between tasks: Task 3's generator is consumed by Task 4's route; the event
contract (Global Constraints) binds Tasks 3–6; Task 2's ActivityEvent is written by
Task 4 and read by Task 5. Task 1 is independent.
