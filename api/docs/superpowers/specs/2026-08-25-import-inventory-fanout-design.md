# One "Import Inventory" button — design

**Status:** approved in chat 2026-08-25, not yet implemented.
**Owner decisions recorded:** scope = suppliers with `auto_import_enabled`; console = one
merged, supplier-tagged stream.

## Problem

Importing today is per supplier: open a supplier detail page, click Import, watch that one
NDJSON stream. With two distributors that is two page visits; the owner wants one button.

The number that matters: the catalog holds **59 suppliers but only 2 are importable** (Mouser,
Digi-Key — the two `registry._PROVIDERS` covers). So the feature is nearly trivial today. The
design work is making it still correct at ten, without building for fifty that do not exist.

## Approach — route-level fan-out

A new endpoint starts N runs through the EXISTING `start_feed_run` and merges their observer
streams into one response. No new lifecycle object.

Rejected alternatives:

- **A first-class `BatchRun`** owning N children, with its own registry entry, pause and
  reattach. More capable (atomic batch pause) but it is a second lifecycle to keep correct
  beside one that already works. Two half-parallel mechanisms for one job is the shape of
  several bugs found on 2026-08-24.
- **Wrapping `jobs/feed_import_daily.run_once`.** Least new code, but it is sequential and
  log-shaped; making it stream would fight its design, and it would then have two callers with
  different concurrency semantics.

The hard parts already exist and are proven: runs are server-owned and outlive the socket,
`GET /suppliers/{id}/feed-run` already replays and tails, and the per-supplier Postgres advisory
lock is already the cross-process guard.

## Concurrency, and why it is safe

Measured 2026-08-24/25, not assumed:

| fact | value |
|---|---|
| advisory lock keys, Mouser vs Digi-Key | 1951017127 vs 1306670777 — distinct |
| both locks held simultaneously | yes |
| second run on the SAME supplier | refused |
| prod connections | 15 of `max_connections` 100 |
| DB-held time per feed run | 12–22% of wall clock (commits per part; HTTP holds nothing) |
| pool saturation | ~70–124 concurrent runs |

Runs are I/O-bound on their OWN provider's rate limiter (Digi-Key gaps at
`_MIN_GAP_SECONDS = 0.55`), so they do not compete for CPU, quota, or connections.

Safety is inherited rather than invented:

1. **Scope is the switch.** Only `auto_import_enabled` suppliers — the same set
   `feed_import_daily._eligible` uses. The button can never wake a distributor deliberately held
   back, and the button set can never disagree with the nightly set.
2. **Per-supplier advisory locks, unchanged.** If the 06:00 job is mid-sweep on Mouser, that
   member stands down with the existing "paused — click again" `sync_finished`, and the others
   proceed. That path exists and is tested (`test_feed_lock.py`).
3. **Per-provider budgets**, landed 2026-08-24: one distributor exhausting itself cannot take
   another's allowance.
4. **A concurrency cap**, `IMPORT_ALL_MAX_CONCURRENCY = 4`. Two orders of magnitude below
   measured headroom; it exists because an unbounded fan-out over a table that grows is fine
   until it is not.
5. **Partial failure is normal.** One member's `FeedFatalError` is one `sync_error` event in the
   merged stream; the others continue. The batch reports per-supplier counts.

## Wire contract

Reuses `sync_event()` verbatim — it is the single event constructor and must stay so. Every
event gains ONE key:

```
supplier_name: str      # which member emitted it; the merged console tags rows with this
```

`sync_started` / `sync_finished` are emitted per MEMBER as they are today, plus one
batch-level pair carrying the roll-up. Existing per-supplier consoles are untouched, because
they read the same events from the same per-supplier endpoints.

## Files

- `api/app/routes/suppliers.py` — new `POST /suppliers/import-all`, streaming NDJSON. Starts a
  run per eligible supplier via `start_feed_run`, merges their observer queues, caps concurrency.
- `api/app/services/part_feed/importer.py` — a `merge_runs(...)` generator. Fan-in only; it
  starts nothing and owns no lifecycle.
- `api/app/jobs/feed_import_daily.py` — export the eligibility predicate so the button and the
  night cannot drift. `_eligible` already exists; the route calls it rather than re-deriving.
- `frontend/src/admin/...` — an Import Inventory action; `SyncConsole` gains a supplier column.

## Tests

Each names the production change that would make it fail.

1. The button runs exactly the switched-on suppliers — flip one off, it is absent. *(Fails if
   scope is re-derived from `match_provider` instead of the switch.)*
2. A supplier whose lock is already held stands down and the others still run. *(Fails if the
   fan-out aborts the batch on one member's stand-down.)*
3. Concurrency never exceeds the cap with more eligible suppliers than the cap. *(Fails if the
   cap is dropped; must use MORE members than the cap or it cannot distinguish.)*
4. One member raising `FeedFatalError` does not stop the others, and the batch reports it.
5. Every merged event carries `supplier_name`. *(Fails if fan-in forwards raw events.)*
6. The per-supplier endpoints still behave identically. *(Fails if the batch mutates `_RUNS`
   shape.)*
7. Budgets stay per provider under fan-out. *(Fails if the batch re-pools them.)*

## Known limitation, written down rather than discovered

`_RUNS` is an in-process dict and prod runs `--workers 1`. If `API_WORKERS` rises above 1 the
batch endpoint's view of active runs splits across workers. The advisory lock still prevents
double-sweeping, so this degrades to "the console shows fewer members than are running", never
to corrupted data or double spend.

## Out of scope

- Pausing the whole batch in one click. Pause is per supplier and already works.
- Any new persistence. The batch is an ephemeral view over runs that already persist their own
  cursors and activity events.
