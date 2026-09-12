// The right rail's rule. Asserts on the STATE TOKEN and the words, which is
// what the reader actually gets — the token because BomTable maps it to a
// class, the label because the rail is a bare coloured strip and the label is
// its accessible name.

import { describe, expect, it } from 'vitest';

import { availability } from './availability';

describe('availability', () => {
  it('reads full when the shelf covers the line', () => {
    expect(availability(500, 100)).toEqual({
      state: 'full',
      label: 'Availability: 500 in stock',
    });
  });

  it('reads full at exactly the line quantity', () => {
    expect(availability(100, 100).state).toBe('full');
  });

  it('reads partial when some but not enough is on the shelf', () => {
    expect(availability(40, 100)).toEqual({
      state: 'partial',
      label: 'Availability: only 40 of 100 in stock',
    });
  });

  it('reads none at zero stock', () => {
    expect(availability(0, 100).state).toBe('none');
  });

  it('reads none when there is no chosen offer at all', () => {
    // Nothing matched, or the reader pinned a supplier this BOM does not
    // carry. Red, not an optimistic blank and not a crash.
    expect(availability(null, 100)).toEqual({
      state: 'none',
      label: 'Availability: nothing in stock',
    });
  });

  it('groups thousands so a big shelf figure stays readable', () => {
    expect(availability(12500, 10).label).toBe('Availability: 12,500 in stock');
  });

  it('never mentions price freshness', () => {
    // THE REGRESSION GUARD. The rail used to test a staleness flag above both
    // stock branches, so a flagged row printed "price not refreshed in 30
    // days" and dropped its stock figure entirely. That flag was reading row
    // AGE, and on 2026-09-24 it would have covered all 167,823 listings in the
    // catalog — every BOM row, everywhere, reporting no stock. Availability
    // answers one question now, and always answers it.
    const labels = [availability(500, 100), availability(40, 100), availability(0, 100)].map(
      (a) => a.label,
    );
    for (const label of labels) {
      expect(label).not.toMatch(/stale|refresh|price/i);
      expect(label).toMatch(/stock/);
    }
  });
});
