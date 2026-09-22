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
  it('records which footprint owns each body and pad triangle, so a pick can name it', () => {
    const body = s.groups.find((g) => g.material === 'body')!;
    expect(body.parts).toBeDefined();
    // 264 courtyard bodies, one range each, tiling the group in order.
    expect(body.parts).toHaveLength(264);
    let cursor = 0;
    for (const r of body.parts!) {
      expect(r.start).toBe(cursor);
      expect(r.count % 3).toBe(0);
      cursor += r.count;
    }
    expect(cursor).toBe(body.indices.length);
    expect(body.parts!.map((r) => r.ref)).toContain('U30');

    const fcu = s.groups.find((g) => g.material === 'copper' && g.layerName === 'F.Cu')!;
    const bcu = s.groups.find((g) => g.material === 'copper' && g.layerName === 'B.Cu')!;
    // Pads come first, per footprint; tracks and pours follow with no owner.
    const refs = new Set(fcu.parts!.map((r) => r.ref));
    expect(refs.has('U30')).toBe(true);
    expect(fcu.parts!.at(-1)!.start + fcu.parts!.at(-1)!.count).toBeLessThan(fcu.indices.length);
    // A through-hole part's pads are on BOTH copper layers; U30 (a BGA) is on one.
    expect(bcu.parts!.some((r) => r.ref === 'U30')).toBe(false);
    // No table on the groups nobody can pick.
    for (const g of s.groups) if (g.material !== 'body' && g.material !== 'copper') expect(g.parts).toBeUndefined();
  });
  it('reduced quality has no bodies and fewer triangles', () => {
    const r = load('glasgow-revC3/glasgow.kicad_pcb', 'reduced');
    expect(r.groups.find((g) => g.material === 'body')).toBeUndefined();
    expect(r.stats.triangles).toBeLessThan(s.stats.triangles);
    // …but a phone can still pick a part by its pads.
    // 172 of the 272 footprints have a pad on F.Cu; the rest are back-side parts.
    expect(r.groups.find((g) => g.material === 'copper' && g.layerName === 'F.Cu')!.parts).toHaveLength(172);
  });
  it('transferList lists every buffer once', () => {
    expect(transferList(s)).toHaveLength(s.groups.length * 3);
  });
});

describe('buildScene — the panel', () => {
  it('no stackup → null thickness + warning; its mask zones are not reported as unfilled copper', () => {
    const s = load('bad-thing-panel/panel.kicad_pcb');
    expect(s.thicknessMm).toBeNull();
    expect(s.warnings).toEqual(expect.arrayContaining([{ kind: 'no-stackup' }]));
    expect(s.warnings.find((w) => w.kind === 'zones-unfilled')).toBeUndefined();
  });
});

/** A 1 mm grid of 0.3 mm vias (and optionally SMD pads) inside a plain outline. */
function denseBoard(vias: number, pads = 0): string {
  const side = Math.ceil(Math.sqrt(vias + pads));
  const w = side + 4;
  const lines = [
    '(kicad_pcb (version 20221018) (generator pcbnew)',
    '(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (38 "B.Mask" user) (39 "F.Mask" user) (44 "Edge.Cuts" user))',
    `(gr_rect (start 0 0) (end ${w} ${w}) (layer "Edge.Cuts") (width 0.1))`,
  ];
  let k = 0;
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++, k++) {
      if (k < vias) lines.push(`(via (at ${2 + i} ${2 + j}) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu"))`);
      else if (k < vias + pads) lines.push(`(footprint "x" (layer "F.Cu") (at ${2 + i} ${2 + j}) (property "Reference" "R${k}") (pad "1" smd rect (at 0 0) (size 0.4 0.4) (layers "F.Cu" "F.Mask")))`);
    }
  }
  lines.push(')');
  return lines.join('\n');
}

describe('buildScene — a dense board stays inside the face budget', () => {
  it('cuts the first 1,500 drills and MARKS the rest, in bounded time', () => {
    // 3,000 vias took ~9 s before the budget (earcut bridges every hole into ONE
    // face); the build is now bounded by the budget rather than by the file.
    const s = buildScene({ text: denseBoard(3000), stackup: null, quality: 'reduced' });
    expect(s.warnings).toContainEqual({ kind: 'holes-marked', count: 1500 });
    const marks = s.groups.filter((g) => g.material === 'hole-wall' && g.layerName?.endsWith('.Marks'));
    expect(marks.map((g) => g.layerName).sort()).toEqual(['B.Marks', 'F.Marks']);
    expect(s.stats.buildMs).toBeLessThan(6000);
  });
  it('raises the pads whose mask openings do not fit, and counts them', () => {
    const s = buildScene({ text: denseBoard(0, 1600), stackup: null, quality: 'reduced' });
    expect(s.warnings).toContainEqual({ kind: 'holes-marked', count: 100 });
    // Every pad is still drawn, and still pickable by its footprint.
    expect(s.groups.find((g) => g.material === 'copper' && g.layerName === 'F.Cu')!.parts).toHaveLength(1600);
    const mask = s.groups.find((g) => g.material === 'mask' && g.layerName === 'F.Mask')!;
    const copper = s.groups.find((g) => g.material === 'copper' && g.layerName === 'F.Cu')!;
    const maskZ = mask.positions[2];
    let above = 0;
    for (let i = 2; i < copper.positions.length; i += 3) if (copper.positions[i] > maskZ) above++;
    expect(above).toBe(100 * 4);   // 100 raised rect pads, four vertices each
  });
  it('Glasgow is inside the budget: nothing marked', () => {
    const s = load('glasgow-revC3/glasgow.kicad_pcb');
    expect(s.warnings.find((w) => w.kind === 'holes-marked')).toBeUndefined();
    expect(s.groups.some((g) => g.layerName?.endsWith('.Marks'))).toBe(false);
  });
});

describe('buildScene — outlines that are not all gr_* lines', () => {
  it('a board whose outline is a footprint closes, and the model is centred on it', () => {
    const board = [
      '(kicad_pcb (version 20221018) (generator pcbnew)',
      '(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))',
      '(footprint "outline" (layer "F.Cu") (at 50 40) (property "Reference" "BRD1")',
      '  (fp_rect (start -10 -5) (end 10 5) (layer "Edge.Cuts") (width 0.1)))',
      ')',
    ].join('\n');
    const s = buildScene({ text: board, stackup: null, quality: 'reduced' });
    expect(s.warnings.find((w) => w.kind === 'outline-open')).toBeUndefined();
    expect(s.bounds).toEqual({ min: { x: -10, y: -5 }, max: { x: 10, y: 5 } });
  });
  it('a board with no outline yet is drawn in the box around its copper', () => {
    const board = [
      '(kicad_pcb (version 20221018) (generator pcbnew)',
      '(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))',
      '(segment (start 100 80) (end 140 110) (width 0.25) (layer "F.Cu"))',
      ')',
    ].join('\n');
    const s = buildScene({ text: board, stackup: null, quality: 'reduced' });
    expect(s.warnings).toContainEqual({ kind: 'outline-open', segments: 0 });
    expect(s.bounds.max.x - s.bounds.min.x).toBeCloseTo(42, 6);
    expect(s.bounds.max.y - s.bounds.min.y).toBeCloseTo(32, 6);
  });
});
