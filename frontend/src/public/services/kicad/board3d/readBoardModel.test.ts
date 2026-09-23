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
  it('reads the package drawing on the footprint\'s own Fab layer, footprint-local', () => {
    const f = m.footprints.find((x) => x.place.at.x === 127 && x.place.at.y === 107.6)!;
    // A C_0402's Fab body is the 1.0 × 0.5 mm chip, drawn around the origin
    // BEFORE placement (the footprint sits at (127, 107.6)).
    expect(f.fab.length).toBeGreaterThanOrEqual(4);
    for (const sh of f.fab) if (sh.kind === 'line') expect(Math.abs(sh.a.x) + Math.abs(sh.a.y)).toBeLessThan(2);
    // Back-side parts read B.Fab: 80 of Glasgow's 94 draw there. The 31 on
    // the board that draw nothing on Fab are test points, mounting holes,
    // logos and the kikit tabs — none of them a package.
    const back = m.footprints.filter((x) => x.place.side === 'B');
    expect(back.filter((x) => x.fab.length > 0)).toHaveLength(80);
    expect(m.footprints.filter((x) => x.fab.length > 0)).toHaveLength(241);
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
  it('reads Fab drawings in the KiCad 9 dialect on both sides', () => {
    expect(m.footprints.filter((f) => f.fab.length > 0).length).toBeGreaterThan(70);
    expect(m.footprints.some((f) => f.place.side === 'B' && f.fab.length > 0)).toBe(true);
  });
  it('the long Fabrication layer name is the same layer', () => {
    const board = [
      '(kicad_pcb (version 20240108) (generator pcbnew)',
      '(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (49 "F.Fab" user "F.Fabrication"))',
      '(footprint "x" (layer "F.Cu") (at 5 5) (property "Reference" "R1")',
      '  (fp_rect (start -1 -0.5) (end 1 0.5) (layer "F.Fabrication") (width 0.1))',
      '  (fp_line (start -1 -0.5) (end 1 -0.5) (layer "F.Fab") (width 0.1))',
      '  (fp_line (start -1 -0.5) (end 1 -0.5) (layer "B.Fab") (width 0.1)))',
      ')',
    ].join('\n');
    const fp = readBoardModel(board, 0.01).footprints[0];
    expect(fp.fab.map((sh) => sh.kind)).toEqual(['rect', 'line']);
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
  it('panel: the copper pour is filled (3 polygons); its unfilled zones are all on B.Mask, so none counts; 84 edge items', () => {
    const m = panel();
    expect(m.zones).toHaveLength(3);
    // The four zones with `(fill yes)` and nothing filled are `(layer "B.Mask")`
    // — not copper pours, and never drawn — so "N copper pours were saved
    // unfilled" would be false about this board.
    expect(m.zonesUnfilled).toBe(0);
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

describe('readBoardModel — zones and the layer table', () => {
  const head = '(kicad_pcb (version 20221018) (generator pcbnew)\n';
  it('counts an unfilled zone only when it is on copper', () => {
    const board = head + [
      '(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (38 "B.Mask" user))',
      '(zone (net 0) (layer "B.Mask") (fill yes) (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))',
      '(zone (net 0) (layers "F&B.Cu") (fill yes) (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))',
      ')',
    ].join('\n');
    expect(readBoardModel(board, 0.01).zonesUnfilled).toBe(1);
  });
  it('refuses a copper-layer table past KiCad\'s 32', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `(${i} "In${i}.Cu" signal)`).join(' ');
    expect(() => readBoardModel(head + `(layers ${rows})\n)`, 0.01)).toThrow(KicadReadError);
  });
  it('refuses a layer table past 128 rows', () => {
    const rows = Array.from({ length: 200 }, (_, i) => `(${i} "User.${i}" user)`).join(' ');
    expect(() => readBoardModel(head + `(layers ${rows})\n)`, 0.01)).toThrow(/at most 128/);
  });
});

describe('readBoardModel — a footprint\'s own Edge.Cuts', () => {
  it('joins the board edge, placed with the footprint', () => {
    // An outline footprint at (50, 40) turned 90°: its 20 × 10 rect becomes a
    // 10 × 20 box around the footprint's origin on the board.
    const board = [
      '(kicad_pcb (version 20221018) (generator pcbnew)',
      '(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))',
      '(footprint "outline" (layer "F.Cu") (at 50 40 90) (property "Reference" "BRD1")',
      '  (fp_rect (start -10 -5) (end 10 5) (layer "Edge.Cuts") (width 0.1)))',
      ')',
    ].join('\n');
    const m = readBoardModel(board, 0.01);
    expect(m.edgeItems).toHaveLength(1);
    const e = m.edgeItems[0];
    if (e.kind !== 'poly') throw new Error('a turned rect is placed as a poly');
    const xs = e.pts.map((p) => p.x), ys = e.pts.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20, 6);
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(50, 6);
    expect((Math.max(...ys) + Math.min(...ys)) / 2).toBeCloseTo(40, 6);
  });
});

describe('readBoardModel — nets', () => {
  const m = glasgow();
  it('the table: 251 nets (the file writes 252 rows; net 0 is "no net")', () => {
    expect(m.nets).toHaveLength(251);
    expect(m.nets.map((n) => n.number)).toEqual(Array.from({ length: 251 }, (_, i) => i + 1));
    expect(m.nets.find((n) => n.number === 3)).toEqual({ number: 3, name: 'GND' });
  });
  it('a known pad: C30 pad 1 is +3V3 (net 2), pad 2 is GND (net 3)', () => {
    const c30 = m.footprints.find((f) => f.ref === 'C30')!;
    expect(c30.pads.map((p) => [p.number, p.net])).toEqual([['1', 2], ['2', 3]]);
    expect(m.nets.find((n) => n.number === 2)?.name).toBe('+3V3');
  });
  it('vias, segments and zones carry their (net N)', () => {
    expect(m.vias.find((v) => v.at.x === 77.4 && v.at.y === 106.700098)?.net).toBe(1);
    expect(m.tracks.find((t) => t.pts[0].x === 73.875 && t.pts[0].y === 106.725)?.net).toBe(1);
    // `(zone (net 200) (net_name "Net-(R6-Pad1)") …)` — every fill of it is net 200.
    expect(m.zones.some((z) => z.net === 200)).toBe(true);
    expect(m.nets.find((n) => n.number === 200)?.name).toBe('Net-(R6-Pad1)');
  });
  it('every net an item carries is 0 or a row of the table', () => {
    const known = new Set(m.nets.map((n) => n.number));
    const all = [
      ...m.footprints.flatMap((f) => f.pads.map((p) => p.net)),
      ...m.vias.map((v) => v.net), ...m.tracks.map((t) => t.net), ...m.zones.map((z) => z.net),
    ];
    expect(all.every((n) => n === 0 || known.has(n))).toBe(true);
    // Nearly all copper is on a net; the exceptions are logos and mounting holes.
    expect(all.filter((n) => n !== 0).length).toBeGreaterThan(all.length * 0.9);
  });
  it('StickHub: an arc track carries its net (KiCad 9 multi-line dialect)', () => {
    const s = stickhub();
    expect(s.nets).toHaveLength(47);
    const arc = s.tracks.find((t) => t.pts.length > 2 && Math.abs(t.pts[0].x - 152.494224) < 1e-6)!;
    expect(arc.net).toBe(2);
  });
  it('an item with no (net …) is net 0; a writer that NAMES its nets is resolved by name', () => {
    const board = [
      '(kicad_pcb (version 20250907) (generator pcbnew)',
      '(layers (0 "F.Cu" signal) (2 "B.Cu" signal))',
      '(net 0 "") (net 1 "GND")',
      '(segment (start 0 0) (end 1 0) (width 0.2) (layer "F.Cu"))',
      '(segment (start 0 1) (end 1 1) (width 0.2) (layer "F.Cu") (net "GND"))',
      '(segment (start 0 2) (end 1 2) (width 0.2) (layer "F.Cu") (net "VBUS"))',
      '(segment (start 0 3) (end 1 3) (width 0.2) (layer "F.Cu") (net "VBUS"))',
      ')',
    ].join('\n');
    const b = readBoardModel(board, 0.01);
    expect(b.tracks.map((t) => t.net)).toEqual([0, 1, 2, 2]);
    expect(b.nets).toEqual([{ number: 1, name: 'GND' }, { number: 2, name: 'VBUS' }]);
  });
});
