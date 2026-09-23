import { describe, expect, it } from 'vitest';
import { fixtureText } from '../fixtures';
import { readBoardModel } from './readBoardModel';
import { chipThicknessMm, courtyardOf, courtyards, estimateHeightMm } from './courtyards';
import { bbox, signedArea } from './geom';

describe('estimateHeightMm', () => {
  it('is monotone in area and clamped to [0.6, 12]', () => {
    expect(estimateHeightMm(0)).toBe(0.6);
    expect(estimateHeightMm(1.5)).toBeCloseTo(0.6, 6);           // 0402: 0.35·√1.5 = 0.43 → floor
    expect(estimateHeightMm(100)).toBeCloseTo(3.5, 6);
    expect(estimateHeightMm(10_000)).toBe(12);
  });
});

describe('courtyards on Glasgow', () => {
  const m = readBoardModel(fixtureText('glasgow-revC3/glasgow.kicad_pcb'), 0.01);
  it('264 closed courtyards (J4 closes within the 20 µm courtyard snap), 8 footprints without one', () => {
    const r = courtyards(m, 0.01);
    // 8 footprints (the logos, the kikit tabs) draw no courtyard at all. The 9th
    // is J4, whose four F.CrtYd lines miss each other by 8 µm at one corner —
    // 1.778 against 1.770 — so the courtyard is genuinely open and the part gets
    // no body rather than a guessed one.
    expect(r.bodies).toHaveLength(264);
    expect(r.missing).toBe(8);
    expect(m.footprints.filter((f) => f.courtyard.length === 0)).toHaveLength(8);
  });
  it('the package outline wins wherever it closes: more than 200 of the 264 bodies are Fab outlines', () => {
    const r = courtyards(m, 0.01);
    const fab = r.bodies.filter((b) => b.source === 'fab');
    expect(fab.length).toBeGreaterThan(200);
    // Every other body is its courtyard, and no part that draws no Fab
    // outline gets one.
    expect(r.bodies.filter((b) => b.source === 'courtyard')).toHaveLength(264 - fab.length);
    const noFab = new Set(m.footprints.filter((f) => f.fab.length === 0).map((f) => f.ref));
    for (const b of fab) expect(noFab.has(b.ref), b.ref).toBe(false);
    // The test points draw only a courtyard, and keep it.
    expect(r.bodies.find((b) => b.ref === 'TP5')?.source).toBe('courtyard');
  });
  it('the C at (127, 107.6, 90) is its 1.0 × 0.5 mm chip, placed around its centre, at the 0402 nominal thickness', () => {
    const f = m.footprints.find((x) => x.place.at.x === 127 && x.place.at.y === 107.6)!;
    const c = courtyardOf(f, 0.01)!;
    expect(c.source).toBe('fab');
    const b = bbox(c.ring.pts);
    expect((b.min.x + b.max.x) / 2).toBeCloseTo(127, 2);
    expect((b.min.y + b.max.y) / 2).toBeCloseTo(107.6, 2);
    // The Fab body of an 0402 is the chip itself, 1.0 × 0.5 mm; rotated 90°
    // the long side runs along y. (The courtyard was ~1.86 × 0.94.)
    expect(b.max.y - b.min.y).toBeCloseTo(1.0, 2);
    expect(b.max.x - b.min.x).toBeCloseTo(0.5, 2);
    expect(signedArea(c.ring.pts)).toBeLessThan(0);   // outer orientation
    expect(c.heightMm).toBe(0.35);
  });
  it('a part keeps the height its courtyard gave it; only chip passives take the table', () => {
    const r = courtyards(m, 0.01);
    const u30 = m.footprints.find((f) => f.ref === 'U30')!;
    const body = r.bodies.find((b) => b.ref === 'U30')!;
    const court = courtyardOf({ ...u30, fab: [] }, 0.01)!;
    expect(court.source).toBe('courtyard');
    expect(body.heightMm).toBe(court.heightMm);
    expect(body.areaMm2).toBeLessThan(court.areaMm2);
  });
});

describe('courtyards — which outline', () => {
  const fp = (fab: string, court: string) => readBoardModel([
    '(kicad_pcb (version 20221018) (generator pcbnew)',
    '(layers (0 "F.Cu" signal) (31 "B.Cu" signal))',
    `(footprint "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm" (layer "F.Cu") (at 10 10) (property "Reference" "U1") ${fab} ${court})`,
    ')',
  ].join('\n'), 0.01).footprints[0];
  const crt = '(fp_rect (start -3.7 -2.7) (end 3.7 2.7) (layer "F.CrtYd") (width 0.05))';
  it('a closed Fab outline wins over the courtyard', () => {
    const c = courtyardOf(fp('(fp_rect (start -1.95 -2.45) (end 1.95 2.45) (layer "F.Fab") (width 0.1))', crt), 0.01)!;
    expect(c.source).toBe('fab');
    expect(c.areaMm2).toBeCloseTo(3.9 * 4.9, 6);
    expect(c.heightMm).toBeCloseTo(estimateHeightMm(7.4 * 5.4), 9);
  });
  it('a Fab drawing that never closes, or closes only round a mark, leaves the courtyard', () => {
    const open = courtyardOf(fp('(fp_line (start -1.95 -2.45) (end 1.95 -2.45) (layer "F.Fab") (width 0.1))', crt), 0.01)!;
    expect(open.source).toBe('courtyard');
    const mark = courtyardOf(fp('(fp_circle (center -1.2 -1.7) (end -1 -1.7) (layer "F.Fab") (width 0.1))', crt), 0.01)!;
    expect(mark.source).toBe('courtyard');
  });
  it('with no courtyard at all, a Fab outline is the body and gives the height', () => {
    const c = courtyardOf(fp('(fp_rect (start -2 -2) (end 2 2) (layer "F.Fab") (width 0.1))', ''), 0.01)!;
    expect(c.source).toBe('fab');
    expect(c.heightMm).toBeCloseTo(estimateHeightMm(16), 9);
  });
  it('neither closes → no body', () => {
    expect(courtyardOf(fp('', ''), 0.01)).toBeNull();
  });
});

describe('chipThicknessMm', () => {
  it('reads the imperial size code of a chip passive, first token first', () => {
    expect(chipThicknessMm('Capacitor_SMD:C_0402_1005Metric')).toBe(0.35);
    expect(chipThicknessMm('Resistor_SMD:R_0603_1608Metric')).toBe(0.45);
    expect(chipThicknessMm('Glasgow:R_0603_1608Metric_DNP')).toBe(0.45);
    expect(chipThicknessMm('Inductor_SMD:L_0402_1005Metric')).toBe(0.35);
    expect(chipThicknessMm('Capacitor_SMD:C_0201_0603Metric')).toBe(0.3);
    expect(chipThicknessMm('Capacitor_SMD:C_0805_2012Metric')).toBe(0.6);
    expect(chipThicknessMm('Resistor_SMD:R_1206_3216Metric')).toBe(0.7);
  });
  it('an array, an LED of the same size and an electrolytic are not chips', () => {
    expect(chipThicknessMm('Glasgow:R_Array_Convex_4x0402')).toBeNull();
    expect(chipThicknessMm('LED_SMD:LED_0603_1608Metric')).toBeNull();
    expect(chipThicknessMm('Capacitor_SMD:CP_Elec_6.3x5.9')).toBeNull();
    expect(chipThicknessMm('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm')).toBeNull();
  });
});

describe('courtyards — StickHub back side', () => {
  const stickhub = readBoardModel(fixtureText('kicad-demos/stickhub/StickHub.kicad_pcb'), 0.01);
  it('back-side courtyards are placed without a second mirror (the file saves them flipped)', () => {
    // C38's courtyard rect is off-centre in y, so a mirror would move it.
    const f = stickhub.footprints.find((x) => x.ref === 'C38')!;
    expect(f.place.side).toBe('B');
    const r = f.courtyard.find((sh) => sh.kind === 'rect');
    if (r == null || r.kind !== 'rect') throw new Error('C38 has no courtyard rect');
    expect(Math.abs(r.a.y + r.b.y)).toBeGreaterThan(0.2);
    // The courtyard path, on purpose: with its Fab drawing set aside the body
    // IS the courtyard, whose off-centre rect is what a mirror would move.
    const c = courtyardOf({ ...f, fab: [] }, 0.01)!;
    expect(c.source).toBe('courtyard');
    expect(c.side).toBe('B');
    const t = (f.place.rotDeg * Math.PI) / 180;
    const turn = (p: { x: number; y: number }) => ({
      x: p.x * Math.cos(t) + p.y * Math.sin(t) + f.place.at.x,
      y: -p.x * Math.sin(t) + p.y * Math.cos(t) + f.place.at.y,
    });
    const corners = [r.a, { x: r.b.x, y: r.a.y }, r.b, { x: r.a.x, y: r.b.y }].map(turn);
    for (const e of corners) {
      expect(Math.min(...c.ring.pts.map((q) => Math.hypot(q.x - e.x, q.y - e.y)))).toBeLessThan(0.03);
    }
  });
  it('its Fab body is the package even where that is not inside the courtyard: a can lying over the board edge', () => {
    // C38 is `CP_Elec_6.3x11_Board_Edge_Mirrored`: an electrolytic laid on
    // its side, hanging 11.5 mm past the board edge, with a courtyard only
    // round its solder pads. The Fab drawing is the can, and it is placed
    // with the same rigid motion (no mirror).
    const f = stickhub.footprints.find((x) => x.ref === 'C38')!;
    const body = courtyardOf(f, 0.01)!, court = courtyardOf({ ...f, fab: [] }, 0.01)!;
    expect(body.source).toBe('fab');
    const b = bbox(body.ring.pts), k = bbox(court.ring.pts);
    expect(b.max.x - b.min.x).toBeCloseTo(6.3, 6);
    expect(b.max.y - b.min.y).toBeCloseTo(11.5, 6);
    // The courtyard is on one side of the footprint origin (y = 80), the can on the other.
    expect(k.min.y).toBeCloseTo(80, 6);
    expect(b.max.y).toBeCloseTo(80, 6);
  });
});
