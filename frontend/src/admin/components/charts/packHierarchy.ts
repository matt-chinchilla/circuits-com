/**
 * packHierarchy — dependency-free 2-level circle packing (enclosure / circle packing).
 *
 * Hand-rolled port of the two algorithms behind `d3.pack()`:
 *   • packSiblings — Wang et al. front-chain greedy sibling placement
 *   • packEnclose  — Matousek–Sharir–Welzl smallest-enclosing-circle (move-to-front basis)
 *
 * Fully deterministic: zero use of the platform RNG. packEnclose normally shuffles its
 * input for expected-linear time; here the shuffle is a seeded LCG whose seed is derived
 * from the input length only, so identical input always yields identical output.
 *
 * Guarantees (all covered by the checks in the usage note):
 *   • leaf radius ∝ sqrt(value)  →  bubble AREA ∝ value, with ONE global scale factor
 *   • leaves never overlap and always sit inside their group circle
 *   • group circles never overlap and always sit inside the width × height box
 *   • groups and children come back in INPUT order (stable colours / React keys); each
 *     leaf carries its original `index`
 *   • x/y are ABSOLUTE box coordinates for groups AND leaves — paste straight into
 *     <circle cx cy r>, no nested <g transform> needed
 *   • input is never mutated
 *
 * No imports, no side effects, no DOM. Paste anywhere.
 */

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

export interface PackLeafInput {
  value: number;
}

export interface PackGroupInput {
  name: string;
  children: PackLeafInput[];
}

export interface PackedLeaf {
  x: number;
  y: number;
  r: number;
  /** Index of this leaf in its group's original `children` array. */
  index: number;
}

export interface PackedGroup {
  name: string;
  x: number;
  y: number;
  r: number;
  children: PackedLeaf[];
}

export interface PackHierarchyResult {
  groups: PackedGroup[];
}

export interface PackHierarchyOptions {
  /** Gap between sibling leaves, as a fraction of the mean leaf radius. Default 0.10. */
  leafPadding?: number;
  /** Gap between group circles, as a fraction of the mean group radius. Default 0.06. */
  groupPadding?: number;
  /** Breathing room inside each group circle, as a fraction of its packed radius. Default 0.04. */
  groupInset?: number;
  /** Pixels of empty margin kept inside the width x height box. Default 0. */
  margin?: number;
  /** Radius of a group with no children, as a fraction of the mean leaf radius. Default 0.7. */
  emptyGroupRadius?: number;
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

interface Circle {
  x: number;
  y: number;
  r: number;
}

interface ChainNode {
  c: Circle;
  next: ChainNode;
  prev: ChainNode;
}

/** Deterministic Fisher-Yates using a 32-bit LCG seeded from `seed` (no platform RNG). */
function seededShuffle<T>(input: readonly T[], seed: number): T[] {
  const out = input.slice();
  let s = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

/* ---------- smallest enclosing circle (Welzl / MSW, iterative basis) ---------- */

function enclosesNot(a: Circle, b: Circle): boolean {
  const dr = a.r - b.r;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dr < 0 || dr * dr < dx * dx + dy * dy;
}

function enclosesWeak(a: Circle, b: Circle): boolean {
  const dr = a.r - b.r + Math.max(a.r, b.r, 1) * 1e-9;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dr > 0 && dr * dr > dx * dx + dy * dy;
}

function enclosesWeakAll(a: Circle, B: Circle[]): boolean {
  for (let i = 0; i < B.length; i++) if (!enclosesWeak(a, B[i])) return false;
  return true;
}

function encloseBasis1(a: Circle): Circle {
  return { x: a.x, y: a.y, r: a.r };
}

function encloseBasis2(a: Circle, b: Circle): Circle {
  const x1 = a.x;
  const y1 = a.y;
  const r1 = a.r;
  const x2 = b.x;
  const y2 = b.y;
  const r2 = b.r;
  const x21 = x2 - x1;
  const y21 = y2 - y1;
  const r21 = r2 - r1;
  const l = Math.sqrt(x21 * x21 + y21 * y21);
  // Concentric circles: the larger one already encloses the other.
  if (!(l > 0)) return r1 >= r2 ? encloseBasis1(a) : encloseBasis1(b);
  return {
    x: (x1 + x2 + (x21 / l) * r21) / 2,
    y: (y1 + y2 + (y21 / l) * r21) / 2,
    r: (l + r1 + r2) / 2,
  };
}

function encloseBasis3(a: Circle, b: Circle, c: Circle): Circle {
  const x1 = a.x;
  const y1 = a.y;
  const r1 = a.r;
  const x2 = b.x;
  const y2 = b.y;
  const r2 = b.r;
  const x3 = c.x;
  const y3 = c.y;
  const r3 = c.r;
  const a2 = x1 - x2;
  const a3 = x1 - x3;
  const b2 = y1 - y2;
  const b3 = y1 - y3;
  const c2 = r2 - r1;
  const c3 = r3 - r1;
  const d1 = x1 * x1 + y1 * y1 - r1 * r1;
  const d2 = d1 - x2 * x2 - y2 * y2 + r2 * r2;
  const d3 = d1 - x3 * x3 - y3 * y3 + r3 * r3;
  const ab = a3 * b2 - a2 * b3;
  if (ab === 0) return encloseBasis2(encloseBasis2(a, b), c); // collinear degeneracy
  const xa = (b2 * d3 - b3 * d2) / (ab * 2) - x1;
  const xb = (b3 * c2 - b2 * c3) / ab;
  const ya = (a3 * d2 - a2 * d3) / (ab * 2) - y1;
  const yb = (a2 * c3 - a3 * c2) / ab;
  const A = xb * xb + yb * yb - 1;
  const B = 2 * (r1 + xa * xb + ya * yb);
  const C = xa * xa + ya * ya - r1 * r1;
  const r = -(Math.abs(A) > 1e-6 ? (B + Math.sqrt(B * B - 4 * A * C)) / (2 * A) : C / B);
  if (!Number.isFinite(r)) return encloseBasis2(encloseBasis2(a, b), c);
  return { x: x1 + xa + xb * r, y: y1 + ya + yb * r, r };
}

function encloseBasis(B: Circle[]): Circle {
  if (B.length === 1) return encloseBasis1(B[0]);
  if (B.length === 2) return encloseBasis2(B[0], B[1]);
  return encloseBasis3(B[0], B[1], B[2]);
}

function extendBasis(B: Circle[], p: Circle): Circle[] {
  if (enclosesWeakAll(p, B)) return [p];

  for (let i = 0; i < B.length; i++) {
    if (enclosesNot(p, B[i]) && enclosesWeakAll(encloseBasis2(B[i], p), B)) {
      return [B[i], p];
    }
  }

  for (let i = 0; i < B.length - 1; i++) {
    for (let j = i + 1; j < B.length; j++) {
      if (
        enclosesNot(encloseBasis2(B[i], B[j]), p) &&
        enclosesNot(encloseBasis2(B[i], p), B[j]) &&
        enclosesNot(encloseBasis2(B[j], p), B[i]) &&
        enclosesWeakAll(encloseBasis3(B[i], B[j], p), B)
      ) {
        return [B[i], B[j], p];
      }
    }
  }

  // Numerically degenerate input — signal the caller to use the naive fallback.
  // (d3 throws here; a chart in an admin panel should degrade instead.)
  return [];
}

/** Naive (never-fails) enclosing circle: centroid + farthest rim. */
function naiveEnclose(circles: readonly Circle[]): Circle {
  if (circles.length === 0) return { x: 0, y: 0, r: 0 };
  let sx = 0;
  let sy = 0;
  for (const c of circles) {
    sx += c.x;
    sy += c.y;
  }
  const x = sx / circles.length;
  const y = sy / circles.length;
  let r = 0;
  for (const c of circles) {
    const d = Math.sqrt((c.x - x) * (c.x - x) + (c.y - y) * (c.y - y)) + c.r;
    if (d > r) r = d;
  }
  return { x, y, r };
}

/** Grow `e` if floating-point drift left anything poking out. Cheap O(n) insurance. */
function ensureEncloses(e: Circle, circles: readonly Circle[]): Circle {
  let r = e.r;
  for (const c of circles) {
    const d = Math.sqrt((c.x - e.x) * (c.x - e.x) + (c.y - e.y) * (c.y - e.y)) + c.r;
    if (d > r) r = d;
  }
  return r > e.r ? { x: e.x, y: e.y, r } : e;
}

/** Smallest circle enclosing all input circles. Deterministic. */
export function packEnclose(circles: readonly Circle[]): Circle {
  const n = circles.length;
  if (n === 0) return { x: 0, y: 0, r: 0 };
  if (n === 1) return encloseBasis1(circles[0]);

  const shuffled = seededShuffle(circles, n * 2654435761);
  let B: Circle[] = [];
  let e: Circle | null = null;
  let i = 0;
  let guard = 0;
  const maxSteps = 32 * n * n + 4096; // hard stop; MSW is expected-linear, never this slow

  while (i < n) {
    if (++guard > maxSteps) return naiveEnclose(circles);
    const p = shuffled[i];
    if (e && enclosesWeak(e, p)) {
      i++;
    } else {
      const nb = extendBasis(B, p);
      if (nb.length === 0) return naiveEnclose(circles);
      B = nb;
      e = encloseBasis(B);
      i = 0;
    }
  }

  if (!e || !Number.isFinite(e.r) || !Number.isFinite(e.x) || !Number.isFinite(e.y)) {
    return naiveEnclose(circles);
  }
  return e;
}

/* ---------- front-chain sibling packing ---------- */

/** Place `c` externally tangent to both `a` and `b`. */
function place(b: Circle, a: Circle, c: Circle): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  if (d2) {
    let a2 = a.r + c.r;
    a2 *= a2;
    let b2 = b.r + c.r;
    b2 *= b2;
    if (a2 > b2) {
      const x = (d2 + b2 - a2) / (2 * d2);
      const y = Math.sqrt(Math.max(0, b2 / d2 - x * x));
      c.x = b.x - x * dx - y * dy;
      c.y = b.y - x * dy + y * dx;
    } else {
      const x = (d2 + a2 - b2) / (2 * d2);
      const y = Math.sqrt(Math.max(0, a2 / d2 - x * x));
      c.x = a.x + x * dx - y * dy;
      c.y = a.y + x * dy + y * dx;
    }
  } else {
    c.x = a.x + c.r;
    c.y = a.y;
  }
}

function intersects(a: Circle, b: Circle): boolean {
  const dr = a.r + b.r - 1e-6;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dr > 0 && dr * dr > dx * dx + dy * dy;
}

/** Distance-from-centroid score used to pick the next pair on the front chain. */
function score(node: ChainNode): number {
  const a = node.c;
  const b = node.next.c;
  const ab = a.r + b.r;
  if (!(ab > 0)) return 0;
  const dx = (a.x * b.r + b.x * a.r) / ab;
  const dy = (a.y * b.r + b.y * a.r) / ab;
  return dx * dx + dy * dy;
}

function chainNode(c: Circle): ChainNode {
  const n = { c } as ChainNode;
  n.next = n;
  n.prev = n;
  return n;
}

/**
 * Deterministic last-resort placement for circles the front chain never seated.
 * Only reachable if the chain search blows its step budget (it shouldn't) — this
 * exists so a pathological input degrades visually instead of freezing the tab.
 */
function ringFallback(circles: Circle[], from: number): void {
  let ring = 0;
  for (let i = 0; i < from; i++) {
    const c = circles[i];
    const d = Math.sqrt(c.x * c.x + c.y * c.y) + c.r;
    if (d > ring) ring = d;
  }
  let theta = 0;
  for (let i = from; i < circles.length; i++) {
    const c = circles[i];
    const step = 2 * Math.asin(Math.min(1, c.r / (ring + c.r))) + 1e-3;
    if (theta + step > 2 * Math.PI) {
      ring += 2 * c.r;
      theta = 0;
    }
    const rr = ring + c.r;
    c.x = rr * Math.cos(theta + step / 2);
    c.y = rr * Math.sin(theta + step / 2);
    theta += step;
  }
}

/**
 * Packs `circles` (mutating their x/y) around the origin, tangentially and without
 * overlap, and returns the radius of the smallest circle enclosing the result.
 * Pack biggest-first for the classic "big in the middle" look.
 */
export function packSiblings(circles: Circle[]): number {
  const n = circles.length;
  if (n === 0) return 0;

  // 1 circle.
  let c0 = circles[0];
  c0.x = 0;
  c0.y = 0;
  if (n === 1) return c0.r;

  // 2 circles, side by side, centred on the origin.
  const c1 = circles[1];
  c0.x = -c1.r;
  c1.x = c0.r;
  c1.y = 0;
  if (n === 2) return c0.r + c1.r;

  // 3rd circle tangent to the first two.
  place(c1, c0, circles[2]);

  let a = chainNode(c0);
  let b = chainNode(c1);
  let c = chainNode(circles[2]);
  a.next = c.prev = b;
  b.next = a.prev = c;
  c.next = b.prev = a;

  let budget = 8 * n + 1024; // chain-churn stop; see ringFallback

  pack: for (let i = 3; i < n; i++) {
    place(a.c, b.c, circles[i]);
    c = chainNode(circles[i]);

    // Walk the front chain outward from the a/b pair, nearest-first, looking for an overlap.
    let j = b.next;
    let k = a.prev;
    let sj = b.c.r;
    let sk = a.c.r;
    do {
      if (sj <= sk) {
        if (intersects(j.c, c.c)) {
          b = j;
          a.next = b;
          b.prev = a;
          i--;
          if (--budget < 0) {
            ringFallback(circles, i + 1);
            break pack;
          }
          continue pack;
        }
        sj += j.c.r;
        j = j.next;
      } else {
        if (intersects(k.c, c.c)) {
          a = k;
          a.next = b;
          b.prev = a;
          i--;
          if (--budget < 0) {
            ringFallback(circles, i + 1);
            break pack;
          }
          continue pack;
        }
        sk += k.c.r;
        k = k.prev;
      }
    } while (j !== k.next);

    // No overlap: splice c into the chain between a and b.
    c.prev = a;
    c.next = b;
    a.next = b.prev = c;

    // Re-seed the a/b pair with the chain pair closest to the centroid.
    b = c;
    let best = score(a);
    let cur = c.next;
    while (cur !== b) {
      const s = score(cur);
      if (s < best) {
        a = cur;
        best = s;
      }
      cur = cur.next;
    }
    b = a.next;
  }

  // The enclosing circle of the front chain encloses everything; verify, then centre.
  const front: Circle[] = [b.c];
  let cur = b.next;
  while (cur !== b) {
    front.push(cur.c);
    cur = cur.next;
  }
  const e = ensureEncloses(packEnclose(front), circles);

  for (let i = 0; i < n; i++) {
    c0 = circles[i];
    c0.x -= e.x;
    c0.y -= e.y;
  }
  return e.r;
}

/* ------------------------------------------------------------------ *
 * The 2-level entry point
 * ------------------------------------------------------------------ */

/**
 * Two-level circle packing: leaves inside their group circle, group circles inside the box.
 * Generic so you can pass your real row types (extra fields on groups/leaves are fine).
 */
export function packHierarchy<
  L extends { value: number },
  G extends { name: string; children: readonly L[] },
>(
  groups: readonly G[],
  width: number,
  height: number,
  options: PackHierarchyOptions = {},
): PackHierarchyResult {
  const leafPadding = options.leafPadding ?? 0.1;
  const groupPadding = options.groupPadding ?? 0.06;
  const groupInset = options.groupInset ?? 0.04;
  const margin = options.margin ?? 0;
  const emptyGroupRadius = options.emptyGroupRadius ?? 0.7;

  const w = Number.isFinite(width) ? width : 0;
  const h = Number.isFinite(height) ? height : 0;
  const boxW = Math.max(0, w - margin * 2);
  const boxH = Math.max(0, h - margin * 2);
  const cx = w / 2;
  const cy = h / 2;

  if (!groups.length || boxW <= 0 || boxH <= 0) return { groups: [] };

  // ---- leaf radii: r ∝ sqrt(value) ----
  const radii: number[][] = groups.map((g) =>
    (g.children ?? []).map((leaf) => {
      const v = leaf && Number.isFinite(leaf.value) && leaf.value > 0 ? leaf.value : 0;
      return Math.sqrt(v);
    }),
  );

  let sum = 0;
  let count = 0;
  let maxLeaf = 0;
  for (const rs of radii) {
    for (const r of rs) {
      sum += r;
      count++;
      if (r > maxLeaf) maxLeaf = r;
    }
  }
  const meanLeaf = count > 0 && sum > 0 ? sum / count : 1;
  // Floor keeps zero/near-zero values from collapsing the packer into coincident points.
  const minLeaf = Math.max(maxLeaf, meanLeaf) * 1e-3;
  const leafPad = meanLeaf * leafPadding;

  // ---- level 1: pack each group's leaves in its own frame, centred on (0,0) ----
  interface WorkGroup {
    name: string;
    circle: Circle;
    leaves: { c: Circle; index: number }[];
  }

  const work: WorkGroup[] = groups.map((g, gi) => {
    const leaves = radii[gi].map((r, index) => ({
      c: { x: 0, y: 0, r: Math.max(r, minLeaf) },
      index,
    }));

    // Fallbacks: 0 children -> placeholder dot; 1 child -> dead centre.
    if (leaves.length === 0) {
      return {
        name: g.name,
        circle: { x: 0, y: 0, r: Math.max(meanLeaf * emptyGroupRadius, minLeaf) },
        leaves: [],
      };
    }
    if (leaves.length === 1) {
      return {
        name: g.name,
        circle: { x: 0, y: 0, r: (leaves[0].c.r + leafPad) * (1 + groupInset) },
        leaves,
      };
    }

    // Biggest-first gives the stable "large in the middle" packing.
    const inflated = leaves
      .slice()
      .sort((p, q) => q.c.r - p.c.r || p.index - q.index)
      .map((l) => l.c);
    for (const cc of inflated) cc.r += leafPad; // pad by inflating…
    const packedR = packSiblings(inflated);
    for (const cc of inflated) cc.r -= leafPad; // …then deflate for clean gutters

    return {
      name: g.name,
      circle: { x: 0, y: 0, r: packedR * (1 + groupInset) },
      leaves,
    };
  });

  // ---- level 2: pack the group circles ----
  if (work.length === 1) {
    work[0].circle.x = 0;
    work[0].circle.y = 0;
  } else {
    let gsum = 0;
    for (const wg of work) gsum += wg.circle.r;
    const groupPad = (gsum / work.length) * groupPadding;

    const order = work
      .map((wg, i) => ({ wg, i }))
      .sort((p, q) => q.wg.circle.r - p.wg.circle.r || p.i - q.i)
      .map((e) => e.wg.circle);

    for (const cc of order) cc.r += groupPad;
    packSiblings(order);
    for (const cc of order) cc.r -= groupPad;
  }

  // ---- scale to fit + translate to box centre ----
  // Measured from the real (de-padded) extent so the chart fills the box exactly.
  let extent = 0;
  for (const wg of work) {
    const d = Math.sqrt(wg.circle.x * wg.circle.x + wg.circle.y * wg.circle.y) + wg.circle.r;
    if (d > extent) extent = d;
  }
  const k = extent > 0 ? Math.min(boxW, boxH) / (2 * extent) : 0;

  return {
    groups: work.map((wg) => {
      const gx = cx + wg.circle.x * k;
      const gy = cy + wg.circle.y * k;
      return {
        name: wg.name,
        x: gx,
        y: gy,
        r: wg.circle.r * k,
        children: wg.leaves.map((l) => ({
          x: gx + l.c.x * k,
          y: gy + l.c.y * k,
          r: l.c.r * k,
          index: l.index,
        })),
      };
    }),
  };
}
