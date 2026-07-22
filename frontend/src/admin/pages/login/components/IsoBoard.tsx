// IsoBoard — the lively 3D-isometric PCB hero on the brand panel (ported
// verbatim from the v13 design's IsoBoard.jsx). The CIRCUITCENTER chip is ONE
// entity: a floating QFP body on gull-wing leads whose feet sit just OUTSIDE the
// silhouette, rise in +Z, then bend back to the chip edge. Flat green traces
// route to each foot; data packets flow across the board and climb the risers.
// Board-local space 460×320 (x→right, y→down), extruded up in +Z. All styling
// lives in LoginPage.module.scss (rendered inside the hashed .authRoot wrapper),
// so the literal class strings below resolve scoped.
import type { CSSProperties, ReactNode } from 'react';

import IsoBoardSvg from './IsoBoardSvg';
import {
  BOARD_D,
  BOARD_H,
  BOARD_W,
  BX,
  BX2,
  BY,
  BY2,
  CHIP_H,
  CLIMB_DELAYS,
  ELEV,
  FEET,
  FINGERS,
  FLOWS,
  NETS,
  PINS,
  type Pt,
  TW,
} from './isoGeometry';

// The board's geometry (coords, pins, nets, flows) lives in isoGeometry.ts so the
// desktop CSS-3D board (here) and the mobile vector board (IsoBoardSvg) share ONE
// source of truth and can never drift apart.

const lpath = (x1: number, y1: number, x2: number, y2: number) =>
  `M${x1} ${y1} L${x2} ${y1} L${x2} ${y2}`;

// ── Cuboid: top + four side faces ──────────────────────────────────────
function Cube({
  x = 0,
  y = 0,
  w,
  d,
  h,
  cls = '',
  top = null,
  vars,
}: {
  x?: number;
  y?: number;
  w: number;
  d: number;
  h: number;
  cls?: string;
  top?: ReactNode;
  vars?: Record<string, string>;
}) {
  const style = { left: x, top: y, width: w, height: d, '--h': `${h}px`, ...vars } as CSSProperties;
  return (
    <div className={`cube ${cls}`} style={style}>
      <div className="cf cf-top">{top}</div>
      <div className="cf cf-s" />
      <div className="cf cf-n" />
      <div className="cf cf-e" />
      <div className="cf cf-w" />
    </div>
  );
}

// flat orthogonal trace (elbow at x2,y1) with a landing pad
function Trace({
  x1,
  y1,
  x2,
  y2,
  c = 'sig',
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  c?: string;
}) {
  const hx = Math.min(x1, x2);
  const hw = Math.abs(x2 - x1);
  const vy = Math.min(y1, y2);
  const vh = Math.abs(y2 - y1);
  return (
    <>
      {hw > 0 && (
        <div className={`tr tr-${c}`} style={{ left: hx, top: y1 - TW / 2, width: hw + TW, height: TW }} />
      )}
      {vh > 0 && (
        <div className={`tr tr-${c}`} style={{ left: x2 - TW / 2, top: vy, width: TW, height: vh + TW }} />
      )}
      <div className={`via via-${c}`} style={{ left: x2 - 4.5, top: y2 - 4.5 }} />
    </>
  );
}

function Flow({
  x1,
  y1,
  x2,
  y2,
  dur = 3,
  delay = 0,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dur?: number;
  delay?: number;
}) {
  const style = {
    offsetPath: `path('${lpath(x1, y1, x2, y2)}')`,
    animationDuration: `${dur}s`,
    animationDelay: `${delay}s`,
  } as CSSProperties;
  return <div className="flow" style={style} />;
}

// vertical gull-wing riser — thin gold trace carrying a green pulse
function Lead({ x, y, delay = 0 }: { x: number; y: number; delay?: number }) {
  return <Cube x={x - 1.5} y={y - 1.5} w={3} d={3} h={ELEV} cls="c-lead" vars={{ '--ld': `${delay}s` }} />;
}

// gold QFP side-pin — short stub exiting the chip's SIDE face at mid-height
function SidePin({ foot, pin }: { foot: Pt; pin: Pt }) {
  const [fx, fy] = foot;
  const [bx, by] = pin;
  if (fx === bx) {
    // top/bottom edge → vertical stub
    const into = by > fy ? by + 4 : by - 4;
    const top = Math.min(fy, into);
    const h = Math.abs(into - fy);
    return <div className="side-pin" style={{ left: fx - 2.25, top, width: 4.5, height: h }} />;
  }
  // left/right edge → horizontal stub
  const into = bx > fx ? bx + 4 : bx - 4;
  const left = Math.min(fx, into);
  const w = Math.abs(into - fx);
  return <div className="side-pin" style={{ left, top: fy - 2.25, width: w, height: 4.5 }} />;
}

export default function IsoBoard() {
  return (
    <div className="iso-stage" aria-hidden="true">
      <div className="iso-glow" />
      {/* Mobile (<=900px) renders the board as a single vector <svg> (IsoBoardSvg)
          instead of this live CSS-3D scene: at the iPhone's DPR 3 the live
          ~210-layer preserve-3d board re-rasterizes on pinch-zoom and OOM-crashes
          iOS Safari (and the per-frame recomposite flickered). One SVG element does
          neither, stays crisp at any zoom, and keeps the full animation. Hidden on
          desktop, which renders the live board below. */}
      <IsoBoardSvg />
      <div className="iso-scene">
        <div className="iso-shadow" />
        <div className="iso-lift">
          {/* PCB slab */}
          <Cube x={0} y={0} w={BOARD_W} d={BOARD_D} h={BOARD_H} cls="c-board" />

          {/* surface plane — flat traces, components, lead feet, chip unit */}
          <div className="surface">
            <div className="chip-cast" />

            {NETS.map((n, i) => (
              <Trace key={`t${i}`} x1={n[0]} y1={n[1]} x2={n[2]} y2={n[3]} c={n[4]} />
            ))}

            {/* solder pad at every lead foot */}
            {FEET.map(([x, y], i) => (
              <div key={`bp${i}`} className="via via-sig" style={{ left: x - 4.5, top: y - 4.5 }} />
            ))}

            <div className="via via-sig" style={{ left: 110, top: 250 }} />
            <div className="via via-au" style={{ left: 372, top: 110 }} />

            {/* board components (stay low) */}
            <Cube x={336} y={84} w={44} d={44} h={38} cls="c-cap" top={<span className="cap-mark" />} />
            <Cube x={34} y={60} w={74} d={44} h={15} cls="c-ic" top={<span className="ic-dot" />} />
            <Cube x={40} y={244} w={64} d={40} h={13} cls="c-ic" top={<span className="ic-dot" />} />
            <Cube x={398} y={150} w={22} d={22} h={14} cls="c-led" />
            <Cube x={108} y={256} w={14} d={30} h={9} cls="c-res" />
            {FINGERS.map((cx) => (
              <Cube key={`f${cx}`} x={cx - 5.5} y={300} w={11} d={22} h={4} cls="c-gold" />
            ))}

            {FLOWS.map((f, i) => (
              <Flow key={`fl${i}`} x1={f[0]} y1={f[1]} x2={f[2]} y2={f[3]} dur={f[4]} delay={f[5]} />
            ))}

            {/* ── The chip UNIT: leads, gold side-pins, floating body ── */}
            <div className="chip-unit">
              {FEET.map(([x, y], i) => (
                <Lead
                  key={`l${i}`}
                  x={x}
                  y={y}
                  delay={-(CLIMB_DELAYS[i % CLIMB_DELAYS.length] + (i % 3) * 0.5)}
                />
              ))}
              <div className="pin-plane">
                {PINS.map((pin, i) => (
                  <SidePin key={`sp${i}`} foot={FEET[i]} pin={pin} />
                ))}
              </div>
              <div className="chip-elev">
                <Cube
                  x={BX}
                  y={BY}
                  w={BX2 - BX}
                  d={BY2 - BY}
                  h={CHIP_H}
                  cls="c-chip"
                  top={
                    <div className="chip-face">
                      <span className="chip-pin1" />
                      <span className="chip-brand">CIRCUITCENTER</span>
                      <span className="chip-part">U1 &middot; QFP-64</span>
                      <span className="chip-shine" />
                    </div>
                  }
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
