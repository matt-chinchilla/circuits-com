import { add, cross, len, scale, sub } from './geom';
import type { Ring, Vec2 } from './types';

const EPS = 1e-9;
const DEG = Math.PI / 180;
/** Beyond this multiple of the half width a miter spike is cut back to a bevel. */
const MITER_LIMIT = 4;

/**
 * Angular step that keeps a circle of radius `r` within `tolMm` of its polygon,
 * clamped to [2°, 15°]. Deliberately the same formula `flattenArc` uses — half
 * the textbook sagitta step, so the result errs fine rather than coarse.
 */
export function arcStep(r: number, tolMm: number): number {
  if (!(r > 0)) return 15 * DEG;
  return Math.min(15 * DEG, Math.max(2 * DEG, Math.acos(Math.max(-1, 1 - tolMm / r))));
}

/** Points of an arc, endpoints INCLUDED, `segments` steps from `a0` sweeping `sweep`. */
export function arcPoints(centre: Vec2, r: number, a0: number, sweep: number, segments: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = a0 + (sweep * i) / segments;
    out.push({ x: centre.x + r * Math.cos(t), y: centre.y + r * Math.sin(t) });
  }
  return out;
}

const unit = (d: Vec2): Vec2 => { const l = len(d); return l < EPS ? { x: 0, y: 0 } : { x: d.x / l, y: d.y / l }; };
/** Left normal: d rotated +90°, so angle(n) = angle(d) + 90°. */
const nrm = (d: Vec2): Vec2 => ({ x: -d.y, y: d.x });

function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last != null && Math.hypot(last.x - p.x, last.y - p.y) < EPS) continue;
    out.push(p);
  }
  return out;
}

/**
 * Half-circle end cap, interior points ONLY (the two ends coincide with the
 * offset points that bracket it, so emitting them would duplicate vertices).
 * `sign` +1 starts at +normal and is the cap for the LAST vertex; −1 starts at
 * −normal and is the cap for the FIRST. Both sweep −π, which carries the arc
 * through +direction and −direction respectively because angle(n) = angle(d)+90°.
 */
function capArc(centre: Vec2, normal: Vec2, hw: number, segments: number, sign: 1 | -1): Vec2[] {
  const a0 = Math.atan2(normal.y, normal.x) + (sign === -1 ? Math.PI : 0);
  const n = Math.max(1, segments);
  return arcPoints(centre, hw, a0, -Math.PI, n).slice(1, -1);
}

/**
 * Polyline (≥2 distinct points) with width → one closed ring: round joins on the
 * OUTER side of every turn, a sharp intersection on the inner side, and a round
 * cap at each end. `capSegments` is the segment count across a half-circle cap
 * (8 full / 4 reduced) and sets the join fans' resolution too.
 *
 * Which side is outer follows from the turn: cross(dPrev, dNext) > 0 is a
 * counter-clockwise turn, whose INNER side is the left (+normal) one — the left
 * offsets cross each other there, while the right offsets open a wedge that the
 * fan fills. The reverse for a clockwise turn. (The sketch in the task brief had
 * these two swapped, contradicting its own comment; this follows the geometry.)
 *
 * Self-intersections on very tight polylines are tolerated: these rings are
 * painted, not analysed.
 */
export function strokePolygon(pts: Vec2[], width: number, capSegments: number): Ring {
  const p = dedupe(pts);
  if (p.length < 2) return { pts: [] };
  const hw = width / 2;
  const n = p.length;
  const seg = Math.max(1, capSegments);
  const dir = (i: number): Vec2 => unit(sub(p[i + 1], p[i]));
  const left: Vec2[] = [], right: Vec2[] = [];

  /** Round join on one side: an arc around p[i] from one offset normal to the other. */
  const fan = (i: number, from: Vec2, to: Vec2): Vec2[] => {
    const a0 = Math.atan2(from.y, from.x);
    let da = Math.atan2(to.y, to.x) - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const k = Math.max(1, Math.ceil(Math.abs(da) / (Math.PI / seg)));
    return arcPoints(p[i], hw, a0, da, k);
  };

  /**
   * Sharp inner join: where the two offset lines on `sign`'s side cross. Falls
   * back to the midpoint of the two offset points when they are near-parallel or
   * when the spike runs further than MITER_LIMIT half-widths from the vertex.
   */
  const miter = (i: number, dPrev: Vec2, dNext: Vec2, nPrev: Vec2, nNext: Vec2, sign: 1 | -1): Vec2 => {
    const a = add(p[i], scale(nPrev, sign * hw));
    const b = add(p[i], scale(nNext, sign * hw));
    const den = cross(dPrev, dNext);
    if (Math.abs(den) < EPS) return scale(add(a, b), 0.5);
    const t = cross(sub(b, a), dNext) / den;
    const m = add(a, scale(dPrev, t));
    return len(sub(m, p[i])) > MITER_LIMIT * hw ? scale(add(a, b), 0.5) : m;
  };

  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) {
      const nn = nrm(i === 0 ? dir(0) : dir(n - 2));
      left.push(add(p[i], scale(nn, hw)));
      right.push(sub(p[i], scale(nn, hw)));
      continue;
    }
    const dPrev = dir(i - 1), dNext = dir(i);
    const nPrev = nrm(dPrev), nNext = nrm(dNext);
    const turn = cross(dPrev, dNext);
    if (Math.abs(turn) < EPS) {                       // collinear (or doubling back)
      left.push(add(p[i], scale(nNext, hw)));
      right.push(sub(p[i], scale(nNext, hw)));
    } else if (turn > 0) {                            // counter-clockwise: outer is the right side
      left.push(miter(i, dPrev, dNext, nPrev, nNext, 1));
      right.push(...fan(i, scale(nPrev, -1), scale(nNext, -1)));
    } else {                                          // clockwise: outer is the left side
      left.push(...fan(i, nPrev, nNext));
      right.push(miter(i, dPrev, dNext, nPrev, nNext, -1));
    }
  }

  const capEnd = capArc(p[n - 1], nrm(dir(n - 2)), hw, seg, 1);
  const capStart = capArc(p[0], nrm(dir(0)), hw, seg, -1);
  return { pts: [...left, ...capEnd, ...right.reverse(), ...capStart] };
}

/** Circle → ring. At least 8 points; the step keeps the polygon within `tolMm`. */
export function circleRing(c: Vec2, r: number, tolMm: number): Ring {
  const n = Math.max(8, Math.ceil((2 * Math.PI) / arcStep(r, tolMm)));
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    pts.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
  }
  return { pts };
}
