import { describe, expect, it } from 'vitest';
import { highlightSlices, partAtFace } from './partRanges';
import type { PartRange } from './types';

// Three footprints: R1 owns indices [0, 6), C1 [6, 12), U1 [30, 36); the gap
// [12, 30) is tracks, and [36, 48) is a pour after the last footprint.
const PARTS: PartRange[] = [
  { ref: 'R1', start: 0, count: 6 },
  { ref: 'C1', start: 6, count: 6 },
  { ref: 'U1', start: 30, count: 6 },
];

describe('partAtFace', () => {
  it('maps a triangle back to the footprint whose range holds it', () => {
    expect(partAtFace(PARTS, 0)).toBe('R1');
    expect(partAtFace(PARTS, 1)).toBe('R1');
    expect(partAtFace(PARTS, 2)).toBe('C1');
    expect(partAtFace(PARTS, 10)).toBe('U1');
    expect(partAtFace(PARTS, 11)).toBe('U1');
  });
  it('answers null for a triangle nobody owns, and for a group with no table', () => {
    expect(partAtFace(PARTS, 4)).toBeNull(); // a track between C1 and U1
    expect(partAtFace(PARTS, 12)).toBeNull(); // past the last range
    expect(partAtFace(PARTS, -1)).toBeNull();
    expect(partAtFace(undefined, 0)).toBeNull();
    expect(partAtFace([], 0)).toBeNull();
  });
});

describe('highlightSlices', () => {
  it('draws everything with the base material when nothing is selected', () => {
    expect(highlightSlices(PARTS, null, 48)).toEqual([{ start: 0, count: 48, materialIndex: 0 }]);
    expect(highlightSlices(undefined, 'R1', 48)).toEqual([{ start: 0, count: 48, materialIndex: 0 }]);
  });
  it('tiles the whole index range with the selection lifted out', () => {
    expect(highlightSlices(PARTS, 'C1', 48)).toEqual([
      { start: 0, count: 6, materialIndex: 0 },
      { start: 6, count: 6, materialIndex: 1 },
      { start: 12, count: 36, materialIndex: 0 },
    ]);
    // A selection at the very start emits no empty leading slice.
    expect(highlightSlices(PARTS, 'R1', 48)[0]).toEqual({ start: 0, count: 6, materialIndex: 1 });
  });
  it('a selection this group does not draw leaves the group untouched', () => {
    expect(highlightSlices(PARTS, 'J9', 48)).toEqual([{ start: 0, count: 48, materialIndex: 0 }]);
  });
  it('every tiling covers exactly [0, total) in order', () => {
    for (const ref of ['R1', 'C1', 'U1', 'J9', null]) {
      const slices = highlightSlices(PARTS, ref, 48);
      let cursor = 0;
      for (const s of slices) {
        expect(s.start).toBe(cursor);
        expect(s.count).toBeGreaterThan(0);
        cursor += s.count;
      }
      expect(cursor).toBe(48);
    }
  });
});
