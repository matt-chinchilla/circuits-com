/**
 * Client for `POST /api/suppliers/{id}/sync` — the live inventory-sync stream.
 *
 * This is the admin SPA's FIRST non-axios transport, and deliberately so: the
 * route answers with NDJSON over minutes (the provider throttles itself under
 * the free tier), and axios has no way to hand back lines as they arrive — it
 * resolves once, with the whole body. `fetch` + a stream reader is the only
 * shape that lets the console show work as it happens.
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
import { bustSponsorCaches } from '@admin/services/swCache';
import { DEMO_READ_ONLY_MESSAGE, isDemoReadOnly } from '@admin/services/demoReadOnly';

/** Every event kind the stream can carry. Mirrors the backend's `_sync_event`. */
export type SyncEventKind = 'sync_started' | 'part_synced' | 'sync_error' | 'sync_finished';

/**
 * What the feed did with ONE part.
 *  - `updated`      — a listing was written (price/stock refreshed)
 *  - `media_filled` — an image and/or datasheet was filled in (also counts as synced)
 *  - `not_found`    — the provider does not carry this MPN
 *  - `no_data`      — found, but the feed carried no price and no new media
 */
export type SyncAction = 'updated' | 'media_filled' | 'not_found' | 'no_data';

/** The four running totals. All keys are always present on `sync_finished`. */
export interface SyncCounts {
  synced: number;
  media_filled: number;
  not_found: number;
  no_data: number;
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

/** A non-OK response from the sync route. `detail` is the API's own string. */
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

const ZERO_COUNTS: SyncCounts = { synced: 0, media_filled: 0, not_found: 0, no_data: 0 };

function isZeroCounts(counts: SyncCounts): boolean {
  return (
    counts.synced === 0 &&
    counts.media_filled === 0 &&
    counts.not_found === 0 &&
    counts.no_data === 0
  );
}

/**
 * The counters for the console header.
 *
 * Once `sync_finished` has landed its `counts` ARE the answer — the server did
 * the counting and the footer prints its sentence verbatim, so re-deriving a
 * second number here could only produce a disagreement. Before that, the tally
 * mirrors the server's arithmetic exactly, including the part that reads oddly:
 * a `media_filled` part counts in BOTH `synced` and `media_filled`, because
 * filling an image IS a write.
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
export function tallyCounts(events: SyncEvent[]): SyncCounts {
  const totals: SyncCounts = { ...ZERO_COUNTS };
  for (const event of events) {
    if (event.kind !== 'part_synced') continue;
    switch (event.action) {
      case 'media_filled':
        totals.synced += 1;
        totals.media_filled += 1;
        break;
      case 'updated':
        totals.synced += 1;
        break;
      case 'not_found':
        totals.not_found += 1;
        break;
      case 'no_data':
        totals.no_data += 1;
        break;
      default:
        break;
    }
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const counts = events[i].counts;
    if (events[i].kind !== 'sync_finished' || !counts) continue;
    return isZeroCounts(counts) && !isZeroCounts(totals) ? totals : counts;
  }
  return totals;
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

const GENERIC_ERROR = 'Sync failed to start. Check the connection and try again.';

/**
 * One plain sentence for whatever went wrong, for the console's quiet hint.
 * Each branch names a state the operator can actually act on; everything else
 * collapses to the generic line rather than leaking a status code at them.
 */
export function syncErrorMessage(err: unknown): string {
  if (!(err instanceof SyncStreamError)) return GENERIC_ERROR;
  if (err.status === 404) {
    // The route 404s when MOUSER_API_KEY is unset — the same feature-off
    // posture as the Stripe routes — which is indistinguishable from a real
    // missing row except by the detail string.
    return err.detail === 'sync_unavailable'
      ? 'No live feed connected — set the Mouser key on the API container to enable.'
      : 'That supplier no longer exists — reload the page.';
  }
  if (err.status === 409) return 'No feed integration for this supplier yet.';
  if (err.status === 401) return 'Your session expired — sign in again to run a sync.';
  if (isDemoReadOnly(err.status, err.detail)) return DEMO_READ_ONLY_MESSAGE;
  if (err.status === 403) return 'This account is not allowed to run a sync.';
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

/** Did this event write something a public page could be showing? */
function isMutation(event: SyncEvent): boolean {
  return (
    event.kind === 'part_synced' &&
    (event.action === 'updated' || event.action === 'media_filled')
  );
}

/**
 * Open the sync stream and call `onEvent` for each event as it lands.
 *
 * Resolves when the server closes the stream; rejects with a `SyncStreamError`
 * for a non-OK status (callers branch on it via `syncErrorMessage`).
 *
 * The cache bust sits in a `finally` and is gated on a real write, because the
 * importer commits PER PART: a run that dies halfway — quota wall, dropped
 * connection, the operator navigating away — has still changed parts the public
 * site may be serving from a SW cache.
 */
export async function syncSupplier(
  supplierId: string,
  onEvent: (event: SyncEvent) => void
): Promise<void> {
  const token = localStorage.getItem('admin_token') ?? '';
  const res = await fetch(
    `${API_BASE_URL}/suppliers/${encodeURIComponent(supplierId)}/sync?limit=25`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    if (res.status === 401) {
      // Mirrors adminApi's response interceptor: the token is retired, so drop
      // it and let the next render bounce to sign-in.
      localStorage.removeItem('admin_token');
    }
    throw new SyncStreamError(res.status, await readDetail(res));
  }
  if (!res.body) {
    // No readable stream (a proxy that buffered it away, or a browser without
    // streaming fetch). Treated as a failure rather than a silent empty run.
    throw new SyncStreamError(res.status, null);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let mutated = false;

  const emit = (events: SyncEvent[]) => {
    for (const event of events) {
      if (isMutation(event)) mutated = true;
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
  } finally {
    if (mutated) await bustSponsorCaches();
  }
}
