import { describe, expect, it } from 'vitest';

import { OUTCOME_META, OUTCOME_ORDER, firstInitial } from './outcome';

describe('OUTCOME_META', () => {
  it('covers the trio with word + hex + glyph', () => {
    for (const key of OUTCOME_ORDER) {
      const meta = OUTCOME_META[key];
      expect(meta.word.length).toBeGreaterThan(0);
      expect(meta.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(meta.inkDark).toMatch(/^#[0-9a-f]{6}$/);
      expect(meta.glyph.length).toBe(1);
    }
  });

  it('never uses the CVD-forbidden pair', () => {
    const hexes = OUTCOME_ORDER.map((k) => OUTCOME_META[k].hex);
    expect(hexes).not.toContain('#2563eb');
    expect(hexes).not.toContain('#7c3aed');
  });
});

describe('firstInitial', () => {
  it('takes the first letter, uppercased', () => {
    expect(firstInitial('ian locke')).toBe('I');
    expect(firstInitial('  Nathan Little')).toBe('N');
  });

  it('returns null for placeholders — the caller renders a dot', () => {
    expect(firstInitial(null)).toBeNull();
    expect(firstInitial('')).toBeNull();
    expect(firstInitial('   ')).toBeNull();
  });
});
