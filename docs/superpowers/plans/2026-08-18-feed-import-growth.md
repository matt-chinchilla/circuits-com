# Feed Import Growth: "Import new parts" button + per-supplier nightly toggle

Approved (owner, 2026-08-18): a second, SEPARATE action beside Sync — importing
NEW inventory via Mouser keyword search (1 call ≈ up to 50 new parts, vs sync's
1 call = 1 part) — plus a per-company "nightly auto-import" TOGGLE, active only
when that supplier's provider key exists (greyed out otherwise), honored by a
nightly job that spends the day's quota automatically.

## Global Constraints

- Branch `updates`; commit per task; NEVER Co-Authored-By. Gates per task:
  `cd api && python -m pytest tests/ -q` green; ruff clean;
  `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`.
- Key hygiene unchanged: keys via `get_feed_key(db, slug)` /
  `match_provider`; never in logs/errors/responses/tests.
- **Contract change (planned across ALL consumers):** action union gains
  `created`; `counts` gains ALWAYS-PRESENT key `created` (sync runs emit 0).
  Consumers: importer `_finished()`-equivalents, route persist rule, route
  abort tally, TS `SyncAction`/`SyncCounts`, console chip + 5th counter +
  footer strings, dashboard read filter. `sync_finished.detail` for IMPORT
  runs: `"C created · U updated · S already elsewhere · X calls used"`; for
  SYNC runs the existing string is UNCHANGED.
- Persistence mapping: wire `part_synced`+action `created` is stored as kind
  **`part_imported`** (ActivityEvent has no action column; the dashboard
  template must not say "Synced" for an import). `not_found`/`no_data` stay
  transient; `updated`/`media_filled` persist as `part_synced` as today.
- The wire/event single-home rule stands: `sync_event()` in importer.py is
  the only constructor of event dicts.

## Task 1 — Importer: call accounting + `grow_catalog` generator

Files: `api/app/services/part_feed/mouser.py`, `base.py`, `importer.py`,
`api/tests/test_part_feed.py` (+ feed_helpers).

1. Provider call accounting: `MouserProvider` gains `calls_made: int`
   (instance attr, incremented in `_post`); document that `search(limit=N)`
   costs `ceil(pages)` calls. `FakeProvider` (tests/feed_helpers.py) mirrors
   it (increment per search/lookup call).
2. `grow_catalog(db, provider, supplier, call_budget: int, per_category: int = 50)
   -> Iterator[dict]`:
   - Candidate categories: SUBCATEGORIES ordered by part count ASC (thinnest
     first), all of them (budget is the loop bound, not the list).
   - Yield `sync_started` (title supplier.name, detail
     f"growing catalog · budget {call_budget} calls").
   - Per category, while budget remains: `provider.search(keyword, per_category)`
     where keyword = the category display name (same query derivation
     `fill_category` uses — reuse/extract its helper if one exists, else its
     inline rule). For each FeedPart:
       * MPN exists in THIS category → `_upsert_listing` + `_fill_part_media`
         → yield action `updated` (or `media_filled`) — counts.synced++.
       * MPN exists in ANOTHER category → no-hijack skip: NO event; tally
         `skipped_elsewhere` for the finish detail only.
       * New MPN → create Part (same construction as `fill_category`: slugify,
         sub_slug, media through `_safe_image`) + listing + breaks in one
         per-part commit → yield action `created`, counts.created++,
         title f"{sku} — {manufacturer}", detail category name, image_url.
   - Stop when `provider.calls_made` reaches `call_budget` (check between
     categories AND between pages if reachable) or categories exhaust.
   - `FeedFatalError` → rollback, `sync_error` ("Feed unavailable", str(exc)),
     then finish. Finish event: counts (5 keys) + the IMPORT detail string
     (calls used = provider.calls_made).
3. Tests (FakeProvider): created/updated/skip-elsewhere paths; budget stops
   the run mid-sweep (fake counts calls); thinnest-first order pinned; fatal
   mid-run keeps committed parts; counts have all 5 keys; existing sync tests
   updated for the 5th key ONLY (no behavior change).
Commit: `feat(api): grow_catalog import stream with call budget`.

## Task 2 — Activity service hoist + import route

Files: NEW `api/app/services/activity.py`, `api/app/routes/suppliers.py`,
`api/tests/test_supplier_sync_route.py` (+ new import-route tests).

1. Hoist `_record_event` (+ its clamps, allow-rule, logger, own-commit,
   swallow-and-warn) from routes/suppliers.py into
   `app/services/activity.py::record_stream_event(db, supplier_id, event)` —
   the nightly job (Task 5) is its second consumer, which is exactly the
   review's "activity service" altitude finding. The allow-rule table gains:
   action `created` → persist as kind `part_imported`. Route imports it;
   behavior-identical for sync (existing tests green unmodified except any
   import-path additions).
2. `POST /api/suppliers/{id}/import?calls=200` in routes/suppliers.py —
   same shape as sync: sync `def`, get_current_user, refusal order
   (key-for-matched-slug → 404 sync_unavailable; supplier 404; no provider
   409), calls clamped 1..900, StreamingResponse x-ndjson + X-Accel-Buffering
   no + Cache-Control no-cache, broad-Exception guard WITH the real tally
   (created counts included), provider close in finally.
3. Tests: postures ×4; happy stream with FakeProvider asserting created rows
   persist as `part_imported` and skips don't; abort tally includes created;
   clamp.
Commit: `feat(api): POST /suppliers/{id}/import + activity service hoist`.

## Task 3 — supplier_feeds table + toggle endpoints (migration 032)

Files: NEW `api/app/models/supplier_feed.py`, `models/__init__.py`, NEW
`api/alembic/versions/032_supplier_feeds.py`, `routes/suppliers.py` (delete
cascade + 2 endpoints), NEW `api/tests/test_supplier_feed_settings.py`.

1. Table `supplier_feeds` (pre-builds the partner-spec Phase A shape):
   `supplier_id` UUID pk + FK suppliers.id, `feed_url` VARCHAR(500) NULL,
   `api_key` TEXT NULL, `auto_import_enabled` BOOLEAN NOT NULL DEFAULT false,
   `last_synced_at` TIMESTAMPTZ NULL, `updated_at` TIMESTAMPTZ NOT NULL
   DEFAULT now() (onupdate). Migration 032 idempotent DDL
   (`revision="032"`, `down_revision="031"`). Model registered both sites.
2. Supplier delete flow: DELETE the supplier_feeds row before the supplier
   (8th cascade surface — mirror the ActivityEvent step's style/comment).
3. `GET /api/suppliers/{id}/feed-settings` (get_current_user; safe for demo —
   carries NO secrets): `{provider: slug|null, key_configured: bool,
   auto_import_enabled: bool}` via `match_provider` + `get_feed_key(db, slug)`.
   `PATCH /api/suppliers/{id}/feed-settings` body
   `{auto_import_enabled: bool}` — enabling requires provider match AND
   key_configured else **409 "feed_not_configured"** (you cannot enable what
   cannot run); disabling always allowed; upserts the row.
4. Tests: shapes; 409 rule; demo 403 on PATCH / clean GET; delete cascade;
   migration text guard per 030/031 style.
Commit: `feat(api): per-supplier feed settings + nightly toggle (migration 032)`.

## Task 4 — Frontend: Import card, 5th counter, created chip, toggle

Files: `QuickActionsPanel.tsx` + module.scss, `SyncConsole.tsx` + module.scss,
`syncStream.ts` + test, `suppliers/detail/index.tsx`, `adminApi.ts`,
`types/admin.ts`, `AdminLayout.module.scss` (one token).

1. `syncStream`: `SyncAction` gains `'created'`; `SyncCounts` gains `created`;
   `importSupplier(id, onEvent, {signal, calls=200})` hitting `/import`
   (share the internals with `syncSupplier` — one `streamSupplierRun(path,…)`
   core, two thin exports). `tallyCounts` handles created. vitest updates.
2. Quick Actions: 5th card `qaCardTeal` — add `--a-teal` token to
   `AdminLayout.module.scss` (BOTH light + dark blocks) and a
   `qa-filled(var(--a-teal), <hover hex>, rgba shadow)` include; icon
   `download-simple` (Phosphor), title "Import new parts", hint
   "Discover new inventory from {host}". Fires `onImport` prop; disabled
   while EITHER run is live (one stream at a time per page).
3. Console: 5th counter ("created"), chip `chipCreated` (green/teal tint),
   footer prints server detail verbatim (unchanged rule). Header title says
   "Inventory import" vs "Inventory sync" — pass a `mode` prop from the page.
4. Toggle: on the supplier detail page near the strip — a labeled switch
   "Nightly auto-import" driven by `getFeedSettings(id)`: greyed
   (`disabled` + hint "Add this supplier's API key in Settings to enable")
   when `!provider || !key_configured`; PATCH on flip with optimistic revert
   on error; demo flip surfaces the global read-only notice (axios handles).
   House switch styling if one exists (check DemoToggle) else a small
   accessible checkbox-switch, tokens only.
5. Gates + `pytest tests/test_wizard_data_anchors.py` (anchors preserved).
Commit: `feat(admin): import-new-parts card, created chip, nightly toggle`.

## Task 5 — Nightly job + compose service

Files: NEW `api/app/jobs/feed_import_daily.py`, `docker-compose.yml`,
`docker-compose.prod.yml`, `deploy.sh`, `api/app/config.py`,
`api/tests/test_compose_env_passthrough.py`, NEW `api/tests/test_feed_import_daily.py`,
`docs/part-import-runbook.md`.

1. Settings: `FEED_IMPORT_HOUR_UTC: int = 6` (≈ midnight CT + buffer, after
   Mouser's quota reset), `FEED_IMPORT_CALL_BUDGET: int = 850` (leaves ~150
   for daytime clicks). Compose passthrough in BOTH files with defaults that
   MIRROR the code defaults (the allowlist gotcha); guard tests.
2. `feed_import_daily.py`: loop — sleep to the next HOUR_UTC boundary; then:
   suppliers with `supplier_feeds.auto_import_enabled` AND `match_provider`
   AND `get_feed_key` → split the call budget evenly; for each, run
   `grow_catalog`, feeding every event through
   `activity.record_stream_event`; log one summary line per supplier
   (counts only, never keys). Tolerates unmigrated schema with a single
   warning (calendar-reminders pattern); FeedFatal ends that supplier's run
   and CONTINUES to the next only if budget remains AND the error was not
   auth/quota (FeedFatal = stop the whole night — quota is account-wide).
3. Compose: service `feed-import` (same build/image as api, command runs the
   job, prod gets the logging anchor + `ports: !reset []` pattern);
   **deploy.sh must name it in BOTH build lists** (the cost-sync lesson).
4. Runbook: new section — the toggle, the budget levers, the seo-manifest
   regen rhythm (imports add part pages; regen
   `frontend/seo-manifest.json` + `--frontend` deploy periodically or the
   new pages serve the generic shell).
5. Tests: job selection logic (enabled+configured only), budget split,
   quota-stop behavior — unit-level with FakeProvider (no sleeps: extract
   `run_once(db, now)` from the loop for testability, loop is a thin shell).
Commit: `feat(ops): nightly feed-import service honoring per-supplier toggle`.

Interfaces: T1's generator + counts contract feed T2's route and T5's job;
T2's activity service is consumed by T5; T3's table/endpoints feed T4's
toggle and T5's selection query. T4 depends on T1-T3 shapes only.
