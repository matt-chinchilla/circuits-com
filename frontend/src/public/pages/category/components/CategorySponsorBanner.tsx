import { useState, useRef, useEffect, useCallback, type ReactNode, type KeyboardEvent, type CSSProperties } from 'react';
import { motion } from 'framer-motion';
import type { Sponsor } from '@public/types/sponsor';
import styles from './CategorySponsorBanner.module.scss';

interface CategorySponsorBannerProps {
  sponsor: Sponsor | null;
  categoryName?: string;
}

type NetId = 'p1' | 'p2' | 'p3' | 'p4';

const NET_ENERGIZE_MS = 4500;

// Each chip occupies one of 4 equal columns in the .rail. The viewBox is
// 1100 units wide so each chip column is 275 units; center-x per chip ≈
// 137 / 412 / 687 / 962. PRESERVED v11→v12 (HTML chip layout depends on these).
const CHIP_X = { p1: 137, p2: 412, p3: 687, p4: 962 } as const;

// SVG viewBox is 1100 wide. We map every CHIP_X to its `% of rail width`
// equivalent so the HTML chip's CSS left coordinate matches the SVG path's
// trace endpoint x at every rail width.
const VIEWBOX_W = 1100;
const CHIP_BODY_VU = 240; // chip silhouette width in viewBox units (PRESERVED)

// v12 per-chip ASYMMETRIC pin slots (each chip exposes 6 pin tabs at
// dx={-50,-30,-10,+10,+30,+50}). HTML chip pin tabs use this slot list for
// CSS-left positioning — the SVG drop routing is per-chip-unique (see Net
// functions below). Slot list ITSELF stays symmetric so the chip silhouette
// reads as a real DIP; the asymmetry lives in the SVG routing each pin uses.
const CHIP_PIN_DX = [-50, -30, -10, 10, 30, 50] as const;

// v12.2 strip geometry — viewBox height + bus y-coords centralized. The bus
// values are referenced by the bus <line> elements + bus-tap vias in BoardArt
// and BottomBoardArt. Per-Net-function path d-strings still spell their own
// y-literals (each Manhattan elbow has unique chamfer geometry not worth
// abstracting); centralizing only the bus terminals makes the next strip
// redistribution safe at the infrastructure level.
const STRIP_H = 53;
const BUS_Y_TOP = { vcc: 6, sda: 22, scl: 38 } as const;
const BUS_Y_BOT = { gnd: 47, osc: 22, pwrIn: 36 } as const;

const CHIP_CX_PCT: Readonly<Record<NetId, string>> = {
  p1: `${(CHIP_X.p1 / VIEWBOX_W) * 100}%`,
  p2: `${(CHIP_X.p2 / VIEWBOX_W) * 100}%`,
  p3: `${(CHIP_X.p3 / VIEWBOX_W) * 100}%`,
  p4: `${(CHIP_X.p4 / VIEWBOX_W) * 100}%`,
};
const CHIP_W_PCT = `${(CHIP_BODY_VU / VIEWBOX_W) * 100}%`;
function chipStyle(net: NetId): CSSProperties {
  return {
    ['--cx-pct' as never]: CHIP_CX_PCT[net],
    ['--cw-pct' as never]: CHIP_W_PCT,
  };
}

function lettermark(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'SP';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function SponsorMedallion({ company, imageUrl }: { company: string; imageUrl: string | null | undefined }) {
  const [failed, setFailed] = useState(false);
  const src = imageUrl?.trim() || '';
  if (!src || failed) {
    return <span className={styles.mark}>{lettermark(company)}</span>;
  }
  return (
    <img
      src={src}
      alt={`${company} logo`}
      className={styles.logo}
      onError={() => setFailed(true)}
    />
  );
}

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), 1400);
      },
      () => { /* clipboard denied — no-op */ },
    );
  };
  return (
    <button
      type="button"
      className={styles.copyChip}
      onClick={onClick}
      aria-label={copied ? `Copied ${value}` : `Copy ${value}`}
    >
      {copied ? <>&#10003; Copied</> : <>&#9112; Copy</>}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// v12 FOOTPRINT CATALOG — SMT component primitives. All sizes in viewBox units.
// Every stroked element carries vector-effect="non-scaling-stroke" so the
// horizontal-stretch from preserveAspectRatio="none" doesn't fatten strokes.
// ─────────────────────────────────────────────────────────────────────────────

/** 0402 ceramic cap (14×7 viewBox units, v12.2). Two terminal stripes flank an FR4 body + dielectric band. */
function Cap0402({ cx, cy, label, value }: { cx: number; cy: number; label?: string; value?: string }) {
  return (
    <g className={styles.csbCap}>
      <rect
        className={`${styles.smdOutline} ${styles.capBody}`}
        x={cx - 7} y={cy - 3.5} width="14" height="7" rx="0.6"
        fill="var(--csb-ic-fill)" stroke="var(--csb-ic-stroke)" strokeWidth="0.6"
        vectorEffect="non-scaling-stroke"
      />
      <rect className={styles.icPad} x={cx - 7} y={cy - 3.5} width="3" height="7" />
      <rect className={styles.icPad} x={cx + 4} y={cy - 3.5} width="3" height="7" />
      {/* Dielectric band — two thin verticals across body center */}
      <line
        x1={cx - 1.5} y1={cy - 2.8} x2={cx - 1.5} y2={cy + 2.8}
        stroke="var(--csb-pad-fill)" strokeWidth="0.4" opacity="0.6"
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1={cx + 1.5} y1={cy - 2.8} x2={cx + 1.5} y2={cy + 2.8}
        stroke="var(--csb-pad-fill)" strokeWidth="0.4" opacity="0.6"
        vectorEffect="non-scaling-stroke"
      />
      {label && (
        <text
          className={styles.csbSilkscreen}
          x={cx} y={cy - 5.5} textAnchor="middle" dominantBaseline="middle"
        >{label}</text>
      )}
      {value && (
        <text
          className={styles.csbSilkscreenValue}
          x={cx} y={cy + 5.5} textAnchor="middle" dominantBaseline="middle"
        >{value}</text>
      )}
    </g>
  );
}

/** 0603 resistor (18×9 viewBox units, v12.2). Slightly larger than 0402, body + center marker. */
function Resistor0603({ cx, cy, label, value }: { cx: number; cy: number; label?: string; value?: string }) {
  return (
    <g className={styles.csbResistor}>
      <rect
        className={`${styles.smdOutline} ${styles.resistorBody}`}
        x={cx - 9} y={cy - 4.5} width="18" height="9" rx="0.5"
        fill="var(--csb-ic-fill)" stroke="var(--csb-ic-stroke)" strokeWidth="0.6"
        vectorEffect="non-scaling-stroke"
      />
      <rect className={styles.icPad} x={cx - 9} y={cy - 4.5} width="3.5" height="9" />
      <rect className={styles.icPad} x={cx + 5.5} y={cy - 4.5} width="3.5" height="9" />
      {/* Center marker band — body resistive element silhouette */}
      <rect
        x={cx - 0.6} y={cy - 4.5} width="1.2" height="9"
        fill="var(--csb-ic-stroke)" opacity="0.65"
      />
      {label && (
        <text
          className={styles.csbSilkscreen}
          x={cx} y={cy - 6.5} textAnchor="middle" dominantBaseline="middle"
        >{label}</text>
      )}
      {value && (
        <text
          className={styles.csbSilkscreenValue}
          x={cx} y={cy + 7} textAnchor="middle" dominantBaseline="middle"
        >{value}</text>
      )}
    </g>
  );
}

/** SOT-23 3-pad transistor (~14×10 bbox, v12.2). Body + 3 pads + pin-1 dot. */
function SOT23({ cx, cy, label = 'Q1' }: { cx: number; cy: number; label?: string }) {
  return (
    <g className={styles.csbTransistor}>
      <rect
        x={cx - 7} y={cy - 5} width="14" height="10" rx="0.6"
        fill="var(--csb-ic-fill)" stroke="var(--csb-ic-stroke)" strokeWidth="0.7"
        vectorEffect="non-scaling-stroke"
      />
      <rect className={styles.icPad} x={cx - 7} y={cy - 4.5} width="5" height="3" />
      <rect className={styles.icPad} x={cx + 2} y={cy - 4.5} width="5" height="3" />
      <rect className={styles.icPad} x={cx - 2.5} y={cy + 1.5} width="5" height="3" />
      {/* Pin-1 dot (top-left interior) */}
      <circle cx={cx - 5} cy={cy - 3} r="0.7" fill="var(--csb-silkscreen)" />
      {label && (
        <text
          className={styles.csbSilkscreen}
          x={cx} y={cy - 7.5} textAnchor="middle" dominantBaseline="middle"
        >{label}</text>
      )}
    </g>
  );
}

/** Diode (v12.2 bigger) — schematic-style triangle + bar. `orient` flips the bar side. */
function DiodeSym({ cx, cy, orient = 'right', label = 'D1' }: {
  cx: number; cy: number; orient?: 'right' | 'left'; label?: string;
}) {
  const flip = orient === 'left' ? -1 : 1;
  const tri = `M${cx - 10 * flip} ${cy - 7} L${cx + 7 * flip} ${cy} L${cx - 10 * flip} ${cy + 7} Z`;
  const bar = { x: cx + 7 * flip, y1: cy - 7, y2: cy + 7 };
  return (
    <g className={styles.csbDiode}>
      <path
        d={tri}
        className={`${styles.icOutline} ${styles.diodeBody}`}
        fill="var(--csb-ic-fill)" stroke="var(--csb-ic-stroke)" strokeWidth="0.8"
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1={bar.x} y1={bar.y1} x2={bar.x} y2={bar.y2}
        stroke="var(--csb-ic-stroke)" strokeWidth="1.4" vectorEffect="non-scaling-stroke"
      />
      {label && (
        <text
          className={styles.csbSilkscreen}
          x={cx} y={cy + 10} textAnchor="middle" dominantBaseline="middle"
        >{label}</text>
      )}
      {/* Cathode "K" letter near the bar */}
      <text
        className={styles.csbSilkscreen}
        x={cx + 10 * flip} y={cy + 10} textAnchor="middle" dominantBaseline="middle"
        opacity="0.7"
      >K</text>
    </g>
  );
}

/** Crystal Y1 (30×16) — rounded-rect can with 4 corner pads + interior frequency text. */
function Crystal({ cx, cy, label = 'Y1' }: { cx: number; cy: number; label?: string }) {
  return (
    <g className={styles.csbCrystal}>
      <rect
        className={styles.icOutline}
        x={cx - 15} y={cy - 8} width="30" height="16" rx="3"
        fill="var(--csb-ic-fill)" stroke="var(--csb-ic-stroke)" strokeWidth="1.2"
        vectorEffect="non-scaling-stroke"
      />
      {[[-13, -6], [9, -6], [-13, 2], [9, 2]].map(([dx, dy]) => (
        <rect key={`${dx},${dy}`} className={styles.icPad}
              x={cx + dx} y={cy + dy} width="4" height="4" rx="0.5" />
      ))}
      <text
        className={styles.csbSilkscreenValue}
        x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" opacity="0.5"
      >16M</text>
      {label && (
        <text
          className={styles.csbSilkscreen}
          x={cx} y={cy - 11} textAnchor="middle" dominantBaseline="middle"
        >{label}</text>
      )}
    </g>
  );
}

/** Inductor coil (v12.2 enlarged) — cubic-bezier spiral + ferrite core + bigger pads. */
function InductorCoil({ cx, cy, label = 'L1', value }: {
  cx: number; cy: number; label?: string; value?: string;
}) {
  const d =
    `M${cx - 25} ${cy} C${cx - 22} ${cy - 6}, ${cx - 15} ${cy - 6}, ${cx - 12} ${cy} ` +
    `C${cx - 9} ${cy - 6}, ${cx - 2} ${cy - 6}, ${cx + 1} ${cy} ` +
    `C${cx + 4} ${cy - 6}, ${cx + 11} ${cy - 6}, ${cx + 14} ${cy} ` +
    `C${cx + 17} ${cy - 6}, ${cx + 22} ${cy - 6}, ${cx + 25} ${cy}`;
  return (
    <g className={styles.csbInductor}>
      {/* Ferrite core silhouette above the coil */}
      <rect
        x={cx - 22} y={cy - 9} width="44" height="3" rx="1.5"
        fill="var(--csb-ic-fill)" stroke="var(--csb-ic-stroke)" strokeWidth="0.6"
        opacity="0.7" vectorEffect="non-scaling-stroke"
      />
      <path
        d={d}
        fill="none"
        stroke="var(--csb-ic-stroke)" strokeWidth="1.4"
        vectorEffect="non-scaling-stroke"
      />
      <rect className={styles.icPad} x={cx - 29} y={cy - 3.5} width="9" height="7" rx="1" />
      <rect className={styles.icPad} x={cx + 20} y={cy - 3.5} width="9" height="7" rx="1" />
      {label && (
        <text
          className={styles.csbSilkscreen}
          x={cx} y={cy + 10} textAnchor="middle" dominantBaseline="middle"
        >{label}</text>
      )}
      {value && (
        <text
          className={styles.csbSilkscreenValue}
          x={cx} y={cy + 13} textAnchor="middle" dominantBaseline="middle"
        >{value}</text>
      )}
    </g>
  );
}

/** SOT-89 regulator (v12.2: 36×14) — body + 3 bottom pads + 1 top tab pad + LDO interior text. */
function RegulatorSOT89({ cx, cy, label = 'VR1' }: { cx: number; cy: number; label?: string }) {
  return (
    <g className={styles.csbRegulator}>
      <rect
        className={styles.icOutline}
        x={cx - 18} y={cy - 7} width="36" height="14" rx="1.5"
        fill="var(--csb-ic-fill)" stroke="var(--csb-ic-stroke)" strokeWidth="1.2"
        vectorEffect="non-scaling-stroke"
      />
      <rect className={styles.icPad} x={cx - 15} y={cy + 6} width="8" height="4" />
      <rect className={styles.icPad} x={cx - 4}  y={cy + 6} width="8" height="4" />
      <rect className={styles.icPad} x={cx + 7}  y={cy + 6} width="8" height="4" />
      <rect className={styles.icPad} x={cx - 10} y={cy - 9} width="20" height="3" />
      {/* Pin-1 dot top-left of body */}
      <circle cx={cx - 15} cy={cy - 5} r="0.6" fill="var(--csb-silkscreen)" />
      <text
        className={styles.csbSilkscreenValue}
        x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" opacity="0.55"
      >LDO</text>
      {label && (
        <text
          className={styles.csbSilkscreen}
          x={cx} y={cy + 12} textAnchor="middle" dominantBaseline="middle"
        >{label}</text>
      )}
    </g>
  );
}

/** Card-edge connector — vertical column of rectangular pads. */
function EdgeConnector({
  x, y, w, h, pinCount, gap, label,
}: {
  x: number; y: number; w: number; h: number;
  pinCount: number; gap: number; label?: string;
}) {
  const pins = Array.from({ length: pinCount }, (_, i) => y + i * gap);
  return (
    <g className={styles.csbEdgeConn}>
      {pins.map((py) => (
        <rect
          key={`ec-${x}-${py}`}
          className={styles.icPad}
          x={x} y={py} width={w} height={h} rx="0.5"
        />
      ))}
      {label && (
        <text
          className={styles.csbSilkscreen}
          x={x + w / 2} y={y - 3} textAnchor="middle" dominantBaseline="middle"
        >{label}</text>
      )}
    </g>
  );
}

/** Assembly fiducial — 3 concentric circles. */
function Fiducial({ cx, cy, r = 3 }: { cx: number; cy: number; r?: number }) {
  return (
    <g className={styles.csbFiducial}>
      <circle
        cx={cx} cy={cy} r={r}
        fill="none" stroke="var(--csb-node)" strokeWidth="0.5"
        vectorEffect="non-scaling-stroke"
        className={styles.fiducialRing}
      />
      <circle
        cx={cx} cy={cy} r={r * 0.5}
        fill="none" stroke="var(--csb-node)" strokeWidth="0.5"
        vectorEffect="non-scaling-stroke"
        className={styles.fiducialRing}
      />
      <circle cx={cx} cy={cy} r="0.8" fill="var(--csb-node)" />
    </g>
  );
}

/** Via dot — outer ring + inner copper hole. */
function Via({ cx, cy, r = 2 }: { cx: number; cy: number; r?: number }) {
  return (
    <g className={styles.via}>
      <circle
        cx={cx} cy={cy} r={r}
        fill="var(--csb-node)" fillOpacity="0.20"
        stroke="var(--csb-node)" strokeOpacity="0.50" strokeWidth="0.6"
        vectorEffect="non-scaling-stroke"
        className={styles.viaRing}
      />
      <circle
        cx={cx} cy={cy} r={r * 0.4}
        className={styles.viaInner}
        fill="var(--csb-node)" fillOpacity="0.75"
      />
    </g>
  );
}

/** Silkscreen label text helper. */
function SilkText({
  x, y, align = 'middle', children, opacity,
}: {
  x: number; y: number; align?: 'start' | 'middle' | 'end';
  children: ReactNode; opacity?: number;
}) {
  return (
    <text
      className={styles.csbSilkscreen}
      x={x} y={y}
      textAnchor={align}
      dominantBaseline="middle"
      opacity={opacity}
    >{children}</text>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TOP STRIP — per-chip routing functions. Each returns the JSX for that chip's
// PRIVATE drop traces + adjacent components. Wrapped by BoardArt into
// <g data-net="pN"> so click-to-energize lights only that chip's content.
//
// Paths originate at chip pin tab attachment (y=0 of the SVG strip = strip
// top edge, where the HTML chip's top pin row buts in). Manhattan routing with
// 3vu 45° chamfers at every corner.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P1 — cx=137 (leftmost). All paths originate at y=53 (chip pin row) and route
 * UP through Manhattan elbows to either a bus line OR a component pad. Drops
 * bias LEFT toward CN1 edge connector. Components placed at cy=46 (near chip
 * pins) so the eye reads them as adjacent to the IC they decouple. v12.2:
 * top strip grew 43→53; SDA bus moved 18→22, SCL bus 32→38, caps 37→46.
 */
function P1Net() {
  const cx = CHIP_X.p1;
  return (
    <>
      {/* dx=-50 → CN1 pad row y=28 (long Manhattan UP + LEFT to right edge x=20) */}
      <path className={styles.pinDrop}
            d={`M${cx - 50} 53 V32 L${cx - 60} 28 H20`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=-30 → C1 decoupling cap → VCC bus. Pin lands on cap's left pad at
           (cx-30, 46); cap's right pad stub continues UP to VCC at y=6. */}
      <path className={styles.pinDrop}
            d={`M${cx - 30} 53 V46`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <Cap0402 cx={cx - 26} cy={46} label="C1" value="100n" />
      <path className={styles.componentStub}
            d={`M${cx - 22} 42.5 V6`}
            fill="none" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      {/* dx=-10 → SDA bus tap (lands ON SDA at y=22) */}
      <path className={styles.pinDrop}
            d={`M${cx - 10} 53 V26 L${cx - 6} 22`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+10 → SCL bus tap (lands ON SCL at y=38) */}
      <path className={styles.pinDrop}
            d={`M${cx + 10} 53 V42 L${cx + 14} 38`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+30 → VCC bus (single-elbow Manhattan, lands ON VCC at y=6) */}
      <path className={styles.pinDrop}
            d={`M${cx + 30} 53 V10 L${cx + 34} 6`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+50 → SCL bus tap (long approach, lands ON SCL at y=38) */}
      <path className={styles.pinDrop}
            d={`M${cx + 50} 53 V42 L${cx + 46} 38`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* Via dots at significant endpoint junctions */}
      <Via cx={20} cy={28} r={1.4} />
      <Via cx={cx - 22} cy={6} r={1.4} />
      <Via cx={cx - 6} cy={22} r={1.4} />
      <Via cx={cx + 14} cy={38} r={1.4} />
      <Via cx={cx + 30} cy={6} r={1.4} />
      <Via cx={cx + 46} cy={38} r={1.4} />
    </>
  );
}

/**
 * P2 — cx=412. Centerpiece is crystal Y1 (between P2/P3) — its 4 corner pads
 * connect 2 chip pins (from P2's right side) to 2 buses (SDA + SCL) via top
 * pad stubs. C2 decoupling cap on dx=-30 to VCC. v12.2 buses: SDA=22, SCL=38;
 * Y1 sits at cy=42 (was 36).
 */
function P2Net() {
  const cx = CHIP_X.p2;
  // Y1 crystal placement (between P2 and P3)
  const Y1_CX = 470;
  const Y1_CY = 42;
  // Crystal pad y bounds (helper uses cy-6..cy-2 for top pads, cy+2..cy+6 for bottom):
  //   TL/TR top edge: y=36; bottom edge of bot pads: y=48
  return (
    <>
      {/* dx=-50 → VCC bus (single-elbow Manhattan UP to y=6) */}
      <path className={styles.pinDrop}
            d={`M${cx - 50} 53 V10 L${cx - 46} 6`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=-30 → C2 decoupling cap → VCC. Pin lands on cap left pad at (cx-30, 46);
           cap right pad stub continues UP to VCC at y=6. */}
      <path className={styles.pinDrop}
            d={`M${cx - 30} 53 V46`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <Cap0402 cx={cx - 26} cy={46} label="C2" value="100n" />
      <path className={styles.componentStub}
            d={`M${cx - 22} 42.5 V6`}
            fill="none" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      {/* dx=-10 → SDA bus tap (lands ON SDA at y=22) */}
      <path className={styles.pinDrop}
            d={`M${cx - 10} 53 V26 L${cx - 6} 22`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+10 → SCL bus tap (lands ON SCL at y=38) */}
      <path className={styles.pinDrop}
            d={`M${cx + 10} 53 V42 L${cx + 14} 38`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+30 → Y1 BL pad. v12.2 fix: route BELOW Y1 body (y=51) before
           dropping up into the pad — old `V48 H` ran horizontally THROUGH Y1
           body silhouette at y=48 for x=455..459 (4vu under body). New route
           crosses only 2vu of body at the pad approach (V48 from y=51). */}
      <path className={styles.pinDrop}
            d={`M${cx + 30} 53 V51 H${Y1_CX - 11} V48`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+50 → Y1 BR pad. Same fix — was a 17vu horizontal inside Y1 body
           at y=48 (x=462..481 all inside body). New route stays below body. */}
      <path className={styles.pinDrop}
            d={`M${cx + 50} 53 V51 H${Y1_CX + 11} V48`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />

      {/* Y1 — 16MHz crystal between P2/P3. 4 corner pads receive 2 inbound
           pins from below (BL+BR) and emit 2 outbound stubs from top (TL+TR)
           to SDA + SCL buses respectively, completing the network. */}
      <Crystal cx={Y1_CX} cy={Y1_CY} label="Y1" />
      {/* TL pad top edge (y=36) → SDA bus (y=22) */}
      <path className={styles.componentStub}
            d={`M${Y1_CX - 11} 36 V22`}
            fill="none" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      {/* TR pad top edge (y=36) → SCL bus (y=38) — short stub since SCL just below crystal top */}
      <path className={styles.componentStub}
            d={`M${Y1_CX + 11} 36 V38`}
            fill="none" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />

      {/* Via dots at significant endpoint junctions */}
      <Via cx={cx - 46} cy={6} r={1.4} />
      <Via cx={cx - 22} cy={6} r={1.4} />
      <Via cx={cx - 6} cy={22} r={1.4} />
      <Via cx={cx + 14} cy={38} r={1.4} />
      <Via cx={Y1_CX - 11} cy={22} r={1.4} />
    </>
  );
}

/**
 * P3 — cx=687. Carries the I²C pull-up resistors R1/R2 (sit INLINE on the
 * SDA + SCL buses between P2 and P3 so they read as "in series with the bus"),
 * plus SOT-23 transistor Q1 with all 3 pins wired (E→SCL, B→pin, C→VCC).
 * v12.2: SDA=22, SCL=38; Q1 at cy=44 (was 38).
 */
function P3Net() {
  const cx = CHIP_X.p3;
  // Q1 SOT-23 placement to the right of chip — moved down for taller strip
  const Q1_CX = cx + 30;
  const Q1_CY = 44;
  // Q1 pads (per v12.2 SOT23 helper):
  //   emitter: x=cx-7..cx-2, y=cy-4.5..cy-1.5  (top-left)
  //   collector: x=cx+2..cx+7, y=cy-4.5..cy-1.5  (top-right)
  //   base: x=cx-2.5..cx+2.5, y=cy+1.5..cy+4.5  (bottom-center)
  return (
    <>
      {/* dx=-50 → SDA bus tap (chamfered, lands ON SDA at y=22) */}
      <path className={styles.pinDrop}
            d={`M${cx - 50} 53 V26 L${cx - 46} 22`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=-30 → C3 decoupling cap → VCC */}
      <path className={styles.pinDrop}
            d={`M${cx - 30} 53 V46`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <Cap0402 cx={cx - 26} cy={46} label="C3" value="100n" />
      <path className={styles.componentStub}
            d={`M${cx - 22} 42.5 V6`}
            fill="none" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      {/* dx=-10 → SCL bus tap (long, lands ON SCL at y=38) */}
      <path className={styles.pinDrop}
            d={`M${cx - 10} 53 V42 L${cx - 6} 38`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+10 → SDA bus tap (chamfered, lands ON SDA at y=22) */}
      <path className={styles.pinDrop}
            d={`M${cx + 10} 53 V26 L${cx + 14} 22`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+30 → Q1 base pad. Path lands on Q1 base bottom-edge (Q1_CX, Q1_CY+4.5). */}
      <path className={styles.pinDrop}
            d={`M${cx + 30} 53 V${Q1_CY + 4.5}`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+50 → SCL bus tap (lands ON SCL at y=38) */}
      <path className={styles.pinDrop}
            d={`M${cx + 50} 53 V42 L${cx + 46} 38`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />

      {/* R1 — I²C SDA pull-up. Sits inline on SDA bus at midpoint (between P2/P3). */}
      <Resistor0603 cx={580} cy={22} label="R1" value="4.7k" />
      {/* R2 — I²C SCL pull-up. Sits inline on SCL bus. */}
      <Resistor0603 cx={580} cy={38} label="R2" value="4.7k" />
      {/* Q1 — SOT-23 sideband transistor */}
      <SOT23 cx={Q1_CX} cy={Q1_CY} label="Q1" />
      {/* Q1 emitter pad top edge (y=Q1_CY-4.5=39.5) → SCL bus (y=38) */}
      <path className={styles.componentStub}
            d={`M${Q1_CX - 4} ${Q1_CY - 4.5} V38`}
            fill="none" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      {/* Q1 collector pad top edge → VCC bus stub */}
      <path className={styles.componentStub}
            d={`M${Q1_CX + 4} ${Q1_CY - 4.5} V6`}
            fill="none" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />

      {/* Via dots at significant endpoint junctions */}
      <Via cx={cx - 46} cy={22} r={1.4} />
      <Via cx={cx - 22} cy={6} r={1.4} />
      <Via cx={cx - 6} cy={38} r={1.4} />
      <Via cx={cx + 14} cy={22} r={1.4} />
      <Via cx={Q1_CX + 4} cy={6} r={1.4} />
      <Via cx={cx + 46} cy={38} r={1.4} />
    </>
  );
}

/**
 * P4 — cx=962 (rightmost). Drops fan RIGHT toward CN2 edge connector. Two
 * pins reach CN2's mid + lower pads via long Manhattan routes. C4 decoupling
 * cap on dx=-30, SDA/SCL bus terminations on the inner pins. v12.2: SDA=22,
 * SCL=38; CN2 left edge at x=1080 (was 1082) with new w=20 pads.
 */
function P4Net() {
  const cx = CHIP_X.p4;
  return (
    <>
      {/* dx=-50 → SCL bus tap (lands ON SCL at y=38) */}
      <path className={styles.pinDrop}
            d={`M${cx - 50} 53 V42 L${cx - 46} 38`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=-30 → C4 decoupling cap → VCC. Pin lands on C4 left pad. */}
      <path className={styles.pinDrop}
            d={`M${cx - 30} 53 V46`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <Cap0402 cx={cx - 26} cy={46} label="C4" value="100n" />
      <path className={styles.componentStub}
            d={`M${cx - 22} 42.5 V6`}
            fill="none" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      {/* dx=-10 → SDA bus tap (lands at SDA right end, x=952) */}
      <path className={styles.pinDrop}
            d={`M${cx - 10} 53 V26 L${cx - 10 - 4} 22`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+10 → SCL bus tap (lands at SCL right end, x=972). v12.2 fix:
           was M{cx+10} 53 V42 L{cx+10} 38 — degenerate Δx=0 chamfer, rendered
           as a pure vertical and broke the v12.2 Manhattan grammar. */}
      <path className={styles.pinDrop}
            d={`M${cx + 10} 53 V42 L${cx + 14} 38`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+30 → CN2 pad y=22 (mid). Long Manhattan UP + RIGHT to (1080, 22). */}
      <path className={styles.pinDrop}
            d={`M${cx + 30} 53 V32 L${cx + 34} 28 H1076 L1080 24 V22`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+50 → CN2 pad y=38 (lower). Long Manhattan UP + RIGHT to (1080, 38). */}
      <path className={styles.pinDrop}
            d={`M${cx + 50} 53 V46 L${cx + 54} 42 H1076 L1080 40 V38`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />

      {/* Via dots at significant endpoint junctions */}
      <Via cx={cx - 46} cy={38} r={1.4} />
      <Via cx={cx - 22} cy={6} r={1.4} />
      <Via cx={cx - 14} cy={22} r={1.4} />
      <Via cx={cx + 14} cy={38} r={1.4} />
      <Via cx={1080} cy={22} r={1.4} />
      <Via cx={1080} cy={38} r={1.4} />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BOTTOM STRIP — power-supply / clock-distribution section. NOT a mirror of top.
// Each chip's bottom drops connect to GND + per-chip private components:
//   P1: GND drop + protection diode D1 + CN3 edge taps
//   P2: GND drop + decoupling caps C6/C7 + inductor L1 (on OSC bus)
//   P3: GND drop + feedback resistor R3
//   P4: GND drop + LDO regulator VR1 + decoupling cap C8 + CN4 edge taps
// Buses are centralized in BUS_Y_BOT (see top-of-file): gnd=47, osc=22, pwrIn=36.
// Paths originate at y=0 (strip top, where chip bottom pin tabs attach) and
// flow DOWN.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bottom P1 — GND distribution + protection diode D1. Paths originate at y=0
 * (chip bottom pin row) and route DOWN to GND bus (y=47) or to CN3 pads, or
 * to D1's anode pad. C5 decoupling cap near chip. v12.2: GND=47, OSC=22; D1
 * anode at x=D1_CX-10 (was -7) since DiodeSym grew.
 */
function BotP1Net() {
  const cx = CHIP_X.p1;
  const D1_CX = 220;
  const D1_CY = 12;
  // DiodeSym (v12.2 bigger): anode at (D1_CX - 10, D1_CY) = (210, 12); cathode bar at (D1_CX + 7, D1_CY) = (227, 12)
  return (
    <>
      {/* dx=-50 → CN3 pad y=22. Manhattan DOWN + LEFT to (14, 22). */}
      <path className={styles.pinDrop}
            d={`M${cx - 50} 0 V18 L${cx - 56} 22 H14`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=-30 → C5 decoupling cap → GND. Pin lands on C5 right pad. */}
      <path className={styles.pinDrop}
            d={`M${cx - 30} 0 V6`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <Cap0402 cx={cx - 34} cy={6} label="C5" value="10μ" />
      <path className={styles.componentStub}
            d={`M${cx - 38} 9.5 V47`}
            fill="none" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      {/* dx=-10 → CN3 pad y=33. Manhattan DOWN + LEFT. */}
      <path className={styles.pinDrop}
            d={`M${cx - 10} 0 V29 L${cx - 16} 33 H14`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+10 → D1 anode pad (long horizontal jog right). */}
      <path className={styles.pinDrop}
            d={`M${cx + 10} 0 V8 L${cx + 14} 12 H${D1_CX - 10}`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+30 → GND bus (chamfer down). */}
      <path className={styles.pinDrop}
            d={`M${cx + 30} 0 V44 L${cx + 34} 47`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+50 → GND bus (chamfer down). */}
      <path className={styles.pinDrop}
            d={`M${cx + 50} 0 V44 L${cx + 46} 47`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />

      {/* D1 — TVS protection diode. Anode receives signal from dx=+10 pin;
           cathode bar continues DOWN to GND bus. */}
      <DiodeSym cx={D1_CX} cy={D1_CY} orient="right" label="D1" />
      <path className={styles.componentStub}
            d={`M${D1_CX + 7} ${D1_CY + 7} V47`}
            fill="none" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />

      {/* Vias at endpoint junctions */}
      <Via cx={14} cy={22} r={1.4} />
      <Via cx={cx - 38} cy={47} r={1.4} />
      <Via cx={14} cy={33} r={1.4} />
      <Via cx={D1_CX + 7} cy={47} r={1.4} />
      <Via cx={cx + 34} cy={47} r={1.4} />
      <Via cx={cx + 46} cy={47} r={1.4} />
    </>
  );
}

/**
 * Bottom P2 — decoupling caps C6/C7 near chip + L1 power inductor inline on
 * OSC bus. Some pins tap OSC, some tap GND. v12.2: GND=47, OSC=22.
 */
function BotP2Net() {
  const cx = CHIP_X.p2;
  return (
    <>
      {/* dx=-50 → C6 decoupling cap → GND. */}
      <path className={styles.pinDrop}
            d={`M${cx - 50} 0 V6`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <Cap0402 cx={cx - 54} cy={6} label="C6" value="10μ" />
      <path className={styles.componentStub}
            d={`M${cx - 58} 9.5 V47`}
            fill="none" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      {/* dx=-30 → OSC bus tap (lands ON OSC at y=22) */}
      <path className={styles.pinDrop}
            d={`M${cx - 30} 0 V18 L${cx - 26} 22`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=-10 → GND bus tap (chamfer down) */}
      <path className={styles.pinDrop}
            d={`M${cx - 10} 0 V44 L${cx - 6} 47`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+10 → OSC bus tap (lands ON OSC at y=22) */}
      <path className={styles.pinDrop}
            d={`M${cx + 10} 0 V18 L${cx + 14} 22`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+30 → C7 decoupling cap → GND. */}
      <path className={styles.pinDrop}
            d={`M${cx + 30} 0 V6`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <Cap0402 cx={cx + 34} cy={6} label="C7" value="10μ" />
      <path className={styles.componentStub}
            d={`M${cx + 38} 9.5 V47`}
            fill="none" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      {/* dx=+50 → GND bus tap (chamfer down) */}
      <path className={styles.pinDrop}
            d={`M${cx + 50} 0 V44 L${cx + 46} 47`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />

      {/* L1 — power inductor INLINE on OSC bus (decorative — bus visually
           passes through L1, reading as a filter element on the clock line). */}
      <InductorCoil cx={550} cy={22} label="L1" value="10μH" />

      {/* Vias at significant endpoint junctions */}
      <Via cx={cx - 58} cy={47} r={1.4} />
      <Via cx={cx - 26} cy={22} r={1.4} />
      <Via cx={cx - 6} cy={47} r={1.4} />
      <Via cx={cx + 14} cy={22} r={1.4} />
      <Via cx={cx + 38} cy={47} r={1.4} />
      <Via cx={cx + 46} cy={47} r={1.4} />
    </>
  );
}

/**
 * Bottom P3 — feedback resistor R3 near chip + OSC bus + PWR_IN bus access.
 * Pins fan to OSC, GND, R3, and PWR_IN. v12.2: GND=47, OSC=22, PWR_IN=36.
 * R3 v12.2 (18×9): left-pad edge at cx-9, right-pad edge at cx+9.
 */
function BotP3Net() {
  const cx = CHIP_X.p3;
  const R3_CX = cx + 38;
  const R3_CY = 6;
  // Resistor0603 (v12.2): left pad spans cx-9..cx-5.5, right pad cx+5.5..cx+9
  return (
    <>
      {/* dx=-50 → OSC bus tap (lands ON OSC at y=22) */}
      <path className={styles.pinDrop}
            d={`M${cx - 50} 0 V18 L${cx - 46} 22`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=-30 → GND bus (chamfer down) */}
      <path className={styles.pinDrop}
            d={`M${cx - 30} 0 V44 L${cx - 26} 47`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=-10 → OSC bus tap (lands ON OSC at y=22, right end at x=720) */}
      <path className={styles.pinDrop}
            d={`M${cx - 10} 0 V18 L${cx - 6} 22`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+10 → GND bus */}
      <path className={styles.pinDrop}
            d={`M${cx + 10} 0 V44 L${cx + 6} 47`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+30 → R3 feedback resistor. Pin enters R3 left pad edge. */}
      <path className={styles.pinDrop}
            d={`M${cx + 30} 0 V6 H${R3_CX - 9}`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+50 → GND bus tap (chamfer down to bottom-edge bus). v12.2 fix:
           was a 199vu floating horizontal at y=36 from x=741..940 to reach
           the PWR_IN bus's left endpoint (PWR_IN only exists x=940..1095 so
           that horizontal traversed empty board). Re-targeted to GND (full-
           width bus at y=47) so the drop terminates cleanly without a long
           free-floating segment. */}
      <path className={styles.pinDrop}
            d={`M${cx + 50} 0 V44 L${cx + 54} 47`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />

      {/* R3 — feedback resistor. Left pad ← chip pin; right pad → GND bus stub. */}
      <Resistor0603 cx={R3_CX} cy={R3_CY} label="R3" value="22k" />
      <path className={styles.componentStub}
            d={`M${R3_CX + 6} 9 V47`}
            fill="none" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />

      {/* Vias at significant endpoint junctions */}
      <Via cx={cx - 46} cy={22} r={1.4} />
      <Via cx={cx - 26} cy={47} r={1.4} />
      <Via cx={cx - 6} cy={22} r={1.4} />
      <Via cx={cx + 6} cy={47} r={1.4} />
      <Via cx={R3_CX + 6} cy={47} r={1.4} />
      <Via cx={cx + 54} cy={47} r={1.4} />
    </>
  );
}

/**
 * Bottom P4 — LDO regulator VR1 (3 pads wired: IN, OUT, GND) + C8 output
 * bypass cap + CN4 edge connector terminations. Power chain: chip pins feed
 * VR1 input, VR1 output drives the bus that feeds CN4 + C8. v12.2: GND=47,
 * PWR_IN=36. VR1 (v12.2: 36×14) at cy=26; bottom-row pad center y ≈ 33.
 * CN4 at x=1086 (was 1088) — pads land at y=8,19,30,41 with new gap=11.
 */
function BotP4Net() {
  const cx = CHIP_X.p4;
  const VR1_CX = 940;
  const VR1_CY = 26;
  // VR1 (v12.2 SOT-89) pads:
  //   bottom-left  (GND): (cx-15..cx-7,  cy+6..cy+10), mid ≈ (cx-11, cy+8)=(929,34)
  //   bottom-mid   (IN):  (cx-4..cx+4,   cy+6..cy+10), mid ≈ (cx, cy+8)=(940,34)
  //   bottom-right (OUT): (cx+7..cx+15,  cy+6..cy+10), mid ≈ (cx+11,cy+8)=(951,34)
  //   top-tab:            (cx-10..cx+10, cy-9..cy-6)
  const C8_CX = 985;
  const C8_CY = 6;
  return (
    <>
      {/* dx=-50 → C8 decoupling cap → GND. Pin lands on C8 left pad. */}
      <path className={styles.pinDrop}
            d={`M${cx - 50} 0 V6 H${C8_CX - 4}`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <Cap0402 cx={C8_CX} cy={C8_CY} label="C8" value="10μ" />
      <path className={styles.componentStub}
            d={`M${C8_CX + 4} 9.5 V47`}
            fill="none" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      {/* dx=-30 → VR1 IN pad center. v12.2 fix: was V28 L{cx-34} 32 H{VR1_CX}
           which routed horizontally at y=32 from x=928..940 — and VR1 GND pad
           spans x=925..933 y=32..36, so the IN trace crossed the GND pad face
           (visual short between IN and GND). New route stays at y=28 (above
           ALL VR1 bottom pads at y=32..36) across to x=940, then drops into
           the IN pad's top edge — no pad-face crossing. */}
      <path className={styles.pinDrop}
            d={`M${cx - 30} 0 V28 H${VR1_CX} V32`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=-10 → VR1 OUT pad (right bottom-pad center, x=VR1_CX+11). */}
      <path className={styles.pinDrop}
            d={`M${cx - 10} 0 V28 L${cx - 14} 32 H${VR1_CX + 11}`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+10 → CN4 pad y=22 (second pad band). */}
      <path className={styles.pinDrop}
            d={`M${cx + 10} 0 V18 L${cx + 14} 22 H1086`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+30 → CN4 pad y=33 (third pad band). */}
      <path className={styles.pinDrop}
            d={`M${cx + 30} 0 V29 L${cx + 34} 33 H1086`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* dx=+50 → CN4 pad y=43 (fourth pad band). */}
      <path className={styles.pinDrop}
            d={`M${cx + 50} 0 V39 L${cx + 54} 43 H1086`}
            fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />

      {/* VR1 — LDO regulator. */}
      <RegulatorSOT89 cx={VR1_CX} cy={VR1_CY} label="VR1" />
      {/* VR1 GND (bottom-left) pad → GND bus stub. Pad bottom edge y=cy+10=36. */}
      <path className={styles.componentStub}
            d={`M${VR1_CX - 11} 36 V47`}
            fill="none" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />

      {/* Vias at significant endpoint junctions */}
      <Via cx={C8_CX + 4} cy={47} r={1.4} />
      <Via cx={VR1_CX - 11} cy={47} r={1.4} />
      <Via cx={1086} cy={22} r={1.4} />
      <Via cx={1086} cy={33} r={1.4} />
      <Via cx={1086} cy={43} r={1.4} />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BoardArt — top strip composition. Renders shared buses + 4 chip nets +
// edge connectors + fiducials + corner legend. v12 grammar.
// ─────────────────────────────────────────────────────────────────────────────

const NET_IDS: readonly NetId[] = ['p1', 'p2', 'p3', 'p4'];

function BoardArt({
  activeNets,
  onTriggerNet,
}: {
  activeNets: Set<NetId>;
  onTriggerNet: (net: NetId) => void;
}) {
  const handleKey = (net: NetId) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onTriggerNet(net);
    }
  };

  // Pre-render per-chip net group so we can stamp data-net + click handler.
  const netRenderers: Record<NetId, () => ReactNode> = {
    p1: P1Net,
    p2: P2Net,
    p3: P3Net,
    p4: P4Net,
  };

  return (
    <svg
      className={styles.art}
      viewBox={`0 0 1100 ${STRIP_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Reference PCB top strip with VCC, SDA, and SCL buses unifying four chips and showing edge connectors, SMT components, and silkscreen labels."
    >
      {/* ── BOARD EDGE OUTLINE ─────────────────────────────────────────────── */}
      <rect x="1" y="0.5" width="1098" height="52" rx="2" fill="none"
            stroke="var(--csb-ic-stroke)" strokeWidth="0.5" strokeOpacity="0.5"
            vectorEffect="non-scaling-stroke" />

      {/* ── SHARED INFRASTRUCTURE BUSES ─────────────────────────────────────
           v12.2 y-coords centralized in BUS_Y_TOP (see top-of-file). NOTE:
           busVcc no longer carries .icOutline — that class composes a stroke
           override that silently downgrades busVcc 75% → 50% gold (cascade
           bug from v12.2 ship). Buses stand on their own brightness tokens. */}
      <line className={styles.busVcc}
            x1="5" y1={BUS_Y_TOP.vcc} x2="1095" y2={BUS_Y_TOP.vcc}
            strokeWidth="3" vectorEffect="non-scaling-stroke" />
      <line className={styles.busSignal}
            x1="127" y1={BUS_Y_TOP.sda} x2="952" y2={BUS_Y_TOP.sda}
            strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
      <line className={styles.busSignal}
            x1="147" y1={BUS_Y_TOP.scl} x2="972" y2={BUS_Y_TOP.scl}
            strokeWidth="2.2" vectorEffect="non-scaling-stroke" />

      {/* ── EDGE CONNECTORS (always-lit infrastructure) ─────────────────── */}
      <EdgeConnector x={0} y={4} w={20} h={5} pinCount={6} gap={8} label="CN1" />
      <EdgeConnector x={1080} y={4} w={20} h={5} pinCount={6} gap={8} label="CN2" />

      {/* ── FIDUCIALS ───────────────────────────────────────────────────── */}
      <Fiducial cx={10} cy={8} r={3} />
      <Fiducial cx={1090} cy={8} r={3} />

      {/* ── CORNER LEGEND ───────────────────────────────────────────────── */}
      <text
        className={styles.csbSilkscreen}
        x={1060} y={4} textAnchor="end" dominantBaseline="middle"
        opacity="0.4"
      >CIRCUITS.COM   REV.A   2026-W22</text>

      {/* ── BUS TAP VIAS ────────────────────────────────────────────────── */}
      <Via cx={5} cy={6} r={1.8} />
      <Via cx={1095} cy={6} r={1.8} />
      <Via cx={127} cy={22} r={1.6} />
      <Via cx={952} cy={22} r={1.6} />
      <Via cx={147} cy={38} r={1.6} />
      <Via cx={972} cy={38} r={1.6} />

      {/* ── PER-CHIP DROP-TAP GROUPS — click-to-energize targets ─────────── */}
      {NET_IDS.map((net) => (
        <g
          key={`net-${net}`}
          data-net={net}
          data-net-active={activeNets.has(net) ? 'true' : undefined}
          className={`${styles.net} ${styles.clickable}`}
          role="button"
          tabIndex={0}
          aria-label={`Energize ${net.toUpperCase()} net`}
          onClick={() => onTriggerNet(net)}
          onKeyDown={handleKey(net)}
        >
          {netRenderers[net]()}
        </g>
      ))}

      {/* ── CHIP SILKSCREEN DESIGNATORS (U1..U4) — below pin rows (y=51) ── */}
      <SilkText x={CHIP_X.p1} y={51}>U1</SilkText>
      <SilkText x={CHIP_X.p2} y={51}>U2</SilkText>
      <SilkText x={CHIP_X.p3} y={51}>U3</SilkText>
      <SilkText x={CHIP_X.p4} y={51}>U4</SilkText>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BottomBoardArt — power/clock-distribution section. NOT a mirror.
// ─────────────────────────────────────────────────────────────────────────────

function BottomBoardArt({ activeNets }: { activeNets: Set<NetId> }) {
  const netRenderers: Record<NetId, () => ReactNode> = {
    p1: BotP1Net,
    p2: BotP2Net,
    p3: BotP3Net,
    p4: BotP4Net,
  };
  return (
    <svg
      className={styles.artBottom}
      viewBox={`0 0 1100 ${STRIP_H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {/* Board edge outline */}
      <rect x="1" y="0.5" width="1098" height="52" rx="2" fill="none"
            stroke="var(--csb-ic-stroke)" strokeWidth="0.5" strokeOpacity="0.5"
            vectorEffect="non-scaling-stroke" />

      {/* Buses — y-coords centralized in BUS_Y_BOT. busGnd stripped of
           .icOutline (cascade bug fix — same as busVcc above). */}
      <line className={styles.busGnd}
            x1="5" y1={BUS_Y_BOT.gnd} x2="1095" y2={BUS_Y_BOT.gnd}
            strokeWidth="3" vectorEffect="non-scaling-stroke" />
      <line className={styles.busSignal}
            x1="380" y1={BUS_Y_BOT.osc} x2="720" y2={BUS_Y_BOT.osc}
            strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
      <line className={styles.busPower}
            x1="940" y1={BUS_Y_BOT.pwrIn} x2="1095" y2={BUS_Y_BOT.pwrIn}
            strokeWidth="3.5" vectorEffect="non-scaling-stroke" />

      {/* Edge connectors — v12.2: x=1086 (was 1088), w=14 (was 12), h=5, gap=11 */}
      <EdgeConnector x={0} y={8} w={14} h={5} pinCount={4} gap={11} label="CN3" />
      <EdgeConnector x={1086} y={8} w={14} h={5} pinCount={4} gap={11} label="CN4" />

      {/* Fiducials */}
      <Fiducial cx={10} cy={46} r={3} />
      <Fiducial cx={1090} cy={46} r={3} />

      {/* Bus tap vias */}
      <Via cx={5} cy={47} r={1.8} />
      <Via cx={1095} cy={47} r={1.8} />
      <Via cx={380} cy={22} r={1.4} />
      <Via cx={720} cy={22} r={1.4} />
      <Via cx={940} cy={36} r={1.6} />
      <Via cx={1095} cy={36} r={1.6} />

      {/* Per-chip nets */}
      {NET_IDS.map((net) => (
        <g
          key={`bnet-${net}`}
          data-net={net}
          data-net-active={activeNets.has(net) ? 'true' : undefined}
          className={styles.net}
        >
          {netRenderers[net]()}
        </g>
      ))}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BoardShell — PRESERVED v11 surface. Owns the 220px banner frame, gold rim,
// fiducial chrome, silkscreen designator, and entry animation.
// ─────────────────────────────────────────────────────────────────────────────

function BoardShell({
  tier,
  empty,
  children,
}: {
  tier?: string;
  empty?: boolean;
  children: ReactNode;
}) {
  return (
    <motion.div
      className={`${styles.board} ${empty ? styles.boardEmpty : ''}`}
      data-tier={(tier ?? 'gold').toLowerCase()}
      role="region"
      aria-label={empty ? 'Open category sponsor slot' : 'Featured category sponsor'}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: 'easeOut' as const }}
    >
      <div className={styles.substrate} aria-hidden="true" />
      <span className={styles.rim} aria-hidden="true" />
      <span className={`${styles.fid} ${styles.fidTL}`} aria-hidden="true" />
      <span className={`${styles.fid} ${styles.fidTR}`} aria-hidden="true" />
      <span className={`${styles.fid} ${styles.fidBL}`} aria-hidden="true" />
      <span className={`${styles.fid} ${styles.fidBR}`} aria-hidden="true" />
      <span className={styles.designator} aria-hidden="true">CS1 &middot; CATEGORY-SPONSOR</span>
      {children}
    </motion.div>
  );
}

// HTML chip pin row — PRESERVED v11. Pin tabs sit at viewBox-fractional left
// coordinates so they share the rail's % coordinate space with the SVG strips.
function ChipPinRow({ side }: { side: 'top' | 'bottom' }) {
  const half = CHIP_BODY_VU / 2;
  return (
    <span
      className={`${styles.chipPins} ${side === 'top' ? styles.chipPinsTop : styles.chipPinsBottom}`}
      aria-hidden="true"
    >
      {CHIP_PIN_DX.map((dx) => (
        <span
          key={dx}
          className={styles.chipPin}
          style={{ left: `${((dx + half) / CHIP_BODY_VU) * 100}%` }}
        />
      ))}
    </span>
  );
}

export default function CategorySponsorBanner({
  sponsor,
  categoryName,
}: CategorySponsorBannerProps) {
  const [activeNets, setActiveNets] = useState<Set<NetId>>(() => new Set());
  const timeoutsRef = useRef<Map<NetId, number>>(new Map());

  const triggerNet = useCallback((netId: NetId) => {
    setActiveNets((prev) => {
      const next = new Set(prev);
      next.add(netId);
      return next;
    });
    const existing = timeoutsRef.current.get(netId);
    if (existing !== undefined) window.clearTimeout(existing);
    const tid = window.setTimeout(() => {
      setActiveNets((prev) => {
        const next = new Set(prev);
        next.delete(netId);
        return next;
      });
      timeoutsRef.current.delete(netId);
    }, NET_ENERGIZE_MS);
    timeoutsRef.current.set(netId, tid);
  }, []);

  useEffect(() => () => {
    timeoutsRef.current.forEach((t) => window.clearTimeout(t));
    timeoutsRef.current.clear();
  }, []);

  const Rail = (
    <div className={styles.rail}>
      <div className={styles.boardArt}>
        <BoardArt activeNets={activeNets} onTriggerNet={triggerNet} />
      </div>
      <div className={styles.boardArtBottom}>
        <BottomBoardArt activeNets={activeNets} />
      </div>

      <div className={styles.field} data-illuminated={activeNets.has('p1')} style={chipStyle('p1')}>
        <ChipPinRow side="top" />
        <ChipPinRow side="bottom" />
        {sponsor ? (
          <>
            <span className={styles.pLabel}>Company<span className={styles.pinNo}>P1</span></span>
            <span className={styles.val}>{sponsor.supplier_name}</span>
          </>
        ) : (
          <>
            <span className={styles.pLabel}>Company<span className={styles.pinNo}>P1</span></span>
            <span className={`${styles.val} ${styles.valEmpty}`}>Your brand</span>
          </>
        )}
      </div>

      <div className={styles.field} data-illuminated={activeNets.has('p2')} style={chipStyle('p2')}>
        <ChipPinRow side="top" />
        <ChipPinRow side="bottom" />
        {sponsor ? (
          <>
            <span className={styles.pLabel}>Contact<span className={styles.pinNo}>P2</span></span>
            <span className={styles.val}>{sponsor.contact_name || '—'}</span>
          </>
        ) : (
          <>
            <span className={styles.pLabel}>Contact<span className={styles.pinNo}>P2</span></span>
            <span className={`${styles.val} ${styles.valEmpty}`}>Your rep</span>
          </>
        )}
      </div>

      <div className={styles.field} data-illuminated={activeNets.has('p3')} style={chipStyle('p3')}>
        <ChipPinRow side="top" />
        <ChipPinRow side="bottom" />
        <span className={styles.pLabel}>Phone<span className={styles.pinNo}>P3</span></span>
        {sponsor && sponsor.phone ? (
          <div className={styles.rowFoot}>
            <span className={`${styles.val} ${styles.valMono}`}>
              <a href={`tel:${sponsor.phone.replace(/[^0-9+]/g, '')}`}>{sponsor.phone}</a>
            </span>
            <CopyChip value={sponsor.phone} />
          </div>
        ) : sponsor ? (
          <span className={`${styles.val} ${styles.valMono}`}>&mdash;</span>
        ) : (
          <span className={`${styles.val} ${styles.valEmpty}`}>+1 &mdash;</span>
        )}
      </div>

      <div className={styles.field} data-illuminated={activeNets.has('p4')} style={chipStyle('p4')}>
        <ChipPinRow side="top" />
        <ChipPinRow side="bottom" />
        <span className={styles.pLabel}>Email<span className={styles.pinNo}>P4</span></span>
        {sponsor && sponsor.email ? (
          <div className={styles.rowFoot}>
            <span className={`${styles.val} ${styles.valMono}`}>
              <a href={`mailto:${sponsor.email}`}>{sponsor.email}</a>
            </span>
            <CopyChip value={sponsor.email} />
          </div>
        ) : sponsor ? (
          <span className={`${styles.val} ${styles.valMono}`}>&mdash;</span>
        ) : (
          <span className={`${styles.val} ${styles.valEmpty}`}>you@&mdash;</span>
        )}
      </div>
    </div>
  );

  if (!sponsor) {
    const subject = encodeURIComponent(
      categoryName
        ? `Category Sponsorship Inquiry — ${categoryName}`
        : 'Category Sponsorship Inquiry',
    );
    return (
      <BoardShell empty>
        <div className={styles.id}>
          <span className={styles.kicker}>&#9670; Category Sponsor</span>
          <div className={styles.idTop}>
            <span className={styles.pad}><span className={styles.mark}>SP</span></span>
            <span className={styles.co}>
              <span className={styles.coName}>Sponsor this category</span>
              <span className={styles.coTag}>
                Top-of-page placement above the parts table. One slot per category &mdash; yours to claim.
              </span>
            </span>
          </div>
          <a className={styles.cta} href={`mailto:john@circuits.com?subject=${subject}`}>
            Become a sponsor &rarr;
          </a>
        </div>
        {Rail}
      </BoardShell>
    );
  }

  const company = sponsor.supplier_name;
  const blurb = sponsor.description || `Featured partner — sponsoring ${categoryName || 'this category'}`;
  const email = sponsor.email || '';
  const ctaHref = email
    ? `mailto:${email}?subject=${encodeURIComponent(`Inquiry from circuits.com — ${categoryName || 'category page'}`)}`
    : sponsor.website || null;
  const ctaIsExternal = !email && !!sponsor.website;

  return (
    <BoardShell tier={sponsor.tier}>
      <div className={styles.id}>
        <span className={styles.kicker}>&#9670; Category Sponsor</span>
        <div className={styles.idTop}>
          <span className={styles.pad}>
            <SponsorMedallion company={company} imageUrl={sponsor.image_url} />
          </span>
          <span className={styles.co}>
            <span className={styles.coName}>{company}</span>
            <span className={styles.coTag}>{blurb}</span>
          </span>
        </div>
        {ctaHref && (
          <a
            className={styles.cta}
            href={ctaHref}
            {...(ctaIsExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            Contact rep &rarr;
          </a>
        )}
      </div>
      {Rail}
    </BoardShell>
  );
}
