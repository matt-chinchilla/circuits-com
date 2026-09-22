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
  it('263 closed courtyards, 9 footprints without one', () => {
    const r = courtyards(m, 0.01);
    // 8 footprints (the logos, the kikit tabs) draw no courtyard at all. The 9th
    // is J4, whose four F.CrtYd lines miss each other by 8 µm at one corner —
    // 1.778 against 1.770 — so the courtyard is genuinely open and the part gets
    // no body rather than a guessed one.
    expect(r.bodies).toHaveLength(263);
    expect(r.missing).toBe(9);
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
  it('back-side courtyards are mirrored', () => {
    const f = m.footprints.find((x) => x.place.side === 'B' && x.courtyard.length >= 4)!;
    const c = courtyardOf(f, 0.01)!;
    expect(c.side).toBe('B');
    expect(Math.abs(signedArea(c.ring.pts))).toBeGreaterThan(0);
  });
});
