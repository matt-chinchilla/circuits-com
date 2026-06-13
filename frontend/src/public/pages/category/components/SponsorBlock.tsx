import { useRef, useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import type { Sponsor } from '@public/types/sponsor';
import { prependScheme } from '@shared/utils/url';
import { lettermark } from '@shared/utils/lettermark';
import { formatPhone } from '@shared/utils/phone';
import styles from './SponsorBlock.module.scss';

interface SponsorBlockProps {
  sponsor: Sponsor | null;
}

// The float-in entrance plays only on the FIRST card of the session — including
// the empty "open slot" card shown on a parent page, so it animates once on the
// genuine first load into a category and never again. CategoryPage remounts on
// every subcategory nav (pathname-keyed ErrorBoundary), which re-fired this 0.5s
// float-in each time and read as "nauseating". After the first paint the card is
// a top-loaded element rendered in its final position. Module-scoped: persists
// across SPA nav, resets on a full page reload.
let sponsorBlockHasAnimated = false;

/**
 * Hidden through-hole + SMD components scattered across the board. They live
 * behind a radial mask and only become visible inside the cursor "flashlight"
 * pool. Static markup — painted once, no SVG filters (a prior mobile-lag
 * incident traced to feGaussianBlur), so the only per-frame work is the mask
 * window sliding with two CSS custom properties.
 */
function PcbArt() {
  return (
    <svg
      className={styles.art}
      viewBox="0 0 300 360"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {/*
        MCU reference circuit — fully routed. Grid = 12px. Content kept inside
        x∈[16,284], y∈[30,330] (slice-crop safe). Every component pin tip is an
        exact trace endpoint or pad/via centre.

        U1  MCU, 8 pins/side. Body x132..168, y138..234.
            Left  pin tips x=120 @ y 144,156,168,180,192,204,216,228 (L1..L8)
            Right pin tips x=180 @ y 144,156,168,180,192,204,216,228 (R1..R8)

        Nets:
          VCC   J1.1(48,48) · U1.L1(120,144) · C1.t(96,108) · C2.t(216,108) · C4.t(252,120)
          GND   J1.2(84,48) · U1.L8(120,228) · U1.R8(180,228) · C1.b(96,144)
                · C2.b(216,144) · C3a.b(36,288) · C3b.b(132,288) · C4.b(252,204)
                · D1.k(252,288)
          XTAL1 U1.L4(120,180) · Y1.a(72,276) · C3a.t(36,252)
          XTAL2 U1.L5(120,192) · Y1.b(108,276) · C3b.t(132,252)
          LED   U1.R2(180,156) → R5 → D1 → GND
      */}

      {/* ── copper routing (orthogonal H/V + 45° chamfers) ───────────────── */}
      <g className={styles.traces} fill="none" strokeWidth="2">
        {/* VCC bus (y=36) — J1.1(48,48) up, across, down to C4.t(252,120) */}
        <path d="M48 48 V42 L54 36 H246 L252 42 V120" />
        {/* VCC tap → C1.t(96,108) */}
        <path d="M96 36 V108" />
        {/* VCC tap → U1.L1(120,144) (via at 120,36) */}
        <path d="M120 36 V144" />
        {/* VCC tap → C2.t(216,108) */}
        <path d="M216 36 V108" />

        {/* GND spine (y=306) */}
        <path d="M42 306 H252" />
        {/* GND — J1.2(84,48) → spine */}
        <path d="M84 48 V300 L90 306" />
        {/* GND right riser → C4.b(252,204) / D1.k(252,288) */}
        <path d="M252 306 V204" />
        {/* GND — U1.L8(120,228) → spine. Layer-hops UNDER both crystal trunks
             (XTAL2 x=108 and XTAL1 x=96) via the via-pair (114,228)/(90,228):
             top copper stops at the right via, runs on the bottom layer beneath
             the trunks, resumes at the left via, then ties into the C1.b GND
             drop at (66,228) — same net, a solder junction. */}
        <path d="M120 228 H114" />
        <path d="M90 228 H72 L66 234" />
        {/* GND — U1.R8(180,228) → spine */}
        <path d="M180 228 H192 L198 234 V300 L198 306" />
        {/* GND — C1.b(96,144) → spine. y=144 run ties into the J1.2 GND drop at
             (84,144) — same net, shown as a solder junction. */}
        <path d="M96 144 H72 L66 150 V300 L72 306" />
        {/* GND — C2.b(216,144) → spine (between U1 and right riser) */}
        <path d="M216 144 H198 L192 150 V300 L186 306" />
        {/* GND — C3a.b(36,288) → spine */}
        <path d="M36 288 V300 L42 306" />
        {/* GND — C3b.b(132,288) → spine */}
        <path d="M132 288 V300 L126 306" />
        {/* GND — D1.k(252,288) lands on right riser (no extra trace needed) */}

        {/* XTAL1 — U1.L4(120,180) → via(96,186) → down → Y1.a(72,276).
             Layer-hops UNDER the J1.2 GND drop (x=84) on the y=270 run via the
             via-pair (90,270)/(78,270). */}
        <path d="M120 180 H102 L96 186 V270 L90 270" />
        <path d="M78 270 H72 L72 276" />
        {/* XTAL1 branch → C3a.t(36,252). Layer-hops UNDER both GND drops
             (x=84 J1.2 and x=66 C1.b) via the via-pair (90,252)/(60,252). */}
        <path d="M96 252 H90" />
        <path d="M60 252 H36" />
        {/* XTAL2 — U1.L5(120,192) → via(108,198) → down → Y1.b(108,276) */}
        <path d="M120 192 H114 L108 198 V276" />
        {/* XTAL2 branch → C3b.t(132,252) */}
        <path d="M108 252 H132" />

        {/* LED signal — U1.R2(180,156) → R5.t(216,222). Layer-hops UNDER the
             C2.b GND drop (x=192) via the via-pair (186,156)/(198,156). */}
        <path d="M180 156 H186" />
        <path d="M198 156 H210 L216 162 V222" />

        {/* LED signal — R5.b(216,258) → D1.a(216,288) */}
        <path d="M216 258 V288" />

        {/* ── Fanout stubs: every otherwise-unused U1 pin escapes to its own
             fanout via / test-point (realistic QFP escape routing). Each is a
             short horizontal stub to an adjacent via in the channel hugging
             U1 — verified to cross no other net. ── */}
        {/* Left unused L2,L3,L6,L7 */}
        <path d="M120 156 H108" />
        <path d="M120 168 H108" />
        <path d="M120 204 H114" />
        <path d="M120 216 H114" />
        {/* Right unused R1,R3,R4,R5,R6,R7 */}
        <path d="M180 144 H192" />
        <path d="M180 168 H186" />
        <path d="M180 180 H186" />
        <path d="M180 192 H186" />
        <path d="M180 204 H186" />
        <path d="M180 216 H186" />
      </g>

      {/* ── vias / plated pads ───────────────────────────────────────────── */}
      <g className={styles.pads}>
        {[
          [48, 48], // J1.1 VCC pad
          [84, 48], // J1.2 GND pad
          [120, 36], // VCC bus via → U1.L1
          [96, 186], // XTAL1 routing via
          [108, 198], // XTAL2 routing via
          [42, 306], // GND spine / C3a corner
          [252, 306], // GND right-riser corner
        ].map(([cx, cy]) => (
          <g key={`via-${cx}-${cy}`}>
            <circle cx={cx} cy={cy} r="6.5" />
            <circle cx={cx} cy={cy} r="2.2" className={styles.padHole} />
          </g>
        ))}
        {/* fanout vias / test-points terminating the unused U1 escape stubs */}
        {[
          [108, 156], [108, 168], [114, 204], [114, 216], // left  (L2,L3,L6,L7)
          [192, 144], [186, 168], [186, 180], [186, 192], [186, 204], [186, 216], // right (R1,R3,R4,R5,R6,R7)
        ].map(([cx, cy]) => (
          <g key={`fan-${cx}-${cy}`}>
            <circle cx={cx} cy={cy} r="4.5" />
            <circle cx={cx} cy={cy} r="1.8" className={styles.padHole} />
          </g>
        ))}
        {/* layer-change via pairs (trace stops at one donut, resumes at the
             other on the bottom layer — implies a routed crossing, no short) */}
        {[
          [114, 228], [90, 228], // GND U1.L8 hops under XTAL2 + XTAL1 trunks
          [90, 270], [78, 270], // XTAL1 y=270 hops under J1.2 GND
          [90, 252], [60, 252], // XTAL1 branch hops under J1.2 + C1.b GND
          [186, 156], [198, 156], // LED hops under C2.b GND
        ].map(([cx, cy]) => (
          <g key={`hop-${cx}-${cy}`}>
            <circle cx={cx} cy={cy} r="5" />
            <circle cx={cx} cy={cy} r="2" className={styles.padHole} />
          </g>
        ))}
        {/* solder-junction dots (net branch points / same-net ties) */}
        {[
          [96, 36], // VCC: bus + C1 tap
          [216, 36], // VCC: bus + C2 tap
          [96, 252], // XTAL1: trunk + C3a branch
          [108, 252], // XTAL2: trunk + C3b branch
          [84, 144], // GND: J1.2 drop + C1.b run tie
          [84, 228], // GND: J1.2 drop + U1.L8 run tie
          [66, 234], // GND: C1.b drop + U1.L8 run tie
          [198, 306], // GND: spine + U1.R8 drop
          [72, 306], // GND: spine + C1.b drop
          [186, 306], // GND: spine + C2.b drop
          [126, 306], // GND: spine + C3b drop
        ].map(([cx, cy]) => (
          <circle key={`jct-${cx}-${cy}`} cx={cx} cy={cy} r="3" />
        ))}
      </g>

      {/* ── U1: central MCU, 8 pins/side ─────────────────────────────────── */}
      <g className={styles.comp}>
        <rect x="132" y="138" width="36" height="96" rx="5" className={styles.body} />
        {[144, 156, 168, 180, 192, 204, 216, 228].map((y) => (
          <line key={`ul${y}`} x1="120" y1={y} x2="132" y2={y} strokeWidth="2" />
        ))}
        {[144, 156, 168, 180, 192, 204, 216, 228].map((y) => (
          <line key={`ur${y}`} x1="168" y1={y} x2="180" y2={y} strokeWidth="2" />
        ))}
        <circle cx="140" cy="146" r="3" className={styles.pin1} />
      </g>

      {/* ── C1: ceramic decoupling cap (VCC→GND), at U1 left ──────────────── */}
      {/* top(96,108) VCC, bottom(96,144) GND */}
      <g className={styles.comp}>
        <line x1="96" y1="108" x2="96" y2="120" strokeWidth="2" />
        <line x1="96" y1="132" x2="96" y2="144" strokeWidth="2" />
        <rect x="84" y="120" width="24" height="12" rx="2" className={styles.body} />
      </g>

      {/* ── C2: ceramic decoupling cap (VCC→GND), at U1 right ─────────────── */}
      {/* top(216,108) VCC, bottom(216,144) GND */}
      <g className={styles.comp}>
        <line x1="216" y1="108" x2="216" y2="120" strokeWidth="2" />
        <line x1="216" y1="132" x2="216" y2="144" strokeWidth="2" />
        <rect x="204" y="120" width="24" height="12" rx="2" className={styles.body} />
      </g>

      {/* ── C4: bulk electrolytic (VCC→GND), right side ──────────────────── */}
      {/* top(252,120) VCC, bottom(252,204) GND */}
      <g className={styles.comp}>
        <line x1="252" y1="120" x2="252" y2="132" strokeWidth="2" />
        <rect x="234" y="132" width="36" height="60" rx="8" className={styles.body} />
        <ellipse cx="252" cy="132" rx="18" ry="5" className={styles.bodyTop} />
        <rect x="237" y="138" width="8" height="48" className={styles.capStripe} />
        <line x1="252" y1="192" x2="252" y2="204" strokeWidth="2" />
      </g>

      {/* ── Y1: crystal can (XTAL1 / XTAL2) ──────────────────────────────── */}
      {/* leg a tip(72,276) XTAL1, leg b tip(108,276) XTAL2 */}
      <g className={styles.comp}>
        <rect x="66" y="288" width="60" height="30" rx="15" className={styles.body} />
        <line x1="72" y1="276" x2="72" y2="288" strokeWidth="2" />
        <line x1="108" y1="276" x2="108" y2="288" strokeWidth="2" />
      </g>

      {/* ── C3a: crystal load cap (XTAL1→GND) ────────────────────────────── */}
      {/* top(36,252) XTAL1, bottom(36,288) GND */}
      <g className={styles.comp}>
        <line x1="36" y1="252" x2="36" y2="264" strokeWidth="2" />
        <line x1="36" y1="276" x2="36" y2="288" strokeWidth="2" />
        <rect x="24" y="264" width="24" height="12" rx="2" className={styles.body} />
      </g>

      {/* ── C3b: crystal load cap (XTAL2→GND) ────────────────────────────── */}
      {/* top(132,252) XTAL2, bottom(132,288) GND */}
      <g className={styles.comp}>
        <line x1="132" y1="252" x2="132" y2="264" strokeWidth="2" />
        <line x1="132" y1="276" x2="132" y2="288" strokeWidth="2" />
        <rect x="120" y="264" width="24" height="12" rx="2" className={styles.body} />
      </g>

      {/* ── R5: current-limit resistor (LED net) ─────────────────────────── */}
      {/* top(216,222) ← U1.R2, bottom(216,258) → D1 anode */}
      <g className={styles.comp}>
        <line x1="216" y1="222" x2="216" y2="228" strokeWidth="2" />
        <rect x="204" y="228" width="24" height="30" rx="6" className={styles.body} />
        <rect x="204" y="232" width="24" height="4" fill="#9a6a32" />
        <rect x="204" y="240" width="24" height="4" fill="#b04a3a" />
        <rect x="204" y="248" width="24" height="4" className={styles.bandMetal} />
        <line x1="216" y1="258" x2="216" y2="264" strokeWidth="2" />
      </g>

      {/* ── D1: LED (anode 216,288 ← R5 via LEDA trace; cathode 252,288 → GND riser) ── */}
      <g className={styles.comp}>
        <line x1="216" y1="288" x2="222" y2="288" strokeWidth="2" />
        <rect x="222" y="279" width="24" height="18" rx="3" className={styles.body} />
        <rect x="242" y="279" width="4" height="18" className={styles.bandMetal} />
        <line x1="246" y1="288" x2="252" y2="288" strokeWidth="2" />
      </g>

      {/* ── J1: edge power header — pin1 VCC(48,48), pin2 GND(84,48) ──────── */}
      <g className={styles.comp}>
        <rect x="36" y="30" width="60" height="14" rx="3" className={styles.body} />
        <line x1="48" y1="44" x2="48" y2="48" strokeWidth="2" />
        <line x1="84" y1="44" x2="84" y2="48" strokeWidth="2" />
      </g>
    </svg>
  );
}

/**
 * The board shell: stacked layers (substrate texture, masked reveal, lamp
 * glow) plus the silkscreen content. The flashlight runs for BOTH mouse hover
 * and finger drag — Pointer Events unify the two, so pointerenter/move/leave
 * drive it for either. On touch we also setPointerCapture on pointerdown so the
 * reveal keeps tracking when the finger drifts off the card. Gated only on
 * prefers-reduced-motion (live via matchMedia change). The pointer rect is
 * cached on enter (invalidated on scroll/resize) so pointermove does no
 * per-frame reflow. The card carries touch-action:none so finger-drag isn't
 * cancelled as a scroll gesture.
 */
function PcbCard({
  empty,
  children,
}: {
  empty?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const raf = useRef(0);

  // Animate only the first card of the session; subsequent remounts render in
  // place (initial={false} => mount straight at the `animate` state, no motion).
  const [animateIn] = useState(() => {
    if (sponsorBlockHasAnimated) return false;
    sponsorBlockHasAnimated = true;
    return true;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let rect: DOMRect | null = null;

    const onEnter = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      const r = el.getBoundingClientRect();
      rect = r;
      // Seed --mx/--my synchronously so the very first painted frame of
      // data-lit="true" already has the beam under the cursor/finger. Otherwise
      // a tap-without-move (or the gap before the first pointermove rAF) would
      // fade in a beam parked at the default -9999px and look like a no-op flash.
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
      el.setAttribute('data-lit', 'true');
    };
    const onLeave = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      el.setAttribute('data-lit', 'false');
    };
    // Touch/pen pointerup: clear lit state explicitly (don't rely on the implicit
    // leave-after-capture-release dance, which iOS Safari has historically been
    // unreliable about). Skip mouse so cursor-still-hovering keeps the beam on.
    const onUp = (e: PointerEvent) => {
      if (!e.isPrimary || e.pointerType === 'mouse') return;
      try { el.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      el.setAttribute('data-lit', 'false');
    };
    const onMove = (e: PointerEvent) => {
      if (!e.isPrimary || raf.current) return;
      const r = rect ?? el.getBoundingClientRect();
      rect = r;
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        el.style.setProperty('--mx', `${x}px`);
        el.style.setProperty('--my', `${y}px`);
      });
    };
    // Touch + pen: capture the pointer on down so finger drift outside the card
    // keeps the reveal tracking. Mouse doesn't need this (hover state tracks
    // naturally) and capturing it would suppress hover-based pointerleave.
    // CRITICAL: skip capture when the pointerdown lands on an interactive
    // descendant — capture retargets pointerup (and the synthesized click) to
    // the card, swallowing taps on the Visit Website / phone / Become-a-Sponsor
    // links. The flashlight UX over the card substrate is preserved; only the
    // CTAs opt out, and they're exactly where the user wants a real tap.
    const onDown = (e: PointerEvent) => {
      if (!e.isPrimary || e.pointerType === 'mouse') return;
      const t = e.target as Element | null;
      if (t?.closest('a, button, [role="button"], input, textarea, select, label')) return;
      try { el.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    };
    const invalidate = () => {
      rect = null;
    };

    let attached = false;
    const attach = () => {
      if (attached) return;
      attached = true;
      el.addEventListener('pointerenter', onEnter);
      el.addEventListener('pointerleave', onLeave);
      // pointercancel: iOS Safari fires this (NOT pointerleave) when a system
      // gesture preempts the touch — Control Center pull-down, incoming call,
      // multi-finger zoom, etc. Without this, data-lit would stick "true" and
      // the beam would freeze at the last finger position.
      el.addEventListener('pointercancel', onLeave);
      // pointerup belt-and-braces: under setPointerCapture some browsers (older
      // iOS) don't reliably fire pointerleave on implicit release. onUp clears
      // lit state directly for touch/pen.
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerdown', onDown);
      window.addEventListener('scroll', invalidate, true);
      window.addEventListener('resize', invalidate);
    };
    const detach = () => {
      if (!attached) return;
      attached = false;
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointercancel', onLeave);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', invalidate, true);
      window.removeEventListener('resize', invalidate);
      el.setAttribute('data-lit', 'false');
    };

    const sync = () => (reduced.matches ? detach() : attach());
    sync();
    reduced.addEventListener('change', sync);

    return () => {
      detach();
      reduced.removeEventListener('change', sync);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, []);

  return (
    <motion.div
      ref={ref}
      className={`${styles.card} ${empty ? styles.cardEmpty : ''}`}
      role="region"
      aria-label={empty ? 'Open sponsor slot' : 'Featured sponsor'}
      // This is the Gold-tier board (a child category's single Gold sponsor, from
      // category.sponsor). Pinned to gold so the silver/platinum/gold token system
      // tints it gold regardless of the sponsor.tier string casing.
      data-tier="gold"
      data-lit="false"
      initial={animateIn ? { opacity: 0, y: 20 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: animateIn ? 0.5 : 0, ease: 'easeOut' as const }}
    >
      <div className={styles.substrate} aria-hidden="true" />
      <div className={styles.reveal} aria-hidden="true">
        <PcbArt />
      </div>
      <div className={styles.lamp} aria-hidden="true" />
      <span className={styles.fiducialTL} aria-hidden="true" />
      <span className={styles.fiducialBR} aria-hidden="true" />
      <span className={styles.designator} aria-hidden="true">SP1</span>
      <div className={styles.content}>{children}</div>
    </motion.div>
  );
}

/**
 * Sponsor logo on the gold pad. A configured logo URL that 404s would otherwise
 * render the browser's broken-image glyph; on error — or when no URL is set —
 * fall back to the company lettermark, matching the Platinum and Silver boards.
 */
function SbLogo({ src, name }: { src: string | null; name: string }) {
  const [broken, setBroken] = useState(!src);
  if (broken || !src) {
    return (
      <span className={styles.logoMark} aria-hidden="true">
        {lettermark(name)}
      </span>
    );
  }
  return (
    <img src={src} alt={`${name} logo`} className={styles.logo} onError={() => setBroken(true)} />
  );
}

export default function SponsorBlock({ sponsor }: SponsorBlockProps) {
  if (!sponsor) {
    return (
      <PcbCard empty>
        <span className={styles.kicker}>&#9670; OPEN SLOT</span>
        <div className={styles.footprint} aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <h3 className={styles.title}>Advertise Here</h3>
        <p className={styles.text}>
          Reach buyers actively browsing this category. Get featured placement with your brand,
          logo, and direct contact info.
        </p>
        <a
          href="mailto:john@circuits.com?subject=Category%20Sponsorship%20Inquiry"
          className={styles.cta}
        >
          Become a Sponsor &rarr;
        </a>
      </PcbCard>
    );
  }

  return (
    <PcbCard>
      <span className={styles.kicker}>&#9670; FEATURED PARTNER</span>

      <div className={styles.pad}>
        <SbLogo src={sponsor.image_url} name={sponsor.supplier_name} />
      </div>

      <h3 className={styles.name}>{sponsor.supplier_name}</h3>

      {sponsor.description && <p className={styles.description}>{sponsor.description}</p>}

      <div className={styles.details}>
        {sponsor.website && (
          <a href={prependScheme(sponsor.website)} target="_blank" rel="noopener noreferrer" className={styles.visit}>
            Visit Website &#8599;
          </a>
        )}
        {sponsor.phone && (
          <a href={`tel:${sponsor.phone}`} className={styles.phone}>
            {formatPhone(sponsor.phone)}
          </a>
        )}
      </div>
    </PcbCard>
  );
}
