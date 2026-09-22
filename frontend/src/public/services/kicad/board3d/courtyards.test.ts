import { describe, expect, it } from 'vitest';
import { fixtureText } from '../fixtures';
import { readBoardModel } from './readBoardModel';
import { courtyardOf, courtyards, estimateHeightMm } from './courtyards';
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
  it('the C at (127, 107.6, 90) has a closed courtyard placed around its centre', () => {
    const f = m.footprints.find((x) => x.place.at.x === 127 && x.place.at.y === 107.6)!;
    const c = courtyardOf(f, 0.01)!;
    const b = bbox(c.ring.pts);
    expect((b.min.x + b.max.x) / 2).toBeCloseTo(127, 2);
    expect((b.min.y + b.max.y) / 2).toBeCloseTo(107.6, 2);
    // a 0402 courtyard is ~1.86 × 0.94 mm; rotated 90° the long side runs along y
    expect(b.max.y - b.min.y).toBeGreaterThan(b.max.x - b.min.x);
    expect(signedArea(c.ring.pts)).toBeLessThan(0);   // outer orientation
    expect(c.heightMm).toBeGreaterThanOrEqual(0.6);
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
    const c = courtyardOf(f, 0.01)!;
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
});
