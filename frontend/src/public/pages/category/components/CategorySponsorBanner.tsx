import { useState, useRef, useEffect, useCallback, type ReactNode, type KeyboardEvent } from 'react';
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
// 137 / 412 / 687 / 962.
const CHIP_X = { p1: 137, p2: 412, p3: 687, p4: 962 } as const;
const CHIPS: readonly number[] = [CHIP_X.p1, CHIP_X.p2, CHIP_X.p3, CHIP_X.p4];
// Per-pin dx offsets relative to chip center for the 6 stubs each strip draws
// (the 7th pin per row is the primary net's drop-tap and gets a dedicated
// path). Top strip uses -60 for VCC drop-tap; bottom uses +60 for GND.
const TOP_STUB_DX = [-40, -20, 0, 20, 40, 60] as const;
const BOT_STUB_DX = [-60, -40, -20, 0, 20, 40] as const;

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

/**
 * Top board strip — ONE continuous PCB above the four chips. Designed in the
 * style of SponsorBlock's PcbArt: every component lead terminates at a trace
 * endpoint or a documented via, with annotated nets and SponsorBlock-grade
 * comments. Banner is 220px tall; this strip occupies the top 43px (chip pin
 * row overlaps the bottom 11px).
 *
 * NETS
 *   VCC   bus@y6 · J1.pVcc(16,12) · F1(48..78,y6) bridge · L1(88..118,y6) bridge
 *         · C1.t(137,6) tap · drop-taps to chip pin dx=-60 @ y=32:
 *           P1(77,32) P2(352,32) P3(627,32) P4(902,32) · J3.pVcc(1052,12)
 *   P1    J1.pRtn(28,12) → jog right under bus → chip P1 pin dx=-40 (97,32)
 *         · C1.b(137,30) → chip P1 pin dx=0 (137,32)
 *   P2    Y1.legA(260,20) ties C2a.t · Y1.legB(310,20) → clock trunk y=24 →
 *         chip P2 pin dx=-60 (352,32) · C2a/C2b bots terminate at local vias
 *   P3    chip P2 pin dx=+60 (472,32) → up to C3.t(518,20) → C3 → C3.b(518,28)
 *         → jog up to U2.IN-(546,14) → U2 → U2.OUT(610,14) → routed to chip
 *         P3 pin dx=-20 (667,32). U2.IN+(546,22) bias-tied to local via at
 *         (546,30). U2.V+(610,22) tied to VCC bus at (618,6).
 *   P4    chip P3 pin dx=+60 (747,32) → up to R3.t(810,18) → R3 → D1.a(870,18)
 *         → D1 → D1.k(902,18) → chip P4 pin dx=-60 (902,32). J3.pSig(1080,12)
 *         → chip P4 pin dx=+60 (1022,32).
 *
 * Click targets: C1 (P1), Y1 (P2), U2 (P3), D1 (P4).
 */
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

  return (
    <svg
      className={styles.art}
      viewBox="0 0 1100 43"
      preserveAspectRatio="xMidYMin meet"
      role="img"
      aria-label="Reference PCB top strip: J1 power header feeds C1 bulk cap (click to energize Company), Y1 crystal generates clock (click to energize Contact), U2 op-amp conditions signal (click to energize Phone), R3 + D1 LED indicator (click to energize Email), J3 output."
    >
      <defs>
        <linearGradient id="csb-plasma" x1="0" x2="0" y1="1" y2="0">
          <stop offset="0%"   stopColor="#1a4d6e" />
          <stop offset="40%"  stopColor="#3aa3d6" />
          <stop offset="80%"  stopColor="#8fe3ff" />
          <stop offset="100%" stopColor="#d4f5ff" />
        </linearGradient>
        <radialGradient id="csb-led-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%"  stopColor="#fff2a8" stopOpacity="1" />
          <stop offset="55%" stopColor="#f6c453" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#f6c453" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="csb-clk-halo" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%"  stopColor="#bff3ff" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#bff3ff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="csb-wave" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%"   stopColor="#7adfff" stopOpacity="0" />
          <stop offset="30%"  stopColor="#7adfff" stopOpacity="0.9" />
          <stop offset="70%"  stopColor="#f3cf5c" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#f3cf5c" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* ── SHARED VCC BUS (always lit) y=6, full width ─────────────────────── */}
      <g className={styles.busVcc} fill="none" strokeWidth="2">
        <path d="M5 6 H1095" />
      </g>

      {/* ── INTER-CHIP SIGNAL PIPELINE at y=24 (gap-only, not over chip bodies) ── */}
      <g className={styles.busSignal} fill="none" strokeWidth="1.6">
        <path d="M197 24 H352" />   {/* P1.right gap → P2.left */}
        <path d="M472 24 H627" />   {/* P2.right gap → P3.left */}
        <path d="M747 24 H902" />   {/* P3.right gap → P4.left */}
      </g>

      {/* ── VCC DROP-TAPS — bus(y=6) down to chip pin dx=-60 (y=32) ──────────── */}
      <g className={styles.traces} fill="none" strokeWidth="1.6">
        {CHIPS.map((cx) => (
          <path key={`vcc-tap-${cx}`} d={`M${cx - 60} 6 V32`} />
        ))}
      </g>

      {/* ── PER-PIN FAINT STUBS — every remaining chip pin gets a short trace
           from y=22 down to y=32 so NO chip pin is floating. Pins driven by a
           primary net are overlaid by that net's traces below. ── */}
      <g className={styles.tracesFaint} fill="none" strokeWidth="1">
        {CHIPS.flatMap((cx) =>
          TOP_STUB_DX.map((dx) => (
            <path key={`top-stub-${cx}-${dx}`} d={`M${cx + dx} 22 V32`} />
          ))
        )}
      </g>
      <g className={styles.pads}>
        {CHIPS.flatMap((cx) =>
          TOP_STUB_DX.map((dx) => (
            <circle key={`top-stubvia-${cx}-${dx}`} cx={cx + dx} cy={22} r="1.4" />
          ))
        )}
      </g>

      {/* ════════════════════════════════════════════════════════════════════
           NET P1 — POWER IN: J1 → F1 → L1 → C1 → chip P1
           ════════════════════════════════════════════════════════════════════ */}
      <g data-net="p1" data-net-active={activeNets.has('p1')} className={styles.net}>
        <g className={styles.traces} fill="none" strokeWidth="2">
          {/* J1.pVcc(16,12) → VCC bus */}
          <path d="M16 12 V6" />
          {/* J1.pRtn(28,12) → return path jogs right under bus, drops to chip P1 pin dx=-40 */}
          <path d="M28 12 V18 H97 V32" />
          {/* C1.b(137,30) → chip P1 pin dx=0 (137,32) */}
          <path d="M137 30 V32" />
        </g>
        <path
          d="M16 12 V6 H137 V30 V32"
          className={styles.spark}
          fill="none"
          strokeWidth="2.4"
        />

        <g className={styles.pads}>
          {[[16, 12], [28, 12], [97, 32], [137, 6], [137, 30]].map(([cx, cy]) => (
            <g key={`p1-via-${cx}-${cy}`}>
              <circle cx={cx} cy={cy} r="2.2" />
              <circle cx={cx} cy={cy} r="0.8" className={styles.padHole} />
            </g>
          ))}
          {/* Bus solder junctions */}
          <circle cx={77} cy={6} r="1.4" />
          <circle cx={137} cy={6} r="1.4" />
        </g>

        {/* J1 — DC power header. Pins: VCC(16,12), RTN(28,12) */}
        <g className={styles.comp}>
          <rect x="4" y="2" width="36" height="10" rx="1.5" className={styles.compBody} />
          <rect x="10" y="4" width="6" height="6" rx="0.8" fill="#f6c453" />
          <rect x="22" y="4" width="6" height="6" rx="0.8" fill="#cdd6dd" />
          <text x="22" y="20" className={styles.refdes} textAnchor="middle">J1 PWR</text>
        </g>

        {/* F1 — fuse (inline on VCC bus, body envelops bus at y=6) */}
        <g className={styles.comp}>
          <rect x="48" y="3" width="30" height="6" rx="3" className={styles.compBody} />
          <path d="M50 6 L56 4 L62 8 L68 4 L76 6" stroke="#f6c453" strokeWidth="0.6" fill="none" />
          <text x="63" y="14" className={styles.refdes} textAnchor="middle">F1</text>
        </g>

        {/* L1 — ferrite bead (inline on VCC bus) */}
        <g className={styles.comp}>
          <rect x="88" y="3" width="30" height="6" rx="2.4" className={styles.compBody} />
          {[94, 100, 106, 112].map((x) => (
            <line key={`l1-band-${x}`} x1={x} y1="3.6" x2={x} y2="8.4" stroke="#f6c453" strokeWidth="0.5" />
          ))}
          <text x="103" y="14" className={styles.refdes} textAnchor="middle">L1</text>
        </g>

        {/* C1 — bulk electrolytic cap (CLICK). Top lead (137,6)→bus, bottom lead (137,30)→chip P1.dx0 */}
        <g
          data-comp="c1"
          className={styles.clickable}
          role="button"
          tabIndex={0}
          aria-label="Energize power net to highlight Company chip"
          onClick={() => onTriggerNet('p1')}
          onKeyDown={handleKey('p1')}
        >
          <rect x="126" y="2" width="22" height="32" fill="transparent" />
          <g className={styles.comp}>
            <line x1="137" y1="6" x2="137" y2="11" strokeWidth="1.6" />
            <line x1="137" y1="27" x2="137" y2="30" strokeWidth="1.6" />
            <rect x="130" y="11" width="14" height="16" rx="2" className={styles.compBody} />
            <ellipse cx="137" cy="11" rx="7" ry="1.8" className={styles.compBodyTop} />
            <rect x="131" y="13" width="2" height="12" className={styles.capStripe} />
            <g className={styles.plasmaWrap}>
              <rect x="131.5" y="13" width="11" height="12" rx="1" fill="url(#csb-plasma)" className={styles.plasma} />
              <circle cx="135" cy="20" r="1.4" fill="#8fe3ff" className={`${styles.plasmaBlob} ${styles.plasmaBlob1}`} />
              <circle cx="139" cy="17" r="1.1" fill="#d4f5ff" className={`${styles.plasmaBlob} ${styles.plasmaBlob2}`} />
              <circle cx="137" cy="23" r="1.3" fill="#bff3ff" className={`${styles.plasmaBlob} ${styles.plasmaBlob3}`} />
            </g>
            <text x="155" y="20" className={styles.refdesOnBodySmall}>C1</text>
          </g>
        </g>
      </g>

      {/* ════════════════════════════════════════════════════════════════════
           NET P2 — CLOCK: Y1 + C2a/C2b → chip P2 via signal pipeline
           ════════════════════════════════════════════════════════════════════ */}
      <g data-net="p2" data-net-active={activeNets.has('p2')} className={styles.net}>
        <g className={styles.traces} fill="none" strokeWidth="2">
          {/* Clock trunk — Y1.legB(310,20) → bus y=24 → into chip P2 pin dx=-60 (352,32) */}
          <path d="M310 20 V24 H352 V32" />
          {/* C2a bottom (260,28) → local-return via at (260,30) — short tie-down stub */}
          <path d="M260 28 V30" />
          {/* C2b bottom (310,28) → local-return via at (310,30) — short tie-down stub */}
          <path d="M310 28 V30" />
        </g>
        <path
          d="M310 20 V24 H352 V32"
          className={styles.spark}
          fill="none"
          strokeWidth="2.4"
        />

        <g className={styles.pads}>
          {[[260, 20], [260, 28], [260, 30], [310, 20], [310, 28], [310, 30], [352, 32]].map(([cx, cy]) => (
            <g key={`p2-via-${cx}-${cy}`}>
              <circle cx={cx} cy={cy} r="2" />
              <circle cx={cx} cy={cy} r="0.7" className={styles.padHole} />
            </g>
          ))}
          {/* Solder junction where clock trunk taps signal pipeline */}
          <circle cx={310} cy={24} r="1.4" />
        </g>

        {/* C2a — load cap (Y1.legA load). Body x252..268, y20..28; lead pads (260,20) top + (260,28) bot */}
        <g className={styles.comp}>
          <rect x="252" y="20" width="16" height="8" rx="1.2" className={styles.compBody} />
          <text x="260" y="36" className={styles.refdes} textAnchor="middle">C2a</text>
        </g>

        {/* C2b — load cap (Y1.legB load). Body x302..318, y20..28; lead pads (310,20) top + (310,28) bot */}
        <g className={styles.comp}>
          <rect x="302" y="20" width="16" height="8" rx="1.2" className={styles.compBody} />
          <text x="310" y="36" className={styles.refdes} textAnchor="middle">C2b</text>
        </g>

        {/* Y1 — crystal can (CLICK). Body x250..320, y8..20. Body bottom edge IS the
             lead-pad position at (260,20) and (310,20) — no separate <line> leads. */}
        <g
          data-comp="y1"
          className={styles.clickable}
          role="button"
          tabIndex={0}
          aria-label="Energize clock net to highlight Contact chip"
          onClick={() => onTriggerNet('p2')}
          onKeyDown={handleKey('p2')}
        >
          <rect x="244" y="2" width="82" height="22" fill="transparent" />
          <g className={`${styles.comp} ${styles.crystal}`}>
            <ellipse cx="285" cy="14" rx="42" ry="12" className={styles.crystalHalo} fill="url(#csb-clk-halo)" />
            <rect x="250" y="8" width="70" height="12" rx="6" className={styles.compBody} />
            <text x="285" y="17" className={styles.refdesOnBody} textAnchor="middle">Y1 16MHz</text>
          </g>
        </g>
      </g>

      {/* ════════════════════════════════════════════════════════════════════
           NET P3 — SIGNAL: chip P2 out → C3 → U2 op-amp → chip P3
           ════════════════════════════════════════════════════════════════════ */}
      <g data-net="p3" data-net-active={activeNets.has('p3')} className={styles.net}>
        <g className={styles.traces} fill="none" strokeWidth="2">
          {/* chip P2 pin dx=+60 (472,32) → up to C3.t(518,20) */}
          <path d="M472 30 V20 H518" />
          {/* C3.b(518,28) → jog right → up → U2.IN-(546,14) */}
          <path d="M518 28 H540 V14 H546" />
          {/* U2.IN+(546,22) → bias-tie down to local return via (546,30) */}
          <path d="M546 22 V30" />
          {/* U2.OUT(610,14) → right → down → chip P3 pin dx=-20 (667,32) */}
          <path d="M610 14 H650 V30 H667 V32" />
          {/* U2.V+(610,22) → right → up to VCC bus at (618,6) */}
          <path d="M610 22 H618 V6" />
        </g>
        <path
          d="M518 28 H540 V14 H546 M610 14 H650 V30 H667 V32"
          className={styles.spark}
          fill="none"
          strokeWidth="2.4"
        />

        <g className={styles.pads}>
          {[[472, 30], [518, 20], [518, 28], [546, 14], [546, 22], [546, 30], [610, 14], [610, 22], [618, 6], [667, 32]].map(([cx, cy]) => (
            <g key={`p3-via-${cx}-${cy}`}>
              <circle cx={cx} cy={cy} r="2" />
              <circle cx={cx} cy={cy} r="0.7" className={styles.padHole} />
            </g>
          ))}
          {/* Solder junctions */}
          <circle cx={650} cy={30} r="1.4" />
          <circle cx={618} cy={6} r="1.4" />
        </g>

        {/* C3 — input coupling cap. Body x512..524, y20..28; leads (518,20)/(518,28) */}
        <g className={styles.comp}>
          <rect x="512" y="20" width="12" height="8" rx="1.2" className={styles.compBody} />
          <text x="518" y="36" className={styles.refdes} textAnchor="middle">C3</text>
        </g>

        {/* U2 — op-amp DIP-8 (CLICK). Body x552..604, y8..28.
             Left pins (lead tip → body edge):  IN-(546,14)→x552,  IN+(546,22)→x552
             Right pins (body edge → lead tip): OUT(604..610,14),  V+(604..610,22) */}
        <g
          data-comp="u2"
          className={styles.clickable}
          role="button"
          tabIndex={0}
          aria-label="Energize signal net to highlight Phone chip"
          onClick={() => onTriggerNet('p3')}
          onKeyDown={handleKey('p3')}
        >
          <rect x="540" y="2" width="76" height="32" fill="transparent" />
          <g className={`${styles.comp} ${styles.opamp}`}>
            {[14, 22].map((y) => (
              <line key={`u2-l-${y}`} x1="546" y1={y} x2="552" y2={y} strokeWidth="1.6" />
            ))}
            {[14, 22].map((y) => (
              <line key={`u2-r-${y}`} x1="604" y1={y} x2="610" y2={y} strokeWidth="1.6" />
            ))}
            <rect x="552" y="8" width="52" height="20" rx="2.5" className={styles.compBody} />
            <circle cx="556" cy="12" r="1.3" className={styles.pin1} />
            <text x="578" y="20" className={styles.refdesOnBody} textAnchor="middle">U2 OPAMP</text>
            <path
              className={styles.opampWave}
              d="M610 14 Q616 6, 622 14 T634 14 T646 14"
              fill="none"
              stroke="url(#csb-wave)"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </g>
        </g>
      </g>

      {/* ════════════════════════════════════════════════════════════════════
           NET P4 — INDICATOR: chip P3 out → R3 → D1 LED → chip P4 + J3 output
           ════════════════════════════════════════════════════════════════════ */}
      <g data-net="p4" data-net-active={activeNets.has('p4')} className={styles.net}>
        <g className={styles.traces} fill="none" strokeWidth="2">
          {/* chip P3 pin dx=+60 (747,32) → up → into R3.t(810,18) */}
          <path d="M747 30 V18 H810" />
          {/* R3.b(870,18) → D1.a(870,18) — adjacent (R3 right edge IS D1 anode) */}
          {/* D1.k(902,18) → chip P4 pin dx=-60 (902,32) */}
          <path d="M902 18 V32" />
          {/* J3.pSig(1080,12) → chip P4 pin dx=+60 (1022,32) — secondary output */}
          <path d="M1080 12 V20 H1022 V32" />
          {/* J3.pVcc(1052,12) → VCC bus tap (1052,6) */}
          <path d="M1052 12 V6" />
        </g>
        <path
          d="M747 30 V18 H810 M870 18 H902 V32"
          className={styles.spark}
          fill="none"
          strokeWidth="2.4"
        />

        <g className={styles.pads}>
          {[[747, 30], [810, 18], [870, 18], [902, 18], [902, 32], [1022, 32], [1052, 12], [1080, 12]].map(([cx, cy]) => (
            <g key={`p4-via-${cx}-${cy}`}>
              <circle cx={cx} cy={cy} r="2" />
              <circle cx={cx} cy={cy} r="0.7" className={styles.padHole} />
            </g>
          ))}
          {/* Solder junctions */}
          <circle cx={870} cy={18} r="1.4" />
          <circle cx={1052} cy={6} r="1.4" />
        </g>

        {/* R3 — current-limit resistor. Body x810..870, y14..22. Leads (810,18)/(870,18) */}
        <g className={styles.comp}>
          <rect x="810" y="14" width="60" height="8" rx="2" className={styles.compBody} />
          <rect x="816" y="14" width="2" height="8" fill="#7b5226" />
          <rect x="822" y="14" width="2" height="8" fill="#222428" />
          <rect x="848" y="14" width="2" height="8" fill="#b03a2e" />
          <rect x="860" y="14" width="2" height="8" className={styles.bandMetal} />
          <text x="840" y="30" className={styles.refdes} textAnchor="middle">R3 330&#937;</text>
        </g>

        {/* D1 — LED (CLICK). Anode (870,18) ← R3, cathode (902,18) → chip P4 pin */}
        <g
          data-comp="d1"
          className={styles.clickable}
          role="button"
          tabIndex={0}
          aria-label="Energize indicator net to highlight Email chip"
          onClick={() => onTriggerNet('p4')}
          onKeyDown={handleKey('p4')}
        >
          <rect x="868" y="2" width="38" height="28" fill="transparent" />
          <g className={`${styles.comp} ${styles.led}`}>
            <circle cx="886" cy="18" r="18" className={styles.ledHalo} fill="url(#csb-led-glow)" />
            <path
              d="M872 13 H896 L902 18 L896 23 H872 Z"
              className={styles.compBody}
            />
            <circle cx="884" cy="18" r="3" className={styles.ledLens} />
            <rect x="899" y="14" width="2" height="8" className={styles.bandMetal} />
          </g>
        </g>

        {/* J3 — power-out header. Pins: VCC(1052,12), SIG(1080,12) */}
        <g className={styles.comp}>
          <rect x="1040" y="2" width="52" height="10" rx="1.5" className={styles.compBody} />
          <rect x="1046" y="4" width="6" height="6" rx="0.8" fill="#f6c453" />
          <rect x="1074" y="4" width="6" height="6" rx="0.8" fill="#cdd6dd" />
          <text x="1066" y="20" className={styles.refdes} textAnchor="middle">J3 OUT</text>
        </g>
      </g>
    </svg>
  );
}

/**
 * Bottom board strip — mirrors the top with the SAME 4-net layout. A shared
 * GND bus at y=38 collects returns from every chip; each chip's pin dx=+60
 * is the dedicated GND drop-tap. Decoupling caps (C5/C6/C7), a feedback
 * resistor (R4) on P3, and a J2 output header on P4 sit between the chip
 * bottom-pin row and the GND bus.
 *
 * NETS
 *   GND   bus@y38 · drop-taps from chip pin dx=+60 @ y=11
 *         · C5.b(137,32)·C6.b(412,32)·R4.b(660,32)·C7.b(720,32)·J2 body
 *   P1    chip P1 pin dx=0 (137,11) → C5.t(137,22) → C5 → C5.b(137,32) → GND
 *   P2    chip P2 pin dx=0 (412,11) → C6.t(412,22) → C6 → C6.b(412,32) → GND
 *   P3    chip P3 pin dx=-20 (667,11) → R4.t(660,22) feedback → R4 → R4.b(660,32) → GND;
 *         chip P3 pin dx=+20 (707,11) → C7.t(720,22) output → C7 → C7.b(720,32) → GND
 *   P4    chip P4 pin dx=-40 (922,11) → J2.pSig (1018,30) — final output
 */
function BottomBoardArt({ activeNets }: { activeNets: Set<NetId> }) {
  return (
    <svg
      className={styles.artBottom}
      viewBox="0 0 1100 43"
      preserveAspectRatio="xMidYMax meet"
      aria-hidden="true"
    >
      {/* ── SHARED GND BUS (always lit) at y=38, full width ─────────────────── */}
      <g className={styles.busGnd} fill="none" strokeWidth="2">
        <path d="M5 38 H1095" />
      </g>

      {/* ── INTER-CHIP RETURN PATHS at y=14 (gap-only) ──────────────────────── */}
      <g className={styles.busSignal} fill="none" strokeWidth="1.6">
        <path d="M197 14 H352" />
        <path d="M472 14 H627" />
        <path d="M747 14 H902" />
      </g>

      {/* ── GND DROP-TAPS — chip pin dx=+60 (y=11) down to GND bus (y=38) ──── */}
      <g className={styles.traces} fill="none" strokeWidth="1.6">
        {CHIPS.map((cx) => (
          <path key={`gnd-tap-${cx}`} d={`M${cx + 60} 11 V38`} />
        ))}
      </g>

      {/* ── PER-PIN FAINT STUBS — every remaining chip pin gets a short trace
           from y=11 down to y=22 so NO chip pin is floating. ── */}
      <g className={styles.tracesFaint} fill="none" strokeWidth="1">
        {CHIPS.flatMap((cx) =>
          BOT_STUB_DX.map((dx) => (
            <path key={`bot-stub-${cx}-${dx}`} d={`M${cx + dx} 11 V22`} />
          ))
        )}
      </g>
      <g className={styles.pads}>
        {CHIPS.flatMap((cx) =>
          BOT_STUB_DX.map((dx) => (
            <circle key={`bot-stubvia-${cx}-${dx}`} cx={cx + dx} cy={22} r="1.4" />
          ))
        )}
      </g>

      {/* ════════════════════════════════════════════════════════════════════
           P1 OUTPUT — C5 output decoupling cap below chip P1
           ════════════════════════════════════════════════════════════════════ */}
      <g data-net="p1" data-net-active={activeNets.has('p1')} className={styles.net}>
        <g className={styles.traces} fill="none" strokeWidth="2">
          <path d="M137 11 V22" />
          <path d="M137 32 V38" />
        </g>
        <path d="M137 11 V32 V38" className={styles.spark} fill="none" strokeWidth="2.4" />
        <g className={styles.pads}>
          {[[137, 22], [137, 32]].map(([cx, cy]) => (
            <g key={`p1b-via-${cx}-${cy}`}>
              <circle cx={cx} cy={cy} r="2" />
              <circle cx={cx} cy={cy} r="0.7" className={styles.padHole} />
            </g>
          ))}
          <circle cx={137} cy={38} r="1.4" />
        </g>
        <g className={styles.comp}>
          <rect x="128" y="22" width="18" height="10" rx="1.5" className={styles.compBody} />
          <rect x="129" y="23.5" width="2" height="7" className={styles.capStripe} />
          <text x="137" y="42" className={styles.refdes} textAnchor="middle">C5</text>
        </g>
      </g>

      {/* ════════════════════════════════════════════════════════════════════
           P2 OUTPUT — C6 PLL filter cap below chip P2
           ════════════════════════════════════════════════════════════════════ */}
      <g data-net="p2" data-net-active={activeNets.has('p2')} className={styles.net}>
        <g className={styles.traces} fill="none" strokeWidth="2">
          <path d="M412 11 V22" />
          <path d="M412 32 V38" />
        </g>
        <path d="M412 11 V32 V38" className={styles.spark} fill="none" strokeWidth="2.4" />
        <g className={styles.pads}>
          {[[412, 22], [412, 32]].map(([cx, cy]) => (
            <g key={`p2b-via-${cx}-${cy}`}>
              <circle cx={cx} cy={cy} r="2" />
              <circle cx={cx} cy={cy} r="0.7" className={styles.padHole} />
            </g>
          ))}
          <circle cx={412} cy={38} r="1.4" />
        </g>
        <g className={styles.comp}>
          <rect x="403" y="22" width="18" height="10" rx="1.5" className={styles.compBody} />
          <rect x="404" y="23.5" width="2" height="7" className={styles.capStripe} />
          <text x="412" y="42" className={styles.refdes} textAnchor="middle">C6</text>
        </g>
      </g>

      {/* ════════════════════════════════════════════════════════════════════
           P3 OUTPUT — R4 feedback resistor + C7 output coupling cap
           ════════════════════════════════════════════════════════════════════ */}
      <g data-net="p3" data-net-active={activeNets.has('p3')} className={styles.net}>
        <g className={styles.traces} fill="none" strokeWidth="2">
          <path d="M667 11 V18 H660 V22" />
          <path d="M660 32 V38" />
          <path d="M707 11 V18 H720 V22" />
          <path d="M720 32 V38" />
        </g>
        <path
          d="M667 11 V18 H660 V32 M707 11 V18 H720 V32"
          className={styles.spark}
          fill="none"
          strokeWidth="2.4"
        />
        <g className={styles.pads}>
          {[[660, 22], [660, 32], [720, 22], [720, 32], [667, 18], [707, 18]].map(([cx, cy]) => (
            <g key={`p3b-via-${cx}-${cy}`}>
              <circle cx={cx} cy={cy} r="2" />
              <circle cx={cx} cy={cy} r="0.7" className={styles.padHole} />
            </g>
          ))}
          <circle cx={660} cy={38} r="1.4" />
          <circle cx={720} cy={38} r="1.4" />
        </g>
        <g className={styles.comp}>
          <rect x="650" y="22" width="20" height="10" rx="2" className={styles.compBody} />
          <rect x="654" y="22" width="2" height="10" fill="#7b5226" />
          <rect x="658" y="22" width="2" height="10" fill="#222428" />
          <rect x="662" y="22" width="2" height="10" fill="#3a72c0" />
          <rect x="666" y="22" width="2" height="10" className={styles.bandMetal} />
          <text x="660" y="42" className={styles.refdes} textAnchor="middle">R4</text>
        </g>
        <g className={styles.comp}>
          <rect x="711" y="22" width="18" height="10" rx="1.5" className={styles.compBody} />
          <rect x="712" y="23.5" width="2" height="7" className={styles.capStripe} />
          <text x="720" y="42" className={styles.refdes} textAnchor="middle">C7</text>
        </g>
      </g>

      {/* ════════════════════════════════════════════════════════════════════
           P4 OUTPUT — J2 final output header below chip P4
           ════════════════════════════════════════════════════════════════════ */}
      <g data-net="p4" data-net-active={activeNets.has('p4')} className={styles.net}>
        <g className={styles.traces} fill="none" strokeWidth="2">
          <path d="M922 11 V26 H1018 V30" />
        </g>
        <path d="M922 11 V26 H1018 V30" className={styles.spark} fill="none" strokeWidth="2.4" />
        <g className={styles.pads}>
          {[[922, 26], [1018, 30]].map(([cx, cy]) => (
            <g key={`p4b-via-${cx}-${cy}`}>
              <circle cx={cx} cy={cy} r="2" />
              <circle cx={cx} cy={cy} r="0.7" className={styles.padHole} />
            </g>
          ))}
        </g>
        {/* J2 — output header. Body envelops the GND bus, body sits on top of
             y=30..40, GND pin (rightmost, 1076..1082) physically intersects the
             y=38 bus so no extra GND tap trace is needed. */}
        <g className={styles.comp}>
          <rect x="1004" y="30" width="92" height="10" rx="1.5" className={styles.compBody} />
          <rect x="1010" y="32" width="6" height="6" rx="0.8" fill="#f6c453" />
          <rect x="1032" y="32" width="6" height="6" rx="0.8" fill="#cdd6dd" />
          <rect x="1054" y="32" width="6" height="6" rx="0.8" fill="#cdd6dd" />
          <rect x="1076" y="32" width="6" height="6" rx="0.8" fill="#cdd6dd" />
          <text x="1050" y="14" className={styles.refdes} textAnchor="middle">J2 OUT</text>
        </g>
      </g>
    </svg>
  );
}
function BoardShell({
  tier,
  empty,
  children,
}: {
  tier?: string;
  empty?: boolean;
  children: ReactNode;
}) {
  const boardRef = useRef<HTMLDivElement>(null);

  // Cursor lamp — desktop-only warm-pool tracking the pointer. The boardArt
  // sits inside .rail now (not the .board), so the lamp is the only board-
  // level chrome that benefits from a board-wide reference rect.
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let rect: DOMRect | null = null;
    let raf = 0;

    const onEnter = () => {
      rect = el.getBoundingClientRect();
      el.setAttribute('data-lit', 'true');
    };
    const onLeave = () => el.setAttribute('data-lit', 'false');
    const onMove = (e: PointerEvent) => {
      if (raf) return;
      const r = rect ?? el.getBoundingClientRect();
      rect = r;
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      raf = requestAnimationFrame(() => {
        raf = 0;
        el.style.setProperty('--mx', `${x}px`);
        el.style.setProperty('--my', `${y}px`);
      });
    };
    const invalidate = () => { rect = null; };

    let attached = false;
    const attach = () => {
      if (attached) return;
      attached = true;
      el.addEventListener('pointerenter', onEnter);
      el.addEventListener('pointerleave', onLeave);
      el.addEventListener('pointermove', onMove);
      window.addEventListener('scroll', invalidate, true);
      window.addEventListener('resize', invalidate);
    };
    const detach = () => {
      if (!attached) return;
      attached = false;
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointermove', onMove);
      window.removeEventListener('scroll', invalidate, true);
      window.removeEventListener('resize', invalidate);
      el.setAttribute('data-lit', 'false');
    };

    const sync = () => (fine.matches && !reduced.matches ? attach() : detach());
    sync();
    fine.addEventListener('change', sync);
    reduced.addEventListener('change', sync);

    return () => {
      detach();
      fine.removeEventListener('change', sync);
      reduced.removeEventListener('change', sync);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <motion.div
      ref={boardRef}
      className={`${styles.board} ${empty ? styles.boardEmpty : ''}`}
      data-tier={(tier ?? 'gold').toLowerCase()}
      data-lit="false"
      role="region"
      aria-label={empty ? 'Open category sponsor slot' : 'Featured category sponsor'}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: 'easeOut' as const }}
    >
      <div className={styles.substrate} aria-hidden="true" />
      <div className={styles.lamp} aria-hidden="true" />
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

function ChipPinRow({ side }: { side: 'top' | 'bottom' }) {
  // Pin rows flank the chip body on top and bottom. Each pin can pulse
  // independently under CSS when its chip is illuminated.
  return (
    <span
      className={`${styles.chipPins} ${side === 'top' ? styles.chipPinsTop : styles.chipPinsBottom}`}
      aria-hidden="true"
    >
      {Array.from({ length: 7 }, (_, i) => (
        <span key={i} className={styles.chipPin} />
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

  // Rail with the SVG circuit + 4 chips inside it. Scoped so the .id (sponsor
  // brand) column stays clean — no PCB components paint over it.
  const Rail = (
    <div className={styles.rail}>
      <div className={styles.boardArt}>
        <BoardArt activeNets={activeNets} onTriggerNet={triggerNet} />
      </div>
      <div className={styles.boardArtBottom}>
        <BottomBoardArt activeNets={activeNets} />
      </div>

      <div className={styles.field} data-illuminated={activeNets.has('p1')}>
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

      <div className={styles.field} data-illuminated={activeNets.has('p2')}>
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

      <div className={styles.field} data-illuminated={activeNets.has('p3')}>
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

      <div className={styles.field} data-illuminated={activeNets.has('p4')}>
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
