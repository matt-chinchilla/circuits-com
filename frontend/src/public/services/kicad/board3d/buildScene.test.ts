import { describe, expect, it } from 'vitest';
import { fixtureText } from '../fixtures';
import { readStackup } from '../boardStackup';
import { buildScene, transferList } from './buildScene';

// One build per (file, quality) for the whole file: no test mutates a scene,
// and every extra Glasgow build is CPU the `buildMs` bound above competes with
// when the suite runs its files in parallel.
const scenes = new Map<string, ReturnType<typeof buildScene>>();
const load = (rel: string, quality: 'full' | 'reduced' = 'full') => {
  const key = `${rel}|${quality}`;
  const hit = scenes.get(key);
  if (hit != null) return hit;
  const text = fixtureText(rel);
  let stackup = null; try { stackup = readStackup(text); } catch { stackup = null; }
  const scene = buildScene({ text, stackup, quality });
  scenes.set(key, scene);
  return scene;
};

describe('buildScene — Glasgow', () => {
  it('through-hole pins run through the board: their tails poke out under it, and no socket pin tops its body', () => {
    const zs = (material: string) => {
      const g = s.groups.find((x) => x.material === material)!;
      let min = Infinity, max = -Infinity;
      for (let k = 2; k < g.positions.length; k += 3) { min = Math.min(min, g.positions[k]); max = Math.max(max, g.positions[k]); }
      return { min, max };
    };
    const lead = zs('lead'), board = zs('substrate');
    // Tails reach past the far side: every front-side through-hole part on Glasgow.
    expect(lead.min).toBeLessThan(board.min - 1);
  });
  const s = load('glasgow-revC3/glasgow.kicad_pcb');
  it('reports honest thickness, bounds and stats', () => {
    expect(s.thicknessMm).toBeCloseTo(1.6, 6);
    expect(s.bounds.max.x - s.bounds.min.x).toBeCloseTo(80, 0);
    expect(s.bounds.max.y - s.bounds.min.y).toBeCloseTo(49, 0);
    expect(s.stats).toMatchObject({ footprints: 272, pads: 1149, vias: 416, tracks: 4715 });
    expect(s.stats.triangles).toBeGreaterThan(20_000);
    // A runaway guard, not the budget: alone this build is ~1.07 s (spec
    // 2026-09-22 3D parts §3 holds it to 1.5 s), but under the full parallel
    // suite the same build measures ~1.8 s, so the bound here stays loose and
    // the budget the new pass adds is pinned by itself in leads.test.ts.
    expect(s.stats.buildMs).toBeLessThan(3000);
  });
  it('has one group per material/layer, at most a dozen', () => {
    const keys = s.groups.map((g) => `${g.material}/${g.layerName}`);
    expect(keys).toEqual(expect.arrayContaining(['substrate/null', 'hole-wall/null', 'copper/F.Cu', 'copper/B.Cu', 'mask/F.Mask', 'mask/B.Mask', 'silk/F.SilkS', 'body/null', 'lead/null']));
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
  it('stamps every body with its family, draws them in family order, and gives the group its outline edges', () => {
    const body = s.groups.find((g) => g.material === 'body')!;
    const parts = body.parts!;
    expect(parts.length).toBeGreaterThan(250);
    for (const p of parts) expect(p.family, p.ref).toBeDefined();
    // Family order: every opaque family before every glass one, so the
    // renderer's two body materials are two contiguous runs.
    const order = ['ic', 'passive', 'connector', 'led', 'other'];
    const ranks = parts.map((p) => order.indexOf(p.family!));
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
    // …and still ascending by start, which the pick's binary search relies on.
    for (let i = 1; i < parts.length; i++) expect(parts[i].start).toBe(parts[i - 1].start + parts[i - 1].count);
    expect(parts.find((p) => p.ref === 'J5')?.family).toBe('connector');
    expect(parts.filter((p) => p.family === 'led')).toHaveLength(12);
    // Edges: at least the four rim edges of every body (a box has four, an arc
    // many more) plus its corners, six floats each; no other group carries any.
    expect(body.edges).toBeInstanceOf(Float32Array);
    expect(body.edges!.length % 6).toBe(0);
    expect(body.edges!.length / 6).toBeGreaterThan(parts.length * 4 - 1);
    for (const g of s.groups) if (g.material !== 'body') expect(g.edges).toBeUndefined();
    // The edges live in the same model space as the bodies' vertices.
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 2; i < body.edges!.length; i += 3) { minZ = Math.min(minZ, body.edges![i]); maxZ = Math.max(maxZ, body.edges![i]); }
    let vMin = Infinity, vMax = -Infinity;
    for (let i = 2; i < body.positions.length; i += 3) { vMin = Math.min(vMin, body.positions[i]); vMax = Math.max(vMax, body.positions[i]); }
    expect(minZ).toBeGreaterThanOrEqual(vMin - 1e-6);
    expect(maxZ).toBeLessThanOrEqual(vMax + 1e-6);
    expect(transferList(s)).toContain(body.edges!.buffer);
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
    for (const g of s.groups) if (g.material !== 'body' && g.material !== 'copper' && g.material !== 'lead') expect(g.parts).toBeUndefined();
  });
  it('reduced quality has no bodies, no leads and fewer triangles', () => {
    const r = load('glasgow-revC3/glasgow.kicad_pcb', 'reduced');
    expect(r.groups.find((g) => g.material === 'body')).toBeUndefined();
    expect(r.groups.find((g) => g.material === 'lead')).toBeUndefined();
    expect(r.stats.bodiesFromFab).toBe(0);
    expect(r.stats.triangles).toBeLessThan(s.stats.triangles);
    // …but a phone can still pick a part by its pads.
    // 172 of the 272 footprints have a pad on F.Cu; the rest are back-side parts.
    expect(r.groups.find((g) => g.material === 'copper' && g.layerName === 'F.Cu')!.parts).toHaveLength(172);
  });
  it('transferList lists every buffer once, the bodies\' edges and uvs included', () => {
    const extra = s.groups.filter((g) => g.edges != null).length + s.groups.filter((g) => g.uvs != null).length;
    expect(transferList(s)).toHaveLength(s.groups.length * 3 + extra);
    for (const g of s.groups) if (g.uvs != null) expect(transferList(s)).toContain(g.uvs.buffer);
    expect(new Set(transferList(s)).size).toBe(transferList(s).length);
  });
});

describe('buildScene — parts that look like parts (spec 2026-09-22)', () => {
  const s = load('glasgow-revC3/glasgow.kicad_pcb');
  const body = s.groups.find((g) => g.material === 'body')!;
  const lead = s.groups.find((g) => g.material === 'lead')!;
  /** Glasgow before the Fab outlines and the leads, measured at 70ab247. */
  const TRIANGLES_BEFORE = 294_094;

  it('draws more than 200 of the 264 bodies from the package outline, and counts them', () => {
    expect(body.parts).toHaveLength(264);
    expect(s.stats.bodiesFromFab).toBeGreaterThan(200);
    expect(s.stats.bodiesFromFab).toBeLessThanOrEqual(264);
  });
  it('one lead group: layer-less, pickable, uv-mapped, in range', () => {
    expect(s.groups.filter((g) => g.material === 'lead')).toHaveLength(1);
    expect(lead.layerName).toBeNull();
    expect(lead.edges).toBeUndefined();
    for (const g of [body, lead]) {
      expect(g.uvs).toBeInstanceOf(Float32Array);
      expect(g.uvs!.length).toBe((g.positions.length / 3) * 2);
      let max = -1;
      for (const i of g.indices) if (i > max) max = i;
      expect(max).toBeLessThan(g.positions.length / 3);
      for (const v of g.uvs!) if (!Number.isFinite(v)) throw new Error(`${g.material} uv not finite`);
    }
    // Only the body and lead groups carry uvs.
    for (const g of s.groups) if (g.material !== 'body' && g.material !== 'lead') expect(g.uvs).toBeUndefined();
  });
  it('lead ranges tile the group, ascending, each stamped with its part’s family; passives with their kind', () => {
    let cursor = 0;
    for (const r of lead.parts!) {
      expect(r.start).toBe(cursor);
      expect(r.count % 3).toBe(0);
      expect(r.family, r.ref).toBeDefined();
      cursor += r.count;
    }
    expect(cursor).toBe(lead.indices.length);
    // The same family order the bodies take, so both tables read alike.
    const order = ['ic', 'passive', 'connector', 'led', 'other'];
    const ranks = lead.parts!.map((p) => order.indexOf(p.family!));
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
    // A part's pins carry the same family and passive kind as its body.
    const bodyOf = new Map(body.parts!.map((p) => [p.ref, p]));
    for (const r of lead.parts!) {
      expect(bodyOf.get(r.ref)?.family, r.ref).toBe(r.family);
      expect(bodyOf.get(r.ref)?.passive, r.ref).toBe(r.passive);
    }
    expect(lead.parts!.map((r) => r.ref)).toEqual(expect.arrayContaining(['J5', 'U1']));
    expect(lead.parts!.some((r) => r.ref === 'U30')).toBe(false);   // a BGA shows no pins
    // Passive kinds: Glasgow's C refs are caps, its R refs resistors, its L an inductor.
    for (const p of body.parts!) {
      if (p.family !== 'passive') { expect(p.passive, p.ref).toBeUndefined(); continue; }
      if (/^C\d/.test(p.ref)) expect(p.passive, p.ref).toBe('cap');
      if (/^R\d/.test(p.ref)) expect(p.passive, p.ref).toBe('res');
      if (/^L\d/.test(p.ref)) expect(p.passive, p.ref).toBe('ind');
    }
  });
  it('J5’s 44 feet and 44 shoulders are its range: 12 triangles each', () => {
    const j5 = lead.parts!.find((r) => r.ref === 'J5')!;
    expect(j5.family).toBe('connector');
    expect(j5.count / 3).toBe(44 * 12 * 2);
  });
  it('an IC with a pad 1 carries its pin-1 dimple in its body range; a passive none', () => {
    const dimpled = (ref: string) => {
      const r = body.parts!.find((p) => p.ref === ref)!;
      for (let i = r.start; i < r.start + r.count; i++) {
        const v = body.indices[i];
        const nz = Math.abs(body.normals[3 * v + 2]);
        if (nz > 0.1 && nz < 0.5) return true;
      }
      return false;
    };
    const us = body.parts!.filter((p) => /^U\d/.test(p.ref));
    expect(us.length).toBeGreaterThan(20);
    // Measured: every one of Glasgow's 33 U bodies is big enough to carry the
    // mark (4 r ≤ its smaller side, r ≥ 0.15 mm), and each has a pin 1.
    expect(us.filter((p) => !dimpled(p.ref)).map((p) => p.ref)).toEqual([]);
    expect(dimpled('U30')).toBe(true);   // a BGA's pin 1 is ball A1
    const c = body.parts!.find((p) => p.family === 'passive')!;
    expect(dimpled(c.ref)).toBe(false);
  });
  it('the leads stand on the mask, on their part’s own side', () => {
    const mask = s.groups.find((g) => g.material === 'mask' && g.layerName === 'F.Mask')!;
    const back = s.groups.find((g) => g.material === 'mask' && g.layerName === 'B.Mask')!;
    const zF = mask.positions[2], zB = back.positions[2];
    for (let i = 2; i < lead.positions.length; i += 3) {
      const z = lead.positions[i];
      expect(z >= zF - 1e-6 || z <= zB + 1e-6).toBe(true);
    }
  });
  it('costs at most 40 % more triangles than the courtyard boxes did', () => {
    expect(s.stats.triangles).toBeLessThanOrEqual(TRIANGLES_BEFORE * 1.4);
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
    // A RUNAWAY guard, not a performance target: before the hole budget this
    // board took ~95 s; with it, ~2.6 s alone and up to ~6.5 s under the full
    // parallel suite on a loaded machine (a 6 s bound tripped once that way).
    expect(s.stats.buildMs).toBeLessThan(15_000);
    // The test's OWN wall matches the bound it asserts: vitest's default 5 s
    // killed it at ~5.8 s in a full parallel run (2026-09-22, measured at
    // 985dd18 too), so the 15 s guard was never what tripped.
  }, 20_000);
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

describe('buildScene — class and net ranges on the copper', () => {
  const s = load('glasgow-revC3/glasgow.kicad_pcb');
  const copper = s.groups.filter((g) => g.material === 'copper');
  /** The net that drew index `index` of a group, read straight off its table. */
  const netAt = (g: (typeof copper)[number], index: number) =>
    g.nets!.find((r) => r.start <= index && index < r.start + r.count)?.net ?? 0;

  it('every copper group carries both tables; no other group carries either', () => {
    expect(copper.map((g) => g.layerName)).toEqual(['F.Cu', 'B.Cu']);
    for (const g of copper) {
      expect(g.classes, g.layerName!).toBeDefined();
      expect(g.nets, g.layerName!).toBeDefined();
    }
    for (const g of s.groups) {
      if (g.material === 'copper') continue;
      expect(g.classes).toBeUndefined();
      expect(g.nets).toBeUndefined();
    }
  });
  it('class ranges tile every copper triangle exactly once: pads, then tracks, then zones', () => {
    for (const g of copper) {
      expect(g.classes!.map((c) => c.kind)).toEqual(['pads', 'tracks', 'zones']);
      let cursor = 0;
      for (const c of g.classes!) {
        expect(c.start).toBe(cursor);
        expect(c.count).toBeGreaterThan(0);
        expect(c.count % 3).toBe(0);
        cursor += c.count;
      }
      expect(cursor, g.layerName!).toBe(g.indices.length);
      // The pads class is exactly the span the part table covers.
      const lastPart = g.parts![g.parts!.length - 1];
      expect(g.classes![0].count).toBe(lastPart.start + lastPart.count);
    }
  });
  it('net ranges cover each triangle at most once, ascending, in bounds, whole triangles', () => {
    const known = new Set((s.nets ?? []).map((n) => n.number));
    for (const g of copper) {
      let end = 0, covered = 0;
      for (const r of g.nets!) {
        expect(r.start).toBeGreaterThanOrEqual(end);
        expect(r.count).toBeGreaterThan(0);
        expect(r.start % 3).toBe(0);
        expect(r.count % 3).toBe(0);
        expect(r.net).toBeGreaterThan(0);
        expect(known.has(r.net)).toBe(true);
        end = r.start + r.count;
        covered += r.count;
      }
      expect(end).toBeLessThanOrEqual(g.indices.length);
      // Nearly everything on a copper layer is on a net.
      expect(covered, g.layerName!).toBeGreaterThan(g.indices.length * 0.9);
    }
  });
  it('tracks and pours are grouped by net: each net is at most one run per class', () => {
    for (const g of copper) {
      for (const kind of ['tracks', 'zones'] as const) {
        const cls = g.classes!.find((c) => c.kind === kind)!;
        const inside = (start: number) => start >= cls.start && start < cls.start + cls.count;
        const runs = g.nets!.filter((r) => inside(r.start) || inside(r.start + r.count - 1));
        expect(new Set(runs.map((r) => r.net)).size, `${g.layerName} ${kind}`).toBe(runs.length);
      }
    }
  });
  it('a known pad: C30 draws pad 1 (+3V3, net 2) then pad 2 (GND, net 3) on F.Cu', () => {
    const fcu = copper[0];
    const c30 = fcu.parts!.find((r) => r.ref === 'C30')!;
    expect(netAt(fcu, c30.start)).toBe(2);
    expect(netAt(fcu, c30.start + c30.count - 1)).toBe(3);
    // GND owns pads, tracks AND the pours on the front.
    const classOf = (index: number) => fcu.classes!.find((c) => c.start <= index && index < c.start + c.count)!.kind;
    const kinds = new Set<string>();
    for (const r of fcu.nets!) if (r.net === 3) { kinds.add(classOf(r.start)); kinds.add(classOf(r.start + r.count - 1)); }
    expect([...kinds].sort()).toEqual(['pads', 'tracks', 'zones']);
  });
  it('the scene carries the board’s net table for the panel to name what it highlights', () => {
    expect(s.nets).toHaveLength(251);
    expect(s.nets!.find((n) => n.number === 3)).toEqual({ number: 3, name: 'GND' });
  });
  it('reduced quality still tiles, with fewer track triangles', () => {
    const r = load('glasgow-revC3/glasgow.kicad_pcb', 'reduced');
    const full = copper[0].classes!.find((c) => c.kind === 'tracks')!.count;
    const fcu = r.groups.find((g) => g.material === 'copper' && g.layerName === 'F.Cu')!;
    expect(fcu.classes!.reduce((n, c) => n + c.count, 0)).toBe(fcu.indices.length);
    expect(fcu.classes!.find((c) => c.kind === 'tracks')!.count).toBeLessThan(full);
  });
  it('a hand-built board: exact ranges, unconnected items in no net range', () => {
    const board = [
      '(kicad_pcb (version 20221018) (generator pcbnew)',
      '(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))',
      '(net 0 "") (net 1 "A") (net 2 "B")',
      '(gr_rect (start 0 0) (end 20 20) (layer "Edge.Cuts") (width 0.1))',
      '(footprint "x" (layer "F.Cu") (at 5 5) (property "Reference" "R1")',
      '  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 2 "B"))',
      '  (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu")))',
      '(segment (start 1 10) (end 5 10) (width 0.3) (layer "F.Cu") (net 2))',
      '(segment (start 1 12) (end 5 12) (width 0.3) (layer "F.Cu") (net 1))',
      '(segment (start 1 14) (end 5 14) (width 0.3) (layer "F.Cu") (net 2))',
      '(zone (net 1) (net_name "A") (layer "F.Cu") (filled_polygon (layer "F.Cu") (pts (xy 10 10) (xy 15 10) (xy 15 15) (xy 10 15))))',
      ')',
    ].join('\n');
    const scene = buildScene({ text: board, stackup: null, quality: 'reduced' });
    const g = scene.groups.find((x) => x.material === 'copper' && x.layerName === 'F.Cu')!;
    // Two rect pads (2 triangles each), three identical tracks, one quad pour.
    const [pads, tracks, zones] = g.classes!;
    expect(pads).toEqual({ kind: 'pads', start: 0, count: 12 });
    expect(tracks.kind).toBe('tracks');
    expect(tracks.start).toBe(12);
    expect(zones).toEqual({ kind: 'zones', start: 12 + tracks.count, count: 6 });
    const t = tracks.count / 3;
    // Tracks draw in net order (A, then both B's as one run); pad 2 is on no net.
    expect(g.nets).toEqual([
      { net: 2, start: 0, count: 6 },
      { net: 1, start: 12, count: t },
      { net: 2, start: 12 + t, count: 2 * t },
      { net: 1, start: 12 + 3 * t, count: 6 },
    ]);
    expect(scene.nets).toEqual([{ number: 1, name: 'A' }, { number: 2, name: 'B' }]);
  });
});
