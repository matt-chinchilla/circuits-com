import { describe, it, expect } from 'vitest';
import {
  parseNdjson,
  tallyCounts,
  terminalState,
  syncErrorMessage,
  SyncStreamError,
  type SyncEvent,
} from '@admin/services/syncStream';

// The wire shapes below are copied from the backend's `_sync_event`
// (api/app/services/part_feed/importer.py) — the ONE definition of the
// contract. If these literals stop matching that helper, the console is
// rendering a shape the server no longer sends.

const started = '{"kind":"sync_started","supplier_id":"s1","title":"Mouser","detail":"3 parts queued","image_url":null,"action":null}';
const partA = '{"kind":"part_synced","supplier_id":"s1","title":"STM32F103 — ST","detail":"Microcontrollers","image_url":"https://ex.test/a.jpg","action":"updated"}';
const partB = '{"kind":"part_synced","supplier_id":"s1","title":"LM358","detail":null,"image_url":null,"action":"not_found"}';

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
      '{"kind":"sync_finished","supplier_id":"s1","title":"Mouser","detail":"2 synced · 1 images filled · 1 not found","image_url":null,"action":null,"counts":{"synced":2,"media_filled":1,"not_found":1,"no_data":0}}';
    const { events } = parseNdjson(`${finished}\n`);
    expect(events[0].counts).toEqual({ synced: 2, media_filled: 1, not_found: 1, no_data: 0 });
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
    expect(tallyCounts([])).toEqual({ synced: 0, media_filled: 0, not_found: 0, no_data: 0 });
  });

  it('counts a media_filled part as BOTH synced and media filled', () => {
    expect(tallyCounts([part('media_filled')])).toEqual({
      synced: 1,
      media_filled: 1,
      not_found: 0,
      no_data: 0,
    });
  });

  it('counts updated as synced, and keeps not_found / no_data out of synced', () => {
    expect(
      tallyCounts([part('updated'), part('updated'), part('not_found'), part('no_data')])
    ).toEqual({ synced: 2, media_filled: 0, not_found: 1, no_data: 1 });
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
        counts: { synced: 9, media_filled: 4, not_found: 2, no_data: 1 },
      },
    ];
    expect(tallyCounts(events)).toEqual({ synced: 9, media_filled: 4, not_found: 2, no_data: 1 });
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
      part('not_found'),
      { kind: 'sync_error', supplier_id: 's1', title: 'Sync failed', detail: 'boom' },
      {
        kind: 'sync_finished',
        supplier_id: 's1',
        title: 'Mouser',
        detail: 'sync aborted',
        counts: { synced: 0, media_filled: 0, not_found: 0, no_data: 0 },
      },
    ];
    expect(tallyCounts(events)).toEqual({
      synced: 2,
      media_filled: 1,
      not_found: 1,
      no_data: 0,
    });
  });

  it('still reports zeros when a run genuinely did nothing', () => {
    const events: SyncEvent[] = [
      { kind: 'sync_started', supplier_id: 's1', title: 'Mouser', detail: '0 parts queued' },
      {
        kind: 'sync_finished',
        supplier_id: 's1',
        title: 'Mouser',
        counts: { synced: 0, media_filled: 0, not_found: 0, no_data: 0 },
      },
    ];
    expect(tallyCounts(events)).toEqual({ synced: 0, media_filled: 0, not_found: 0, no_data: 0 });
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

  it('names an expired session', () => {
    expect(syncErrorMessage(new SyncStreamError(401, 'Not authenticated'))).toContain('sign in');
  });

  it('names the read-only demo refusal', () => {
    expect(syncErrorMessage(new SyncStreamError(403, 'demo_account_read_only'))).toBe(
      'Editing is disabled in the demo.'
    );
  });

  it('falls back to one generic sentence for anything else', () => {
    expect(syncErrorMessage(new Error('network down'))).toContain('Sync failed');
    expect(syncErrorMessage(new SyncStreamError(500, null))).toContain('Sync failed');
  });
});
