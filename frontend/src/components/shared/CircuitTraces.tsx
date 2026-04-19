import styles from './CircuitTraces.module.scss';

// Shorthand helpers for consistent stroke/animation props
const T = (d: number) => ({ animationDelay: `${d}s` });

// Token-driven stroke. Color comes from var(--trace-color) on the SVG root
// (set in CircuitTraces.module.scss and overridden per theme). Opacity is
// a numeric prop kept per-element so individual traces can be fainter.
const S = (o: number, w = 1) => ({
  stroke: 'var(--trace-color)',
  strokeOpacity: Math.min(o * 2.5, 1),
  strokeWidth: w,
});

// IC body stroke — uses --ic-body-stroke (softer than main trace color)
const IC = (w = 1) => ({ stroke: 'var(--ic-body-stroke)', strokeWidth: w, fill: 'var(--ic-body-fill)' });

const DASH = { strokeDasharray: 1200, strokeDashoffset: 1200 };

// Electrons: [path, duration(s), begin(s), radius]
// begin = trace's T() animationDelay + 6s (wait for draw-circuit to finish)
// With animation: forwards, traces draw once and stay — electrons loop on visible paths
const ELECTRONS: [string, number, number, number][] = [
  // Bundle 1 — IC1 left → left edge (traces T=0.6, T=1.0)
  ['M411 140 H380 L360 120 H200 L170 90 H0', 3, 6.6, 1],
  ['M411 180 H398 L378 160 H240 L210 130 H0', 3.5, 7, 0.8],
  // Bundle 2 — IC1 bottom → bottom edge (trace T=1.2)
  ['M450 229 V270 L430 290 V400', 2.5, 7.2, 0.9],
  // Bundle 3 — IC1 right → IC2 left (traces T=1.2, T=1.5)
  ['M519 145 H580 L600 125 H750 L770 110 H913', 4, 7.2, 1],
  ['M519 175 H595 L615 155 H765 L785 140 H913', 4.5, 7.5, 0.8],
  // Bundle 4 — IC1 top → top edge (trace T=0.7)
  ['M460 121 V90 L480 70 V20 L500 0', 2.5, 6.7, 0.9],
  // Bundle 5 — IC2 right → right edge (trace T=3.0)
  ['M977 110 H1020 L1040 90 H1100 L1120 70 H1200', 3, 9, 1],
  // Long horizontal — full-span (trace T=3.8)
  ['M0 380 H200 L220 360 H400 L420 380 H620 L650 350 H800 L830 320 H950 L970 340 H1200', 6, 9.8, 1.1],
  // Vertical long-run (trace T=1.8)
  ['M650 0 V60 L670 80 V160 L690 180 V400', 4, 7.8, 0.9],
  // Cross-board horizontal (trace T=2.5)
  ['M550 300 H700 L720 280 H850 L870 260 H1000 L1020 240 H1200', 4.5, 8.5, 0.8],
  // IC3 bottom → bottom edge (trace T=3.5)
  ['M150 327 V350 L170 370 H300 L320 390 V400', 3, 9.5, 0.9],
  // Power rail — top edge (trace T=0)
  ['M0 10 H1200', 5, 6, 1],
  // Power rail — bottom edge (trace T=0.1)
  ['M1200 390 H0', 5.5, 6.1, 0.9],
  // USB trace → IC1 (trace T=3.3)
  ['M511 390 V380 L490 360 V340 L470 320 V275', 3, 9.3, 0.8],
];

export default function CircuitTraces() {
  return (
    <svg
      className={styles.circuitTraces}
      viewBox="0 0 1200 400"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <filter id="traceGlow" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feFlood floodColor="var(--trace-glow)" floodOpacity="0.6" />
          <feComposite in2="blur" operator="in" result="glowColor" />
          <feMerge>
            <feMergeNode in="glowColor" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* ═══════════════════════════════════════════════════════════════════════
          Trace paths — all routing traces wrapped in a single glow group.
          Z-order: traces are at back, IC rects and electrons render on top.
          ═══════════════════════════════════════════════════════════════════════ */}
      <g className={styles.traceGroup} filter="url(#traceGlow)">

        {/* QFP IC1 notch path */}
        <path d="M460 130 A5 5 0 0 0 470 130" {...S(0.1, 0.8)} fill="none" className={styles.trace} style={T(0.2)} />

        {/* IC2 top pad traces → exit top edge */}
        <path d="M930 93 V70 L920 50 V0" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(2.7)} />
        <path d="M940 93 V65 L930 45 V0" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(2.8)} />
        <path d="M950 93 V60 L960 40 V0" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(2.9)} />
        <path d="M960 93 V55 L970 35 V0" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.0)} />

        {/* IC2 bottom pad traces → exit bottom */}
        <path d="M930 157 V180 L920 200 V400" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(2.7)} />
        <path d="M940 157 V185 L935 205 V400" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(2.8)} />
        <path d="M950 157 V190 L960 210 V400" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(2.9)} />
        <path d="M960 157 V195 L970 215 V400" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.0)} />

        {/* IC3 top pad traces → connect upward to left-edge routing */}
        <path d="M150 273 V250 L130 230 V200" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.1)} />
        <path d="M160 273 V255 L150 240 H100 L80 220 V200" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.15)} />
        <path d="M170 273 V258 L190 240 H220" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.2)} />
        <path d="M180 273 V260 L200 245 H230 L250 225 V200" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.25)} />
        <path d="M190 273 V262 L210 250 H260" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.3)} />

        {/* ═══════════════════════════════════════════════════════════════════════
            Parallel trace bundle 1 — IC1 left pads → exit left edge
            Every trace exits at x=0 (continues off-board)
            ═══════════════════════════════════════════════════════════════════════ */}
        <path d="M411 140 H380 L360 120 H200 L170 90 H0" {...S(0.08, 1)} {...DASH} className={styles.trace} style={T(0.6)} />
        <path d="M411 150 H385 L365 130 H210 L180 100 H0" {...S(0.07, 0.8)} {...DASH} className={styles.trace} style={T(0.7)} />
        <path d="M411 160 H390 L370 140 H220 L190 110 H0" {...S(0.08, 1)} {...DASH} className={styles.trace} style={T(0.8)} />
        <path d="M411 170 H395 L375 150 H230 L200 120 H0" {...S(0.06, 0.8)} {...DASH} className={styles.trace} style={T(0.9)} />
        <path d="M411 180 H398 L378 160 H240 L210 130 H0" {...S(0.07, 0.8)} {...DASH} className={styles.trace} style={T(1.0)} />
        <path d="M411 190 H396 L376 170 H250 L220 140 H0" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(1.1)} />
        <path d="M411 200 H394 L374 180 H260 L230 150 H0" {...S(0.07, 0.8)} {...DASH} className={styles.trace} style={T(1.2)} />
        <path d="M411 210 H392 L372 190 H270 L240 160 H0" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(1.3)} />

        {/* ═══════════════════════════════════════════════════════════════════════
            Parallel trace bundle 2 — IC1 bottom pads → exit bottom edge
            ═══════════════════════════════════════════════════════════════════════ */}
        <path d="M430 229 V260 L410 280 V400" {...S(0.08, 1)} {...DASH} className={styles.trace} style={T(1.0)} />
        <path d="M440 229 V265 L420 285 V400" {...S(0.07, 0.8)} {...DASH} className={styles.trace} style={T(1.1)} />
        <path d="M450 229 V270 L430 290 V400" {...S(0.08, 1)} {...DASH} className={styles.trace} style={T(1.2)} />
        <path d="M460 229 V275 L440 295 V400" {...S(0.06, 0.8)} {...DASH} className={styles.trace} style={T(1.3)} />
        <path d="M470 229 V268 L490 288 V400" {...S(0.07, 0.8)} {...DASH} className={styles.trace} style={T(1.4)} />
        <path d="M480 229 V262 L500 282 V400" {...S(0.06, 0.8)} {...DASH} className={styles.trace} style={T(1.5)} />
        <path d="M490 229 V258 L510 278 V400" {...S(0.07, 0.7)} {...DASH} className={styles.trace} style={T(1.6)} />
        <path d="M500 229 V255 L520 275 V400" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(1.7)} />

        {/* ═══════════════════════════════════════════════════════════════════════
            Parallel trace bundle 3 — IC1 right pads → IC2 left pads
            (Both ends connect to IC pads — no dead ends)
            ═══════════════════════════════════════════════════════════════════════ */}
        <path d="M519 145 H580 L600 125 H750 L770 110 H913" {...S(0.09, 1.2)} {...DASH} className={styles.trace} style={T(1.2)} />
        <path d="M519 155 H585 L605 135 H755 L775 120 H913" {...S(0.08, 1)} {...DASH} className={styles.trace} style={T(1.3)} />
        <path d="M519 165 H590 L610 145 H760 L780 130 H913" {...S(0.07, 0.8)} {...DASH} className={styles.trace} style={T(1.4)} />
        <path d="M519 175 H595 L615 155 H765 L785 140 H913" {...S(0.08, 1)} {...DASH} className={styles.trace} style={T(1.5)} />

        {/* ═══════════════════════════════════════════════════════════════════════
            Parallel trace bundle 4 — IC1 top pads → exit top edge
            ═══════════════════════════════════════════════════════════════════════ */}
        <path d="M440 121 V100 L420 80 V40 L400 20 V0" {...S(0.07, 0.8)} {...DASH} className={styles.trace} style={T(0.5)} />
        <path d="M450 121 V95 L430 75 V35 L410 15 V0" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(0.6)} />
        <path d="M460 121 V90 L480 70 V20 L500 0" {...S(0.07, 0.8)} {...DASH} className={styles.trace} style={T(0.7)} />
        <path d="M470 121 V88 L490 68 V25 L510 5 V0" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(0.8)} />
        <path d="M490 121 V92 L510 72 V0" {...S(0.07, 0.8)} {...DASH} className={styles.trace} style={T(0.9)} />

        {/* ═══════════════════════════════════════════════════════════════════════
            Parallel trace bundle 5 — IC2 right → exit right edge
            ═══════════════════════════════════════════════════════════════════════ */}
        <path d="M977 110 H1020 L1040 90 H1100 L1120 70 H1200" {...S(0.07, 0.8)} {...DASH} className={styles.trace} style={T(3.0)} />
        <path d="M977 120 H1025 L1045 100 H1105 L1125 80 H1200" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(3.1)} />
        <path d="M977 130 H1030 L1050 110 H1110 L1130 90 H1200" {...S(0.07, 0.8)} {...DASH} className={styles.trace} style={T(3.2)} />
        <path d="M977 140 H1035 L1055 160 H1115 L1135 180 V400" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(3.3)} />

        {/* ═══════════════════════════════════════════════════════════════════════
            Trace bundle 6 — IC3 bottom → exit bottom edge
            ═══════════════════════════════════════════════════════════════════════ */}
        <path d="M150 327 V350 L170 370 H300 L320 390 V400" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(3.5)} />
        <path d="M160 327 V355 L180 375 H310 L330 395 V400" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(3.6)} />
        <path d="M170 327 V360 L190 380 V400" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.7)} />

        {/* ═══════════════════════════════════════════════════════════════════════
            Long-run routing traces — all exit viewBox edges
            ═══════════════════════════════════════════════════════════════════════ */}
        {/* Left-edge origins → connect to IC1 left bundle or IC3 */}
        <path d="M0 120 H100 L120 140 H260 L280 160 H370" {...S(0.06, 0.8)} {...DASH} className={styles.trace} style={T(0.4)} />
        <path d="M0 200 H80 L100 220 H250 L270 240 H380 L400 260 V280" {...S(0.07, 1)} {...DASH} className={styles.trace} style={T(1.5)} />
        <path d="M0 340 H120 L140 320 H140" {...S(0.05, 0.7)} {...DASH} className={styles.trace} style={T(2.8)} />

        {/* Cross-board horizontals — edge to edge */}
        <path d="M0 300 H150 L170 280" {...S(0.05, 0.7)} {...DASH} className={styles.trace} style={T(2.6)} />
        <path d="M550 300 H700 L720 280 H850 L870 260 H1000 L1020 240 H1200" {...S(0.06, 0.8)} {...DASH} className={styles.trace} style={T(2.5)} />
        <path d="M560 320 H710 L730 300 H860 L880 280 H1010 L1030 260 H1200" {...S(0.05, 0.7)} {...DASH} className={styles.trace} style={T(2.6)} />
        <path d="M0 380 H200 L220 360 H400 L420 380 H620 L650 350 H800 L830 320 H950 L970 340 H1200" {...S(0.06, 0.8)} {...DASH} className={styles.trace} style={T(3.8)} />
        <path d="M0 395 H180 L200 375 H380 L400 395 V400" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(4.0)} />

        {/* Vertical long runs — top edge to bottom edge or IC pads */}
        <path d="M650 0 V60 L670 80 V160 L690 180 V400" {...S(0.07, 1)} {...DASH} className={styles.trace} style={T(1.8)} />
        <path d="M660 0 V55 L680 75 V155 L700 175 V400" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(1.9)} />
        <path d="M820 0 V60 L840 80 V200 L860 220 V400" {...S(0.06, 0.8)} {...DASH} className={styles.trace} style={T(2.2)} />
        <path d="M300 0 V80 L280 100 V220 L260 240 V400" {...S(0.06, 0.8)} {...DASH} className={styles.trace} style={T(0.3)} />
        <path d="M1080 0 V100 L1060 120 V250 L1080 270 V400" {...S(0.06, 0.8)} {...DASH} className={styles.trace} style={T(3.4)} />
        <path d="M1090 0 V95 L1070 115 V245 L1090 265 V400" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.5)} />

        {/* Diagonal routing — connect IC regions or exit edges */}
        <path d="M0 180 L130 250 H200 L230 280" {...S(0.05, 0.7)} {...DASH} className={styles.trace} style={T(2.0)} />
        <path d="M800 200 L830 230 V300 L860 330 H1000 L1030 360 H1200" {...S(0.06, 0.8)} {...DASH} className={styles.trace} style={T(2.8)} />

        {/* Power traces (wider) — full-span edge rails */}
        <path d="M0 10 H1200" {...S(0.04, 2)} {...DASH} className={styles.trace} style={T(0)} />
        <path d="M0 390 H1200" {...S(0.04, 2)} {...DASH} className={styles.trace} style={T(0.1)} />
        <path d="M10 0 V400" {...S(0.03, 1.5)} {...DASH} className={styles.trace} style={T(0.05)} />
        <path d="M1190 0 V400" {...S(0.03, 1.5)} {...DASH} className={styles.trace} style={T(0.05)} />

        {/* BGA fan-out traces → exit bottom */}
        <path d="M740 294 V320 L730 340 V400" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(2.8)} />
        <path d="M760 294 V330 L770 350 V400" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(2.9)} />
        <path d="M750 294 V315 L740 335 H700 L680 355 V400" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(2.85)} />
        <path d="M770 294 V310 L780 330 H820 L840 350 V400" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(2.95)} />

        {/* Crystal traces */}
        <path d="M580 26 V0" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(1.8)} />
        <path d="M600 50 V72 L580 92 V121" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(1.8)} />
        {/* Additional crystal pad traces */}
        <path d="M600 26 V0" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(1.8)} />
        <path d="M580 50 V72 L560 92 V121" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(1.8)} />

        {/* Transistor 1 traces */}
        <path d="M84 193 V180 L60 160" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(1.7)} />
        <path d="M98 193 V180 L120 160 V140 H0" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(1.7)} />
        <path d="M91 211 V230 L80 250 V280" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(1.8)} />

        {/* Transistor 2 traces */}
        <path d="M1034 303 V290 L1020 270 V240 H1200" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.7)} />
        <path d="M1048 303 V290 L1060 270 V250 L1080 230 V200" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.7)} />
        <path d="M1041 321 V340 L1060 360 V400" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.8)} />

        {/* Inductor / Coil — spiral symbol (350, 255) */}
        <path
          d="M330 260 C335 250, 345 250, 345 260 C345 270, 355 270, 355 260 C355 250, 365 250, 365 260 C365 270, 375 270, 375 260"
          {...S(0.1, 1)} fill="none" className={styles.trace} style={T(2.0)}
        />
        {/* Coil traces */}
        <path d="M323 260 H280 L260 240" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(2.1)} />
        <path d="M382 260 H400 L420 280" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(2.1)} />

        {/* Diode 1 at (850, 350) — horizontal */}
        <path d="M840 343 L855 350 L840 357 Z" {...S(0.09, 0.8)} fill="var(--ic-body-fill)" className={styles.trace} style={T(3.4)} />
        <line x1="855" y1="343" x2="855" y2="357" {...S(0.09, 0.8)} className={styles.trace} style={T(3.4)} />
        <path d="M830 350 H840" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(3.4)} />
        <path d="M855 350 H870 L890 370 V400" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(3.5)} />

        {/* Diode 2 at (200, 155) — vertical */}
        <path d="M193 145 L200 160 L207 145 Z" {...S(0.08, 0.8)} fill="var(--ic-body-fill)" className={styles.trace} style={T(1.4)} />
        <line x1="193" y1="160" x2="207" y2="160" {...S(0.08, 0.8)} className={styles.trace} style={T(1.4)} />
        {/* Diode 2 traces */}
        <path d="M200 145 V120 L180 100 H0" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(1.5)} />
        <path d="M200 165 V190 L220 210 V240" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(1.5)} />

        {/* Electrolytic Capacitor — circle body and leads (620, 240) */}
        <circle cx="620" cy="240" r="10" {...S(0.08, 0.8)} fill="var(--ic-body-fill)" className={styles.trace} style={T(2.1)} />
        <line x1="616" y1="234" x2="624" y2="234" {...S(0.1, 0.8)} className={styles.trace} style={T(2.1)} />
        <line x1="620" y1="230" x2="620" y2="238" {...S(0.1, 0.8)} className={styles.trace} style={T(2.1)} />
        {/* Leads */}
        <path d="M620 230 V200 L640 180 V160 L670 130 V80" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(2.2)} />
        <path d="M620 250 V280 L640 300 V400" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(2.2)} />

        {/* USB traces → exit bottom */}
        <path d="M495 396 V400" {...S(0.06, 0.6)} {...DASH} className={styles.trace} style={T(3.4)} />
        <path d="M503 396 V400" {...S(0.06, 0.6)} {...DASH} className={styles.trace} style={T(3.4)} />
        <path d="M519 396 V400" {...S(0.06, 0.6)} {...DASH} className={styles.trace} style={T(3.4)} />
        {/* USB traces → route to IC1 bottom */}
        <path d="M511 390 V380 L490 360 V340 L470 320 V275" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(3.3)} />
        <path d="M527 390 V375 L545 355 V320 L560 300" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.4)} />

        {/* Regulator traces */}
        <path d="M1105 154 V120 L1080 100 V0" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(3.6)} />
        <path d="M1096 185 V200 L1080 220 V250" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.6)} />
        <path d="M1114 185 V210 L1135 230 V400" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.7)} />

      </g>

      {/* ═══════════════════════════════════════════════════════════════════════
          QFP IC Package 1 — large, center-left (body at 420,130 → 510,220)
          ═══════════════════════════════════════════════════════════════════════ */}
      <rect x="420" y="130" width="90" height="90" rx="2" {...IC(1)} className={styles.trace} style={T(0.2)} />
      {/* Top pads */}
      {[430,440,450,460,470,480,490,500].map((x, i) => (
        <rect key={`ic1t${i}`} x={x-1.5} y={121} width={3} height={9} rx={0.5} fill="var(--ic-pad-fill)" className={styles.trace} style={T(0.3 + i*0.05)} />
      ))}
      {/* Bottom pads */}
      {[430,440,450,460,470,480,490,500].map((x, i) => (
        <rect key={`ic1b${i}`} x={x-1.5} y={220} width={3} height={9} rx={0.5} fill="var(--ic-pad-fill)" className={styles.trace} style={T(0.3 + i*0.05)} />
      ))}
      {/* Left pads */}
      {[140,150,160,170,180,190,200,210].map((y, i) => (
        <rect key={`ic1l${i}`} x={411} y={y-1.5} width={9} height={3} rx={0.5} fill="var(--ic-pad-fill)" className={styles.trace} style={T(0.4 + i*0.05)} />
      ))}
      {/* Right pads */}
      {[140,150,160,170,180,190,200,210].map((y, i) => (
        <rect key={`ic1r${i}`} x={510} y={y-1.5} width={9} height={3} rx={0.5} fill="var(--ic-pad-fill)" className={styles.trace} style={T(0.4 + i*0.05)} />
      ))}

      {/* ═══════════════════════════════════════════════════════════════════════
          QFP IC Package 2 — small, right (body at 920,100 → 970,150)
          ═══════════════════════════════════════════════════════════════════════ */}
      <rect x="920" y="100" width="50" height="50" rx="2" {...IC(0.8)} className={styles.trace} style={T(2.5)} />
      {/* Top pads */}
      {[930,940,950,960].map((x, i) => (
        <rect key={`ic2t${i}`} x={x-1} y={93} width={2.5} height={7} rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.4} className={styles.trace} style={T(2.6 + i*0.05)} />
      ))}
      {/* Bottom pads */}
      {[930,940,950,960].map((x, i) => (
        <rect key={`ic2b${i}`} x={x-1} y={150} width={2.5} height={7} rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.4} className={styles.trace} style={T(2.6 + i*0.05)} />
      ))}
      {/* Left pads */}
      {[110,120,130,140].map((y, i) => (
        <rect key={`ic2l${i}`} x={913} y={y-1} width={7} height={2.5} rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.4} className={styles.trace} style={T(2.7 + i*0.05)} />
      ))}
      {/* Right pads */}
      {[110,120,130,140].map((y, i) => (
        <rect key={`ic2r${i}`} x={970} y={y-1} width={7} height={2.5} rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.4} className={styles.trace} style={T(2.7 + i*0.05)} />
      ))}

      {/* ═══════════════════════════════════════════════════════════════════════
          SOIC IC Package 3 — bottom-left (body at 140,280 → 200,320)
          ═══════════════════════════════════════════════════════════════════════ */}
      <rect x="140" y="280" width="60" height="40" rx="2" {...IC(0.8)} className={styles.trace} style={T(3.0)} />
      {[150,160,170,180,190].map((x, i) => (
        <g key={`ic3p${i}`}>
          <rect x={x-1} y={273} width={2.5} height={7} rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.36} className={styles.trace} style={T(3.1 + i*0.04)} />
          <rect x={x-1} y={320} width={2.5} height={7} rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.36} className={styles.trace} style={T(3.1 + i*0.04)} />
        </g>
      ))}

      {/* ═══════════════════════════════════════════════════════════════════════
          Vias — at trace junctions and routing intersections
          ═══════════════════════════════════════════════════════════════════════ */}
      {[
        [370,175,3.5],  [540,155,3],  [280,160,3],  [230,280,3.5], [180,130,3],
        [600,80,3],     [820,60,3],   [670,280,3],   [860,260,3],  [700,175,3.5],
        [400,260,2.5],  [510,72,2.5], [750,110,2.5], [780,130,2.5],[1060,120,3.5],
        [1135,180,3],   [950,330,3],  [880,280,3],   [1000,240,3], [1030,260,2.5],
        [260,240,3],    [170,90,2.5], [340,120,3],   [600,125,3],  [500,282,2.5],
        [690,180,3],    [840,80,2.5], [320,390,2.5], [770,110,3],  [120,140,2.5],
      ].map(([cx, cy, r], i) => (
        <g key={`via${i}`}>
          <circle cx={cx} cy={cy} r={r as number} fill="rgba(232,190,45,0.08)" stroke="rgba(232,190,45,0.2)" strokeWidth={0.8} className={styles.node} style={T(0.2 + i * 0.13)} />
          <circle cx={cx} cy={cy} r={(r as number) * 0.4} fill="rgba(232,190,45,0.3)" className={styles.node} style={T(0.2 + i * 0.13)} />
        </g>
      ))}

      {/* ═══════════════════════════════════════════════════════════════════════
          BGA Package — grid of solder balls (center-right, 740,260)
          ═══════════════════════════════════════════════════════════════════════ */}
      <rect x="730" y="250" width="44" height="44" rx={2} {...IC(0.6)} className={styles.trace} style={T(2.2)} />
      {[0,1,2,3].map(row =>
        [0,1,2,3].map(col => (
          <circle key={`bga${row}${col}`} cx={740 + col*10} cy={260 + row*10} r={2} fill="rgba(232,190,45,0.2)" className={styles.node} style={T(2.3 + (row*4+col)*0.04)} />
        ))
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          Crystal Oscillator — rectangular can with 4 pads (590,40)
          ═══════════════════════════════════════════════════════════════════════ */}
      <rect x="575" y="30" width="30" height="16" rx={3} {...IC(0.8)} className={styles.trace} style={T(1.6)} />
      {/* 4 pads at corners */}
      <rect x="578" y="26" width="4" height="4" rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.4} className={styles.trace} style={T(1.7)} />
      <rect x="598" y="26" width="4" height="4" rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.4} className={styles.trace} style={T(1.7)} />
      <rect x="578" y="46" width="4" height="4" rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.4} className={styles.trace} style={T(1.7)} />
      <rect x="598" y="46" width="4" height="4" rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.4} className={styles.trace} style={T(1.7)} />

      {/* ═══════════════════════════════════════════════════════════════════════
          SOT-23 Transistors — 3-pad triangular footprint
          ═══════════════════════════════════════════════════════════════════════ */}
      {/* Transistor 1 at (90, 200) */}
      <rect x="82" y="193" width="4" height="5" rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.4} className={styles.trace} style={T(1.6)} />
      <rect x="96" y="193" width="4" height="5" rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.4} className={styles.trace} style={T(1.6)} />
      <rect x="89" y="206" width="4" height="5" rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.4} className={styles.trace} style={T(1.6)} />

      {/* Transistor 2 at (1040, 310) */}
      <rect x="1032" y="303" width="4" height="5" rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.36} className={styles.trace} style={T(3.6)} />
      <rect x="1046" y="303" width="4" height="5" rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.36} className={styles.trace} style={T(3.6)} />
      <rect x="1039" y="316" width="4" height="5" rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.36} className={styles.trace} style={T(3.6)} />

      {/* ═══════════════════════════════════════════════════════════════════════
          Inductor / Coil — pad rects at coil ends (350, 255)
          ═══════════════════════════════════════════════════════════════════════ */}
      {/* Pads at coil ends */}
      <rect x="323" y="257" width="7" height="6" rx={1} fill="var(--ic-pad-fill)" fillOpacity={0.4} className={styles.trace} style={T(2.0)} />
      <rect x="375" y="257" width="7" height="6" rx={1} fill="var(--ic-pad-fill)" fillOpacity={0.4} className={styles.trace} style={T(2.0)} />

      {/* ═══════════════════════════════════════════════════════════════════════
          Fiducial Markers — target circles at board corners
          ═══════════════════════════════════════════════════════════════════════ */}
      {[[25, 380], [1175, 20], [1175, 380]].map(([x, y], i) => (
        <g key={`fid${i}`}>
          <circle cx={x} cy={y} r={6} fill="none" {...S(0.06, 0.5)} className={styles.node} style={T(0.1)} />
          <circle cx={x} cy={y} r={3} fill="none" {...S(0.08, 0.5)} className={styles.node} style={T(0.1)} />
          <circle cx={x} cy={y} r={1.2} fill="rgba(232,190,45,0.25)" className={styles.node} style={T(0.1)} />
        </g>
      ))}

      {/* ═══════════════════════════════════════════════════════════════════════
          USB Connector Footprint — pad array at bottom edge (500, 370)
          ═══════════════════════════════════════════════════════════════════════ */}
      <rect x="485" y="365" width="50" height="25" rx={2} {...IC(0.6)} className={styles.trace} style={T(3.2)} />
      {/* Shield tabs */}
      <rect x="483" y="370" width="4" height="15" rx={1} fill="var(--ic-pad-fill)" fillOpacity={0.32} className={styles.trace} style={T(3.2)} />
      <rect x="533" y="370" width="4" height="15" rx={1} fill="var(--ic-pad-fill)" fillOpacity={0.32} className={styles.trace} style={T(3.2)} />
      {/* Signal pins */}
      {[495,503,511,519,527].map((x, i) => (
        <rect key={`usb${i}`} x={x-1} y={390} width={2.5} height={6} rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.4} className={styles.trace} style={T(3.3 + i*0.03)} />
      ))}

      {/* ═══════════════════════════════════════════════════════════════════════
          Voltage Regulator — SOT-223 footprint (1100, 170)
          ═══════════════════════════════════════════════════════════════════════ */}
      {/* Body outline */}
      <rect x="1090" y="160" width="30" height="20" rx={1.5} {...IC(0.7)} className={styles.trace} style={T(3.4)} />
      {/* Large thermal pad on top */}
      <rect x="1098" y="154" width="14" height="6" rx={1} fill="var(--ic-pad-fill)" fillOpacity={0.4} className={styles.trace} style={T(3.5)} />
      {/* 3 small pads on bottom */}
      <rect x="1094" y="180" width="4" height="5" rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.36} className={styles.trace} style={T(3.5)} />
      <rect x="1103" y="180" width="4" height="5" rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.36} className={styles.trace} style={T(3.5)} />
      <rect x="1112" y="180" width="4" height="5" rx={0.5} fill="var(--ic-pad-fill)" fillOpacity={0.36} className={styles.trace} style={T(3.5)} />

      {/* ═══════════════════════════════════════════════════════════════════════
          Electrons — small bright dots that follow trace paths
          ═══════════════════════════════════════════════════════════════════════ */}
      {ELECTRONS.map(([path, dur, delay, r], i) => (
        <circle key={`e${i}`} r={r} fill="var(--electron-color)" className={styles.electron}>
          <animateMotion
            path={path}
            dur={`${dur}s`}
            begin={`${delay}s`}
            repeatCount="indefinite"
            rotate="auto"
          />
        </circle>
      ))}
    </svg>
  );
}
