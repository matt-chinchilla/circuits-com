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

/** A vertex is a corner — and gets a vertical edge line — when the outline
 *  turns by more than this at it. A rectangle turns 90° at each corner; a
 *  courtyard arc flattened at 0.01 mm turns a few degrees per vertex. */
export const EDGE_CORNER_DEG = 25;

/** The turn at `b` between the edges a→b and b→c, in degrees, 0 for straight on. */
function turnDeg(a: Vec2, b: Vec2, c: Vec2): number {
  const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
  if (lu < 1e-12 || lv < 1e-12) return 0;
  const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

export class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];
  /** Line segments, six floats each (`MeshGroup.edges`); empty for most groups. */
  edges: number[] = [];

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

  /**
   * The outline of a prism as line segments: the ring at its OUTER face
   * (`zOuter`, the face away from the board) and one vertical at each CORNER
   * down to `zBase` — a vertex where the ring turns by more than
   * `EDGE_CORNER_DEG`, so a box gets its four corners and a round courtyard
   * (a flattened arc of many small turns) gets none, and draws as a drum with
   * a rim rather than a cage of verticals. The base ring is left out — it lies
   * on the board's own surface, where a line would fight the mask for the same
   * pixels and say nothing the mask's opening does not. Zero-length edges are
   * dropped, as `addWalls` drops them. Returns the number of segments added.
   */
  addPrismEdges(ring: Ring, zBase: number, zOuter: number): number {
    const raw = ring.pts;
    if (raw.length < 3) return 0;
    // Zero-length edges first, so a repeated point neither draws nor counts
    // as a turn.
    const model: Vec2[] = [];
    for (const p of raw) {
      const m = this.toModel(p.x, p.y);
      const last = model.length > 0 ? model[model.length - 1] : null;
      if (last == null || Math.hypot(m.x - last.x, m.y - last.y) >= 1e-12) model.push(m);
    }
    if (model.length > 1) {
      const first = model[0], last = model[model.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-12) model.pop();
    }
    if (model.length < 3) return 0;
    const n = model.length;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const prev = model[(i + n - 1) % n], a = model[i], b = model[(i + 1) % n];
      this.edges.push(a.x, a.y, zOuter, b.x, b.y, zOuter);
      count++;
      if (turnDeg(prev, a, b) > EDGE_CORNER_DEG) {
        this.edges.push(a.x, a.y, zBase, a.x, a.y, zOuter);
        count++;
      }
    }
    return count;
  }

  build(material: Material, layerName: string | null): MeshGroup {
    const group: MeshGroup = {
      material,
      layerName,
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      indices: new Uint32Array(this.indices),
    };
    if (this.edges.length > 0) group.edges = new Float32Array(this.edges);
    return group;
  }
}
