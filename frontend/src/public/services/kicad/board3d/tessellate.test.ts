import { describe, expect, it } from 'vitest';
import { EDGE_CORNER_DEG, MeshBuilder, triangulate, UV_MM } from './tessellate';

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

describe('addPrismEdges', () => {
  it('draws the outer ring and one corner per vertex, in model space, and puts them on the group', () => {
    const b = new MeshBuilder(true, { x: 10, y: 10 });
    const ring = { pts: [{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 12, y: 11 }, { x: 10, y: 11 }] };
    expect(b.addPrismEdges(ring, 1, 2)).toBe(8);
    const g = b.build('body', null);
    expect(g.edges).toBeInstanceOf(Float32Array);
    expect(g.edges!.length).toBe(8 * 6);
    // First segment: the top edge from (10,10) to (12,10) → model (0,0,2)→(2,0,2); y flipped, centre subtracted.
    expect([...g.edges!.slice(0, 6)]).toEqual([0, -0, 2, 2, -0, 2].map((n) => n));
    // Second: the corner at (10,10) from base to outer.
    expect([...g.edges!.slice(6, 12)]).toEqual([0, -0, 1, 0, -0, 2]);
    // A base BELOW the outer face (a bottom-side body) is drawn the same way round.
    const c = new MeshBuilder(true);
    c.addPrismEdges(ring, -0.1, -1.2);
    expect(c.edges[2]).toBe(-1.2);
    expect(c.edges[8]).toBe(-0.1);
    expect(c.edges[11]).toBe(-1.2);
  });
  it('drops zero-length edges and rings that are not a polygon; a group with none has no edges field', () => {
    const b = new MeshBuilder(false);
    expect(b.addPrismEdges({ pts: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }, 0, 1)).toBe(6);
    expect(b.addPrismEdges({ pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }, 0, 1)).toBe(0);
    const empty = new MeshBuilder(false).build('silk', 'F.SilkS');
    expect(empty.edges).toBeUndefined();
    expect('edges' in empty).toBe(false);
  });
  it('a round courtyard gets its rim and no verticals; a chamfered box gets a vertical at every real corner', () => {
    const circle = { pts: Array.from({ length: 48 }, (_, i) => ({ x: Math.cos((i / 48) * 2 * Math.PI), y: Math.sin((i / 48) * 2 * Math.PI) })) };
    const b = new MeshBuilder(false);
    expect(b.addPrismEdges(circle, 0, 1)).toBe(48);
    // An octagon turns 45° at each vertex: eight rim edges and eight corners.
    const octagon = { pts: Array.from({ length: 8 }, (_, i) => ({ x: Math.cos((i / 8) * 2 * Math.PI), y: Math.sin((i / 8) * 2 * Math.PI) })) };
    const c = new MeshBuilder(false);
    expect(c.addPrismEdges(octagon, 0, 1)).toBe(16);
    // A point on a straight run (a rectangle with a midpoint) is not a corner.
    const d = new MeshBuilder(false);
    expect(d.addPrismEdges({ pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 }] }, 0, 1)).toBe(5 + 4);
    expect(EDGE_CORNER_DEG).toBe(25);
  });
});

/** The outward-facing check every closed solid below must pass: each
 *  triangle's geometric normal agrees with its stored normals, and points away
 *  from the solid's centroid. */
function assertOutward(g: { positions: Float32Array; normals: Float32Array; indices: Uint32Array }): void {
  const P = g.positions, N = g.normals;
  let cx = 0, cy = 0, cz = 0;
  const n = P.length / 3;
  for (let i = 0; i < n; i++) { cx += P[3 * i]; cy += P[3 * i + 1]; cz += P[3 * i + 2]; }
  cx /= n; cy /= n; cz /= n;
  for (let t = 0; t < g.indices.length; t += 3) {
    const [a, b, c] = [g.indices[t], g.indices[t + 1], g.indices[t + 2]];
    const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
    const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    expect(gx * N[3 * a] + gy * N[3 * a + 1] + gz * N[3 * a + 2], `triangle ${t / 3} winding`).toBeGreaterThan(0);
    const mx = (P[3 * a] + P[3 * b] + P[3 * c]) / 3 - cx, my = (P[3 * a + 1] + P[3 * b + 1] + P[3 * c + 1]) / 3 - cy, mz = (P[3 * a + 2] + P[3 * b + 2] + P[3 * c + 2]) / 3 - cz;
    expect(gx * mx + gy * my + gz * mz, `triangle ${t / 3} faces out`).toBeGreaterThan(0);
  }
}

describe('MeshBuilder — texture coordinates', () => {
  it('a builder asked for uvs writes two per vertex: xy / 2 mm on a cap, (along the ring, z) / 2 mm on a wall', () => {
    const b = new MeshBuilder(false, { x: 0, y: 0 }, true);
    b.addPrism({ outer: { pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }] }, holes: [] }, 0, 1);
    const g = b.build('body', null);
    expect(g.uvs).toBeInstanceOf(Float32Array);
    expect(g.uvs!.length).toBe((g.positions.length / 3) * 2);
    expect(UV_MM).toBe(2);
    for (let v = 0; v < g.positions.length / 3; v++) {
      const [x, y, z] = [g.positions[3 * v], g.positions[3 * v + 1], g.positions[3 * v + 2]];
      const [u, w] = [g.uvs![2 * v], g.uvs![2 * v + 1]];
      if (Math.abs(g.normals[3 * v + 2]) > 0.5) {
        expect([u, w]).toEqual([x / 2, y / 2]);
      } else {
        expect(w).toBeCloseTo(z / 2, 6);
      }
    }
    // Along the walls u runs continuously round the ring: 0 → 12 mm → 6 uv.
    const wallU: number[] = [];
    for (let v = 0; v < g.positions.length / 3; v++) if (Math.abs(g.normals[3 * v + 2]) < 0.5) wallU.push(g.uvs![2 * v]);
    expect(Math.min(...wallU)).toBe(0);
    expect(Math.max(...wallU)).toBeCloseTo(6, 6);
  });
  it('a builder not asked for uvs carries none', () => {
    const b = new MeshBuilder(false);
    b.addPrism({ outer: sq(1), holes: [] }, 0, 1);
    const g = b.build('substrate', null);
    expect(g.uvs).toBeUndefined();
    expect('uvs' in g).toBe(false);
  });
});

describe('MeshBuilder — hexahedron and dimple', () => {
  it('a sloped slab is 12 outward triangles with uvs, under the mirror too', () => {
    for (const flip of [false, true]) {
      const b = new MeshBuilder(flip, { x: 0, y: 0 }, true);
      // A shoulder: 1 mm long in x, rising from z 0..0.1 at x=0 to 0.3..0.4 at x=1.
      const c = [
        { x: 0, y: 0, z: 0 }, { x: 0, y: 0.5, z: 0 }, { x: 1, y: 0.5, z: 0.3 }, { x: 1, y: 0, z: 0.3 },
        { x: 0, y: 0, z: 0.1 }, { x: 0, y: 0.5, z: 0.1 }, { x: 1, y: 0.5, z: 0.4 }, { x: 1, y: 0, z: 0.4 },
      ];
      expect(b.addHexahedron(c)).toBe(12);
      const g = b.build('lead', null);
      expect(g.indices.length).toBe(36);
      expect(g.uvs!.length).toBe((g.positions.length / 3) * 2);
      assertOutward(g);
      for (let v = 0; v < g.normals.length / 3; v++) expect(Math.hypot(g.normals[3 * v], g.normals[3 * v + 1], g.normals[3 * v + 2])).toBeCloseTo(1, 6);
    }
  });
  it('the same corners in the other order still face out', () => {
    const b = new MeshBuilder(false);
    const c = [
      { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 1, z: 1 },
    ];
    b.addHexahedron([...c.slice(0, 4)].reverse().concat([...c.slice(4)].reverse()));
    assertOutward(b.build('lead', null));
  });
  it('a dimple is a fan of facets on the face, each shaded as a pit wall: inward-leaning normals under the cap-tint threshold', () => {
    const b = new MeshBuilder(true, { x: 0, y: 0 }, true);
    expect(b.addDimple({ x: 3, y: 4 }, 0.3, 1.5, true)).toBe(8);
    const g = b.build('body', null);
    expect(g.indices.length).toBe(24);
    expect(g.uvs!.length).toBe((g.positions.length / 3) * 2);
    for (let v = 0; v < g.positions.length / 3; v++) {
      expect(g.positions[3 * v + 2]).toBe(1.5);
      const nz = g.normals[3 * v + 2];
      expect(nz).toBeGreaterThan(0);
      expect(nz).toBeLessThan(0.5);
      expect(Math.hypot(g.positions[3 * v] - 3, g.positions[3 * v + 1] + 4)).toBeLessThanOrEqual(0.3 + 1e-6);
    }
    // Every facet faces the viewer from its side of the board (+z here) …
    const facing = (h: { positions: Float32Array; indices: Uint32Array }, t: number) => {
      const [a, b2, c] = [h.indices[t], h.indices[t + 1], h.indices[t + 2]].map((i) => [h.positions[3 * i], h.positions[3 * i + 1]]);
      return (b2[0] - a[0]) * (c[1] - a[1]) - (b2[1] - a[1]) * (c[0] - a[0]);
    };
    for (let t = 0; t < g.indices.length; t += 3) expect(facing(g, t)).toBeGreaterThan(0);
    // … and on the back side, faces −z.
    const d = new MeshBuilder(true);
    d.addDimple({ x: 0, y: 0 }, 0.3, -1, false);
    const h = d.build('body', null);
    for (let v = 0; v < h.normals.length / 3; v++) expect(h.normals[3 * v + 2]).toBeLessThan(0);
    for (let t = 0; t < h.indices.length; t += 3) expect(facing(h, t)).toBeLessThan(0);
  });
});
