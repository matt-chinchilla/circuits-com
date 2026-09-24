import { describe, expect, it } from 'vitest';
import { VIEW_KEY, VIEW_ORDER, viewForKey } from './viewLabels';

describe('viewForKey', () => {
  it('keys every view, each with its own single lowercase letter', () => {
    const letters = VIEW_ORDER.map((id) => VIEW_KEY[id]);
    expect(new Set(letters).size).toBe(VIEW_ORDER.length);
    for (const letter of letters) expect(letter).toMatch(/^[a-z]$/);
  });

  it('round-trips: each view’s letter jumps back to that view', () => {
    for (const id of VIEW_ORDER) expect(viewForKey(VIEW_KEY[id])).toBe(id);
  });

  it('steers clear of the 3D view’s keys and the page’s own', () => {
    const taken = ['t', 'b', 'f', 'r', '1', '2', '3', '/', 'Escape'];
    for (const k of taken) expect(viewForKey(k)).toBeNull();
  });

  it('answers null for any other key', () => {
    for (const k of ['a', 'x', '', 'Enter', 'ArrowRight', 'S']) expect(viewForKey(k)).toBeNull();
  });
});
