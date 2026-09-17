/**
 * FounderBadge — the founding-distributor mark that sits beside a company
 * name on the Platinum, Gold and Silver sponsor boards (`supplier.founder`,
 * migration 054; owner brief 2026-09-17).
 *
 * The material is a cloisonné lapel pin, not a coin: a hairline of dark gold
 * wire (1.2 units of the 24-unit box → ~1px at the inline sizes), maroon
 * vitreous enamel that darkens as it curves down to meet the wire, and a
 * struck gilt F — a dark impression under a lit face. The dome comes from the
 * edge shade, never from a gloss ellipse; the gold is dark goldenrod with one
 * narrow specular, never a pale brass highlight. Rev 2 was rejected as
 * "cartoonish" for exactly those two defaults.
 *
 * No fonts, no raster: the F is a path, so it never waits on a webfont. The
 * gradients live INSIDE the component and every id carries this instance's
 * `useId()` — three boards mount on one category page, and a shared id would
 * let the first board's gradient paint the others (or vanish with it).
 * One `feDropShadow` lifts the whole pin; the badge is static, so the
 * no-filter-on-animated-nodes rule does not bite.
 *
 * Never a link and never inside the company `<a>` — it is a fact about the
 * company, not a destination.
 */
import { useId } from 'react';
import styles from './FounderBadge.module.scss';

export const FOUNDER_BADGE_LABEL = 'Founding distributor';

interface FounderBadgeProps {
  /** Rendered size in CSS px — 22 beside Platinum's name, 18 Gold, 15 Silver. */
  size?: number;
  className?: string;
}

const F_PATH = 'M8.1 6.2h8.3v3h-4.6v1.9h4.1v2.8h-4.1v3.9h-3.7z';

export default function FounderBadge({ size = 18, className }: FounderBadgeProps) {
  // React's ids carry punctuation (`:r1:` / `«r1»`) that a `url(#…)` reference
  // must not — keep only the safe characters, they are still unique.
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const wire = `fb-wire-${uid}`;
  const enamel = `fb-enamel-${uid}`;
  const shade = `fb-shade-${uid}`;
  const gilt = `fb-gilt-${uid}`;
  const lift = `fb-lift-${uid}`;
  const cls = className ? `${styles.badge} ${className}` : styles.badge;

  return (
    <svg
      className={cls}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={FOUNDER_BADGE_LABEL}
      data-founder-badge=""
    >
      <title>{FOUNDER_BADGE_LABEL}</title>
      <defs>
        {/* the wire: a hairline of real gold, lit top-left, in shadow bottom-right */}
        <linearGradient id={wire} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e6c25a" />
          <stop offset="0.22" stopColor="#c49a1e" />
          <stop offset="0.5" stopColor="#a67c00" />
          <stop offset="0.8" stopColor="#7a5a08" />
          <stop offset="1" stopColor="#5c4306" />
        </linearGradient>
        {/* the enamel: maroon, a restrained warm centre off to the top-left */}
        <radialGradient id={enamel} cx="0.40" cy="0.34" r="0.80">
          <stop offset="0" stopColor="#c0393f" />
          <stop offset="0.38" stopColor="#9a2029" />
          <stop offset="0.82" stopColor="#7a1a24" />
          <stop offset="1" stopColor="#6f1620" />
        </radialGradient>
        {/* the dome: enamel darkens as it curves down to meet the wire */}
        <radialGradient id={shade} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0.74" stopColor="#2a0308" stopOpacity="0" />
          <stop offset="1" stopColor="#2a0308" stopOpacity="0.62" />
        </radialGradient>
        {/* the letter: gilt, lit from above, footed */}
        <linearGradient id={gilt} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e2be52" />
          <stop offset="0.5" stopColor="#c9961c" />
          <stop offset="1" stopColor="#9c7410" />
        </linearGradient>
        <filter id={lift} x="-30%" y="-30%" width="160%" height="170%">
          <feDropShadow dx="0" dy="0.5" stdDeviation="0.55" floodColor="#000" floodOpacity="0.42" />
        </filter>
      </defs>
      <g filter={`url(#${lift})`}>
        <circle cx="12" cy="12" r="11.8" fill="#1b0f03" fillOpacity="0.55" />
        <circle cx="12" cy="12" r="11.4" fill={`url(#${wire})`} />
        <circle cx="12" cy="12" r="10.2" fill={`url(#${enamel})`} />
        <circle cx="12" cy="12" r="10.2" fill={`url(#${shade})`} />
        {/* the F, struck: a dark impression under a gilt face */}
        <path d={F_PATH} transform="translate(0 0.7)" fill="#35080f" fillOpacity="0.9" />
        <path
          d={F_PATH}
          fill={`url(#${gilt})`}
          stroke="#5c4306"
          strokeWidth="0.22"
          strokeOpacity="0.6"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
