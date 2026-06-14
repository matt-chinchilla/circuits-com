// IsoBoard — the lively 3D-isometric PCB hero on the brand panel (ported
// verbatim from the v13 design's IsoBoard.jsx). The CIRCUITS.COM chip is ONE
// entity: a floating QFP body on gull-wing leads whose feet sit just OUTSIDE the
// silhouette, rise in +Z, then bend back to the chip edge. Flat green traces
// route to each foot; data packets flow across the board and climb the risers.
// Board-local space 460×320 (x→right, y→down), extruded up in +Z. All styling
// lives in LoginPage.module.scss (rendered inside the hashed .authRoot wrapper),
// so the literal class strings below resolve scoped.
import type { CSSProperties, ReactNode } from 'react';

const ELEV = 50; // lead height — how high the chip body floats
const BX = 165;
const BX2 = 295; // chip body left / right edges
const BY = 102;
const BY2 = 218; // chip body back / front edges
const LEAD_OUT = 8; // how far each lead foot sits outside the body
const FL = BX - LEAD_OUT;
const FR = BX2 + LEAD_OUT; // left / right foot columns
const FT = BY - LEAD_OUT;
const FB = BY2 + LEAD_OUT; // top / bottom foot rows

type Pt = [number, number];

const lpath = (x1: number, y1: number, x2: number, y2: number) =>
  `M${x1} ${y1} L${x2} ${y1} L${x2} ${y2}`;

// Flat-trace thickness (px). The horizontal and vertical segments BOTH use it,
// so they always render the same thickness; 4 (vs the old 3) gives the flat
// traces the visual weight of the gold Z-risers, esp. at the 0.58 mobile scale.
const TW = 4;

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

// ── Body-edge attach points (where each lead meets the chip) ────────────
const P_TOP: Pt[] = [186, 208, 230, 252, 274].map((x) => [x, BY]);
const P_BOT: Pt[] = [186, 208, 230, 252, 274].map((x) => [x, BY2]);
const P_LFT: Pt[] = [126, 146, 166, 186, 206].map((y) => [BX, y]);
const P_RGT: Pt[] = [126, 146, 166, 186, 206].map((y) => [BX2, y]);
const PINS: Pt[] = [...P_TOP, ...P_BOT, ...P_LFT, ...P_RGT];

// foot point (on board, just outside the body) for an attach point
const footOf = ([x, y]: Pt): Pt => {
  let fx = x;
  let fy = y;
  if (x === BX) fx = FL;
  else if (x === BX2) fx = FR;
  if (y === BY) fy = FT;
  else if (y === BY2) fy = FB;
  return [fx, fy];
};
const FEET: Pt[] = PINS.map(footOf);

// gold edge-connector fingers — centred under the bottom-edge feet
const FINGERS = [186, 208, 230, 252, 274, 300, 322];

// flat nets across the board — every net STARTS at a lead foot (outside body)
const NETS: [number, number, number, number, string][] = [
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

const FLOWS: [number, number, number, number, number, number][] = [
  [FR, 146, 392, 168, 2.6, 0],
  [FL, 126, 110, 80, 3.1, 0.5],
  [FL, 186, 92, 232, 2.9, 1.1],
  [230, FB, 230, 308, 3.4, 0.3],
  [274, FB, 274, 308, 2.7, 0.8],
  [FR, 206, 300, 308, 3.0, 1.4],
];

// climb the clearly-visible front + right riser columns
const CLIMB_DELAYS = [0, 0.9, 1.3, 0.4, 1.0, 1.6, 0.6, 1.2, 0.3, 1.5];

export default function IsoBoard() {
  return (
    <div className="iso-stage" aria-hidden="true">
      <div className="iso-glow" />
      <div className="iso-scene">
        <div className="iso-shadow" />
        <div className="iso-lift">
          {/* PCB slab */}
          <Cube x={0} y={0} w={460} d={320} h={16} cls="c-board" />

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
                  h={22}
                  cls="c-chip"
                  top={
                    <div className="chip-face">
                      <span className="chip-pin1" />
                      <span className="chip-brand">CIRCUITS.COM</span>
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
