import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  tallyCounts,
  tallyEvent,
  tallyTotals,
  appendCapped,
  runOutlivesReader,
  terminalState,
  syncErrorMessage,
  syncSupplier,
  importSupplier,
  observeSupplierRun,
  EMPTY_RUN_TALLY,
  EVENT_ROW_CAP,
  SyncStreamError,
  type FeedRunInfo,
  type SyncEvent,
} from '@admin/services/syncStream';
import { bustSponsorCaches } from '@admin/services/swCache';

// Both collaborators reach for browser globals this node-env suite has no
// business booting (localStorage for the token, `caches` for the SW bust).
// Stubbing them keeps the reader loop itself — the part these cases are about
// — the only real code under test.
vi.mock('@admin/services/adminApi', () => ({
  authHeaders: () => ({}),
  onUnauthorized: vi.fn(),
}));
vi.mock('@admin/services/swCache', () => ({
  bustSponsorCaches: vi.fn(async () => {}),
}));

// The wire shapes below are copied from the backend's `_sync_event`
// (api/app/services/part_feed/importer.py) — the ONE definition of the
// contract. If these literals stop matching that helper, the console is
// rendering a shape the server no longer sends.

const started = '{"kind":"sync_started","supplier_id":"s1","title":"Mouser","detail":"3 parts queued","image_url":null,"action":null}';
const partA = '{"kind":"part_synced","supplier_id":"s1","title":"STM32F103 — ST","detail":"Microcontrollers","image_url":"https://ex.test/a.jpg","action":"updated"}';
const partB = '{"kind":"part_synced","supplier_id":"s1","title":"LM358","detail":null,"image_url":null,"action":"not_found"}';
// An IMPORT's own action — a part the catalog did not have before. Same
// envelope, different route (`grow_catalog`).
const partNew = '{"kind":"part_synced","supplier_id":"s1","title":"NE555P — TI","detail":"Timers","image_url":null,"action":"created"}';

// tallyCounts mirrors the server's own arithmetic so the live header counters
// can never disagree with the summary line the run ends on.
function part(action: SyncEvent['action']): SyncEvent {
  return { kind: 'part_synced', supplier_id: 's1', title: 'x', action };
}

describe('tallyCounts', () => {
  it('is all zeros before anything arrives', () => {
    expect(tallyCounts([])).toEqual({
      synced: 0,
      media_filled: 0,
      not_found: 0,
      no_data: 0,
      created: 0,
    });
  });

  // An import's headline number. `created` is counted APART from `synced` —
  // exactly as `grow_catalog` counts it — because a brand-new catalog row is
  // not a refreshed listing, and folding them would overstate the sync half.
  it('counts a created part on its own, never as synced', () => {
    expect(tallyCounts([part('created'), part('created')])).toEqual({
      synced: 0,
      media_filled: 0,
      not_found: 0,
      no_data: 0,
      created: 2,
    });
  });

  it('tallies a mixed import run the way the server does', () => {
    expect(
      tallyCounts([part('created'), part('updated'), part('media_filled'), part('no_data')])
    ).toEqual({ synced: 2, media_filled: 1, not_found: 0, no_data: 1, created: 1 });
  });

  it('counts a media_filled part as BOTH synced and media filled', () => {
    expect(tallyCounts([part('media_filled')])).toEqual({
      synced: 1,
      media_filled: 1,
      not_found: 0,
      no_data: 0,
      created: 0,
    });
  });

  it('counts updated as synced, and keeps not_found / no_data out of synced', () => {
    expect(
      tallyCounts([part('updated'), part('updated'), part('not_found'), part('no_data')])
    ).toEqual({ synced: 2, media_filled: 0, not_found: 1, no_data: 1, created: 0 });
  });

  it('ignores non-part events', () => {
    const events: SyncEvent[] = [
      { kind: 'sync_started', supplier_id: 's1', title: 'Mouser' },
      part('updated'),
      { kind: 'sync_error', supplier_id: 's1', title: 'Feed unavailable' },
    ];
    expect(tallyCounts(events).synced).toBe(1);
  });

  it('defers to the server counts once sync_finished lands', () => {
    const events: SyncEvent[] = [
      part('updated'),
      {
        kind: 'sync_finished',
        supplier_id: 's1',
        title: 'Mouser',
        counts: { synced: 9, media_filled: 4, not_found: 2, no_data: 1, created: 3 },
      },
    ];
    expect(tallyCounts(events)).toEqual({
      synced: 9,
      media_filled: 4,
      not_found: 2,
      no_data: 1,
      created: 3,
    });
  });

  // The route's catch-all abort (suppliers.py) ends the stream with
  // ALL-ZERO counts and the detail "sync aborted", because at that point the
  // real totals are genuinely unknown to it. Adopting those zeros would wipe
  // the counters while the parts they counted are still on screen — and every
  // one of those parts was committed before it was reported.
  it('keeps the local tally when an aborted run reports all-zero counts', () => {
    const events: SyncEvent[] = [
      part('updated'),
      part('media_filled'),
      part('created'),
      { kind: 'sync_error', supplier_id: 's1', title: 'Sync failed', detail: 'boom' },
      {
        kind: 'sync_finished',
        supplier_id: 's1',
        title: 'Mouser',
        detail: 'sync aborted',
        counts: { synced: 0, media_filled: 0, not_found: 0, no_data: 0, created: 0 },
      },
    ];
    expect(tallyCounts(events)).toEqual({
      synced: 2,
      media_filled: 1,
      not_found: 0,
      no_data: 0,
      created: 1,
    });
  });

  it('still reports zeros when a run genuinely did nothing', () => {
    const events: SyncEvent[] = [
      { kind: 'sync_started', supplier_id: 's1', title: 'Mouser', detail: '0 parts queued' },
      {
        kind: 'sync_finished',
        supplier_id: 's1',
        title: 'Mouser',
        counts: { synced: 0, media_filled: 0, not_found: 0, no_data: 0, created: 0 },
      },
    ];
    expect(tallyCounts(events)).toEqual({
      synced: 0,
      media_filled: 0,
      not_found: 0,
      no_data: 0,
      created: 0,
    });
  });
});

// The DISPLAY WINDOW and the RUN TALLY are two different things, and the
// 2026-08-21 bug was one function doing both jobs: the console tallied the
// capped `events` array, so on a long import the header stalled near the cap
// and `created` went DOWN whenever an older created row was evicted by a
// newer one ("the number-counter for created keeps on stalling around 500…
// it even has the number go down at times"). These cases pin the split.
describe('counting a run longer than the display window', () => {
  /** Exactly what the page does per event: trim the window, fold the tally. */
  function feed(events: SyncEvent[]) {
    let window: SyncEvent[] = [];
    let tally = EMPTY_RUN_TALLY;
    for (const event of events) {
      window = appendCapped(window, event);
      tally = tallyEvent(tally, event);
    }
    return { window, counts: tallyTotals(tally) };
  }

  /** A run of `n` parts, every third one CREATED — an import's headline. */
  function longRun(n: number): SyncEvent[] {
    const events: SyncEvent[] = [
      { kind: 'sync_started', supplier_id: 's1', title: 'Mouser', detail: 'growing catalog' },
    ];
    for (let i = 0; i < n; i += 1) events.push(part(i % 3 === 0 ? 'created' : 'updated'));
    return events;
  }

  it('keeps counting past the row cap instead of stalling at it', () => {
    const { window, counts } = feed(longRun(2000));

    expect(window.length).toBe(EVENT_ROW_CAP);
    expect(counts.created).toBe(667); // 0, 3, 6, … 1998
    expect(counts.synced).toBe(1333);
    expect(counts.created + counts.synced).toBe(2000);
  });

  // The exact shape of the report: the number went DOWN. Once the window is
  // full, every arriving `updated` row evicts an older one — sometimes a
  // `created` — so a total walked over the window falls while the run is
  // still creating parts.
  it('never goes backwards, where a walk over the window does', () => {
    const events = longRun(2000);
    let window: SyncEvent[] = [];
    let tally = EMPTY_RUN_TALLY;
    const arrival: number[] = [];
    const fromWindow: number[] = [];
    for (const event of events) {
      window = appendCapped(window, event);
      tally = tallyEvent(tally, event);
      arrival.push(tallyTotals(tally).created);
      fromWindow.push(tallyCounts(window).created);
    }

    const dropped = (series: number[]) => series.some((n, i) => i > 0 && n < series[i - 1]);
    expect(dropped(arrival)).toBe(false);
    expect(dropped(fromWindow)).toBe(true); // the old behaviour, still reproducible
    // …and it plateaus far below the truth rather than reaching it.
    expect(fromWindow[fromWindow.length - 1]).toBeLessThan(arrival[arrival.length - 1]);
  });

  // The server's own numbers still win at the end — the footer prints its
  // sentence verbatim and a second, disagreeing number is the thing to avoid.
  it('snaps to the server counts when the run finishes', () => {
    const { counts } = feed([
      ...longRun(1200),
      {
        kind: 'sync_finished',
        supplier_id: 's1',
        title: 'Mouser',
        detail: '401 created · 799 updated',
        counts: { synced: 799, media_filled: 0, not_found: 0, no_data: 0, created: 401 },
      },
    ]);

    expect(counts).toEqual({
      synced: 799,
      media_filled: 0,
      not_found: 0,
      no_data: 0,
      created: 401,
    });
  });

  // The abort carve-out has to survive the move to an arrival-time fold: a
  // run the route aborts reports all-zero counts it never actually knew.
  it('still keeps the local tally when an aborted run reports all zeros', () => {
    const { counts } = feed([
      ...longRun(900),
      { kind: 'sync_error', supplier_id: 's1', title: 'Import failed', detail: 'boom' },
      {
        kind: 'sync_finished',
        supplier_id: 's1',
        title: 'Mouser',
        detail: 'import aborted',
        counts: { synced: 0, media_filled: 0, not_found: 0, no_data: 0, created: 0 },
      },
    ]);

    expect(counts.created).toBe(300);
    expect(counts.synced).toBe(600);
  });

  // A re-attach REPLAYS the whole run through the same onEvent path, and the
  // page resets the tally on the first replayed event. The replay must land on
  // the same numbers the original reader had — not on double them.
  it('replays to the same totals, from a tally reset at the first event', () => {
    const events = longRun(1500);
    const live = feed(events).counts;

    // Reset-on-first-event, exactly as the page's `replace` branch does.
    let tally = EMPTY_RUN_TALLY;
    let first = true;
    for (const event of events) {
      tally = tallyEvent(first ? EMPTY_RUN_TALLY : tally, event);
      first = false;
    }

    expect(tallyTotals(tally)).toEqual(live);
  });

  it('is pure, so a React updater re-running it cannot double-count', () => {
    const before = tallyEvent(EMPTY_RUN_TALLY, part('created'));
    const twice = tallyEvent(EMPTY_RUN_TALLY, part('created'));

    expect(twice).toEqual(before);
    expect(EMPTY_RUN_TALLY.local.created).toBe(0); // never mutated in place
  });

  it('keeps every system row in the window, however long the run', () => {
    const { window } = feed([
      { kind: 'sync_started', supplier_id: 's1', title: 'Mouser' },
      ...Array.from({ length: 900 }, () => part('updated')),
      { kind: 'sync_error', supplier_id: 's1', title: 'Feed unavailable' },
      { kind: 'sync_finished', supplier_id: 's1', title: 'Mouser', detail: 'done' },
    ]);

    expect(window.filter((e) => e.kind !== 'part_synced').map((e) => e.kind)).toEqual([
      'sync_started',
      'sync_error',
      'sync_finished',
    ]);
    expect(window.length).toBe(EVENT_ROW_CAP);
  });
});

// Whether the RUN outlived the reader — asked only when a socket died without
// an ending. A dropped socket is not a dropped run, but a socket dropped while
// REPLAYING a finished one is not a live run either, and treating it as one
// strands the console claiming work nothing can ever end.
describe('runOutlivesReader', () => {
  it('claims the run when a live stream drops mid-flow', () => {
    expect(
      runOutlivesReader({ activeAtOpen: true, receivedAny: true, sawFinish: false })
    ).toBe(true);
  });

  it('does not claim a run that already sent its ending', () => {
    expect(runOutlivesReader({ activeAtOpen: true, receivedAny: true, sawFinish: true })).toBe(
      false
    );
  });

  it('does not claim a run that never delivered anything', () => {
    expect(runOutlivesReader({ activeAtOpen: true, receivedAny: false, sawFinish: false })).toBe(
      false
    );
  });

  // The reattach case: the server handed back the REPLAY of a run that had
  // already finished (it keeps them readable for ~15 minutes), and the socket
  // died part-way through. Nothing is running; nothing can arrive to say so.
  it('never resurrects a run that had already finished before this socket opened', () => {
    expect(
      runOutlivesReader({ activeAtOpen: false, receivedAny: true, sawFinish: false })
    ).toBe(false);
  });
});

describe('terminalState', () => {
  const finished = (detail: string): SyncEvent => ({
    kind: 'sync_finished',
    supplier_id: 's1',
    title: 'Mouser',
    detail,
  });
  const errored: SyncEvent = {
    kind: 'sync_error',
    supplier_id: 's1',
    title: 'Feed unavailable',
    detail: 'quota',
  };

  it('is null while the run is still going', () => {
    expect(terminalState([part('updated')])).toBeNull();
  });

  it('reads a clean finish as done, carrying the detail verbatim', () => {
    expect(terminalState([part('updated'), finished('1 synced · 0 images filled · 0 not found')]))
      .toEqual({ outcome: 'done', detail: '1 synced · 0 images filled · 0 not found' });
  });

  it('reads a finish that followed an error as aborted', () => {
    expect(terminalState([part('updated'), errored, finished('sync aborted')])).toEqual({
      outcome: 'aborted',
      detail: 'sync aborted',
    });
  });

  it('ignores an error that arrives AFTER the finish it did not abort', () => {
    expect(terminalState([finished('2 synced · 0 images filled · 0 not found'), errored])).toEqual({
      outcome: 'done',
      detail: '2 synced · 0 images filled · 0 not found',
    });
  });
});

describe('syncErrorMessage', () => {
  it('explains an unconfigured feed key', () => {
    expect(syncErrorMessage(new SyncStreamError(404, 'sync_unavailable'))).toBe(
      'No live feed connected — set the Mouser key on the API container to enable.'
    );
  });

  it('distinguishes a missing supplier from a missing key', () => {
    const msg = syncErrorMessage(new SyncStreamError(404, 'Supplier not found'));
    expect(msg).not.toContain('Mouser key');
    expect(msg).toContain('supplier');
  });

  it('explains a supplier with no feed behind it', () => {
    expect(syncErrorMessage(new SyncStreamError(409, 'no_feed_for_supplier'))).toBe(
      'No feed integration for this supplier yet.'
    );
  });

  // TWO conflicts share 409 and they ask for opposite things: a supplier with
  // no feed is a dead end, a run already going is an invitation to watch it.
  // Reading only the status would tell an operator whose run IS going that
  // their supplier has no feed integration.
  it('separates a run already going from a supplier with no feed', () => {
    const msg = syncErrorMessage(new SyncStreamError(409, 'feed_run_already_active'));
    expect(msg).toContain('already going');
    expect(msg).not.toContain('No feed integration');
  });

  it('names an expired session', () => {
    expect(syncErrorMessage(new SyncStreamError(401, 'Not authenticated'))).toContain('sign in');
  });

  it('names the read-only demo refusal', () => {
    expect(syncErrorMessage(new SyncStreamError(403, 'demo_account_read_only'))).toBe(
      'Editing is disabled in the demo.'
    );
  });

  // The sentence says "run", not "sync": the same mapper answers for the import
  // stream, and naming the wrong route would be the one inaccurate thing on a
  // console that otherwise prints the server verbatim.
  it('falls back to one generic sentence for anything else', () => {
    expect(syncErrorMessage(new Error('network down'))).toContain('The run failed to start');
    expect(syncErrorMessage(new SyncStreamError(500, null))).toContain('The run failed to start');
  });

  // A socket that drops AFTER the 200 is a different event from one that never
  // opened, and `syncSupplier` re-badges it as status 0 / 'stream_interrupted'
  // so this branch can say so. The generic line ("failed to start") would be
  // flatly false with parts already on screen, and it hides what the operator
  // most needs: the run is SERVER-OWNED, so it is still going and can be
  // re-attached to. (The sentence used to hedge — "may still finish" — which
  // was the honest reading of a design where the response body WAS the import
  // and a dead socket really did end it.)
  it('distinguishes a stream that died mid-run from one that never started', () => {
    const msg = syncErrorMessage(new SyncStreamError(0, 'stream_interrupted'));
    expect(msg).toBe(
      'Connection lost — the run is still going on the server. Reconnect to keep watching.'
    );
    expect(msg).not.toContain('failed to start');
  });

  it('does not claim an interruption for an ordinary status-0 failure', () => {
    expect(syncErrorMessage(new SyncStreamError(0, null))).toContain('The run failed to start');
  });

  // An abort is the operator navigating away, which `syncSupplier` swallows —
  // it resolves instead of rejecting, so nothing reaches this function at all.
  // Were an AbortError to leak through, it must NOT read as an interruption:
  // that sentence promises a run is still finishing somewhere.
  it('never reads an abort as an interruption', () => {
    const aborted = new DOMException('The operation was aborted.', 'AbortError');
    expect(syncErrorMessage(aborted)).toBe(
      'The run failed to start. Check the connection and try again.'
    );
  });
});

// How the reader loop ENDS, which is the whole difference between the three
// sentences above — plus which route each export opens, since both now share
// ONE reader and the path is the only thing that separates them. A hand-built
// ReadableStream stands in for the response body: real `fetch` errors the
// stream with an AbortError when its signal aborts, and with an ordinary Error
// when the socket drops, so those are the two endings scripted here.
describe('stream transport', () => {
  const fetchMock = vi.fn();

  /** A body that yields `chunks`, then ends the way `ending` says. */
  function bodyOf(chunks: string[], ending: 'close' | 'drop' | 'abort'): ReadableStream {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i++]));
          return;
        }
        if (ending === 'drop') controller.error(new Error('network dropped'));
        else if (ending === 'abort')
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        else controller.close();
      },
    });
  }

  /** A case-insensitive stand-in for `Headers`, which is all the reader uses. */
  function headersOf(pairs: Record<string, string>) {
    const lower = Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k.toLowerCase(), v]));
    return { get: (name: string) => lower[name.toLowerCase()] ?? null };
  }

  function respondWith(
    chunks: string[],
    ending: 'close' | 'drop' | 'abort',
    headers: Record<string, string> = {}
  ) {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: headersOf(headers),
      body: bodyOf(chunks, ending),
    });
  }

  beforeEach(() => {
    fetchMock.mockReset();
    vi.mocked(bustSponsorCaches).mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves when the server closes the stream cleanly', async () => {
    respondWith([`${started}\n`, `${partA}\n`], 'close');
    const seen: SyncEvent[] = [];

    await expect(syncSupplier('s1', (e) => seen.push(e))).resolves.toBeUndefined();

    expect(seen.map((e) => e.kind)).toEqual(['sync_started', 'part_synced']);
  });

  it('re-badges a drop that happened AFTER events flowed', async () => {
    respondWith([`${started}\n`, `${partA}\n`], 'drop');
    const seen: SyncEvent[] = [];

    const err = await syncSupplier('s1', (e) => seen.push(e)).catch((e) => e);

    expect(err).toBeInstanceOf(SyncStreamError);
    expect(syncErrorMessage(err)).toContain('still going on the server');
    expect(seen).toHaveLength(2); // the rows are on screen and stay there
  });

  it('leaves a drop BEFORE any event as the generic start failure', async () => {
    respondWith([], 'drop');

    const err = await syncSupplier('s1', () => {}).catch((e) => e);

    expect(err).not.toBeInstanceOf(SyncStreamError);
    expect(syncErrorMessage(err)).toContain('failed to start');
  });

  it('ends silently on an abort — no rejection for the caller to report', async () => {
    respondWith([`${started}\n`, `${partA}\n`], 'abort');
    const seen: SyncEvent[] = [];

    await expect(syncSupplier('s1', (e) => seen.push(e))).resolves.toBeUndefined();

    expect(seen).toHaveLength(2);
  });

  it('still busts the SW caches on an abort, because the writes landed', async () => {
    // The importer commits per part, so an aborted run has changed rows the
    // public site may still be serving from its cache — the bust is owed
    // however the stream ended.
    respondWith([`${started}\n`, `${partA}\n`], 'abort');

    await syncSupplier('s1', () => {});

    expect(bustSponsorCaches).toHaveBeenCalledTimes(1);
  });

  it('does not bust the caches when nothing was written', async () => {
    respondWith([`${started}\n`, `${partB}\n`], 'abort'); // not_found only

    await syncSupplier('s1', () => {});

    expect(bustSponsorCaches).not.toHaveBeenCalled();
  });

  it('passes the caller signal straight to fetch', async () => {
    respondWith([], 'close');
    const controller = new AbortController();

    await syncSupplier('s1', () => {}, { signal: controller.signal });

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  // Both exports are now the same reader behind two paths, so the path IS the
  // difference between refreshing the listings a supplier has and adding ones
  // it does not. A wrapper that opened the wrong one would look identical on
  // screen right up until it spent the day's provider quota on the wrong job.
  it('opens the SYNC route with its per-run row limit', async () => {
    respondWith([], 'close');

    await syncSupplier('s1', () => {});

    expect(fetchMock.mock.calls[0][0]).toContain('/suppliers/s1/sync?limit=25');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  it('opens the IMPORT route with the default call budget', async () => {
    respondWith([], 'close');

    await importSupplier('s1', () => {});

    expect(fetchMock.mock.calls[0][0]).toContain('/suppliers/s1/import?calls=200');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  it('lets the caller spend a different call budget', async () => {
    respondWith([], 'close');

    await importSupplier('s1', () => {}, { calls: 500 });

    expect(fetchMock.mock.calls[0][0]).toContain('/suppliers/s1/import?calls=500');
  });

  it('escapes the supplier id it is handed', async () => {
    respondWith([], 'close');

    await importSupplier('a b/c', () => {});

    expect(fetchMock.mock.calls[0][0]).toContain('/suppliers/a%20b%2Fc/import');
  });

  // `importSupplier` destructures `calls` off its options — the signal has to
  // survive that, or leaving the page would no longer end the run.
  it('still passes the caller signal through the import wrapper', async () => {
    respondWith([], 'close');
    const controller = new AbortController();

    await importSupplier('s1', () => {}, { signal: controller.signal, calls: 5 });

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('streams import events through the same reader', async () => {
    respondWith([`${started}\n`, `${partNew}\n`], 'close');
    const seen: SyncEvent[] = [];

    await importSupplier('s1', (e) => seen.push(e));

    expect(seen.map((e) => e.action)).toEqual([null, 'created']);
  });

  // A created part is the biggest public-facing write of the lot: a part page
  // that did not exist, plus a category count that moved.
  it('busts the SW caches for a created part', async () => {
    respondWith([`${partNew}\n`], 'close');

    await importSupplier('s1', () => {});

    expect(bustSponsorCaches).toHaveBeenCalledTimes(1);
  });

  // `onOpen` carries the two things the BODY cannot say, because both streams
  // emit an identical envelope: which job this is, and whether the run is
  // still going. The second one is the 2026-08-21 fix — the server keeps a
  // finished run readable for ~15 minutes so an operator can come back and
  // read it, so a successful attach is NOT evidence of live work.
  describe('the run headers', () => {
    async function openInfo(headers: Record<string, string>): Promise<FeedRunInfo> {
      respondWith([`${partA}\n`], 'close', headers);
      let info: FeedRunInfo | null = null;
      await observeSupplierRun('s1', () => {}, { onOpen: (i) => (info = i) });
      if (info === null) throw new Error('onOpen never fired');
      return info;
    }

    it('names the run and the job it is', async () => {
      const info = await openInfo({
        'X-Feed-Run-Id': 'run-42',
        'X-Feed-Run-Mode': 'import',
        'X-Feed-Run-Active': 'true',
      });

      expect(info.runId).toBe('run-42');
      expect(info.mode).toBe('import');
      expect(info.active).toBe(true);
    });

    it('reports a replay of a FINISHED run as not active', async () => {
      const info = await openInfo({ 'X-Feed-Run-Mode': 'import', 'X-Feed-Run-Active': 'false' });

      expect(info.active).toBe(false);
    });

    // An API deployed before the header exists sends nothing. Assuming
    // "finished" there would idle the Sync/Import cards over a run that is
    // genuinely spending the day's provider quota — the worse half of the
    // trade, and the state this whole split exists to prevent.
    it('assumes the run is live when the header is absent', async () => {
      const info = await openInfo({ 'X-Feed-Run-Mode': 'sync' });

      expect(info.active).toBe(true);
    });

    it('defaults an unknown mode to sync rather than mislabelling an import', async () => {
      const info = await openInfo({});

      expect(info.mode).toBe('sync');
      expect(info.runId).toBeNull();
    });
  });

  // The attach door. A 404 is the NORMAL answer to "is anything going?" and
  // must not reach the caller as an error — the page probes this on every load.
  describe('observeSupplierRun', () => {
    it('opens the feed-run route with GET', async () => {
      respondWith([], 'close');

      await observeSupplierRun('s1', () => {});

      expect(fetchMock.mock.calls[0][0]).toContain('/suppliers/s1/feed-run');
      expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    });

    it('answers false when there is nothing to attach to', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        headers: headersOf({}),
        json: async () => ({ detail: 'no_feed_run' }),
      });

      await expect(observeSupplierRun('s1', () => {})).resolves.toBe(false);
    });

    it('still throws for a 404 that is a missing SUPPLIER, not a missing run', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        headers: headersOf({}),
        json: async () => ({ detail: 'Supplier not found' }),
      });

      await expect(observeSupplierRun('s1', () => {})).rejects.toBeInstanceOf(SyncStreamError);
    });
  });

  // The sentence for a socket that died mid-stream depends on what it was
  // reading: live work carrying on without this tab, or the replay of a run
  // that had already ended. Promising the second one is "still going" is what
  // left the console claiming a paused run forever.
  it('does not promise a finished run is still going when its replay drops', () => {
    const err = new SyncStreamError(0, 'stream_interrupted');

    expect(syncErrorMessage(err, { runActive: false })).not.toContain('still going');
    expect(syncErrorMessage(err, { runActive: false })).toContain('reconnect');
    expect(syncErrorMessage(err, { runActive: true })).toContain('still going on the server');
  });
});
