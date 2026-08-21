/**
 * Client for the two live feed streams — `POST /api/suppliers/{id}/sync`
 * (refresh the listings this supplier ALREADY has) and
 * `POST /api/suppliers/{id}/import` (grow the catalog with parts it does not).
 *
 * This is the admin SPA's FIRST non-axios transport, and deliberately so: the
 * routes answer with NDJSON over minutes (the provider throttles itself under
 * the free tier), and axios has no way to hand back lines as they arrive — it
 * resolves once, with the whole body. `fetch` + a stream reader is the only
 * shape that lets the console show work as it happens.
 *
 * Both routes speak the SAME envelope (`part_feed.sync_event`) and are read by
 * the same console, so ONE reader — `streamSupplierRun` — serves both and the
 * two exports differ only in the path they open. A second copy of the loop is
 * how one of them ends up missing a cache bust or a re-badged interruption.
 *
 * The run is SERVER-OWNED, and that changes what this client is. A click
 * STARTS a run on the server; the response only OBSERVES it. So a dropped
 * socket costs the operator the VIEW, never the run — `observeSupplierRun`
 * (GET .../feed-run) attaches to whatever is still going, replaying it from
 * the top and then following live, and an `AbortSignal` here DETACHES a
 * reader rather than cancelling any work. (Until 2026-08-20 the opposite was
 * true and this file said so: the response body WAS the import, so hanging up
 * silently ended it mid-sweep.)
 *
 * The cost of leaving axios is that NONE of `adminApi`'s interceptors run here,
 * so this module handles its own statuses:
 *   - 401 → drop the stale token, exactly as the response interceptor does, so
 *     the next render bounces to the sign-in screen.
 *   - 403 → surfaced as a named error only. The passwordGate mechanics are NOT
 *     replicated: the gate is raised by the very next ordinary admin call, and
 *     duplicating that state machine here would give it two owners.
 */

import { API_BASE_URL } from '@shared/services/constants';
import { authHeaders, onUnauthorized } from '@admin/services/adminApi';
import { bustSponsorCaches } from '@admin/services/swCache';
import { DEMO_READ_ONLY_MESSAGE, isDemoReadOnly } from '@admin/services/demoReadOnly';

/** Every event kind the stream can carry. Mirrors the backend's `_sync_event`. */
export type SyncEventKind = 'sync_started' | 'part_synced' | 'sync_error' | 'sync_finished';

/**
 * What the feed did with ONE part.
 *  - `created`      — a part the catalog did not have before (import only)
 *  - `updated`      — a listing was written (price/stock refreshed)
 *  - `media_filled` — an image and/or datasheet was filled in (also counts as synced)
 *  - `not_found`    — the provider does not carry this MPN
 *  - `no_data`      — found, but the feed carried no price and no new media
 */
export type SyncAction = 'created' | 'updated' | 'media_filled' | 'not_found' | 'no_data';

/**
 * The five running totals. All keys are always present on `sync_finished`, on
 * BOTH routes — a sync reports `created: 0` and an import reports
 * `not_found: 0` rather than omitting the key, so the console never has to
 * tell a missing counter from a zero one (`importer._finished`).
 *
 * `created` is counted APART from `synced`, exactly as the server counts it: a
 * brand-new catalog row is not a refreshed listing, and folding the two would
 * make an import's headline number unreadable.
 */
export interface SyncCounts {
  synced: number;
  media_filled: number;
  not_found: number;
  no_data: number;
  created: number;
}

/** One wire event. `counts` rides on `sync_finished` alone. */
export interface SyncEvent {
  kind: SyncEventKind;
  supplier_id: string;
  title: string;
  detail?: string | null;
  image_url?: string | null;
  action?: SyncAction | null;
  counts?: SyncCounts | null;
}

/** A non-OK response from either feed route. `detail` is the API's own string. */
export class SyncStreamError extends Error {
  readonly status: number;
  readonly detail: string | null;

  constructor(status: number, detail: string | null) {
    super(`sync failed: ${status}${detail ? ` ${detail}` : ''}`);
    this.name = 'SyncStreamError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Split an NDJSON buffer into whole events plus the leftover partial line.
 *
 * Pure on purpose — the reader loop is untestable in a node vitest run, but
 * chunk-boundary handling is exactly where a stream client goes wrong, so the
 * boundary logic lives here where a unit test can reach it. Never throws: a
 * half-written or malformed line is skipped, because the alternative is one
 * bad byte killing a run whose per-part writes already committed.
 */
export function parseNdjson(buffer: string): { events: SyncEvent[]; rest: string } {
  const lines = buffer.split('\n');
  // The tail after the last '\n' is by definition incomplete — it may be the
  // front half of an event still in flight. It goes back to the caller.
  const rest = lines.pop() ?? '';
  const events: SyncEvent[] = [];
  for (const line of lines) {
    // trim() also absorbs the '\r' of a CRLF-normalizing proxy.
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // `null` is typeof 'object', and an array would sail through a bare
    // typeof check into the renderer as an event with no kind.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      events.push(parsed as SyncEvent);
    }
  }
  return { events, rest };
}

const ZERO_COUNTS: SyncCounts = {
  synced: 0,
  media_filled: 0,
  not_found: 0,
  no_data: 0,
  created: 0,
};

function isZeroCounts(counts: SyncCounts): boolean {
  return Object.values(counts).every((n) => n === 0);
}

/**
 * A run's counters, kept as the events ARRIVE rather than derived from the
 * rows still on screen.
 *
 * The distinction is the whole reason this type exists. The console keeps a
 * bounded WINDOW of rows (a continuous import emits tens of thousands, and an
 * unbounded list is an O(n²) copy and a DOM full of thumbnails), so anything
 * counted by walking that window counts only what survived the eviction:
 * mid-run the totals stall at the cap and go DOWN as older `created` rows are
 * pushed out by newer ones (owner-reported 2026-08-21, "stalls around 500 and
 * the number goes down at times"). A tally folded at arrival time is immune —
 * it never looks at the window at all.
 *
 * `local` is this reader's own arithmetic, which mirrors the server's exactly,
 * including the part that reads oddly: a `media_filled` part counts in BOTH
 * `synced` and `media_filled`, because filling an image IS a write.
 * `finished` is the server's own tally off the last `sync_finished`.
 */
export interface RunTally {
  local: SyncCounts;
  finished: SyncCounts | null;
}

export const EMPTY_RUN_TALLY: RunTally = { local: ZERO_COUNTS, finished: null };

/**
 * Fold ONE event into a running tally. Pure — same input, same output — so it
 * is safe inside a React state updater, which may run it more than once for
 * the same update.
 */
export function tallyEvent(tally: RunTally, event: SyncEvent): RunTally {
  if (event.kind === 'sync_finished') {
    // A later finish replaces an earlier one; a finish with no counts (a shape
    // the server does not send, but the type allows) leaves the last one.
    return event.counts ? { ...tally, finished: event.counts } : tally;
  }
  if (event.kind !== 'part_synced') return tally;
  const local = { ...tally.local };
  switch (event.action) {
    // A NEW part, not a refreshed one — the server keeps these apart and so
    // does this, or an import would read as if it had re-priced the catalog.
    case 'created':
      local.created += 1;
      break;
    case 'media_filled':
      local.synced += 1;
      local.media_filled += 1;
      break;
    case 'updated':
      local.synced += 1;
      break;
    case 'not_found':
      local.not_found += 1;
      break;
    case 'no_data':
      local.no_data += 1;
      break;
    default:
      return tally;
  }
  return { ...tally, local };
}

/**
 * The numbers the console header prints.
 *
 * Once `sync_finished` has landed its `counts` ARE the answer — the server did
 * the counting and the footer prints its sentence verbatim, so preferring a
 * second number here could only produce a disagreement.
 *
 * ONE exception, and it is not the server being wrong. The route's catch-all
 * abort ends the stream with all-zero counts and the detail "sync aborted",
 * because at that point the totals are genuinely unknown TO IT — it rolled back
 * and never saw the generator's running tally. But the importer commits per
 * part BEFORE reporting it, so every part already on screen is real work that
 * survived. Adopting those zeros would blank the counters above rows that are
 * still sitting there, directly under a line promising progress was saved. So
 * an all-zero finish loses to a non-empty local tally.
 */
export function tallyTotals(tally: RunTally): SyncCounts {
  const { local, finished } = tally;
  if (!finished) return local;
  return isZeroCounts(finished) && !isZeroCounts(local) ? local : finished;
}

/**
 * The same counters for a COMPLETE event list — the whole run, not a window.
 *
 * Only safe where nothing has been evicted; a capped display array must fold
 * `tallyEvent` at arrival instead. Kept because a full list is the natural
 * shape in a test and in any future caller that holds one.
 */
export function tallyCounts(events: SyncEvent[]): SyncCounts {
  return tallyTotals(events.reduce(tallyEvent, EMPTY_RUN_TALLY));
}

/**
 * How many rows the console keeps on screen.
 *
 * A continuous auto-import emits tens of thousands of events; an unbounded
 * array is an O(n²) copy and a DOM full of thumbnails nobody will scroll back
 * through.
 */
export const EVENT_ROW_CAP = 500;

/**
 * Add one event to the DISPLAY WINDOW, evicting the oldest part rows past the
 * cap. System rows (started / error / finished) are always kept — they are the
 * run's structure, and losing the finish would lose the footer.
 *
 * It lives next to `tallyEvent` deliberately: the two together are the whole
 * bug of 2026-08-21. Anything counted by walking THIS array counts only what
 * survived eviction, so the totals stall at the cap and then go DOWN as older
 * `created` rows are pushed out. The window is for reading; the tally is for
 * counting; nothing may do both.
 */
export function appendCapped(events: SyncEvent[], event: SyncEvent): SyncEvent[] {
  const next = [...events, event];
  if (next.length <= EVENT_ROW_CAP) return next;
  // Everything not on the system list is evictable — including a kind the
  // backend grows later, which must not be able to fill the window forever.
  const isSystem = (e: SyncEvent) =>
    e.kind === 'sync_started' || e.kind === 'sync_error' || e.kind === 'sync_finished';
  const system = next.filter(isSystem);
  const rows = next.filter((e) => !isSystem(e));
  return [...system, ...rows.slice(rows.length - (EVENT_ROW_CAP - system.length))];
}

/** How a finished run ended. `aborted` = a `sync_error` cut it short. */
export interface SyncTerminalState {
  outcome: 'done' | 'aborted';
  detail: string | null;
}

/**
 * The console's footer: whether the run has ended, and how.
 *
 * Split out of the JSX because the distinction is a judgement about the event
 * sequence, not a layout detail — a run that hit the quota wall still ends with
 * `sync_finished`, and rendering that under a green check would tell the
 * operator it completed. `detail` is passed through untouched; the server's
 * summary sentence is the server's to write.
 */
export function terminalState(events: SyncEvent[]): SyncTerminalState | null {
  let finished: SyncEvent | null = null;
  let erroredBeforeFinish = false;
  let errorSeen = false;
  for (const event of events) {
    if (event.kind === 'sync_error') {
      errorSeen = true;
    } else if (event.kind === 'sync_finished') {
      finished = event;
      // Snapshot rather than read at the end: only an error that PRECEDED this
      // finish is what aborted it.
      erroredBeforeFinish = errorSeen;
    }
  }
  if (!finished) return null;
  return {
    outcome: erroredBeforeFinish ? 'aborted' : 'done',
    detail: finished.detail ?? null,
  };
}

const GENERIC_ERROR = 'The run failed to start. Check the connection and try again.';

/**
 * The marker for a stream that DIED MID-RUN, as opposed to one that never
 * opened. Status 0 because no response carried it — the socket dropped after
 * the 200. It matters because the two failures need opposite sentences: the
 * generic line says "failed to start", which is a lie once parts have scrolled
 * past, and it hides the fact that the server-side run is still going and can
 * be re-attached to.
 */
const STREAM_INTERRUPTED = 'stream_interrupted';

/**
 * True for the DOMException `fetch`/`reader.read()` reject with when their
 * signal is aborted. Structural rather than `instanceof DOMException` so it
 * also holds under a test DOM and in a worker-less runtime.
 */
function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * One plain sentence for whatever went wrong, for the console's quiet hint.
 * Each branch names a state the operator can actually act on; everything else
 * collapses to the generic line rather than leaking a status code at them.
 *
 * Shared by both runs, so the wording says "run" rather than "sync": the two
 * routes fail for identical reasons (no key, no provider, expired session), and
 * a sentence that named the wrong one would be the only inaccurate thing on
 * screen.
 */
export function syncErrorMessage(err: unknown, opts: { runActive?: boolean } = {}): string {
  if (!(err instanceof SyncStreamError)) return GENERIC_ERROR;
  if (err.status === 0 && err.detail === STREAM_INTERRUPTED) {
    // A socket that died while REPLAYING a run that had already ended is a
    // lost download, not a lost view of live work — promising it is "still
    // going" would be the same lie in the other direction.
    if (opts.runActive === false) {
      return 'Connection lost while loading this run — reconnect to load the rest of it.';
    }
    // Not a maybe: the run is owned by the server and is still going. The
    // only thing this client lost is the view of it.
    return 'Connection lost — the run is still going on the server. Reconnect to keep watching.';
  }
  if (err.status === 404) {
    // The route 404s when MOUSER_API_KEY is unset — the same feature-off
    // posture as the Stripe routes — which is indistinguishable from a real
    // missing row except by the detail string.
    return err.detail === 'sync_unavailable'
      ? 'No live feed connected — set the Mouser key on the API container to enable.'
      : 'That supplier no longer exists — reload the page.';
  }
  if (err.status === 409) {
    // TWO conflicts share this status, and they ask for opposite things: a
    // supplier with no feed behind it is a dead end, a run already going is
    // an invitation to watch it.
    return err.detail === 'feed_run_already_active'
      ? 'A run is already going for this supplier — reconnect to watch it.'
      : 'No feed integration for this supplier yet.';
  }
  if (err.status === 401) return 'Your session expired — sign in again to start a run.';
  if (isDemoReadOnly(err.status, err.detail)) return DEMO_READ_ONLY_MESSAGE;
  if (err.status === 403) return 'This account is not allowed to run the feed.';
  return GENERIC_ERROR;
}

/** Best-effort read of the API's `{"detail": "..."}` off a non-OK response. */
async function readDetail(res: Response): Promise<string | null> {
  try {
    const body = await res.json();
    const detail = (body as { detail?: unknown })?.detail;
    return typeof detail === 'string' ? detail : null;
  } catch {
    return null;
  }
}

/**
 * Did this event write something a public page could be showing?
 *
 * `created` counts hardest of the three: an import that adds parts changes the
 * category counts and the parts table the SW may still be serving from cache.
 */
function isMutation(event: SyncEvent): boolean {
  return (
    event.kind === 'part_synced' &&
    (event.action === 'updated' || event.action === 'media_filled' || event.action === 'created')
  );
}

/** Extra knobs shared by both runs. */
export interface SyncSupplierOptions {
  /**
   * DETACHES this reader. It does NOT cancel the run — the work is owned by
   * the server and keeps going, and `observeSupplierRun` can attach to it
   * again later. Silent: the promise resolves like a clean finish and no
   * error reaches the caller, because the only thing that aborts a reader is
   * the operator leaving the page, and they are not waiting to be told.
   */
  signal?: AbortSignal;

  /**
   * Called once the run's headers land, BEFORE any event.
   *
   * Carries the only thing a reader cannot infer from the stream: which of
   * the two jobs it is watching. The sync and import routes emit an identical
   * envelope, so a console re-attaching to a run it did not start would label
   * an import as a sync without this.
   */
  onOpen?: (info: FeedRunInfo) => void;
}

/** Which run a socket is watching. From the response headers, not the body. */
export interface FeedRunInfo {
  runId: string | null;
  mode: 'sync' | 'import';
  /**
   * Is the run still GOING, as of the moment this socket opened?
   *
   * False for a run that has already ended: the server keeps a finished run
   * readable for ~15 minutes so an operator who lost the socket can still come
   * back and read it, so attaching is NOT evidence of a live run. Without this
   * the console spent the whole replay of a paused run claiming it was
   * running, offering a Pause that could only 404 (owner-reported 2026-08-21,
   * "keeps showing that it is running once I come back to it after pausing").
   *
   * Defaults TRUE when the header is absent, which is what an API older than
   * this field sends — the old, optimistic behaviour, never a false "finished"
   * over a run that is genuinely spending quota.
   */
  active: boolean;
}

/**
 * Did the RUN outlive this reader?
 *
 * Asked on the failure path only, where the socket died without an ending. A
 * dropped socket is not a dropped run — the work is server-owned — so the
 * console keeps claiming the run and keeps the second click blocked. But that
 * only holds for a run that was going in the first place: the same drop while
 * REPLAYING a finished run would otherwise resurrect it on screen forever,
 * because no ending can ever arrive to clear it.
 */
export function runOutlivesReader(state: {
  activeAtOpen: boolean;
  receivedAny: boolean;
  sawFinish: boolean;
}): boolean {
  return state.activeAtOpen && state.receivedAny && !state.sawFinish;
}

/** `importSupplier` also spends a provider CALL budget, not a row count. */
export interface ImportSupplierOptions extends SyncSupplierOptions {
  /**
   * How many provider calls this one click may spend. The server clamps it to
   * 1–900 (the free tier allows ~1,000/day), so this is a batch size rather
   * than a value a caller can get wrong.
   */
  calls?: number;
}

/**
 * Open a feed stream at `path` and call `onEvent` for each event as it lands.
 *
 * The whole transport, shared by sync and import: the two routes differ only in
 * the path and the batch knob in its query string, and everything downstream —
 * the NDJSON reader, the 401 retirement, the mid-stream re-badge, the cache
 * bust — is the same job for both.
 *
 * Resolves when the server closes the stream, or when `options.signal` aborts;
 * rejects with a `SyncStreamError` for a non-OK status, and for a mid-stream
 * death after events flowed (callers branch via `syncErrorMessage`). Neither
 * ending stops the run: `method` picks between STARTING one (POST) and
 * attaching to one already going (GET), and both only read.
 *
 * The cache bust sits in a `finally` and is gated on a real write, because the
 * importer commits PER PART: a run that dies halfway — quota wall, dropped
 * connection, the operator navigating away — has still changed parts the public
 * site may be serving from a SW cache. That holds for an abort too, which is
 * why the silent return still goes out through the `finally`.
 */
async function streamSupplierRun(
  path: string,
  onEvent: (event: SyncEvent) => void,
  options: SyncSupplierOptions = {},
  method: 'POST' | 'GET' = 'POST'
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: authHeaders(),
      signal: options.signal,
    });
  } catch (err) {
    // Aborted before the response even landed: nothing ran, nothing to say.
    if (isAbortError(err)) return;
    throw err;
  }

  if (!res.ok) {
    if (res.status === 401) {
      // Same retirement rule as adminApi's response interceptor — and the
      // same function, so the two transports cannot drift.
      onUnauthorized();
    }
    throw new SyncStreamError(res.status, await readDetail(res));
  }
  if (!res.body) {
    // No readable stream (a proxy that buffered it away, or a browser without
    // streaming fetch). Treated as a failure rather than a silent empty run.
    throw new SyncStreamError(res.status, null);
  }

  options.onOpen?.({
    runId: res.headers.get('X-Feed-Run-Id'),
    mode: res.headers.get('X-Feed-Run-Mode') === 'import' ? 'import' : 'sync',
    // Only an explicit "false" means finished. An absent header is an API that
    // predates the field, and assuming finished there would idle a card over a
    // run that is still spending the day's quota.
    active: res.headers.get('X-Feed-Run-Active') !== 'false',
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let mutated = false;
  // Whether the operator has SEEN anything. It is what separates "the sync
  // never started" from "the sync was running and the pipe broke".
  let delivered = false;

  const emit = (events: SyncEvent[]) => {
    for (const event of events) {
      if (isMutation(event)) mutated = true;
      delivered = true;
      onEvent(event);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` keeps a multi-byte character split across chunks intact
      // — part titles carry an em dash, which is 3 bytes in UTF-8.
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseNdjson(buffer);
      buffer = rest;
      emit(events);
    }
    buffer += decoder.decode();
    // A stream that ends without a trailing newline leaves its last event in
    // the remainder; the added '\n' completes it.
    if (buffer.trim()) emit(parseNdjson(`${buffer}\n`).events);
  } catch (err) {
    if (isAbortError(err)) return;
    // The socket died mid-run. Re-badge it so the console can say so: the
    // generic "failed to start" line is plainly false with rows on screen,
    // and the run IS still going — it is owned by a server-side worker, not
    // by this reader, so the honest offer is to re-attach (this comment used
    // to assert the same thing about a design where it was false, which is
    // why the silent-death bug went unchased for so long).
    if (delivered && !(err instanceof SyncStreamError)) {
      throw new SyncStreamError(0, STREAM_INTERRUPTED);
    }
    throw err;
  } finally {
    if (mutated) await bustSponsorCaches();
  }
}

/**
 * Refresh the listings this supplier ALREADY carries — one provider call per
 * part, so the bound is a row count.
 */
export function syncSupplier(
  supplierId: string,
  onEvent: (event: SyncEvent) => void,
  options: SyncSupplierOptions = {}
): Promise<void> {
  return streamSupplierRun(
    `/suppliers/${encodeURIComponent(supplierId)}/sync?limit=25`,
    onEvent,
    options
  );
}

/**
 * Grow the catalog with parts this supplier does NOT carry yet, thinnest
 * subcategory first.
 *
 * The bound is a CALL budget, not a row count: an import spends one call per
 * PAGE of results, so the same number buys wildly different amounts of catalog
 * depending on how much of each page is already known. 200 is the default for a
 * click — a fifth of the free tier's day, leaving room for the nightly job and
 * for a second click.
 */
export function importSupplier(
  supplierId: string,
  onEvent: (event: SyncEvent) => void,
  options: ImportSupplierOptions = {}
): Promise<void> {
  const { calls = 200, ...rest } = options;
  return streamSupplierRun(
    `/suppliers/${encodeURIComponent(supplierId)}/import?calls=${encodeURIComponent(calls)}`,
    onEvent,
    rest
  );
}

/**
 * Attach to the run this supplier ALREADY has going — the door back in.
 *
 * Starts nothing. The run is server-owned, so a lost socket (a frozen tab, a
 * proxy timeout, navigating away) costs the view and not the work: this
 * replays everything the run has said so far and then follows it live to the
 * same ending, which is what lets the console refill instead of the run
 * appearing to vanish.
 *
 * Resolves `true` when there WAS a run to watch (and it has now ended or this
 * reader detached), `false` when the server has nothing — a 404 here is the
 * normal answer to "is anything going?", not a failure, so it must not reach
 * the caller as an error and light up the console's red hint. Every other
 * status still throws.
 */
export async function observeSupplierRun(
  supplierId: string,
  onEvent: (event: SyncEvent) => void,
  options: SyncSupplierOptions = {}
): Promise<boolean> {
  try {
    await streamSupplierRun(
      `/suppliers/${encodeURIComponent(supplierId)}/feed-run`,
      onEvent,
      options,
      'GET'
    );
    return true;
  } catch (err) {
    if (err instanceof SyncStreamError && err.status === 404 && err.detail === 'no_feed_run') {
      return false;
    }
    throw err;
  }
}
