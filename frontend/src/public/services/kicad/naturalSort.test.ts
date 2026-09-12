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
});
