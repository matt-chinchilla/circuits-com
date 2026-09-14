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
// KiCad's Board Setup offers Mixed and Jumper beside Signal and Plane.
const MIXED: BoardStackup = {
  ...FULL,
  copperLayers: [
    { ordinal: 1, name: 'F.Cu', kind: 'Signal' }, { ordinal: 2, name: 'In1.Cu', kind: 'Mixed' },
    { ordinal: 3, name: 'In2.Cu', kind: 'Jumper' }, { ordinal: 4, name: 'B.Cu', kind: 'Signal' },
  ],
  layerCount: 4,
};
/** 6 measured rows at MIN_BAND 2, plus F.SilkS at HAIRLINE 1. */
const FLOORS = 13;

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
    expect(summarize(FULL)).toEqual({ total: 3, signal: 2, plane: 1, mixed: 0, jumper: 0, dielectric: 2, listed: '1.198 mm', design: '1.200 mm', thru: 40, blindBuried: 3, micro: 0, unknown: 1, finish: 'ENIG' });
    expect(summarize(BARE)).toMatchObject({ dielectric: 0, listed: null, design: '1.200 mm', finish: null });
  });
  it('accounts for the copper kinds that are neither signal nor plane', () => {
    const s = summarize(MIXED);
    expect([s.total, s.signal, s.plane, s.mixed, s.jumper]).toEqual([4, 2, 0, 1, 1]);
    expect(s.signal + s.plane + s.mixed + s.jumper).toBe(s.total);
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

describe('bands geometry', () => {
  it('fills the box exactly, floors every band, and keeps the file order contiguous', () => {
    for (const h of [240, 100, 26, 240.7, 199.33]) {
      const b = bands(FULL, h);
      expect(b[b.length - 1]!.y + b[b.length - 1]!.h).toBe(h);
      // Contiguous to the last drawable decimal. A seam is ONE accumulated
      // value, so the only difference is the sub-ULP of reading it back as
      // y + (bottom - y) — measured at 1.4e-14px on one seam of the 100px box.
      const seams = b.map((x, i) => (i === 0 ? 0 : Math.abs(x.y - (b[i - 1]!.y + b[i - 1]!.h))));
      expect(Math.max(...seams)).toBeLessThan(1e-9);
      expect(b.map((x) => x.name)).toEqual(FULL.stackup!.map((r) => r.name));
      expect(b[0]!.h).toBe(1);
      expect(Math.min(...b.slice(1).map((x) => x.h))).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps every row at its floor when the box is too small, absent, or not a number', () => {
    for (const h of [FLOORS, 12, 1, 0, -5, NaN, Infinity, -Infinity]) {
      const b = bands(FULL, h);
      expect(b[0]!.h).toBe(1);
      expect(b.slice(1).map((x) => x.h)).toEqual([2, 2, 2, 2, 2, 2]);
      expect(b[b.length - 1]!.y + b[b.length - 1]!.h).toBe(FLOORS);
    }
  });

  it('classifies each physical row so the cross-section can colour it', () => {
    expect(bands(FULL, 240).map((x) => x.kind)).toEqual(['other', 'mask', 'copper', 'dielectric', 'copper', 'dielectric', 'copper']);
    expect(bands(BARE, 240).map((x) => x.kind)).toEqual(['copper', 'copper', 'copper']);
  });
});

describe('viaSpans lanes', () => {
  it('numbers lanes by drawn order, so a group it cannot anchor leaves no empty lane', () => {
    const drawn = bands(FULL, 240);
    expect(viaSpans(FULL, drawn).map((v) => v.x)).toEqual([24, 42, 60]);
    const orphan: BoardStackup = {
      ...FULL,
      vias: [FULL.vias[0]!, { type: 'micro', start: 'In8.Cu', end: 'In9.Cu', count: 2 }, FULL.vias[1]!],
    };
    expect(viaSpans(orphan, drawn).map((v) => [v.type, v.x])).toEqual([['through', 24], ['blind', 42]]);
  });

  it('drops a via whose two ends land on the same band', () => {
    const same: BoardStackup = { ...FULL, vias: [{ type: 'through', start: 'F.Cu', end: 'F.Cu', count: 9 }] };
    expect(viaSpans(same, bands(same, 240))).toEqual([]);
  });
});

describe('formatMm', () => {
  it('never renders a non-finite figure as a number', () => {
    expect([formatMm(NaN), formatMm(Infinity), formatMm(-Infinity)]).toEqual(['—', '—', '—']);
    expect(formatMm(0)).toBe('0.0000');
  });
});
