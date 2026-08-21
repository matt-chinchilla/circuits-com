// TierBannerRibbon.tsx — production port of the ui_kit "tier banner button"
// (ui_kits/website/components/Join.jsx §j3-ribbon, advertise.css passes
// 2026-08-14c→i). A raised glass slab whose color emission is a traveling
// rim light: a long gradient segment slides along the border and its GLOW
// is a blurred TWIN of the same dashed rect (identical pathLength dash +
// offset animation), so the bloom hugs the lit stretch and bends around
// corners with it — modeled on the client's reference motion capture.
//
// No new deps. No assets. TS strict-clean (no unused vars).

import { useId } from 'react';
import styles from './TierBannerRibbon.module.scss';

export type SponsorTierId = 'silver' | 'gold' | 'platinum';

/** The metal for each tier's element square — Ag/Au/Pt, the ribbon's opening
 *  glyph. Exported for consumers (the BOM table) that label by tier name. */
export const SPONSOR_TIER_ELEMENT: Record<SponsorTierId, string> = {
  silver: 'Ag',
  gold: 'Au',
  platinum: 'Pt',
};

interface TierBannerRibbonProps {
  tier: SponsorTierId;   // picks the metal palette (data-tier attr)
  el: string;            // element tile label: "Ag" | "Au" | "Pt"
  label: string;         // ribbon text: "Basic" | "Pro" | "Enterprise"
  /** true while the owning tier card is hovered OR selected — turns the
   *  rim light + glow on. The ribbon's own :hover also triggers it. */
  active?: boolean;
  /** selected-card (dark surface) variant — dims the slab face, brightens
   *  the label gradients, runs the glow at full opacity. */
  checked?: boolean;
}

export function TierBannerRibbon({
  tier,
  el,
  label,
  active = false,
  checked = false,
}: TierBannerRibbonProps) {
  const gradId = useId(); // unique per instance — three ribbons share one page
  const cls = [
    styles.ribbon,
    active ? styles.active : '',
    checked ? styles.checked : '',
  ]
    .join(' ')
    .trim();
  return (
    <span className={cls} data-tier={tier} aria-hidden="true">
      <svg className={styles.ring}>
        <defs>
          {/* ONE horizontal gradient pins the hues in space: metal at both
              ends (left/right edges), counter-hues across the middle (top/
              bottom edges). The dim base ring always shows the pattern; the
              snake + glow reveal whatever color lives where they pass. */}
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" className={styles.stopTc} />
            <stop offset="0.32" className={styles.stopG4} />
            <stop offset="0.68" className={styles.stopG2} />
            <stop offset="1" className={styles.stopTc} />
          </linearGradient>
        </defs>
        <rect className={styles.ringBase} pathLength={100} stroke={`url(#${gradId})`} />
        <rect className={styles.ringGlow} pathLength={100} stroke={`url(#${gradId})`} />
        <rect className={styles.ringSnake} pathLength={100} stroke={`url(#${gradId})`} />
      </svg>
      <span className={styles.el}>
        <span className={styles.elWheels}>
          <i />
          <i />
        </span>
        <b>{el}</b>
      </span>
      <span className={styles.txt}>{label}</span>
    </span>
  );
}

export default TierBannerRibbon;
