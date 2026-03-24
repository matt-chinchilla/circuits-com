import styles from './CircuitTraces.module.scss';

// Shorthand helpers for consistent stroke/animation props
const T = (d: number) => ({ animationDelay: `${d}s` });
const S = (o: number, w = 1) => ({ stroke: `rgba(201,168,76,${o})`, strokeWidth: w });
const DASH = { strokeDasharray: 1200, strokeDashoffset: 1200 };

// Electrons: [path, duration(s), begin(s), radius]
// begin = trace's T() animationDelay + ~4s (time for draw-circuit to make path visible)
const ELECTRONS: [string, number, number, number][] = [
  // Bundle 1 — IC1 left → left edge (traces T=0.6, T=1.0)
  ['M411 140 H380 L360 120 H200 L170 90 H0', 3, 4.6, 2],
  ['M411 180 H398 L378 160 H240 L210 130 H0', 3.5, 5, 1.5],
  // Bundle 2 — IC1 bottom → bottom edge (trace T=1.2)
  ['M450 229 V270 L430 290 V400', 2.5, 5.2, 1.8],
  // Bundle 3 — IC1 right → IC2 left (traces T=1.2, T=1.5)
  ['M519 145 H580 L600 125 H750 L770 110 H913', 4, 5.2, 2],
  ['M519 175 H595 L615 155 H765 L785 140 H913', 4.5, 5.5, 1.5],
  // Bundle 4 — IC1 top → top edge (trace T=0.7)
  ['M460 121 V90 L480 70 V20 L500 0', 2.5, 4.7, 1.8],
  // Bundle 5 — IC2 right → right edge (trace T=3.0)
  ['M977 110 H1020 L1040 90 H1100 L1120 70 H1200', 3, 7, 2],
  // Long horizontal — full-span (trace T=3.8)
  ['M0 380 H200 L220 360 H400 L420 380 H620 L650 350 H800 L830 320 H950 L970 340 H1200', 6, 7.8, 2.2],
  // Vertical long-run (trace T=1.8)
  ['M650 0 V60 L670 80 V160 L690 180 V400', 4, 5.8, 1.8],
  // Cross-board horizontal (trace T=2.5)
  ['M550 300 H700 L720 280 H850 L870 260 H1000 L1020 240 H1200', 4.5, 6.5, 1.5],
  // IC3 bottom → bottom edge (trace T=3.5)
  ['M150 327 V350 L170 370 H300 L320 390 V400', 3, 7.5, 1.8],
  // Power rail — top edge (trace T=0)
  ['M0 10 H1200', 5, 4, 2],
  // Power rail — bottom edge (trace T=0.1)
  ['M1200 390 H0', 5.5, 4.1, 1.8],
  // USB trace → IC1 (trace T=3.3)
  ['M511 390 V380 L490 360 V340 L470 320 V275', 3, 7.3, 1.5],
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
      {/* ═══════════════════════════════════════════════════════════════════════
          QFP IC Package 1 — large, center-left (body at 420,130 → 510,220)
          ═══════════════════════════════════════════════════════════════════════ */}
      <rect x="420" y="130" width="90" height="90" rx="2" {...S(0.12, 1)} fill="rgba(201,168,76,0.02)" className={styles.trace} style={T(0.2)} />
      {/* Notch */}
      <path d="M460 130 A5 5 0 0 0 470 130" {...S(0.1, 0.8)} fill="none" className={styles.trace} style={T(0.2)} />
      {/* Top pads */}
      {[430,440,450,460,470,480,490,500].map((x, i) => (
        <rect key={`ic1t${i}`} x={x-1.5} y={121} width={3} height={9} rx={0.5} fill={`rgba(201,168,76,${0.25})`} className={styles.trace} style={T(0.3 + i*0.05)} />
      ))}
      {/* Bottom pads */}
      {[430,440,450,460,470,480,490,500].map((x, i) => (
        <rect key={`ic1b${i}`} x={x-1.5} y={220} width={3} height={9} rx={0.5} fill={`rgba(201,168,76,${0.25})`} className={styles.trace} style={T(0.3 + i*0.05)} />
      ))}
      {/* Left pads */}
      {[140,150,160,170,180,190,200,210].map((y, i) => (
        <rect key={`ic1l${i}`} x={411} y={y-1.5} width={9} height={3} rx={0.5} fill={`rgba(201,168,76,${0.25})`} className={styles.trace} style={T(0.4 + i*0.05)} />
      ))}
      {/* Right pads */}
      {[140,150,160,170,180,190,200,210].map((y, i) => (
        <rect key={`ic1r${i}`} x={510} y={y-1.5} width={9} height={3} rx={0.5} fill={`rgba(201,168,76,${0.25})`} className={styles.trace} style={T(0.4 + i*0.05)} />
      ))}

      {/* ═══════════════════════════════════════════════════════════════════════
          QFP IC Package 2 — small, right (body at 920,100 → 970,150)
          ═══════════════════════════════════════════════════════════════════════ */}
      <rect x="920" y="100" width="50" height="50" rx="2" {...S(0.1, 0.8)} fill="rgba(201,168,76,0.02)" className={styles.trace} style={T(2.5)} />
      {/* Top pads */}
      {[930,940,950,960].map((x, i) => (
        <rect key={`ic2t${i}`} x={x-1} y={93} width={2.5} height={7} rx={0.5} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(2.6 + i*0.05)} />
      ))}
      {/* Bottom pads */}
      {[930,940,950,960].map((x, i) => (
        <rect key={`ic2b${i}`} x={x-1} y={150} width={2.5} height={7} rx={0.5} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(2.6 + i*0.05)} />
      ))}
      {/* Left pads */}
      {[110,120,130,140].map((y, i) => (
        <rect key={`ic2l${i}`} x={913} y={y-1} width={7} height={2.5} rx={0.5} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(2.7 + i*0.05)} />
      ))}
      {/* Right pads */}
      {[110,120,130,140].map((y, i) => (
        <rect key={`ic2r${i}`} x={970} y={y-1} width={7} height={2.5} rx={0.5} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(2.7 + i*0.05)} />
      ))}

      {/* ═══════════════════════════════════════════════════════════════════════
          SOIC IC Package 3 — bottom-left (body at 140,280 → 200,320)
          ═══════════════════════════════════════════════════════════════════════ */}
      <rect x="140" y="280" width="60" height="40" rx="2" {...S(0.09, 0.8)} fill="rgba(201,168,76,0.015)" className={styles.trace} style={T(3.0)} />
      {[150,160,170,180,190].map((x, i) => (
        <g key={`ic3p${i}`}>
          <rect x={x-1} y={273} width={2.5} height={7} rx={0.5} fill="rgba(201,168,76,0.09)" className={styles.trace} style={T(3.1 + i*0.04)} />
          <rect x={x-1} y={320} width={2.5} height={7} rx={0.5} fill="rgba(201,168,76,0.09)" className={styles.trace} style={T(3.1 + i*0.04)} />
        </g>
      ))}

      {/* ═══════════════════════════════════════════════════════════════════════
          SMD Component Pads — pairs of rectangular pads (resistors/caps)
          ═══════════════════════════════════════════════════════════════════════ */}
      {/* SMD 1 — horizontal, near IC1 top */}
      <rect x="445" y="82" width="8" height="5" rx={1} fill="rgba(201,168,76,0.12)" className={styles.trace} style={T(0.7)} />
      <rect x="457" y="82" width="8" height="5" rx={1} fill="rgba(201,168,76,0.12)" className={styles.trace} style={T(0.7)} />
      {/* SMD 2 */}
      <rect x="530" y="155" width="8" height="5" rx={1} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(1.0)} />
      <rect x="542" y="155" width="8" height="5" rx={1} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(1.0)} />
      {/* SMD 3 */}
      <rect x="370" y="175" width="5" height="8" rx={1} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(1.2)} />
      <rect x="370" y="187" width="5" height="8" rx={1} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(1.2)} />
      {/* SMD 4 — near IC2 */}
      <rect x="870" y="118" width="7" height="4" rx={1} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(2.3)} />
      <rect x="881" y="118" width="7" height="4" rx={1} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(2.3)} />
      {/* SMD 5 */}
      <rect x="1000" y="135" width="7" height="4" rx={1} fill="rgba(201,168,76,0.09)" className={styles.trace} style={T(3.2)} />
      <rect x="1011" y="135" width="7" height="4" rx={1} fill="rgba(201,168,76,0.09)" className={styles.trace} style={T(3.2)} />
      {/* SMD 6 — bottom area */}
      <rect x="650" y="310" width="5" height="8" rx={1} fill="rgba(201,168,76,0.08)" className={styles.trace} style={T(3.8)} />
      <rect x="650" y="322" width="5" height="8" rx={1} fill="rgba(201,168,76,0.08)" className={styles.trace} style={T(3.8)} />
      {/* SMD 7 */}
      <rect x="780" y="260" width="8" height="4" rx={1} fill="rgba(201,168,76,0.09)" className={styles.trace} style={T(3.5)} />
      <rect x="792" y="260" width="8" height="4" rx={1} fill="rgba(201,168,76,0.09)" className={styles.trace} style={T(3.5)} />
      {/* SMD 8 — far left */}
      <rect x="60" y="160" width="7" height="4" rx={1} fill="rgba(201,168,76,0.08)" className={styles.trace} style={T(1.8)} />
      <rect x="71" y="160" width="7" height="4" rx={1} fill="rgba(201,168,76,0.08)" className={styles.trace} style={T(1.8)} />
      {/* SMD 9 — top center */}
      <rect x="700" y="50" width="4" height="7" rx={1} fill="rgba(201,168,76,0.08)" className={styles.trace} style={T(2.0)} />
      <rect x="700" y="61" width="4" height="7" rx={1} fill="rgba(201,168,76,0.08)" className={styles.trace} style={T(2.0)} />
      {/* SMD 10 */}
      <rect x="300" y="340" width="8" height="4" rx={1} fill="rgba(201,168,76,0.07)" className={styles.trace} style={T(4.2)} />
      <rect x="312" y="340" width="8" height="4" rx={1} fill="rgba(201,168,76,0.07)" className={styles.trace} style={T(4.2)} />

      {/* ═══════════════════════════════════════════════════════════════════════
          Through-hole pad array — top-left edge connector
          ═══════════════════════════════════════════════════════════════════════ */}
      {[30,50,70,90,110,130].map((x, i) => (
        <g key={`th${i}`}>
          <circle cx={x} cy={40} r={4.5} fill="rgba(218,165,32,0.08)" stroke="rgba(218,165,32,0.2)" strokeWidth={1} className={styles.node} style={T(0.1 + i*0.15)} />
          <circle cx={x} cy={40} r={1.5} fill="rgba(218,165,32,0.3)" className={styles.node} style={T(0.1 + i*0.15)} />
        </g>
      ))}
      {/* Second row */}
      {[30,50,70,90,110,130].map((x, i) => (
        <g key={`th2${i}`}>
          <circle cx={x} cy={60} r={4.5} fill="rgba(218,165,32,0.08)" stroke="rgba(218,165,32,0.2)" strokeWidth={1} className={styles.node} style={T(0.2 + i*0.15)} />
          <circle cx={x} cy={60} r={1.5} fill="rgba(218,165,32,0.3)" className={styles.node} style={T(0.2 + i*0.15)} />
        </g>
      ))}

      {/* ═══════════════════════════════════════════════════════════════════════
          Through-hole pad array — right edge
          ═══════════════════════════════════════════════════════════════════════ */}
      {[200,220,240,260,280].map((y, i) => (
        <g key={`thr${i}`}>
          <circle cx={1170} cy={y} r={4} fill="rgba(218,165,32,0.06)" stroke="rgba(218,165,32,0.18)" strokeWidth={0.8} className={styles.node} style={T(3.5 + i*0.12)} />
          <circle cx={1170} cy={y} r={1.5} fill="rgba(218,165,32,0.25)" className={styles.node} style={T(3.5 + i*0.12)} />
        </g>
      ))}

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
          <circle cx={cx} cy={cy} r={r as number} fill="rgba(218,165,32,0.08)" stroke="rgba(218,165,32,0.2)" strokeWidth={0.8} className={styles.node} style={T(0.2 + i * 0.13)} />
          <circle cx={cx} cy={cy} r={(r as number) * 0.4} fill="rgba(218,165,32,0.3)" className={styles.node} style={T(0.2 + i * 0.13)} />
        </g>
      ))}

      {/* ═══════════════════════════════════════════════════════════════════════
          Ground plane fragments — low-opacity filled areas
          ═══════════════════════════════════════════════════════════════════════ */}
      <rect x="580" y="200" width="45" height="35" rx={2} fill="rgba(201,168,76,0.02)" stroke="rgba(201,168,76,0.04)" strokeWidth={0.5} className={styles.node} style={T(2.0)} />
      <rect x="1050" y="150" width="35" height="45" rx={2} fill="rgba(201,168,76,0.02)" stroke="rgba(201,168,76,0.04)" strokeWidth={0.5} className={styles.node} style={T(3.6)} />
      <rect x="200" y="320" width="50" height="30" rx={2} fill="rgba(201,168,76,0.015)" stroke="rgba(201,168,76,0.035)" strokeWidth={0.5} className={styles.node} style={T(3.2)} />

      {/* ═══════════════════════════════════════════════════════════════════════
          Decoupling caps near IC corners + pull-up resistor pads
          ═══════════════════════════════════════════════════════════════════════ */}
      <rect x="415" y="110" width="6" height="3" rx={0.5} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(0.5)} />
      <rect x="425" y="110" width="6" height="3" rx={0.5} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(0.5)} />
      <rect x="499" y="110" width="6" height="3" rx={0.5} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(0.6)} />
      <rect x="509" y="110" width="6" height="3" rx={0.5} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(0.6)} />
      <rect x="915" y="85" width="5" height="3" rx={0.5} fill="rgba(201,168,76,0.08)" className={styles.trace} style={T(2.4)} />
      <rect x="923" y="85" width="5" height="3" rx={0.5} fill="rgba(201,168,76,0.08)" className={styles.trace} style={T(2.4)} />
      <rect x="345" y="95" width="3" height="6" rx={0.5} fill="rgba(201,168,76,0.08)" className={styles.trace} style={T(0.9)} />
      <rect x="345" y="105" width="3" height="6" rx={0.5} fill="rgba(201,168,76,0.08)" className={styles.trace} style={T(0.9)} />
      <rect x="355" y="95" width="3" height="6" rx={0.5} fill="rgba(201,168,76,0.08)" className={styles.trace} style={T(0.9)} />
      <rect x="355" y="105" width="3" height="6" rx={0.5} fill="rgba(201,168,76,0.08)" className={styles.trace} style={T(0.9)} />
      <rect x="365" y="95" width="3" height="6" rx={0.5} fill="rgba(201,168,76,0.08)" className={styles.trace} style={T(1.0)} />
      <rect x="365" y="105" width="3" height="6" rx={0.5} fill="rgba(201,168,76,0.08)" className={styles.trace} style={T(1.0)} />

      {/* ═══════════════════════════════════════════════════════════════════════
          BGA Package — grid of solder balls (center-right, 740,260)
          ═══════════════════════════════════════════════════════════════════════ */}
      <rect x="730" y="250" width="44" height="44" rx={2} {...S(0.08, 0.6)} fill="rgba(201,168,76,0.015)" className={styles.trace} style={T(2.2)} />
      {[0,1,2,3].map(row =>
        [0,1,2,3].map(col => (
          <circle key={`bga${row}${col}`} cx={740 + col*10} cy={260 + row*10} r={2} fill="rgba(218,165,32,0.2)" className={styles.node} style={T(2.3 + (row*4+col)*0.04)} />
        ))
      )}
      {/* BGA fan-out traces → exit bottom */}
      <path d="M740 294 V320 L730 340 V400" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(2.8)} />
      <path d="M760 294 V330 L770 350 V400" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(2.9)} />

      {/* ═══════════════════════════════════════════════════════════════════════
          Crystal Oscillator — rectangular can with 4 pads (590,40)
          ═══════════════════════════════════════════════════════════════════════ */}
      <rect x="575" y="30" width="30" height="16" rx={3} {...S(0.1, 0.8)} fill="rgba(201,168,76,0.02)" className={styles.trace} style={T(1.6)} />
      {/* 4 pads at corners */}
      <rect x="578" y="26" width="4" height="4" rx={0.5} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(1.7)} />
      <rect x="598" y="26" width="4" height="4" rx={0.5} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(1.7)} />
      <rect x="578" y="46" width="4" height="4" rx={0.5} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(1.7)} />
      <rect x="598" y="46" width="4" height="4" rx={0.5} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(1.7)} />
      {/* Traces from crystal → exit top or connect to IC1 top bundle */}
      <path d="M580 26 V0" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(1.8)} />
      <path d="M600 50 V72 L580 92 V121" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(1.8)} />

      {/* ═══════════════════════════════════════════════════════════════════════
          SOT-23 Transistors — 3-pad triangular footprint
          ═══════════════════════════════════════════════════════════════════════ */}
      {/* Transistor 1 at (90, 200) */}
      <rect x="82" y="193" width="4" height="5" rx={0.5} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(1.6)} />
      <rect x="96" y="193" width="4" height="5" rx={0.5} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(1.6)} />
      <rect x="89" y="206" width="4" height="5" rx={0.5} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(1.6)} />
      <path d="M84 193 V180 L60 160" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(1.7)} />
      <path d="M98 193 V180 L120 160 V140 H0" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(1.7)} />
      <path d="M91 211 V230 L80 250 V280" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(1.8)} />

      {/* Transistor 2 at (1040, 310) */}
      <rect x="1032" y="303" width="4" height="5" rx={0.5} fill="rgba(201,168,76,0.09)" className={styles.trace} style={T(3.6)} />
      <rect x="1046" y="303" width="4" height="5" rx={0.5} fill="rgba(201,168,76,0.09)" className={styles.trace} style={T(3.6)} />
      <rect x="1039" y="316" width="4" height="5" rx={0.5} fill="rgba(201,168,76,0.09)" className={styles.trace} style={T(3.6)} />
      <path d="M1034 303 V290 L1020 270 V240 H1200" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.7)} />
      <path d="M1048 303 V290 L1060 270 V250 L1080 230 V200" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.7)} />
      <path d="M1041 321 V340 L1060 360 V400" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.8)} />

      {/* ═══════════════════════════════════════════════════════════════════════
          Inductor / Coil — spiral symbol (350, 255)
          ═══════════════════════════════════════════════════════════════════════ */}
      <path
        d="M330 260 C335 250, 345 250, 345 260 C345 270, 355 270, 355 260 C355 250, 365 250, 365 260 C365 270, 375 270, 375 260"
        {...S(0.1, 1)} fill="none" className={styles.trace} style={T(2.0)}
      />
      {/* Pads at coil ends */}
      <rect x="323" y="257" width="7" height="6" rx={1} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(2.0)} />
      <rect x="375" y="257" width="7" height="6" rx={1} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(2.0)} />
      {/* Coil traces */}
      <path d="M323 260 H280 L260 240" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(2.1)} />
      <path d="M382 260 H400 L420 280" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(2.1)} />

      {/* ═══════════════════════════════════════════════════════════════════════
          Diode Symbols — triangle + bar
          ═══════════════════════════════════════════════════════════════════════ */}
      {/* Diode 1 at (850, 350) — horizontal */}
      <path d="M840 343 L855 350 L840 357 Z" {...S(0.09, 0.8)} fill="rgba(201,168,76,0.04)" className={styles.trace} style={T(3.4)} />
      <line x1="855" y1="343" x2="855" y2="357" {...S(0.09, 0.8)} className={styles.trace} style={T(3.4)} />
      <path d="M830 350 H840" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(3.4)} />
      <path d="M855 350 H870 L890 370 V400" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(3.5)} />

      {/* Diode 2 at (200, 155) — vertical */}
      <path d="M193 145 L200 160 L207 145 Z" {...S(0.08, 0.8)} fill="rgba(201,168,76,0.03)" className={styles.trace} style={T(1.4)} />
      <line x1="193" y1="160" x2="207" y2="160" {...S(0.08, 0.8)} className={styles.trace} style={T(1.4)} />

      {/* ═══════════════════════════════════════════════════════════════════════
          Electrolytic Capacitor — circle with polarity mark (620, 240)
          ═══════════════════════════════════════════════════════════════════════ */}
      <circle cx="620" cy="240" r="10" {...S(0.08, 0.8)} fill="rgba(201,168,76,0.015)" className={styles.trace} style={T(2.1)} />
      <line x1="616" y1="234" x2="624" y2="234" {...S(0.1, 0.8)} className={styles.trace} style={T(2.1)} />
      <line x1="620" y1="230" x2="620" y2="238" {...S(0.1, 0.8)} className={styles.trace} style={T(2.1)} />
      {/* Leads */}
      <path d="M620 230 V200 L640 180 V160 L670 130 V80" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(2.2)} />
      <path d="M620 250 V280 L640 300 V400" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(2.2)} />

      {/* ═══════════════════════════════════════════════════════════════════════
          Test Points — single exposed circular pads
          ═══════════════════════════════════════════════════════════════════════ */}
      {[
        [50, 290, 'TP1'], [560, 270, 'TP2'], [900, 50, 'TP3'],
        [1100, 300, 'TP4'], [400, 350, 'TP5'],
      ].map(([x, y, label]) => (
        <g key={label as string}>
          <circle cx={x as number} cy={y as number} r={3.5} fill="rgba(218,165,32,0.1)" stroke="rgba(218,165,32,0.22)" strokeWidth={1} className={styles.node} style={T(2.5)} />
          <circle cx={x as number} cy={y as number} r={1} fill="rgba(218,165,32,0.35)" className={styles.node} style={T(2.5)} />
        </g>
      ))}

      {/* ═══════════════════════════════════════════════════════════════════════
          Fiducial Markers — target circles at board corners
          ═══════════════════════════════════════════════════════════════════════ */}
      {[[25, 380], [1175, 20], [1175, 380]].map(([x, y], i) => (
        <g key={`fid${i}`}>
          <circle cx={x} cy={y} r={6} fill="none" {...S(0.06, 0.5)} className={styles.node} style={T(0.1)} />
          <circle cx={x} cy={y} r={3} fill="none" {...S(0.08, 0.5)} className={styles.node} style={T(0.1)} />
          <circle cx={x} cy={y} r={1.2} fill="rgba(218,165,32,0.25)" className={styles.node} style={T(0.1)} />
        </g>
      ))}

      {/* ═══════════════════════════════════════════════════════════════════════
          USB Connector Footprint — pad array at bottom edge (500, 370)
          ═══════════════════════════════════════════════════════════════════════ */}
      <rect x="485" y="365" width="50" height="25" rx={2} {...S(0.07, 0.6)} fill="rgba(201,168,76,0.01)" className={styles.trace} style={T(3.2)} />
      {/* Shield tabs */}
      <rect x="483" y="370" width="4" height="15" rx={1} fill="rgba(201,168,76,0.08)" className={styles.trace} style={T(3.2)} />
      <rect x="533" y="370" width="4" height="15" rx={1} fill="rgba(201,168,76,0.08)" className={styles.trace} style={T(3.2)} />
      {/* Signal pins */}
      {[495,503,511,519,527].map((x, i) => (
        <rect key={`usb${i}`} x={x-1} y={390} width={2.5} height={6} rx={0.5} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(3.3 + i*0.03)} />
      ))}
      {/* USB traces → exit bottom */}
      <path d="M495 396 V400" {...S(0.06, 0.6)} {...DASH} className={styles.trace} style={T(3.4)} />
      <path d="M503 396 V400" {...S(0.06, 0.6)} {...DASH} className={styles.trace} style={T(3.4)} />
      <path d="M519 396 V400" {...S(0.06, 0.6)} {...DASH} className={styles.trace} style={T(3.4)} />
      {/* USB traces → route to IC1 bottom */}
      <path d="M511 390 V380 L490 360 V340 L470 320 V275" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(3.3)} />
      <path d="M527 390 V375 L545 355 V320 L560 300" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.4)} />

      {/* ═══════════════════════════════════════════════════════════════════════
          Voltage Regulator — SOT-223 footprint (1100, 170)
          ═══════════════════════════════════════════════════════════════════════ */}
      {/* Body outline */}
      <rect x="1090" y="160" width="30" height="20" rx={1.5} {...S(0.08, 0.7)} fill="rgba(201,168,76,0.015)" className={styles.trace} style={T(3.4)} />
      {/* Large thermal pad on top */}
      <rect x="1098" y="154" width="14" height="6" rx={1} fill="rgba(201,168,76,0.1)" className={styles.trace} style={T(3.5)} />
      {/* 3 small pads on bottom */}
      <rect x="1094" y="180" width="4" height="5" rx={0.5} fill="rgba(201,168,76,0.09)" className={styles.trace} style={T(3.5)} />
      <rect x="1103" y="180" width="4" height="5" rx={0.5} fill="rgba(201,168,76,0.09)" className={styles.trace} style={T(3.5)} />
      <rect x="1112" y="180" width="4" height="5" rx={0.5} fill="rgba(201,168,76,0.09)" className={styles.trace} style={T(3.5)} />
      {/* Regulator traces */}
      <path d="M1105 154 V120 L1080 100 V0" {...S(0.06, 0.7)} {...DASH} className={styles.trace} style={T(3.6)} />
      <path d="M1096 185 V200 L1080 220 V250" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.6)} />
      <path d="M1114 185 V210 L1135 230 V400" {...S(0.05, 0.6)} {...DASH} className={styles.trace} style={T(3.7)} />

      {/* ═══════════════════════════════════════════════════════════════════════
          Electrons — small bright dots that follow trace paths
          ═══════════════════════════════════════════════════════════════════════ */}
      {ELECTRONS.map(([path, dur, delay, r], i) => (
        <circle key={`e${i}`} r={r} fill="rgba(255, 220, 80, 0.9)" className={styles.electron}>
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
