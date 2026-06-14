// isoGeometry — the single source of truth for the login PCB board's geometry and
// its isometric projection. Both renderers consume this: the desktop CSS-3D board
// (IsoBoard.tsx) and the mobile vector board (IsoBoardSvg.tsx). Keeping the numbers
// here means the two boards can never drift apart.
//
// Board-local space is 460×320 (x→right, y→down), extruded up in +Z. The board is
// viewed at a FIXED isometric angle, so we don't need real-time 3D — a fixed
// orthographic projection of these coordinates reproduces the exact look at O(1)
// compositing cost (one SVG element) instead of CSS-3D's ~210 GPU layers.

export type Pt = [number, number];

// ── board-local constants (mirror IsoBoard.tsx) ─────────────────────────────
export const BOARD_W = 460;
export const BOARD_D = 320;
export const BOARD_H = 16; // PCB slab thickness
export const SURFACE_Z = 20; // trace/component plane, lifted just above the slab top

export const ELEV = 50; // gull-wing lead height (how high the chip body floats)
export const BX = 165;
export const BX2 = 295; // chip body left / right edges
export const BY = 102;
export const BY2 = 218; // chip body back / front edges
const LEAD_OUT = 8; // how far each lead foot sits outside the body
export const FL = BX - LEAD_OUT;
export const FR = BX2 + LEAD_OUT; // left / right foot columns
export const FT = BY - LEAD_OUT;
export const FB = BY2 + LEAD_OUT; // top / bottom foot rows
export const TW = 4; // flat-trace thickness

export const CHIP_Z = SURFACE_Z + 39; // .chip-elev translateZ(39)
export const CHIP_H = 22;

// ── chip pins / lead feet ───────────────────────────────────────────────────
const P_TOP: Pt[] = [186, 208, 230, 252, 274].map((x) => [x, BY]);
const P_BOT: Pt[] = [186, 208, 230, 252, 274].map((x) => [x, BY2]);
const P_LFT: Pt[] = [126, 146, 166, 186, 206].map((y) => [BX, y]);
const P_RGT: Pt[] = [126, 146, 166, 186, 206].map((y) => [BX2, y]);
export const PINS: Pt[] = [...P_TOP, ...P_BOT, ...P_LFT, ...P_RGT];

export const footOf = ([x, y]: Pt): Pt => {
  let fx = x;
  let fy = y;
  if (x === BX) fx = FL;
  else if (x === BX2) fx = FR;
  if (y === BY) fy = FT;
  else if (y === BY2) fy = FB;
  return [fx, fy];
};
export const FEET: Pt[] = PINS.map(footOf);

// gold edge-connector fingers (centred under the bottom-edge feet)
export const FINGERS = [186, 208, 230, 252, 274, 300, 322];

// flat nets across the board — every net STARTS at a lead foot (outside body)
export const NETS: [number, number, number, number, string][] = [
  [FR, 126, 348, 126, 'sig'],
  [FR, 146, 392, 168, 'sig'],
  [FR, 166, 388, 166, 'sig'],
  [FR, 186, 322, 308, 'sig'],
  [FR, 206, 300, 308, 'sig'],
  [FL, 126, 110, 80, 'sig'],
  [FL, 146, 110, 104, 'sig'],
  [FL, 166, 60, 166, 'sig'],
  [FL, 186, 92, 232, 'sig'],
  [FL, 206, 66, 236, 'sig'],
  [186, FT, 186, 44, 'sig'],
  [208, FT, 150, 48, 'sig'],
  [230, FT, 230, 44, 'au'],
  [252, FT, 300, 48, 'sig'],
  [186, FB, 186, 308, 'sig'],
  [208, FB, 208, 308, 'sig'],
  [230, FB, 230, 308, 'sig'],
  [252, FB, 252, 308, 'sig'],
  [274, FB, 274, 308, 'sig'],
];

// data packets that travel a net (electron flows): x1,y1,x2,y2,dur,delay
export const FLOWS: [number, number, number, number, number, number][] = [
  [FR, 146, 392, 168, 2.6, 0],
  [FL, 126, 110, 80, 3.1, 0.5],
  [FL, 186, 92, 232, 2.9, 1.1],
  [230, FB, 230, 308, 3.4, 0.3],
  [274, FB, 274, 308, 2.7, 0.8],
  [FR, 206, 300, 308, 3.0, 1.4],
];

// per-lead electron-climb delays, cycled across the 20 gull-wing leads
export const CLIMB_DELAYS = [0, 0.9, 1.3, 0.4, 1.0, 1.6, 0.6, 1.2, 0.3, 1.5];

// ── board components (cuboids on the surface plane) ─────────────────────────
export interface Box {
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  cls: string;
}
export const COMPONENTS: Box[] = [
  { x: 336, y: 84, w: 44, d: 44, h: 38, cls: 'cap' },
  { x: 34, y: 60, w: 74, d: 44, h: 15, cls: 'ic' },
  { x: 40, y: 244, w: 64, d: 40, h: 13, cls: 'ic' },
  { x: 398, y: 150, w: 22, d: 22, h: 14, cls: 'led' },
  { x: 108, y: 256, w: 14, d: 30, h: 9, cls: 'res' },
  ...FINGERS.map((cx): Box => ({ x: cx - 5.5, y: 300, w: 11, d: 22, h: 4, cls: 'gold' })),
];

// ── isometric projection ─────────────────────────────────────────────────────
// Matches the CSS transform `rotateX(56deg) rotateZ(-45deg)` (applied right→left:
// rotateZ first, then rotateX), orthographic (perspective is negligible at 1600px
// and only complicates a fixed-angle drawing). +Z is "up" out of the board plane.
const C45 = Math.SQRT1_2; // cos45 === sin45
const C56 = Math.cos((56 * Math.PI) / 180);
const S56 = Math.sin((56 * Math.PI) / 180);

/** Project a board-local point (x,y,z) to 2-D screen coords [sx, sy]. */
export function project(x: number, y: number, z: number): Pt {
  const x1 = C45 * (x + y); // rotateZ(-45) → screen x
  const y1 = C45 * (y - x); // rotateZ(-45) → intermediate y
  return [x1, C56 * y1 - S56 * z]; // rotateX(56) → screen y
}

/** Painter's-order key: larger = nearer the camera, so draw it later (on top). */
export function depth(x: number, y: number, z: number): number {
  return S56 * (C45 * (y - x)) + C56 * z;
}

/**
 * SVG `transform` matrix that places content authored in board (x,y) coordinates
 * onto the horizontal iso plane at height z. Lets flat surface art (traces, vias,
 * electron paths) be drawn in the same board coords the CSS `.surface` uses, then
 * skewed onto the projection — no per-point projection needed.
 */
export function planeMatrix(z: number): string {
  const a = C45;
  const b = -C56 * C45;
  const c = C45;
  const d = C56 * C45;
  const f = -S56 * z;
  return `matrix(${a.toFixed(5)},${b.toFixed(5)},${c.toFixed(5)},${d.toFixed(5)},0,${f.toFixed(3)})`;
}

export interface Face {
  pts: string; // SVG points attribute "x,y x,y x,y x,y"
  depth: number; // painter's-order key (avg of corners)
  side: 'top' | 's' | 'n' | 'e' | 'w';
}

/** The 5 faces of a cuboid (base at z0, height h), projected + depth-keyed. */
export function boxFaces(x: number, y: number, z0: number, w: number, d: number, h: number): Face[] {
  const z1 = z0 + h;
  const corners = (pts: [number, number, number][]): Face['pts'] =>
    pts.map(([px, py, pz]) => project(px, py, pz).map((n) => n.toFixed(2)).join(',')).join(' ');
  const avgDepth = (pts: [number, number, number][]): number =>
    pts.reduce((s, [px, py, pz]) => s + depth(px, py, pz), 0) / pts.length;
  const mk = (side: Face['side'], pts: [number, number, number][]): Face => ({
    pts: corners(pts),
    depth: avgDepth(pts),
    side,
  });
  return [
    mk('top', [
      [x, y, z1],
      [x + w, y, z1],
      [x + w, y + d, z1],
      [x, y + d, z1],
    ]),
    mk('s', [
      [x, y + d, z0],
      [x + w, y + d, z0],
      [x + w, y + d, z1],
      [x, y + d, z1],
    ]),
    mk('e', [
      [x + w, y, z0],
      [x + w, y + d, z0],
      [x + w, y + d, z1],
      [x + w, y, z1],
    ]),
    mk('n', [
      [x, y, z0],
      [x + w, y, z0],
      [x + w, y, z1],
      [x, y, z1],
    ]),
    mk('w', [
      [x, y, z0],
      [x, y + d, z0],
      [x, y + d, z1],
      [x, y, z1],
    ]),
  ];
}

/** Bounding box of a set of projected points, with padding — for the SVG viewBox. */
export function projectedBounds(points: Pt[], pad = 14): { x: number; y: number; w: number; h: number } {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  return { x: minX, y: minY, w: Math.max(...xs) + pad - minX, h: Math.max(...ys) + pad - minY };
}
