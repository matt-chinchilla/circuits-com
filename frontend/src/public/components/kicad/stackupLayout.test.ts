import { describe, expect, it } from 'vitest';
import type { BoardStackup } from '@public/services/kicad/types';
import { bands, formatMm, summarize, tableRows, viaSpans } from './stackupLayout';

const FULL: BoardStackup = {
  copperLayers: [{ ordinal: 1, name: 'F.Cu', kind: 'Signal' }, { ordinal: 2, name: 'In1.Cu', kind: 'Plane' }, { ordinal: 3, name: 'B.Cu', kind: 'Signal' }],
  stackup: [
    { name: 'F.SilkS', type: 'Top Silk Screen', thicknessMm: null, material: null, epsilonR: null, lossTangent: null },
    { name: 'F.Mask', type: 'Top Solder Mask', thicknessMm: 0.01, material: null, epsilonR: null, lossTangent: null },
    { name: 'F.Cu', type: 'copper', thicknessMm: 0.035, material: null, epsilonR: null, lossTangent: null },
    { name: 'dielectric 1', type: 'prepreg', thicknessMm: 0.1, material: 'FR4', epsilonR: 4.5, lossTangent: 0.02 },
    { name: 'In1.Cu', type: 'copper', thicknessMm: 0.018, material: null, epsilonR: null, lossTangent: null },
    { name: 'dielectric 2', type: 'core', thicknessMm: 1.0, material: 'FR4', epsilonR: 4.5, lossTangent: 0.02 },
    { name: 'B.Cu', type: 'copper', thicknessMm: 0.035, material: null, epsilonR: null, lossTangent: null },
  ],
  copperFinish: 'ENIG',
  listedThicknessMm: 1.198,
  designThicknessMm: 1.2,
  vias: [{ type: 'through', start: 'F.Cu', end: 'B.Cu', count: 40 }, { type: 'blind', start: 'F.Cu', end: 'In1.Cu', count: 3 }, { type: 'unknown', start: 'F.Cu', end: 'B.Cu', count: 1 }],
  layerCount: 3,
};
const BARE: BoardStackup = { ...FULL, stackup: null, copperFinish: null, listedThicknessMm: null };

describe('tableRows', () => {
  it('renders the physical stack in file order with copper ordinals joined by name', () => {
    expect(tableRows(FULL).map((r) => [r.ordinal, r.layer, r.type, r.thk])).toEqual([
      ['-', 'F.SilkS', 'Top Silk Screen', '—'], ['-', 'F.Mask', 'Top Solder Mask', '0.0100'], ['1', 'F.Cu', 'Signal', '0.0350'],
      ['-', 'dielectric 1', 'prepreg', '0.1000'], ['2', 'In1.Cu', 'Plane', '0.0180'], ['-', 'dielectric 2', 'core', '1.0000'], ['3', 'B.Cu', 'Signal', '0.0350'],
    ]);
  });
  it('degrades to the copper rows alone when the board has no stackup block', () => {
    expect(tableRows(BARE).map((r) => [r.ordinal, r.layer, r.type, r.thk])).toEqual([['1', 'F.Cu', 'Signal', '—'], ['2', 'In1.Cu', 'Plane', '—'], ['3', 'B.Cu', 'Signal', '—']]);
  });
});

describe('summarize', () => {
  it('counts what the file carries and labels the two thicknesses separately', () => {
    expect(summarize(FULL)).toEqual({ total: 3, signal: 2, plane: 1, dielectric: 2, listed: '1.198 mm', design: '1.200 mm', thru: 40, blindBuried: 3, micro: 0, unknown: 1, finish: 'ENIG' });
    expect(summarize(BARE)).toMatchObject({ dielectric: 0, listed: null, design: '1.200 mm', finish: null });
  });
});

describe('bands and viaSpans', () => {
  it('scales thicknesses to the height, gives thickness-less rows a hairline, and spans vias between real layers', () => {
    const b = bands(FULL, 240);
    expect(b).toHaveLength(7);
    expect(b[0]).toMatchObject({ name: 'F.SilkS', kind: 'other', h: 1 });
    expect(b.find((x) => x.name === 'dielectric 2')?.h).toBeGreaterThan(b.find((x) => x.name === 'F.Cu')?.h ?? 0);
    expect(b[b.length - 1]!.y + b[b.length - 1]!.h).toBeLessThanOrEqual(240);
    const spans = viaSpans(FULL, b);
    expect(spans.map((s) => [s.type, s.count])).toEqual([['through', 40], ['blind', 3], ['unknown', 1]]);
    const through = spans[0]!;
    expect(through.y1).toBeLessThan(through.y2);
    expect(viaSpans(BARE, bands(BARE, 240))).toHaveLength(3);
  });
});

describe('formatMm', () => {
  it('prints four decimals or an em dash', () => {
    expect(formatMm(0.035)).toBe('0.0350');
    expect(formatMm(null)).toBe('—');
  });
});
