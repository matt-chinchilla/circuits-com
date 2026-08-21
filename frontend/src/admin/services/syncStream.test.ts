import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseNdjson,
  tallyCounts,
  terminalState,
  syncErrorMessage,
  syncSupplier,
  importSupplier,
  SyncStreamError,
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

describe('parseNdjson', () => {
  it('returns every complete line and an empty remainder', () => {
    const { events, rest } = parseNdjson(`${started}\n${partA}\n`);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe('sync_started');
    expect(events[0].detail).toBe('3 parts queued');
    expect(events[1].action).toBe('updated');
    expect(rest).toBe('');
  });

  it('holds back a trailing partial line as the remainder', () => {
    const partial = partA.slice(0, 30);
    const { events, rest } = parseNdjson(`${started}\n${partial}`);
    expect(events).toHaveLength(1);
    expect(rest).toBe(partial);
  });

  it('reassembles a line split across two chunks', () => {
    const head = partA.slice(0, 24);
    const tail = partA.slice(24);
    const first = parseNdjson(head);
    expect(first.events).toHaveLength(0);
    // Exactly what the reader loop does: prepend the leftover to the next chunk.
    const second = parseNdjson(first.rest + tail + '\n');
    expect(second.events).toHaveLength(1);
    expect(second.events[0].title).toBe('STM32F103 — ST');
    expect(second.rest).toBe('');
  });

  it('skips a malformed line without throwing or losing its neighbours', () => {
    const { events, rest } = parseNdjson(`${started}\n{"kind":"part_syn\n${partB}\n`);
    expect(events.map((e) => e.kind)).toEqual(['sync_started', 'part_synced']);
    expect(rest).toBe('');
  });

  it('skips JSON that parses to a non-object', () => {
    const { events } = parseNdjson(`12\n"hello"\nnull\n[1,2]\n${partB}\n`);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('not_found');
  });

  it('returns nothing for an empty buffer', () => {
    expect(parseNdjson('')).toEqual({ events: [], rest: '' });
  });

  it('tolerates CRLF line endings and blank lines', () => {
    const { events, rest } = parseNdjson(`${started}\r\n\r\n${partA}\r\n`);
    expect(events).toHaveLength(2);
    expect(rest).toBe('');
  });

  it('keeps the counts object that rides on sync_finished', () => {
    const finished =
      '{"kind":"sync_finished","supplier_id":"s1","title":"Mouser","detail":"2 synced · 1 images filled · 1 not found","image_url":null,"action":null,"counts":{"synced":2,"media_filled":1,"not_found":1,"no_data":0,"created":0}}';
    const { events } = parseNdjson(`${finished}\n`);
    expect(events[0].counts).toEqual({
      synced: 2,
      media_filled: 1,
      not_found: 1,
      no_data: 0,
      created: 0,
    });
    expect(events[0].detail).toBe('2 synced · 1 images filled · 1 not found');
  });
});

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

  function respondWith(chunks: string[], ending: 'close' | 'drop' | 'abort') {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: bodyOf(chunks, ending) });
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
});
