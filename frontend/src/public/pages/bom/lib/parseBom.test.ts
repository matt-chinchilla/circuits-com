import { describe, expect, it } from 'vitest';
import {
  JLCPCB_STYLE, KICAD_CLI_UNQUOTED, LEGACY_GROUPED_WITH_FP,
  SEMICOLON_EU, TSV_KIBOT, UNQUOTED_MULTI_REF_OVERFLOW,
} from './fixtures';
import { expandRefs, MAX_LINES, parseBomText, parsePasteRows } from './parseBom';

describe('kicad-cli default export', () => {
  const r = parseBomText(KICAD_CLI_UNQUOTED);
  it('maps the stock header row', () => {
    expect(r.error).toBeNull();
    expect(r.lines).toHaveLength(4);
    expect(r.lines[0]).toMatchObject({ value: '10k', qty: 1, refs: ['R1'], dnp: false });
  });
  it('DNP is string-or-empty, never parsed for true/false/Y', () => {
    expect(r.lines[2].dnp).toBe(true);
  });
});

describe('unquoted multi-ref overflow', () => {
  it('re-joins overflow cells into the refs column (cells > headers)', () => {
    const r = parseBomText(UNQUOTED_MULTI_REF_OVERFLOW);
    expect(r.lines[0].refs).toEqual(['R1', 'R2', 'R3', 'R7']);
    expect(r.lines[0].value).toBe('10k');
  });
});

describe('legacy grouped exporter', () => {
  const r = parseBomText(LEGACY_GROUPED_WITH_FP);
  it('finds the header row under the 5-line preamble', () => {
    expect(r.error).toBeNull();
    expect(r.lines).toHaveLength(2);
  });
  it('Qnty and Cmp name map; comma-space ref joins split', () => {
    expect(r.lines[0].qty).toBe(3);
    expect(r.lines[0].refs).toEqual(['R1', 'R2', 'R3']);
  });
});

describe('delimiter sniffing', () => {
  it('TSV with the kibot ${QUANTITY} spelling', () => {
    const r = parseBomText(TSV_KIBOT);
    expect(r.lines[0].qty).toBe(2);
    expect(r.lines[0].refs).toEqual(['R1', 'R2']);
  });
  it('semicolon with Comment as value', () => {
    const r = parseBomText(SEMICOLON_EU);
    expect(r.lines[0].value).toBe('10k');
  });
});

describe('JLCPCB style', () => {
  it('Comment is the value; LCSC Part # is distributor_pn', () => {
    const r = parseBomText(JLCPCB_STYLE);
    expect(r.lines[0].value).toBe('10k');
    expect(r.lines[0].distributorPn).toBe('C17414');
  });
});

describe('expandRefs', () => {
  it('prefix-aware ranges and both join regimes', () => {
    expect(expandRefs('R1-R3')).toEqual(['R1', 'R2', 'R3']);
    expect(expandRefs('R1, R2,R7')).toEqual(['R1', 'R2', 'R7']);
  });
  it('mismatched prefixes stay literal', () => {
    expect(expandRefs('R1-C3')).toEqual(['R1-C3']);
  });
});

describe('caps and warnings', () => {
  it('the 2000-line hard cap errors', () => {
    const rows = Array.from({ length: MAX_LINES + 1 }, (_, i) => `R${i},10k`).join('\n');
    const r = parseBomText(`Refs,Value\n${rows}\n`);
    expect(r.error).toMatch(/2[.,]?000/);
  });
  it('duplicate designators warn, never block', () => {
    const r = parseBomText('Refs,Value\nR1,10k\nR1,22k\n');
    expect(r.error).toBeNull();
    expect(r.warnings.join(' ')).toMatch(/R1/);
  });
});

describe('unmappable header opens the mapper, never an error', () => {
  it('reports every column unmapped with error null (spec section 9)', () => {
    const r = parseBomText('Alpha,Beta,Gamma\n1,2,3\n');
    expect(r.error).toBeNull();
    expect(r.lines).toEqual([]);
    expect(r.roleByColumn).toEqual([null, null, null]);
    expect(r.unmappedColumns).toEqual([0, 1, 2]);
  });
});

describe('parsePasteRows (the Mouser PART[ ,|]QTY grammar)', () => {
  it('splits on the first whitespace run', () => {
    const r = parsePasteRows('LM317T 4\n');
    expect(r.error).toBeNull();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ mpn: 'LM317T', qty: 4, refs: [], dnp: false });
  });
  it('splits on the first comma', () => {
    const r = parsePasteRows('LM317T,4\n');
    expect(r.lines[0]).toMatchObject({ mpn: 'LM317T', qty: 4 });
  });
  it('a bare part defaults to qty 1', () => {
    const r = parsePasteRows('LM317T\n');
    expect(r.lines[0]).toMatchObject({ mpn: 'LM317T', qty: 1 });
  });
});
