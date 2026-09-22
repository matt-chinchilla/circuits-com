import { describe, expect, it } from 'vitest';
import { drawSlices, normaliseSpans, triangleSpan, type MaterialSpan, type Span } from './drawGroups';

/** Every slice non-empty, ascending, non-overlapping, inside [0, total), and a
 *  multiple of 3 wherever the input was. */
function wellFormed(slices: MaterialSpan[], total: number): void {
  let cursor = 0;
  for (const s of slices) {
    expect(s.count).toBeGreaterThan(0);
    expect(s.start).toBeGreaterThanOrEqual(cursor);
    cursor = s.start + s.count;
  }
  expect(cursor).toBeLessThanOrEqual(total);
}

/** Which material each index draws in; -1 = not drawn. */
function paint(slices: MaterialSpan[], total: number): number[] {
  const out = new Array<number>(total).fill(-1);
  for (const s of slices) for (let i = s.start; i < s.start + s.count; i++) out[i] = s.materialIndex;
  return out;
}

// A copper group of 36 indices (12 triangles): pads [0, 12), tracks [12, 24),
// zones [24, 36) — the order buildScene appends them in.
const TOTAL = 36;
const CLASSES: MaterialSpan[] = [
  { start: 0, count: 12, materialIndex: 3 },
  { start: 12, count: 12, materialIndex: 2 },
  { start: 24, count: 12, materialIndex: 4 },
];
const OPTS = { baseIndex: 0, litIndex: 1 };

describe('triangleSpan', () => {
  it('turns a triangle range (spec §2.3) into the index range three draws', () => {
    expect(triangleSpan({ start: 4, count: 2 })).toEqual({ start: 12, count: 6 });
  });
});

describe('normaliseSpans', () => {
  it('sorts, merges overlapping and touching spans, clamps and drops empties', () => {
    const spans: Span[] = [{ start: 30, count: 12 }, { start: 3, count: 3 }, { start: 0, count: 3 }, { start: 9, count: 0 }, { start: 5, count: 4 }];
    expect(normaliseSpans(spans, 36)).toEqual([{ start: 0, count: 9 }, { start: 30, count: 6 }]);
  });
});

describe('drawSlices', () => {
  it('with nothing lit and no classes, draws the whole group in its own material', () => {
    expect(drawSlices(TOTAL, [], [], OPTS)).toEqual([{ start: 0, count: TOTAL, materialIndex: 0 }]);
  });

  it('draws each class in its own material, one slice each', () => {
    const slices = drawSlices(TOTAL, CLASSES, [], OPTS);
    expect(slices).toEqual(CLASSES);
  });

  it('fills the triangles no class claims with the base material', () => {
    const slices = drawSlices(TOTAL, [{ start: 12, count: 12, materialIndex: 2 }], [], OPTS);
    expect(slices).toEqual([
      { start: 0, count: 12, materialIndex: 0 },
      { start: 12, count: 12, materialIndex: 2 },
      { start: 24, count: 12, materialIndex: 0 },
    ]);
  });

  it('lights a span that crosses a class boundary without disturbing the rest', () => {
    const slices = drawSlices(TOTAL, CLASSES, [{ start: 9, count: 6 }], OPTS);
    wellFormed(slices, TOTAL);
    const painted = paint(slices, TOTAL);
    expect(painted.slice(0, 9).every((m) => m === 3)).toBe(true);
    expect(painted.slice(9, 15).every((m) => m === 1)).toBe(true);
    expect(painted.slice(15, 24).every((m) => m === 2)).toBe(true);
    expect(painted.slice(24).every((m) => m === 4)).toBe(true);
  });

  it('joins adjacent lit slices into one draw range', () => {
    const slices = drawSlices(TOTAL, CLASSES, [{ start: 6, count: 6 }, { start: 12, count: 6 }], OPTS);
    expect(slices.filter((s) => s.materialIndex === 1)).toEqual([{ start: 6, count: 12, materialIndex: 1 }]);
  });

  it('a whole-group light (a layer highlight) is one slice', () => {
    expect(drawSlices(TOTAL, CLASSES, [{ start: 0, count: TOTAL }], OPTS)).toEqual([{ start: 0, count: TOTAL, materialIndex: 1 }]);
  });

  it('a hidden class draws nothing at all, lit or not', () => {
    const slices = drawSlices(TOTAL, CLASSES, [{ start: 9, count: 6 }], { ...OPTS, hidden: new Set([2]) });
    wellFormed(slices, TOTAL);
    const painted = paint(slices, TOTAL);
    // Tracks [12, 24) are gone — including the lit part of them.
    expect(painted.slice(12, 24).every((m) => m === -1)).toBe(true);
    expect(painted.slice(9, 12).every((m) => m === 1)).toBe(true);
    expect(painted.slice(24).every((m) => m === 4)).toBe(true);
  });

  it('ignores ranges outside the group and survives unsorted, overlapping input', () => {
    const slices = drawSlices(
      TOTAL,
      [CLASSES[2], CLASSES[0], CLASSES[1], { start: 30, count: 30, materialIndex: 2 }],
      [{ start: 33, count: 90 }, { start: -6, count: 9 }],
      OPTS,
    );
    wellFormed(slices, TOTAL);
    const painted = paint(slices, TOTAL);
    expect(painted.slice(0, 3).every((m) => m === 1)).toBe(true);
    expect(painted.slice(33).every((m) => m === 1)).toBe(true);
    expect(painted.every((m) => m !== -1)).toBe(true);
  });

  it('covers every index exactly once when nothing is hidden', () => {
    const lit: Span[] = [{ start: 3, count: 3 }, { start: 18, count: 9 }];
    const slices = drawSlices(TOTAL, CLASSES, lit, OPTS);
    wellFormed(slices, TOTAL);
    expect(slices.reduce((n, s) => n + s.count, 0)).toBe(TOTAL);
  });
});
