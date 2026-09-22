import { describe, expect, it } from 'vitest';
import { MeshBuilder, triangulate } from './tessellate';

const sq = (s: number, cx = 0, cy = 0) => ({ pts: [{ x: cx - s, y: cy - s }, { x: cx + s, y: cy - s }, { x: cx + s, y: cy + s }, { x: cx - s, y: cy + s }] });

describe('triangulate', () => {
  it('a square with a square hole yields 8 triangles', () => {
    const t = triangulate({ outer: sq(5), holes: [{ pts: [...sq(1).pts].reverse() }] });
    expect(t.tris.length / 3).toBe(8);
  });
  it('a plain square yields 2', () => { expect(triangulate({ outer: sq(5), holes: [] }).tris.length / 3).toBe(2); });
});

describe('MeshBuilder', () => {
  it('a prism has 2 faces + 4 walls·2 = 12 triangles, outward normals, in-range indices', () => {
    const b = new MeshBuilder(false);
    const n = b.addPrism({ outer: sq(1), holes: [] }, 0, 2);
    expect(n).toBe(12);
    const g = b.build('substrate', null);
    expect(g.indices.length).toBe(36);
    for (const i of g.indices) expect(i).toBeLessThan(g.positions.length / 3);
    // top face normal up, bottom down
    expect(g.normals[2]).toBe(1);
    // a wall on the +x side has normal +x: find a vertex at x=1, z between 0..2 with nz==0
    let found = false;
    for (let i = 0; i < g.positions.length / 3; i++) if (g.positions[3 * i] === 1 && g.normals[3 * i + 2] === 0 && g.normals[3 * i] > 0.99) found = true;
    expect(found).toBe(true);
  });
  it('flipY negates y and keeps faces up', () => {
    const b = new MeshBuilder(true);
    b.addFace({ outer: { pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }, holes: [] }, 0, true);
    const g = b.build('copper', 'F.Cu');
    expect(Math.min(...Array.from(g.positions).filter((_, i) => i % 3 === 1))).toBe(-1);
    // winding still counter-clockwise seen from +z after the flip: cross product of the first triangle's edges has positive z
    const [a, b2, c] = [g.indices[0], g.indices[1], g.indices[2]].map((i) => [g.positions[3 * i], g.positions[3 * i + 1]]);
    const cz = (b2[0] - a[0]) * (c[1] - a[1]) - (b2[1] - a[1]) * (c[0] - a[0]);
    expect(cz).toBeGreaterThan(0);
  });
  it('a hole is walled inward and the centre offsets the whole group', () => {
    const b = new MeshBuilder(false, { x: 10, y: 0 });
    const n = b.addPrism({ outer: sq(5), holes: [sq(1)] }, 0, 1);
    expect(n).toBe(8 * 2 + 4 * 2 + 4 * 2);     // 16 face + 8 outer wall + 8 hole wall
    const g = b.build('substrate', null);
    // centred: the outer ring's x runs -15..-5, not -5..5
    const xs = Array.from(g.positions).filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBe(-15);
    expect(Math.max(...xs)).toBe(-5);
    // the hole's wall at x = -9 (world 1) faces -x: into the hole, away from the solid
    let inward = false;
    for (let i = 0; i < g.positions.length / 3; i++) {
      if (g.positions[3 * i] === -9 && g.normals[3 * i + 2] === 0 && g.normals[3 * i] < -0.99) inward = true;
    }
    expect(inward).toBe(true);
  });
});
