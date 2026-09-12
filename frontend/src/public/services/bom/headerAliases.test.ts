import { describe, expect, it } from 'vitest';
import { HEADER_ALIASES, matchHeader, normalizeHeader } from './headerAliases';

describe('normalizeHeader', () => {
  it('lowers, trims, unwraps ${} and collapses space', () => {
    expect(normalizeHeader('  Designator ')).toBe('designator');
    expect(normalizeHeader('${QUANTITY}')).toBe('quantity');
    expect(normalizeHeader('Reference(s)')).toBe('reference(s)');
  });
});

describe('attested aliases (spot checks against the brief)', () => {
  it('Comment maps to VALUE — the JLCPCB convention, never a note', () => {
    expect(matchHeader('Comment')).toBe('value');
  });
  it('legacy exporter spellings are real', () => {
    expect(matchHeader('Qnty')).toBe('qty');
    expect(matchHeader('Cmp name')).toBe('value');
    expect(matchHeader('Reference(s)')).toBe('refs');
    expect(matchHeader('#')).toBe('distributor_pn');
  });
  it('both Designator and References live', () => {
    expect(matchHeader('Designator')).toBe('refs');
    expect(matchHeader('References')).toBe('refs');
  });
});

describe('pattern rules (verifier-corrected: runtime strings, not literals)', () => {
  it('distributor + hash — KiCost accepts any known distributor name + #', () => {
    expect(matchHeader('digikey#')).toBe('distributor_pn');
    expect(matchHeader('Mouser#')).toBe('distributor_pn');
  });
  it('LCSC/JLCPCB x Part-variants — the Fabrication-Toolkit cross-product', () => {
    for (const h of ['LCSC Part #', 'LCSC Part', 'JLCPCB PN', 'JLCPCB P/N', 'LCSC Part No.', 'JLCPCB Part Number']) {
      expect(matchHeader(h)).toBe('distributor_pn');
    }
  });
  it('unknown headers return null — never guess silently', () => {
    expect(matchHeader('Tolerance')).toBeNull();
    expect(matchHeader('')).toBeNull();
  });
});

describe('generated map hygiene', () => {
  it('every alias key is pre-normalized (key === normalizeHeader(key))', () => {
    for (const key of Object.keys(HEADER_ALIASES)) {
      expect(key).toBe(normalizeHeader(key));
    }
  });
});

describe('pinned role conflicts (human-resolved, never iteration order)', () => {
  it('bare pn/p#/part# are MANUFACTURER part numbers — the distributor sense needs a prefix', () => {
    expect(matchHeader('PN')).toBe('mpn');
    expect(matchHeader('P#')).toBe('mpn');
    expect(matchHeader('Part#')).toBe('mpn');
  });
});
