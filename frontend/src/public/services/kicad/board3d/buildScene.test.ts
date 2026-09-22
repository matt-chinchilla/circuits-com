import { describe, expect, it } from 'vitest';
import { fixtureText } from '../fixtures';
import { readStackup } from '../boardStackup';
import { buildScene, transferList } from './buildScene';

const load = (rel: string, quality: 'full' | 'reduced' = 'full') => {
  const text = fixtureText(rel);
  let stackup = null; try { stackup = readStackup(text); } catch { stackup = null; }
  return buildScene({ text, stackup, quality });
};

describe('buildScene — Glasgow', () => {
  const s = load('glasgow-revC3/glasgow.kicad_pcb');
  it('reports honest thickness, bounds and stats', () => {
    expect(s.thicknessMm).toBeCloseTo(1.6, 6);
    expect(s.bounds.max.x - s.bounds.min.x).toBeCloseTo(80, 0);
    expect(s.bounds.max.y - s.bounds.min.y).toBeCloseTo(49, 0);
    expect(s.stats).toMatchObject({ footprints: 272, pads: 1149, vias: 416, tracks: 4715 });
    expect(s.stats.triangles).toBeGreaterThan(20_000);
    expect(s.stats.buildMs).toBeLessThan(3000);
  });
  it('has one group per material/layer, at most a dozen', () => {
    const keys = s.groups.map((g) => `${g.material}/${g.layerName}`);
    expect(keys).toEqual(expect.arrayContaining(['substrate/null', 'hole-wall/null', 'copper/F.Cu', 'copper/B.Cu', 'mask/F.Mask', 'mask/B.Mask', 'silk/F.SilkS', 'body/null']));
    expect(s.groups.length).toBeLessThanOrEqual(12);
    for (const g of s.groups) {
      expect(g.positions.length % 3).toBe(0);
      expect(g.normals.length).toBe(g.positions.length);
      // The largest index, in ONE assertion: an expect() per index is ~700k calls on
      // Glasgow and times the test out at 5 s. Same guarantee, 1,000x the speed.
      let max = -1;
      for (const i of g.indices) if (i > max) max = i;
      expect(max, `${g.material}/${g.layerName} index range`).toBeLessThan(g.positions.length / 3);
    }
  });
  it('is centred on the origin with y flipped', () => {
    const sub = s.groups.find((g) => g.material === 'substrate')!;
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < sub.positions.length; i += 3) { minX = Math.min(minX, sub.positions[i]); maxX = Math.max(maxX, sub.positions[i]); }
    expect(minX + maxX).toBeCloseTo(0, 3);
  });
  it('warnings: the 8 missing courtyards, and nothing else', () => {
    expect(s.warnings.filter((w) => w.kind !== 'holes-merged' && w.kind !== 'no-courtyard')).toEqual([]);
    // Measured: 126 pad openings are dropped as duplicates on this board and
    // EVERY one of them is wholly inside the opening it lost to, so the union is
    // unchanged and nothing was approximated. The caption used to add those 126
    // to the 8 below and tell the owner "134 features simplified" about his own
    // board; a merge is reported only when it really loses area now.
    expect(s.warnings.find((w) => w.kind === 'holes-merged')).toBeUndefined();
    // 8, not 9: cf30fd3 ("chainLoops matches endpoints by distance across grid
    // cells") closed J4's 8 µm courtyard gap, so J4 now gets a body. The 8 left are
    // the logos and the kikit tabs, which draw no courtyard at all — the same number
    // courtyards.test.ts pins.
    expect(s.warnings.find((w) => w.kind === 'no-courtyard')).toEqual({ kind: 'no-courtyard', count: 8 });
  });
  it('reduced quality has no bodies and fewer triangles', () => {
    const r = load('glasgow-revC3/glasgow.kicad_pcb', 'reduced');
    expect(r.groups.find((g) => g.material === 'body')).toBeUndefined();
    expect(r.stats.triangles).toBeLessThan(s.stats.triangles);
  });
  it('transferList lists every buffer once', () => {
    expect(transferList(s)).toHaveLength(s.groups.length * 3);
  });
});

describe('buildScene — the panel', () => {
  it('no stackup → null thickness + warning; unfilled zones reported', () => {
    const s = load('bad-thing-panel/panel.kicad_pcb');
    expect(s.thicknessMm).toBeNull();
    expect(s.warnings).toEqual(expect.arrayContaining([{ kind: 'no-stackup' }, { kind: 'zones-unfilled', count: 4 }]));
  });
});
