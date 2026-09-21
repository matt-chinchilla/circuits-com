// FounderDiscount.tsx — the Founder's Discount card (design 3bbc46a2,
// 2026-09-21). ONE card in the tier material — dotted slab, top-metal border,
// ribbon ring — in the black selected-tier finish with a brand-red palette.
//
// Opening it "burns" the FEATURES list into place: the panel grows (grid-rows
// 0fr→1fr) while a flickering ember edge rides its bottom lip, and the perks
// ignite in sequence. The SAME click flips `data-fd="on"` on the page root so
// every tier price gets a red slash burned bottom-left→top-right.
//
// The fire is real: `<fire-edge>` (the Burning Badge particle engine driven
// along a moving front). Flame, sparks and smoke are canvas particles; CSS
// keeps only the char/colour aftermath. `active` flips with the state so
// re-opening replays, and the timings mirror the CSS keyframe delays.

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import TierBannerRibbon from '@public/components/widgets/TierBannerRibbon';
import { BADGE_SCHEMES } from '@shared/types/badge';
import styles from './JoinPage.module.scss';
import './fireEdge/fire-edge.vendor.js';
import '@shared/components/FounderBadge/fireBadge/fire-badge.vendor.js';
import '@shared/components/FounderBadge/glowBadge/glow-badge.vendor.js';

const FOUNDER_PERKS = [
  'Access to the exclusive "Founder’s Badge" next to your company name',
  'Permanent discount & price-lock for all subscriptions purchased',
  'Priority placement on the "Local Businesses" map',
  'Access to all future badge-drops for Suppliers & Users',
];

interface FireProps {
  on: boolean;
  mode?: 'lip' | 'line' | 'sweep';
  delay?: string | number;
  dur?: string | number;
  scale?: string | number;
  blend?: 'add' | 'over';
  intensity?: string | number;
  scheme?: 'orange' | 'red';
  x1?: string | number;
  y1?: string | number;
  x2?: string | number;
  y2?: string | number;
  coals?: boolean;
  sustain?: string | number;
  hold?: string | number;
  linger?: string | number;
  linear?: boolean;
}

/** Thin wrapper over the vendored element — every attribute spelled the way
 *  the design's own `Fire` helper spells it, defaults included. */
export function Fire(p: FireProps) {
  return (
    <fire-edge
      active={p.on ? 'true' : 'false'}
      mode={p.mode}
      delay={p.delay}
      duration={p.dur}
      scale={p.scale}
      blend={p.blend || 'add'}
      intensity={p.intensity || 1}
      scheme={p.scheme || 'orange'}
      x1={p.x1}
      y1={p.y1}
      x2={p.x2}
      y2={p.y2}
      coals={p.coals ? 'true' : 'false'}
      sustain={p.sustain || 0}
      hold={p.hold || 1}
      linger={p.linger || 0}
      linear={p.linear ? 'true' : 'false'}
      aria-hidden="true"
    />
  );
}

// Rounded circle-check — inherits the card's ink. (Same glyph the tier cards
// draw; kept local so this module does not import back into the page.)
function TierCheck() {
  return (
    <svg className={styles.ck} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5 8.2 7.2 10.4 11 5.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface FounderDiscountProps {
  open: boolean;
  onToggle: () => void;
  /** Fired once the band has actually opened — the page starts the price
   *  burns only then, so the two fires are in step. */
  onArrive?: () => void;
}

export default function FounderDiscount({ open, onToggle, onArrive }: FounderDiscountProps) {
  const [schemeIx, setSchemeIx] = useState(0);
  const [grown, setGrown] = useState(false);
  const [hovered, setHovered] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Band is always full-width; opening reveals the perks panel (grid-rows
  // grow), then the burns start.
  useEffect(() => {
    if (!open) {
      setGrown(false);
      return;
    }
    const id = requestAnimationFrame(() => {
      setGrown(true);
      onArrive?.();
    });
    return () => cancelAnimationFrame(id);
    // onArrive is a fresh closure every render; the design keys this on `open`
    // alone and re-running it would replay the burn on every parent render.
  }, [open]);

  // Follow the growing panel: while it expands, nudge the page so the tile's
  // bottom edge stays on screen. Plain scrollBy per frame; stops when the
  // transition settles. Skipped under reduced-motion.
  useEffect(() => {
    const el = rootRef.current;
    if (!grown || !el) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const r = el.getBoundingClientRect();
      const over = r.bottom + 28 - window.innerHeight;
      const minTop = 96;
      if (over > 0 && r.top - over > minTop) window.scrollBy(0, over);
      else if (over > 0 && r.top > minTop) window.scrollBy(0, r.top - minTop);
      if (performance.now() - t0 < 2000) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [grown]);

  // Both badge iterations step through the enamel colours together every 3s.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(
      () => setSchemeIx(i => (i + 1) % BADGE_SCHEMES.length),
      3000,
    );
    return () => clearInterval(id);
  }, [open]);

  const scheme = BADGE_SCHEMES[schemeIx];
  const isOpen = open && grown;
  const cls = [styles.tier, styles.fd, isOpen ? styles.fdIsOpen : ''].join(' ').trim();

  return (
    <div
      ref={rootRef}
      className={cls}
      data-tier="founder"
      role="presentation"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e: MouseEvent<HTMLDivElement>) => {
        // The tile is its own button — let it handle its own clicks.
        if (e.target instanceof Element && e.target.closest(`.${styles.fdTile}`)) return;
        onToggle();
      }}
    >
      <button
        type="button"
        className={styles.fdTile}
        aria-expanded={open}
        aria-controls="j3-fd-panel"
        onClick={onToggle}
      >
        <span className={styles.tierHead}>
          <span className={styles.tierName}>Founder&rsquo;s Discount</span>
          <TierBannerRibbon tier="founder" el="Fd" label="Founder" active={hovered || open} checked />
        </span>
        <span className={styles.fdHint}>
          <span>{open ? 'Locked for life' : 'Tap to ignite'}</span>
          <svg className={styles.fdChev} viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M2.5 4.5L6 8l3.5-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      <div id="j3-fd-panel" className={styles.fdPanel} aria-hidden={!open}>
        <div className={styles.fdInner}>
          <span className={styles.featLabel}>FEATURES</span>
          <p className={styles.featLead}>What founding partners keep, forever</p>
          <ul className={`${styles.perks} ${styles.checks}`}>
            {FOUNDER_PERKS.map((p, i) => (
              <li key={p} style={{ '--i': i } as CSSProperties}>
                <span className={styles.fdIgn}>
                  <TierCheck />
                  <span>{p}</span>
                  {i === 0 && (
                    <span
                      className={styles.fdBadges}
                      role="img"
                      aria-label="Founder's Badge, pulsing and burning variants"
                    >
                      <glow-badge size={22} scheme={scheme} glow={2} speed={3} />
                      <fire-badge
                        badge="true"
                        size={22}
                        scheme={scheme}
                        intensity={1.6}
                        opacity={1}
                        sparks="true"
                      />
                    </span>
                  )}
                </span>
                <Fire on={isOpen} mode="sweep" delay={(0.45 + i * 0.3).toFixed(2)} dur="0.9" scale="9" intensity="0.8" />
              </li>
            ))}
          </ul>
        </div>
        <span className={styles.fdFire} aria-hidden="true">
          <Fire on={isOpen} mode="lip" delay="0" dur="2" scale="16" sustain="0.5" />
        </span>
      </div>
    </div>
  );
}
