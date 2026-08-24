// The provenance label. Two arms only reach the page: a live feed, or
// silence. `static` and absent are both silence, by owner decision — badging
// the 57 sourceless distributors would publish our integration backlog as a
// mark against them on a neutral-comparison page. The silent cases are the
// ones that matter here: a hand-written `=== 'live'` at a render site gets
// them wrong in the direction that invents a claim.

import { describe, expect, it } from 'vitest';

import { priceSourceNote } from './priceSource';

const JUNE = '2026-06-03T00:00:00+00:00';

describe('priceSourceNote', () => {
  it('names a live feed and the date the offer was added', () => {
    expect(priceSourceNote({ price_source: 'live', price_as_of: JUNE })).toBe(
      'live feed · added Jun 3, 2026',
    );
  });

  it('says NOTHING for a supplier with no live source', () => {
    // Owner decision, 2026-08-24. The number is real — the ~37,095 listings
    // behind the 57 sourceless suppliers were collected, not invented — but we
    // cannot say when it was last read, and a chip saying so would read as a
    // judgement on the distributor when the actual cause is our own backlog.
    // The server still SENDS 'static'; suppressing it is a render decision.
    expect(priceSourceNote({ price_source: 'static', price_as_of: JUNE })).toBeNull();
    expect(priceSourceNote({ price_source: 'static' })).toBeNull();
    expect(priceSourceNote({ price_source: 'static', price_as_of: null })).toBeNull();
  });

  it('says NOTHING when the source is absent', () => {
    // A share link created before the field existed replays its stored offers
    // verbatim. `=== 'static'` is false for undefined, so a two-armed branch
    // at a render site prints whichever arm is the else — and if that is the
    // static chip, every offer on every old share accuses a live distributor
    // of not maintaining its prices. Null is the third arm, made unavoidable.
    expect(priceSourceNote({})).toBeNull();
    expect(priceSourceNote({ price_as_of: JUNE })).toBeNull();
    // And a bogus value must not fall through into the live arm.
    expect(priceSourceNote({ price_source: 'whatever' as never })).toBeNull();
  });

  it('never claims a price was confirmed, checked or updated', () => {
    // The whole point of the change: we know where a price came from and we
    // do NOT know when it was last read. No wording may imply otherwise.
    const note = priceSourceNote({ price_source: 'live', price_as_of: JUNE });
    expect(note).not.toMatch(/confirm|verified|checked|updated|as of|current/i);
    expect(note).toMatch(/added/);
  });

  it('keeps the label and the date in ONE string', () => {
    // Rendered as a single node the pair cannot be split by a later layout
    // change that keeps the chip and drops the date, which would leave a bare
    // "static price" with nothing anchoring it in time.
    const note = priceSourceNote({ price_source: 'live', price_as_of: JUNE });
    expect(note).toContain('live feed');
    expect(note).toContain('Jun 3, 2026');
  });

  it('still labels the source when the date is missing or unusable', () => {
    // Degrading to the bare label is right; printing "Invalid Date" into a
    // buyer's sourcing table is not.
    expect(priceSourceNote({ price_source: 'live' })).toBe('live feed');
    expect(priceSourceNote({ price_source: 'live', price_as_of: null })).toBe('live feed');
    expect(priceSourceNote({ price_source: 'live', price_as_of: 'not a date' })).toBe('live feed');
  });

  it('reads the date in UTC so a listing does not change day by timezone', () => {
    // The server sends an instant; late-evening UTC must not print as the
    // previous day for a reader west of Greenwich.
    expect(priceSourceNote({ price_source: 'live', price_as_of: '2026-06-03T23:30:00+00:00' })).toBe(
      'live feed · added Jun 3, 2026',
    );
  });
});
