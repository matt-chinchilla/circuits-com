import { describe, expect, it } from 'vitest';
import { naturalRefCompare } from './naturalSort';

describe('naturalRefCompare', () => {
  it('orders R2 before R10 and letters before their numbers', () => {
    expect(['R10', 'R2', 'C1', 'R1'].sort(naturalRefCompare)).toEqual(['C1', 'R1', 'R2', 'R10']);
  });
  it('keeps suffixes stable and is total', () => {
    expect(['U1B', 'U1A', 'U1'].sort(naturalRefCompare)).toEqual(['U1', 'U1A', 'U1B']);
    expect(naturalRefCompare('R1', 'R1')).toBe(0);
  });

  it('survives a designator carrying a line terminator', () => {
    // The SPLIT regex does NOT match every string, though every group being
    // `*`-quantified reads as though it must: `.` never matches a line
    // terminator and there is no `m` flag, so `exec` returns null once a digit
    // is followed by one. The tokenizer reads a quoted schematic property to its
    // closing quote, newlines included, so this arrives from a real file — and a
    // null deref would throw from inside a sort and take the BOM table with it.
    for (const bad of ['R1\n', 'R1\nX', 'R1\r\nX', '1\u20282']) {
      expect(() => naturalRefCompare(bad, 'R2')).not.toThrow();
      expect(() => naturalRefCompare('R2', bad)).not.toThrow();
      expect(naturalRefCompare(bad, bad)).toBe(0);
    }
    // Still a total order, so a sort cannot wedge on one.
    expect(['R10', 'R1\nX', 'R2'].sort(naturalRefCompare)).toHaveLength(3);
  });
});
