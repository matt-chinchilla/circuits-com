import { describe, expect, it } from 'vitest';
import type { ParsedBomLine } from '@public/services/bom/bomLines';
import type { BomOffer, TableRow } from '@public/services/bom/types';
import type { FootprintPlacement } from '@public/services/kicad/boardPlacements';
import { footprintName, formatMm, knownRefs, partFacts, resolveRef, type PartSources } from './partFacts';

const line = (index: number, refs: string[], over: Partial<ParsedBomLine> = {}): ParsedBomLine => ({
  index, mpn: null, value: null, footprint: null, description: null, manufacturer: null, distributorPn: null,
  qty: refs.length, refs, dnp: false, ...over,
});

const offer = (id: string, name: string, price: number, stock: number, tier: string | null = null): BomOffer => ({
  supplier_id: id, supplier_name: name, supplier_website: null, tier, currency: 'USD',
  unit_price: price, stock_quantity: stock, breaks: [{ min_quantity: 10, unit_price: price / 2 }],
});

const row = (l: ParsedBomLine, over: Partial<TableRow> = {}): TableRow => ({
  ...l,
  server: {
    index: l.index, status: 'exact', approx_reason: null, package_warning: null, resolve_query: null,
    part: { id: 'id-1', sku: 'ICE40HX8K-BG121', slug: 'ice40hx8k-bg121', manufacturer_name: 'Lattice', description: 'FPGA', package: 'BGA', lifecycle_status: 'active', lifecycle_verified: true, image_url: null, datasheet_url: null },
    recommended_supplier_id: null,
    offers: [offer('s1', 'Mouser', 20, 500), offer('s2', 'DigiKey', 18, 0)],
    similar: [],
  },
  state: 'matched', viewerHref: null, ...over,
});

const placement = (ref: string, over: Partial<FootprintPlacement> = {}): FootprintPlacement => ({
  ref, lib: 'Package_BGA:BGA-121', value: 'from-board', side: 'F', x: 83.7, y: 95.5, rotDeg: -90, ...over,
});

const U30 = line(0, ['U30'], { value: 'ICE40HX8K-BG121', footprint: 'Package_BGA:BGA-121_9x9', mpn: 'ICE40HX8K-BG121' });
const CAPS = line(1, ['C1', 'C2', 'C3'], { value: '100n', footprint: 'Capacitor_SMD:C_0402' });

const sources = (over: Partial<PartSources> = {}): PartSources => ({
  lines: [U30, CAPS],
  rows: [],
  refs: new Map([['U30', { sheet: 'glasgow.kicad_sch', instancePath: '/r' }], ['C1', { sheet: 'io_banks.kicad_sch', instancePath: '/r/a' }]]),
  placements: new Map([['U30', placement('U30')], ['H1', placement('H1', { lib: 'MountingHole:M3', value: null, side: 'B' })]]),
  buildQty: 1,
  ...over,
});

describe('partFacts', () => {
  it('assembles identity, sheet and position for a part every source knows', () => {
    const f = partFacts('U30', sources());
    expect(f.found).toBe(true);
    expect(f.value).toBe('ICE40HX8K-BG121');
    expect(f.footprint).toBe('Package_BGA:BGA-121_9x9');
    expect(f.mpn).toBe('ICE40HX8K-BG121');
    expect(f.sheet).toBe('glasgow.kicad_sch');
    expect(f.instancePath).toBe('/r');
    expect(f.placement).toMatchObject({ side: 'F', x: 83.7, y: 95.5, rotDeg: -90 });
    expect(f.siblings).toEqual([]);
    expect(f.priced).toBe(false);
    expect(f.catalog).toBeNull();
    expect(f.price).toBeNull();
  });

  it('names the siblings on a shared line and leaves the position null without a board', () => {
    const f = partFacts('C2', sources({ placements: null }));
    expect(f.line?.qty).toBe(3);
    expect(f.siblings).toEqual(['C1', 'C3']);
    expect(f.placement).toBeNull();
    // C2 has no RefLocation of its own — the reader records the line's first.
    expect(f.sheet).toBeNull();
  });

  it('a footprint the schematic never lists is still found, with the board’s own facts', () => {
    const f = partFacts('H1', sources());
    expect(f.found).toBe(true);
    expect(f.line).toBeNull();
    expect(f.value).toBeNull();
    expect(f.footprint).toBe('MountingHole:M3');
    expect(f.placement?.side).toBe('B');
  });

  it('is honest about a designator nobody knows', () => {
    const f = partFacts('U99', sources());
    expect(f.found).toBe(false);
    expect(f.value).toBeNull();
    expect(f.placement).toBeNull();
  });

  it('reads the catalog match and the price the BOM table would show, at the table’s quantity', () => {
    const rows = [row(U30)];
    const f = partFacts('U30', sources({ rows, buildQty: 10 }));
    expect(f.priced).toBe(true);
    expect(f.catalog).toEqual({
      sku: 'ICE40HX8K-BG121', path: '/part/ice40hx8k-bg121', manufacturer: 'Lattice', description: 'FPGA', lifecycle: 'active', match: 'exact',
    });
    // Line qty 1 × build 10 = 10 → the 10+ break of the cheapest IN-STOCK offer
    // (DigiKey is cheaper but has nothing on the shelf, exactly as the table rules).
    expect(f.price).toEqual({ unit: 10, lineQty: 10, supplier: 'Mouser', stock: 500 });
  });

  it('a priced BOM whose line had no match says so, and a resolving line says it is waiting', () => {
    const noMatch = row(CAPS, { server: null, state: 'not_found' });
    const f = partFacts('C1', sources({ rows: [noMatch] }));
    expect(f.priced).toBe(true);
    expect(f.catalog).toBeNull();
    expect(f.price).toBeNull();
    expect(f.resolving).toBe(false);
    const waiting = row(CAPS, { state: 'resolving' });
    expect(partFacts('C1', sources({ rows: [waiting] })).resolving).toBe(true);
  });

  it('prefers the part page slug and falls back to the id', () => {
    const r = row(U30);
    r.server!.part!.slug = null;
    expect(partFacts('U30', sources({ rows: [r] })).catalog?.path).toBe('/part/id-1');
  });
});

describe('resolveRef and knownRefs', () => {
  it('resolves an exact designator, then a case-insensitive one, then nothing', () => {
    const known = ['U30', 'c1', 'C1'];
    expect(resolveRef(' U30 ', known)).toBe('U30');
    expect(resolveRef('u30', known)).toBe('U30');
    // Exact spelling wins over the earlier loose match.
    expect(resolveRef('C1', known)).toBe('C1');
    expect(resolveRef('c1', known)).toBe('c1');
    expect(resolveRef('R9', known)).toBeNull();
    expect(resolveRef('   ', known)).toBeNull();
  });
  it('lists every designator once, from lines, then the sheet index, then the board', () => {
    expect(knownRefs(sources())).toEqual(['U30', 'C1', 'C2', 'C3', 'H1']);
    expect(knownRefs(sources({ placements: null }))).toEqual(['U30', 'C1', 'C2', 'C3']);
  });
});

describe('formatting', () => {
  it('strips the library from a footprint and trims trailing zeros from millimetres', () => {
    expect(footprintName('Package_SO:SOIC-8_3.9x4.9mm')).toBe('SOIC-8_3.9x4.9mm');
    expect(footprintName('SOIC-8')).toBe('SOIC-8');
    expect(formatMm(83.7)).toBe('83.7');
    expect(formatMm(95.5)).toBe('95.5');
    expect(formatMm(100)).toBe('100');
    expect(formatMm(0.1234)).toBe('0.123');
  });
});
