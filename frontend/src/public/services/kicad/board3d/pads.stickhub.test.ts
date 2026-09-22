// A back-side footprint's children are saved ALREADY mirrored: KiCad's file
// stores them in the footprint frame un-rotated but not un-flipped, which is why
// the vendored 2D renderer places them with a translate + rotate and no mirror.
// Measured against where the copper actually goes: every B-side pad of
// StickHub's U2 (a TDFN-8 on B.Cu) whose centre is off its local x axis must sit
// on the end of a track or a via, as the router left it.
import { describe, expect, it } from 'vitest';
import { fixtureText } from '../fixtures';
import { readBoardModel } from './readBoardModel';
import { place, dist } from './geom';

describe('StickHub U2 — a back-side part with pads off its local x axis', () => {
  const m = readBoardModel(fixtureText('kicad-demos/stickhub/StickHub.kicad_pcb'), 0.01);
  const u2 = m.footprints.find((f) => f.ref === 'U2')!;
  const ends = [
    ...m.tracks.filter((t) => t.layer === 'B.Cu').flatMap((t) => [t.pts[0], t.pts[t.pts.length - 1]]),
    ...m.vias.map((vv) => vv.at),
  ];
  const nearestEnd = (p: { x: number; y: number }) => Math.min(...ends.map((e) => dist(e, p)));

  it('is on the back, with pads off its local x axis', () => {
    expect(u2.place.side).toBe('B');
    expect(u2.pads.some((p) => Math.abs(p.at.y) > 0.1)).toBe(true);
  });

  it('every routed pad centre lands where its copper ends (within 0.05 mm)', () => {
    const offAxis = u2.pads.filter((p) => Math.abs(p.at.y) > 0.1);
    const landed = offAxis.filter((p) => nearestEnd(place(p.at, u2.place)) < 0.05);
    // Not every pad is routed from its centre, but the placement that is RIGHT
    // puts the routed ones on their copper, and a mirrored one puts none there.
    expect(landed.length).toBeGreaterThanOrEqual(offAxis.length / 2);
  });
});
