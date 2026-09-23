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

/** Texture coordinates are millimetres over this: one texture repeat per 2 mm,
 *  so a procedural grain has the same scale on an 0402 and on a QFN. */
export const UV_MM = 2;

/** A pin-1 dimple's facets lean this far from the face's own normal. Past 60°
 *  the facet's normal is under 0.5 on z, so a renderer that tints a body's
 *  caps lighter than its walls by the normal's z tints the dimple as a WALL —
 *  darker than the top it sits in, which is how a moulded dimple reads. */
const DIMPLE_TILT_DEG = 65;

/** A point in board millimetres (x, y on the page) at model height z. */
export interface Vec3 { x: number; y: number; z: number }

export class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];
  /** Line segments, six floats each (`MeshGroup.edges`); empty for most groups. */
  edges: number[] = [];
  /** Two floats per vertex when the builder was asked for them, else empty. */
  uvs: number[] = [];

  private readonly sy: number;
  private readonly cx: number;
  private readonly cy: number;
  private readonly withUvs: boolean;

  /** `flipY` mirrors the KiCad page into a y-up model; `centre` is subtracted
   *  first, so a board 100 mm from the origin still builds around (0, 0).
   *  `withUvs` writes a texture coordinate per vertex (`MeshGroup.uvs`) — for
   *  the bodies and leads, which carry a surface texture; every other group
   *  leaves it off and costs nothing. */
  constructor(flipY: boolean, centre: Vec2 = { x: 0, y: 0 }, withUvs = false) {
    this.sy = flipY ? -1 : 1;
    this.cx = centre.x;
    this.cy = centre.y;
    this.withUvs = withUvs;
  }

  /** Board millimetres → model space. The ONE place either frame change happens;
   *  every normal below is authored in model space already, which is why no code
   *  here has to mirror a normal and then un-mirror a winding to match. */
  private toModel(x: number, y: number): Vec2 {
    return { x: x - this.cx, y: this.sy * (y - this.cy) };
  }

  private vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0): number {
    const index = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.normals.push(nx, ny, nz);
    if (this.withUvs) this.uvs.push(u, v);
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
      this.vertex(m.x, m.y, z, 0, 0, nz, m.x / UV_MM, m.y / UV_MM);
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
    // u runs along the ring, so a texture wraps round a body without a seam
    // at every corner; v is the height.
    let along = 0;
    const v0 = lo / UV_MM, v1 = hi / UV_MM;
    for (let i = 0; i < model.length; i++) {
      const a = model[i], b = model[(i + 1) % model.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length < 1e-12) continue;
      const nx = (sign * dy) / length, ny = (-sign * dx) / length;
      const ua = along / UV_MM, ub = (along + length) / UV_MM;
      along += length;
      const i0 = this.vertex(a.x, a.y, lo, nx, ny, 0, ua, v0);
      const i1 = this.vertex(b.x, b.y, lo, nx, ny, 0, ub, v0);
      const i2 = this.vertex(b.x, b.y, hi, nx, ny, 0, ub, v1);
      const i3 = this.vertex(a.x, a.y, hi, nx, ny, 0, ua, v1);
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

  /**
   * A closed solid of six flat-shaded quads from eight corners: `corners[0..3]`
   * the base ring and `corners[4..7]` the ring above it, in the same order —
   * so a lead's sloped shoulder, which no vertical prism can draw, is one call.
   * Each face's normal is its own (Newell's, from the corners as MIRRORED) and
   * is turned to point away from the solid's centre, and the two triangles are
   * wound to agree with it — so the corners may be listed either way round.
   * Texture coordinates project each face onto the plane it faces most.
   * Returns the number of triangles (12).
   */
  addHexahedron(corners: readonly Vec3[]): number {
    if (corners.length !== 8) return 0;
    const m = corners.map((c) => { const p = this.toModel(c.x, c.y); return { x: p.x, y: p.y, z: c.z }; });
    let ox = 0, oy = 0, oz = 0;
    for (const p of m) { ox += p.x / 8; oy += p.y / 8; oz += p.z / 8; }
    const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    let count = 0;
    for (const face of faces) {
      const q = face.map((i) => m[i]);
      let nx = 0, ny = 0, nz = 0, fx = 0, fy = 0, fz = 0;
      for (let i = 0; i < 4; i++) {
        const a = q[i], b = q[(i + 1) % 4];
        nx += (a.y - b.y) * (a.z + b.z);
        ny += (a.z - b.z) * (a.x + b.x);
        nz += (a.x - b.x) * (a.y + b.y);
        fx += a.x / 4; fy += a.y / 4; fz += a.z / 4;
      }
      const length = Math.hypot(nx, ny, nz);
      if (length < 1e-12) continue;
      const out = nx * (fx - ox) + ny * (fy - oy) + nz * (fz - oz) >= 0 ? 1 : -1;
      nx *= out / length; ny *= out / length; nz *= out / length;
      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
      const uv = (p: Vec3): [number, number] =>
        az >= ax && az >= ay ? [p.x / UV_MM, p.y / UV_MM] : ax >= ay ? [p.y / UV_MM, p.z / UV_MM] : [p.x / UV_MM, p.z / UV_MM];
      const ids = q.map((p) => { const [u, v] = uv(p); return this.vertex(p.x, p.y, p.z, nx, ny, nz, u, v); });
      // Does (0, 1, 2) as written agree with the normal? If not, both
      // triangles go the other way round.
      const [p0, p1, p2] = q;
      const ux = p1.x - p0.x, uy = p1.y - p0.y, uz = p1.z - p0.z;
      const vx = p2.x - p0.x, vy = p2.y - p0.y, vz = p2.z - p0.z;
      const agrees = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz > 0;
      if (agrees) this.indices.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
      else this.indices.push(ids[0], ids[2], ids[1], ids[0], ids[3], ids[2]);
      count += 2;
    }
    return count;
  }

  /**
   * A pin-1 dimple: a flat fan of `segments` facets of radius `r` around `c`
   * at height `z`, facing +z (`up`) or −z. Flat, so it costs no depth and
   * cannot poke through a thin body; each facet's NORMAL leans
   * `DIMPLE_TILT_DEG` in toward the centre, as the wall of a shallow pit
   * would, so the light reads it as a recess and a renderer that tints caps
   * by their normal draws it darker than the top face round it. Returns the
   * number of triangles.
   */
  addDimple(c: Vec2, r: number, z: number, up: boolean, segments = 8): number {
    if (!(r > 0) || segments < 3) return 0;
    const centre = this.toModel(c.x, c.y);
    const tilt = (DIMPLE_TILT_DEG * Math.PI) / 180;
    const lean = Math.sin(tilt), nz = (up ? 1 : -1) * Math.cos(tilt);
    // Corners in MODEL space, so the facet's inward lean is measured after
    // the mirror and needs no un-mirroring.
    const rim: Vec2[] = [];
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * 2 * Math.PI;
      const p = this.toModel(c.x + r * Math.cos(t), c.y + r * Math.sin(t));
      rim.push(p);
    }
    for (let i = 0; i < segments; i++) {
      const a = rim[i], b = rim[(i + 1) % segments];
      const mx = (a.x + b.x) / 2 - centre.x, my = (a.y + b.y) / 2 - centre.y;
      const ml = Math.hypot(mx, my) || 1;
      const nx = (-mx / ml) * lean, ny = (-my / ml) * lean;
      const i0 = this.vertex(centre.x, centre.y, z, nx, ny, nz, centre.x / UV_MM, centre.y / UV_MM);
      const i1 = this.vertex(a.x, a.y, z, nx, ny, nz, a.x / UV_MM, a.y / UV_MM);
      const i2 = this.vertex(b.x, b.y, z, nx, ny, nz, b.x / UV_MM, b.y / UV_MM);
      this.faceTriangle(i0, i1, i2, up);
    }
    return segments;
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
    if (this.withUvs) group.uvs = new Float32Array(this.uvs);
    return group;
  }
}
