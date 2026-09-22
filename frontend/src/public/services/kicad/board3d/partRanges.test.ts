import { describe, expect, it } from 'vitest';
import { classSlices, highlightSlices, netAtFace, netRangesOf, partAtFace, rangeSlices, type ClassSlice, type DrawSlice } from './partRanges';
import type { ClassRange, NetRange, PartRange } from './types';

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

/** Every tiling in this file must cover [0, total) in order with non-empty slices. */
function expectTiles(slices: readonly (DrawSlice | ClassSlice)[], total: number): void {
  let cursor = 0;
  for (const s of slices) {
    expect(s.start).toBe(cursor);
    expect(s.count).toBeGreaterThan(0);
    cursor += s.count;
  }
  expect(cursor).toBe(total);
}

// A copper group of 60 indices: pads [0, 18), tracks [18, 42), zones [42, 60).
// Net 3 owns a pad, a track run and a pour; net 5 a pad and a track; the pad at
// [12, 18) and the track at [36, 42) are on no net.
const CLASSES: ClassRange[] = [
  { kind: 'pads', start: 0, count: 18 },
  { kind: 'tracks', start: 18, count: 24 },
  { kind: 'zones', start: 42, count: 18 },
];
const NETS: NetRange[] = [
  { net: 3, start: 0, count: 6 },
  { net: 5, start: 6, count: 6 },
  { net: 3, start: 18, count: 12 },
  { net: 5, start: 30, count: 6 },
  { net: 3, start: 42, count: 18 },
];

describe('rangeSlices', () => {
  it('lifts arbitrary ranges, joining touching ones, in any order', () => {
    expect(rangeSlices([{ start: 30, count: 6 }, { start: 6, count: 6 }, { start: 12, count: 6 }], 48)).toEqual([
      { start: 0, count: 6, materialIndex: 0 },
      { start: 6, count: 12, materialIndex: 1 },
      { start: 18, count: 12, materialIndex: 0 },
      { start: 30, count: 6, materialIndex: 1 },
      { start: 36, count: 12, materialIndex: 0 },
    ]);
  });
  it('a whole-group range is one highlighted slice; none is one plain slice', () => {
    expect(rangeSlices([{ start: 0, count: 48 }], 48)).toEqual([{ start: 0, count: 48, materialIndex: 1 }]);
    expect(rangeSlices([], 48)).toEqual([{ start: 0, count: 48, materialIndex: 0 }]);
  });
  it('clips ranges to the group and tiles it exactly', () => {
    const slices = rangeSlices([{ start: -6, count: 12 }, { start: 42, count: 30 }], 48);
    expect(slices).toEqual([
      { start: 0, count: 6, materialIndex: 1 },
      { start: 6, count: 36, materialIndex: 0 },
      { start: 42, count: 6, materialIndex: 1 },
    ]);
    expectTiles(slices, 48);
  });
  it('highlightSlices is rangeSlices over one footprint', () => {
    for (const ref of ['R1', 'C1', 'U1']) {
      expect(highlightSlices(PARTS, ref, 48)).toEqual(rangeSlices(PARTS.filter((p) => p.ref === ref), 48));
    }
  });
});

describe('nets', () => {
  it('netRangesOf picks one net; null, 0 and an absent table pick nothing', () => {
    expect(netRangesOf(NETS, 3).map((r) => r.start)).toEqual([0, 18, 42]);
    expect(netRangesOf(NETS, null)).toEqual([]);
    expect(netRangesOf(NETS, 0)).toEqual([]);
    expect(netRangesOf(undefined, 3)).toEqual([]);
  });
  it('netAtFace maps a triangle back to its net, 0 for none', () => {
    expect(netAtFace(NETS, 0)).toBe(3);
    expect(netAtFace(NETS, 2)).toBe(5);
    expect(netAtFace(NETS, 4)).toBe(0);    // the unconnected pad
    expect(netAtFace(NETS, 12)).toBe(0);   // the unconnected track
    expect(netAtFace(NETS, 19)).toBe(3);
    expect(netAtFace(undefined, 0)).toBe(0);
  });
  it('a net highlight tiles the group', () => {
    expectTiles(rangeSlices(netRangesOf(NETS, 3), 60), 60);
    expect(rangeSlices(netRangesOf(NETS, 3), 60).filter((s) => s.materialIndex === 1).reduce((n, s) => n + s.count, 0)).toBe(36);
  });
});

describe('classSlices', () => {
  it('no highlight: one slice per class', () => {
    expect(classSlices(CLASSES, [], 60)).toEqual([
      { start: 0, count: 18, kind: 'pads', highlighted: false },
      { start: 18, count: 24, kind: 'tracks', highlighted: false },
      { start: 42, count: 18, kind: 'zones', highlighted: false },
    ]);
  });
  it('a net highlight splits each class it touches, and keeps each class its own', () => {
    const slices = classSlices(CLASSES, netRangesOf(NETS, 5), 60);
    expect(slices).toEqual([
      { start: 0, count: 6, kind: 'pads', highlighted: false },
      { start: 6, count: 6, kind: 'pads', highlighted: true },
      { start: 12, count: 6, kind: 'pads', highlighted: false },
      { start: 18, count: 12, kind: 'tracks', highlighted: false },
      { start: 30, count: 6, kind: 'tracks', highlighted: true },
      { start: 36, count: 6, kind: 'tracks', highlighted: false },
      { start: 42, count: 18, kind: 'zones', highlighted: false },
    ]);
    expectTiles(slices, 60);
  });
  it('a highlight spanning a class boundary is cut at it', () => {
    const slices = classSlices(CLASSES, [{ start: 12, count: 36 }], 60);
    expect(slices.map((s) => [s.kind, s.highlighted, s.count])).toEqual([
      ['pads', false, 12], ['pads', true, 6], ['tracks', true, 24], ['zones', true, 6], ['zones', false, 12],
    ]);
  });
  it('a whole-layer highlight is every class, highlighted', () => {
    expect(classSlices(CLASSES, [{ start: 0, count: 60 }], 60).map((s) => [s.kind, s.highlighted])).toEqual([
      ['pads', true], ['tracks', true], ['zones', true],
    ]);
  });
  it('a group with no class table is one kind-less slice (plus the highlight)', () => {
    expect(classSlices(undefined, [], 30)).toEqual([{ start: 0, count: 30, kind: null, highlighted: false }]);
    expectTiles(classSlices(undefined, [{ start: 6, count: 6 }], 30), 30);
  });
});
