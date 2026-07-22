// IsoBoardSvg — the mobile board, rendered as ONE vector <svg> instead of the
// desktop CSS-3D board's ~210 GPU layers. The board is a fixed isometric angle, so
// a static projection of the same geometry reproduces the look at O(1) compositing
// cost: pinch-zoom re-rasters a single vector element (crisp, no OOM crash) and
// there's no preserve-3d subtree to re-composite each frame (no flicker). All
// geometry + the projection live in isoGeometry.ts (shared, so it can't drift from
// the desktop board). Animations (float, flowing electrons) are plain CSS.
import { useMemo } from 'react';

import {
  BOARD_D,
  BOARD_H,
  BOARD_W,
  type Box,
  type Face,
  boxFaces,
  BX,
  BX2,
  BY,
  BY2,
  CHIP_H,
  CHIP_Z,
  COMPONENTS,
  depth,
  ELEV,
  FEET,
  FLOWS,
  NETS,
  planeMatrix,
  project,
  projectedBounds,
  type Pt,
  SURFACE_Z,
  TW,
} from './isoGeometry';

// flat orthogonal trace path in board coords (elbow at x2,y1) — matches IsoBoard
const lpath = (x1: number, y1: number, x2: number, y2: number) =>
  `M${x1} ${y1} L${x2} ${y1} L${x2} ${y2}`;

// side-face fill by component class (top faces use the gradients in <defs>)
const SIDE_FILL: Record<string, { sn: string; ew: string }> = {
  board: { sn: '#061d12', ew: '#0a3019' },
  cap: { sn: '#14181a', ew: '#1d2225' },
  ic: { sn: '#05090a', ew: '#0b110e' },
  led: { sn: '#1f5e16', ew: '#2a7a1c' },
  res: { sn: '#16150f', ew: '#1e1c15' },
  gold: { sn: '#8f7227', ew: '#a8862f' },
  lead: { sn: '#b7912f', ew: '#cda33c' },
  chip: { sn: '#1b231e', ew: '#222c25' },
};

function faceFill(cls: string, side: Face['side']): string {
  if (side === 'top') return `url(#t-${cls})`;
  const f = SIDE_FILL[cls] ?? SIDE_FILL.ic;
  return side === 's' || side === 'n' ? f.sn : f.ew;
}

type Drawable =
  | { depth: number; kind: 'face'; cls: string; face: Face }
  | { depth: number; kind: 'cap' };

function boxDrawables(b: Box, z0: number): Drawable[] {
  return boxFaces(b.x, b.y, z0, b.w, b.d, b.h).map(
    (face): Drawable => ({ depth: face.depth, kind: 'face', cls: b.cls, face }),
  );
}

// The electrolytic cap is a CYLINDER, not a cuboid: a horizontal circle projects
// to an axis-aligned ellipse (rx = r, ry = r·cos56°) and +z only shifts it up in
// screen-y, so the body is just a wall rect between the two tangent ellipses.
const RY_K = Math.cos((56 * Math.PI) / 180); // ellipse minor-axis factor
function CapCylinder() {
  const cap = COMPONENTS.find((c) => c.cls === 'cap');
  if (!cap) return null;
  const cx = cap.x + cap.w / 2;
  const cy = cap.y + cap.d / 2;
  const rx = cap.w / 2;
  const ry = rx * RY_K;
  const sx = project(cx, cy, 0)[0];
  const topY = project(cx, cy, SURFACE_Z + cap.h)[1];
  const botY = project(cx, cy, SURFACE_Z)[1];
  return (
    <g>
      <ellipse cx={sx} cy={botY} rx={rx} ry={ry} fill="#23282b" />
      <rect x={sx - rx} y={topY} width={rx * 2} height={botY - topY} fill="url(#t-cap-side)" />
      <ellipse cx={sx} cy={topY} rx={rx} ry={ry} fill="url(#t-cap)" />
      <ellipse cx={sx} cy={topY} rx={rx} ry={ry} fill="none" stroke="rgba(0,0,0,0.3)" strokeWidth={1.3} />
      <line x1={sx - rx * 0.78} y1={topY} x2={sx + rx * 0.78} y2={topY} stroke="rgba(18,18,20,0.5)" strokeWidth={1.6} />
    </g>
  );
}

export default function IsoBoardSvg() {
  const scene = useMemo(() => {
    // ── raised boxes: components (on the surface) + gull-wing leads + the chip ──
    const raised: Drawable[] = [];
    for (const c of COMPONENTS) {
      if (c.cls === 'cap') {
        raised.push({ depth: depth(c.x + c.w / 2, c.y + c.d / 2, SURFACE_Z + c.h / 2), kind: 'cap' });
        continue;
      }
      raised.push(...boxDrawables(c, SURFACE_Z));
    }
    for (const [fx, fy] of FEET) {
      raised.push(...boxDrawables({ x: fx - 1.5, y: fy - 1.5, w: 3, d: 3, h: ELEV, cls: 'lead' }, SURFACE_Z));
    }
    raised.push(...boxDrawables({ x: BX, y: BY, w: BX2 - BX, d: BY2 - BY, h: CHIP_H, cls: 'chip' }, CHIP_Z));
    raised.sort((a, b) => a.depth - b.depth);

    // ── board slab (drawn first, under everything) ──
    const slab = boxFaces(0, 0, 0, BOARD_W, BOARD_D, BOARD_H)
      .map((face) => ({ depth: face.depth, cls: 'board', face }))
      .sort((a, b) => a.depth - b.depth);

    // ── viewBox: project every extreme point so the art always fits ──
    const pts: Pt[] = [];
    const corners = (x: number, y: number, z0: number, w: number, d: number, h: number) => {
      for (const [px, py, pz] of [
        [x, y, z0],
        [x + w, y, z0],
        [x + w, y + d, z0],
        [x, y + d, z0],
        [x, y, z0 + h],
        [x + w, y, z0 + h],
        [x + w, y + d, z0 + h],
        [x, y + d, z0 + h],
      ] as const)
        pts.push(project(px, py, pz));
    };
    corners(0, 0, 0, BOARD_W, BOARD_D, BOARD_H);
    for (const c of COMPONENTS) corners(c.x, c.y, SURFACE_Z, c.w, c.d, c.h);
    corners(BX, BY, CHIP_Z, BX2 - BX, BY2 - BY, CHIP_H);
    for (const [fx, fy] of FEET) corners(fx - 1.5, fy - 1.5, SURFACE_Z, 3, 3, ELEV);
    const vb = projectedBounds(pts, 16);

    return { raised, slab, viewBox: `${vb.x.toFixed(1)} ${vb.y.toFixed(1)} ${vb.w.toFixed(1)} ${vb.h.toFixed(1)}` };
  }, []);

  const surfaceT = planeMatrix(SURFACE_Z);
  const chipFaceT = planeMatrix(CHIP_Z + CHIP_H);

  return (
    <svg className="iso-svg" viewBox={scene.viewBox} aria-hidden="true" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="t-board" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#125c3a" />
          <stop offset="0.55" stopColor="#0b3f28" />
          <stop offset="1" stopColor="#0a3a25" />
        </linearGradient>
        <radialGradient id="t-cap" cx="0.38" cy="0.34" r="0.75">
          <stop offset="0" stopColor="#7d858a" />
          <stop offset="0.45" stopColor="#4a5054" />
          <stop offset="1" stopColor="#23282b" />
        </radialGradient>
        <linearGradient id="t-cap-side" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#1a1e20" />
          <stop offset="0.5" stopColor="#565d62" />
          <stop offset="1" stopColor="#1a1e20" />
        </linearGradient>
        <linearGradient id="t-ic" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1c2420" />
          <stop offset="1" stopColor="#0e1410" />
        </linearGradient>
        <radialGradient id="t-led" cx="0.5" cy="0.5" r="0.6">
          <stop offset="0" stopColor="#c7ff8d" />
          <stop offset="0.55" stopColor="#5fdc2d" />
          <stop offset="1" stopColor="#2f8a1a" />
        </radialGradient>
        <linearGradient id="t-res" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#2c2b22" />
          <stop offset="0.3" stopColor="#3a3830" />
          <stop offset="1" stopColor="#23221c" />
        </linearGradient>
        <linearGradient id="t-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e6c662" />
          <stop offset="1" stopColor="#c79f42" />
        </linearGradient>
        <linearGradient id="t-lead" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f7e6a4" />
          <stop offset="1" stopColor="#e0b94e" />
        </linearGradient>
        <radialGradient id="t-chip" cx="0.3" cy="0.2" r="0.95">
          <stop offset="0" stopColor="#2c3631" />
          <stop offset="0.46" stopColor="#1a221d" />
          <stop offset="1" stopColor="#0d1310" />
        </radialGradient>
        <radialGradient id="g-via" cx="0.4" cy="0.4" r="0.6">
          <stop offset="0.25" stopColor="#fff4cf" />
          <stop offset="0.6" stopColor="#e6c662" />
          <stop offset="1" stopColor="#9c7a2a" />
        </radialGradient>
        <radialGradient id="g-elec" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.35" stopColor="#d6ffb0" />
          <stop offset="0.6" stopColor="#7cff45" stopOpacity="0.55" />
          <stop offset="1" stopColor="#7cff45" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="g-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#44bd13" stopOpacity="0.28" />
          <stop offset="0.5" stopColor="#44bd13" stopOpacity="0.08" />
          <stop offset="1" stopColor="#44bd13" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="g-led-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#7cff45" stopOpacity="0.7" />
          <stop offset="0.45" stopColor="#5aec45" stopOpacity="0.25" />
          <stop offset="1" stopColor="#5aec45" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* ambient board glow (pre-baked, no filter) */}
      <ellipse cx={project(BOARD_W / 2, BOARD_D / 2, 0)[0]} cy={project(BOARD_W / 2, BOARD_D / 2, 0)[1]} rx={260} ry={150} fill="url(#g-glow)" />

      <g className="iso-svg-lift">
        {/* 1 — PCB slab */}
        {scene.slab.map((d, i) => (
          <polygon key={`slab${i}`} points={d.face.pts} fill={faceFill('board', d.face.side)} />
        ))}

        {/* 2 — flat surface layer: traces + vias (board coords on the surface plane) */}
        <g transform={surfaceT}>
          {NETS.map((n, i) => {
            const [x1, y1, x2, y2] = n;
            const hx = Math.min(x1, x2);
            const hw = Math.abs(x2 - x1);
            const vy = Math.min(y1, y2);
            const vh = Math.abs(y2 - y1);
            const glow = 'rgba(232,200,98,0.20)'; // soft gold halo (no filter = mobile-safe)
            return (
              <g key={`net${i}`}>
                {hw > 0 && <rect x={hx - 2} y={y1 - TW / 2 - 3} width={hw + TW + 4} height={TW + 6} rx={4} fill={glow} />}
                {vh > 0 && <rect x={x2 - TW / 2 - 3} y={vy - 2} width={TW + 6} height={vh + TW + 4} rx={4} fill={glow} />}
                {hw > 0 && <rect x={hx} y={y1 - TW / 2} width={hw + TW} height={TW} rx={1.5} fill="url(#t-gold)" />}
                {vh > 0 && <rect x={x2 - TW / 2} y={vy} width={TW} height={vh + TW} rx={1.5} fill="url(#t-gold)" />}
                <circle cx={x2} cy={y2} r={4.2} fill="url(#g-via)" />
              </g>
            );
          })}
          {FEET.map(([x, y], i) => (
            <circle key={`pad${i}`} cx={x} cy={y} r={4.2} fill="url(#g-via)" />
          ))}
        </g>

        {/* 3 — raised boxes: components, leads, floating chip (depth-sorted) */}
        {scene.raised.map((d, i) =>
          d.kind === 'cap' ? (
            <CapCylinder key={`box${i}`} />
          ) : (
            <polygon key={`box${i}`} points={d.face.pts} fill={faceFill(d.cls, d.face.side)} />
          ),
        )}

        {/* LED emissive halo (pre-baked radial — no filter) */}
        <ellipse cx={project(409, 161, SURFACE_Z + 14)[0]} cy={project(409, 161, SURFACE_Z + 14)[1]} rx={30} ry={22} fill="url(#g-led-glow)" />

        {/* chip face label, skewed onto the chip top plane */}
        <g transform={chipFaceT} fill="#d6fac4" fontFamily="ui-monospace, 'SF Mono', Menlo, monospace">
          <text x={(BX + BX2) / 2} y={(BY + BY2) / 2 - 2} textAnchor="middle" fontSize="14" fontWeight="700" letterSpacing="0.5">
            CIRCUITCENTER
          </text>
          <text x={(BX + BX2) / 2} y={(BY + BY2) / 2 + 16} textAnchor="middle" fontSize="9" fill="#8fc88c" letterSpacing="0.5">
            U1 · QFP-64
          </text>
        </g>

        {/* 4 — flowing electrons (on the surface plane, drawn on top) */}
        <g transform={surfaceT}>
          {FLOWS.map((f, i) => {
            const [x1, y1, x2, y2, dur, delay] = f;
            return (
              <circle
                key={`flow${i}`}
                className="iso-svg-flow"
                r={5.5}
                fill="url(#g-elec)"
                style={{
                  offsetPath: `path('${lpath(x1, y1, x2, y2)}')`,
                  animationDuration: `${dur}s`,
                  animationDelay: `${delay}s`,
                }}
              />
            );
          })}
        </g>
      </g>
    </svg>
  );
}
