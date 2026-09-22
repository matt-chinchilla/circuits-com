import { describe, expect, it } from 'vitest';
import { fixtureText } from '../fixtures';
import { readBoardModel } from './readBoardModel';
import { KicadReadError } from '../types';

const glasgow = () => readBoardModel(fixtureText('glasgow-revC3/glasgow.kicad_pcb'), 0.01);
const stickhub = () => readBoardModel(fixtureText('kicad-demos/stickhub/StickHub.kicad_pcb'), 0.01);
const panel = () => readBoardModel(fixtureText('bad-thing-panel/panel.kicad_pcb'), 0.01);
const hier = () => readBoardModel(fixtureText('kicad-demos/complex_hierarchy/complex_hierarchy.kicad_pcb'), 0.01);

describe('readBoardModel — Glasgow revC3 (KiCad 6)', () => {
  const m = glasgow();
  it('counts', () => {
    expect(m.version).toBe(20221018);
    expect(m.footprints).toHaveLength(272);
    expect(m.footprints.reduce((n, f) => n + f.pads.length, 0)).toBe(1149);
    expect(m.vias).toHaveLength(416);
    expect(m.tracks).toHaveLength(4715);
    expect(m.zones).toHaveLength(32);
    expect(m.zonesUnfilled).toBe(0);
    expect(m.edgeItems).toHaveLength(8);
  });
  it('layers carry kinds and sides', () => {
    expect(m.layers.filter((l) => l.kind === 'copper').map((l) => l.name)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    expect(m.layers.find((l) => l.name === 'Edge.Cuts')?.kind).toBe('edge');
    expect(m.layers.find((l) => l.name === 'F.CrtYd')?.kind).toBe('courtyard');
  });
  it('sides: 178 front, 94 back', () => {
    expect(m.footprints.filter((f) => f.place.side === 'F')).toHaveLength(178);
    expect(m.footprints.filter((f) => f.place.side === 'B')).toHaveLength(94);
  });
  it('a known footprint: C at (127, 107.6, 90) with two roundrect pads and a courtyard', () => {
    const f = m.footprints.find((x) => x.place.at.x === 127 && x.place.at.y === 107.6)!;
    expect(f.lib).toBe('Capacitor_SMD:C_0402_1005Metric');
    expect(f.place.rotDeg).toBe(90);
    expect(f.pads[0]).toMatchObject({ number: '1', kind: 'smd', shape: 'roundrect', rratio: 0.25, size: { x: 0.59, y: 0.64 } });
    expect(f.courtyard.length).toBeGreaterThanOrEqual(4);
  });
  it('pad wildcards expand to the board layers', () => {
    const tht = m.footprints.flatMap((f) => f.pads).find((p) => p.kind === 'thru_hole')!;
    // The first through-hole pad in the file states `(layers "*.Cu")` alone.
    expect(tht.layers).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    expect(tht.drill).not.toBeNull();
    // `(layers "*.Cu" "*.Mask" "F.Paste")` expands both wildcards and keeps the literal.
    const masked = m.footprints.flatMap((f) => f.pads).find((p) => p.layers.includes('F.Paste') && p.kind === 'thru_hole')!;
    expect(masked.layers).toEqual(expect.arrayContaining(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu', 'F.Mask', 'B.Mask', 'F.Paste']));
  });
  it('drill slots are read', () => {
    const slot = m.footprints.flatMap((f) => f.pads).find((p) => p.drill?.slotW != null)!;
    expect(slot.drill).toEqual({ d: 0.6, slotW: 0.6, slotH: 1.7 });
  });
  it('a via: (at 77.4 106.700098) (size 0.6) (drill 0.3) F.Cu→B.Cu', () => {
    expect(m.vias.find((v) => v.at.x === 77.4)).toMatchObject({ size: 0.6, drill: 0.3, layers: ['F.Cu', 'B.Cu'] });
  });
  it('references come from fp_text', () => {
    expect(m.footprints.some((f) => f.ref === 'TP5')).toBe(true);
    expect(m.footprints.filter((f) => f.ref === '')).toHaveLength(0);
  });
  it('reads Glasgow in under 400 ms', () => {
    const t0 = performance.now();
    glasgow();
    expect(performance.now() - t0).toBeLessThan(400);
  });
});

describe('readBoardModel — StickHub (KiCad 9 dialect)', () => {
  const m = stickhub();
  it('references come from (property "Reference")', () => {
    expect(m.footprints.some((f) => f.ref === 'D4')).toBe(true);
    expect(m.footprints.some((f) => f.ref === 'J7')).toBe(true);
  });
  it('180 arc tracks are flattened, none degenerate', () => {
    expect(m.tracks.filter((t) => t.pts.length > 2)).toHaveLength(180);
    expect(m.warnings.find((w) => w.kind === 'arc-degenerate')).toBeUndefined();
  });
  it('the custom pad falls back to its anchor size', () => {
    const c = m.footprints.flatMap((f) => f.pads).find((p) => p.shape === 'custom')!;
    expect(c.kind).toBe('connect');
    expect(c.size.x).toBeGreaterThan(0);
  });
  it('counts', () => {
    expect(m.footprints).toHaveLength(94);
    expect(m.footprints.reduce((n, f) => n + f.pads.length, 0)).toBe(278);
    expect(m.edgeItems).toHaveLength(20);
  });
});

describe('readBoardModel — the panel (no stackup) and complex_hierarchy', () => {
  it('panel: 6 pours, 2 of them filled into 3 polygons → 4 unfilled; 84 edge items', () => {
    const m = panel();
    expect(m.zones).toHaveLength(3);
    expect(m.zonesUnfilled).toBe(4);
    expect(m.edgeItems).toHaveLength(84);
  });
  it('complex_hierarchy: 165 THT pads, all drilled', () => {
    const m = hier();
    const pads = m.footprints.flatMap((f) => f.pads);
    expect(pads).toHaveLength(165);
    expect(pads.every((p) => p.kind === 'thru_hole' && p.drill != null)).toBe(true);
  });
});

describe('readBoardModel — errors', () => {
  it('refuses a non-board and a truncated board with KicadReadError', () => {
    expect(() => readBoardModel('(kicad_sch (version 1))', 0.01)).toThrow(KicadReadError);
    const t = fixtureText('glasgow-revC3/glasgow.kicad_pcb');
    expect(() => readBoardModel(t.slice(0, 200000), 0.01)).toThrow(KicadReadError);
  });
});
