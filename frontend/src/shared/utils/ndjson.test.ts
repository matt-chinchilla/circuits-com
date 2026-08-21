import { describe, it, expect } from 'vitest';
import { parseNdjson } from '@shared/utils/ndjson';

// The wire shapes below are copied from the backend's `_sync_event`
// (api/app/services/part_feed/importer.py) — the ONE definition of the
// contract the admin console reads. The parser itself is contract-agnostic
// (it hands back `unknown`), so these are realistic fodder, not a schema.
type WireEvent = {
  kind: string;
  title: string | null;
  detail: string | null;
  action: string | null;
  counts?: Record<string, number>;
};
const asEvents = (events: unknown[]) => events as WireEvent[];

const started = '{"kind":"sync_started","supplier_id":"s1","title":"Mouser","detail":"3 parts queued","image_url":null,"action":null}';
const partA = '{"kind":"part_synced","supplier_id":"s1","title":"STM32F103 — ST","detail":"Microcontrollers","image_url":"https://ex.test/a.jpg","action":"updated"}';
const partB = '{"kind":"part_synced","supplier_id":"s1","title":"LM358","detail":null,"image_url":null,"action":"not_found"}';

describe('parseNdjson', () => {
  it('returns every complete line and an empty remainder', () => {
    const { events, rest } = parseNdjson(`${started}\n${partA}\n`);
    const parsed = asEvents(events);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].kind).toBe('sync_started');
    expect(parsed[0].detail).toBe('3 parts queued');
    expect(parsed[1].action).toBe('updated');
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
    expect(asEvents(second.events)[0].title).toBe('STM32F103 — ST');
    expect(second.rest).toBe('');
  });

  it('skips a malformed line without throwing or losing its neighbours', () => {
    const { events, rest } = parseNdjson(`${started}\n{"kind":"part_syn\n${partB}\n`);
    expect(asEvents(events).map((e) => e.kind)).toEqual(['sync_started', 'part_synced']);
    expect(rest).toBe('');
  });

  it('skips JSON that parses to a non-object', () => {
    const { events } = parseNdjson(`12\n"hello"\nnull\n[1,2]\n${partB}\n`);
    expect(events).toHaveLength(1);
    expect(asEvents(events)[0].action).toBe('not_found');
  });

  it('returns nothing for an empty buffer', () => {
    expect(parseNdjson('')).toEqual({ events: [], rest: '' });
  });

  it('tolerates CRLF line endings and blank lines', () => {
    const { events, rest } = parseNdjson(`${started}\r\n\r\n${partA}\r\n`);
    expect(events).toHaveLength(2);
    expect(rest).toBe('');
  });

  it('skips the bare-newline heartbeat without emitting an event', () => {
    const { events, rest } = parseNdjson(`\n\n${partB}\n\n`);
    expect(events).toHaveLength(1);
    expect(rest).toBe('');
  });

  it('keeps the counts object that rides on a terminal event', () => {
    const finished =
      '{"kind":"sync_finished","supplier_id":"s1","title":"Mouser","detail":"2 synced · 1 images filled · 1 not found","image_url":null,"action":null,"counts":{"synced":2,"media_filled":1,"not_found":1,"no_data":0,"created":0}}';
    const { events } = parseNdjson(`${finished}\n`);
    const parsed = asEvents(events);
    expect(parsed[0].counts).toEqual({
      synced: 2,
      media_filled: 1,
      not_found: 1,
      no_data: 0,
      created: 0,
    });
    expect(parsed[0].detail).toBe('2 synced · 1 images filled · 1 not found');
  });
});
