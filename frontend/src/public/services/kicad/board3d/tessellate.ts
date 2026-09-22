// Rings → triangles (spec 2026-09-21 §4). The last pure step before a scene:
// everything above this file speaks polygons in KiCad millimetres, everything
// below it speaks typed arrays a worker can transfer to the renderer.
//
// One MeshBuilder per (material, layer) group. It owns the two frame changes
// the scene needs — the y flip from KiCad's y-DOWN page to a y-up model, and
// the recentring onto the origin — so no other module has to think about them.
import earcut from 'earcut';
import { signedArea } from './geom';
import type { Material, MeshGroup, PolygonWithHoles, Ring, Vec2 } from './types';

/** earcut on a polygon with holes: the concatenated xy of the outer ring then
 *  each hole, with `holeIndices` pointing at each hole's first VERTEX (not its
 *  first number). Either winding works — earcut normalises internally. */
export function triangulate(poly: PolygonWithHoles): { verts: Float64Array; tris: Uint32Array } {
  if (poly.outer.pts.length < 3) return { verts: new Float64Array(0), tris: new Uint32Array(0) };
  const flat: number[] = [];
  for (const p of poly.outer.pts) flat.push(p.x, p.y);
  const holeIndices: number[] = [];
  for (const hole of poly.holes) {
    if (hole.pts.length < 3) continue;
    holeIndices.push(flat.length / 2);
    for (const p of hole.pts) flat.push(p.x, p.y);
  }
  return { verts: new Float64Array(flat), tris: new Uint32Array(earcut(flat, holeIndices, 2)) };
}

export class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];

  private readonly sy: number;
  private readonly cx: number;
  private readonly cy: number;

  /** `flipY` mirrors the KiCad page into a y-up model; `centre` is subtracted
   *  first, so a board 100 mm from the origin still builds around (0, 0). */
  constructor(flipY: boolean, centre: Vec2 = { x: 0, y: 0 }) {
    this.sy = flipY ? -1 : 1;
    this.cx = centre.x;
    this.cy = centre.y;
  }

  /** Board millimetres → model space. The ONE place either frame change happens;
   *  every normal below is authored in model space already, which is why no code
   *  here has to mirror a normal and then un-mirror a winding to match. */
  private toModel(x: number, y: number): Vec2 {
    return { x: x - this.cx, y: this.sy * (y - this.cy) };
  }

  private vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
    const index = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.normals.push(nx, ny, nz);
    return index;
  }

  /** Emit a flat triangle wound so its right-hand normal agrees with `up`,
   *  measured from the vertices as WRITTEN. That makes the winding independent
   *  of both earcut's convention and the mirror: the mirror reverses the sign
   *  this reads, and the triangle comes out the other way round by itself. */
  private faceTriangle(a: number, b: number, c: number, up: boolean): void {
    const p = this.positions;
    const ax = p[3 * a], ay = p[3 * a + 1];
    const ccw = (p[3 * b] - ax) * (p[3 * c + 1] - ay) - (p[3 * b + 1] - ay) * (p[3 * c] - ax) > 0;
    if (ccw === up) this.indices.push(a, b, c);
    else this.indices.push(a, c, b);
  }

  /** A flat polygon (with holes) at height `z`, facing +z or −z. */
  addFace(poly: PolygonWithHoles, z: number, up: boolean): number {
    const { verts, tris } = triangulate(poly);
    const base = this.positions.length / 3;
    const nz = up ? 1 : -1;
    for (let i = 0; i < verts.length; i += 2) {
      const m = this.toModel(verts[i], verts[i + 1]);
      this.vertex(m.x, m.y, z, 0, 0, nz);
    }
    for (let t = 0; t < tris.length; t += 3) {
      this.faceTriangle(base + tris[t], base + tris[t + 1], base + tris[t + 2], up);
    }
    return tris.length / 3;
  }

  /**
   * Vertical walls around a ring, from `z0` to `z1`. `outward` means "away from
   * the solid": true for an outer ring, false for a hole, whose wall faces into
   * the void it cuts. The ring's own winding is READ rather than assumed — a
   * hole stored either way round walls correctly — and the quad's winding
   * follows the same sign, so the stored normal and the geometric one never
   * disagree. Zero-length edges are dropped; they would carry no normal.
   */
  addWalls(ring: Ring, z0: number, z1: number, outward: boolean): number {
    const pts = ring.pts;
    if (pts.length < 3) return 0;
    const lo = Math.min(z0, z1), hi = Math.max(z0, z1);
    const model = pts.map((p) => this.toModel(p.x, p.y));
    const sign = (signedArea(model) > 0 ? 1 : -1) * (outward ? 1 : -1);
    let count = 0;
    for (let i = 0; i < model.length; i++) {
      const a = model[i], b = model[(i + 1) % model.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length < 1e-12) continue;
      const nx = (sign * dy) / length, ny = (-sign * dx) / length;
      const i0 = this.vertex(a.x, a.y, lo, nx, ny, 0);
      const i1 = this.vertex(b.x, b.y, lo, nx, ny, 0);
      const i2 = this.vertex(b.x, b.y, hi, nx, ny, 0);
      const i3 = this.vertex(a.x, a.y, hi, nx, ny, 0);
      if (sign > 0) this.indices.push(i0, i1, i2, i0, i2, i3);
      else this.indices.push(i0, i2, i1, i0, i3, i2);
      count += 2;
    }
    return count;
  }

  /** A solid: capped top and bottom, walled around the outer ring and each hole. */
  addPrism(poly: PolygonWithHoles, z0: number, z1: number): number {
    const lo = Math.min(z0, z1), hi = Math.max(z0, z1);
    let count = this.addFace(poly, hi, true) + this.addFace(poly, lo, false);
    count += this.addWalls(poly.outer, lo, hi, true);
    for (const hole of poly.holes) count += this.addWalls(hole, lo, hi, false);
    return count;
  }

  build(material: Material, layerName: string | null): MeshGroup {
    return {
      material,
      layerName,
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      indices: new Uint32Array(this.indices),
    };
  }
}
