import { describe, expect, it } from 'vitest';
import { fixtureText } from '../fixtures';
import { readStackup } from '../boardStackup';
import { buildScene } from './buildScene';
import { hasEstimatedBody, partAnchor } from './partAnchor';
import type { BoardScene } from './types';

const text = fixtureText('glasgow-revC3/glasgow.kicad_pcb');
const stackup = readStackup(text);
const full = buildScene({ text, stackup, quality: 'full' });
const reduced = buildScene({ text, stackup, quality: 'reduced' });

const inside = (scene: BoardScene, a: { x: number; y: number }) =>
  a.x >= scene.bounds.min.x && a.x <= scene.bounds.max.x && a.y >= scene.bounds.min.y && a.y <= scene.bounds.max.y;

describe('partAnchor — Glasgow', () => {
  it('anchors a front-side part to the top of its estimated body', () => {
    const a = partAnchor(full, 'J5')!;
    expect(a).not.toBeNull();
    expect(a.body).toBe(true);
    expect(a.side).toBe('F');
    expect(inside(full, a)).toBe(true);
    // Above the board: the body's outer face, not its base on the mask.
    const substrate = full.groups.find((g) => g.material === 'substrate')!;
    let top = -Infinity;
    for (let i = 2; i < substrate.positions.length; i += 3) top = Math.max(top, substrate.positions[i]);
    expect(a.z).toBeGreaterThan(top);
    expect(hasEstimatedBody(full, 'J5')).toBe(true);
  });
  it('a back-side part anchors below the board, at its body\'s outer face', () => {
    const body = full.groups.find((g) => g.material === 'body')!;
    const substrate = full.groups.find((g) => g.material === 'substrate')!;
    let bottom = Infinity;
    for (let i = 2; i < substrate.positions.length; i += 3) bottom = Math.min(bottom, substrate.positions[i]);
    // Find a body drawn under the board.
    const under = body.parts!.find((p) => {
      let z = Infinity;
      for (let i = p.start; i < p.start + p.count; i++) z = Math.min(z, body.positions[body.indices[i] * 3 + 2]);
      return z < bottom;
    });
    expect(under).toBeDefined();
    const a = partAnchor(full, under!.ref)!;
    expect(a.side).toBe('B');
    expect(a.body).toBe(true);
    expect(a.z).toBeLessThan(bottom);
  });
  it('falls back to the pads for a part with no body — the reduced tier draws none', () => {
    const a = partAnchor(reduced, 'J5')!;
    expect(a).not.toBeNull();
    expect(a.body).toBe(false);
    expect(a.side).toBe('F');
    expect(inside(reduced, a)).toBe(true);
    expect(hasEstimatedBody(reduced, 'J5')).toBe(false);
  });
  it('a back-side part with pads and no body anchors to its pads, under the board', () => {
    // Glasgow's eight courtyard-less footprints are logos, tabs and holes with
    // no pads on either face, so this one is built by hand: a slab from z 0 to
    // 1 and one pad quad on B.Cu just under it.
    const quad = (z: number, extra: Partial<BoardScene['groups'][number]> = {}) => ({
      layerName: null, positions: new Float32Array([-1, -1, z, 1, -1, z, 1, 1, z, -1, 1, z]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]), ...extra,
    });
    const scene: BoardScene = {
      bounds: { min: { x: -5, y: -5 }, max: { x: 5, y: 5 } }, thicknessMm: 1, warnings: [],
      stats: { footprints: 1, pads: 1, vias: 0, tracks: 0, triangles: 4, buildMs: 0, bodiesFromFab: 0 },
      groups: [
        { material: 'substrate', ...quad(1) },
        { material: 'substrate', ...quad(0) },
        { material: 'copper', ...quad(-0.01, { layerName: 'B.Cu', parts: [{ ref: 'R9', start: 0, count: 6 }] }) },
      ],
    };
    const a = partAnchor(scene, 'R9')!;
    expect(a).toMatchObject({ side: 'B', body: false });
    expect(a.x).toBeCloseTo(0, 6);
    expect(a.y).toBeCloseTo(0, 6);
    expect(a.z).toBeCloseTo(-0.01, 6);
    expect(hasEstimatedBody(scene, 'R9')).toBe(false);
  });
  it('the pads anchor and the body anchor of one part agree about where it is', () => {
    const body = partAnchor(full, 'J5')!, pads = partAnchor(reduced, 'J5')!;
    expect(Math.hypot(body.x - pads.x, body.y - pads.y)).toBeLessThan(3);
  });
  it('a designator the scene does not draw has no anchor', () => {
    expect(partAnchor(full, 'NOPE99')).toBeNull();
    expect(partAnchor({ ...full, groups: [] }, 'J5')).toBeNull();
    expect(hasEstimatedBody(full, 'NOPE99')).toBe(false);
  });
});
