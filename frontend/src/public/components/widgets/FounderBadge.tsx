/**
 * FounderBadge — the founding-distributor mark that sits beside a company
 * name on the Platinum, Gold and Silver sponsor boards (`supplier.founder`,
 * migration 054; owner brief 2026-09-17, "Burning Badge" revision 2026-09-17).
 *
 * This is a THIN HOST. The mark itself — the enamel pin and the particle fire
 * that burns behind it — is the owner's design, vendored byte-identical at
 * `fireBadge/fire-badge.vendor.js` (read `fireBadge/PROVENANCE.md`). The
 * side-effect import registers the `<fire-badge>` custom element once; this
 * component only decides WHICH element, at what size, with what accessible
 * name. Nothing here paints, so re-tuning the fire is a re-export of one
 * vendor file and no change to this file at all.
 *
 * Attributes are left OFF on purpose. `scheme` orange, `intensity` 1,
 * `opacity` 0.75 and `sparks` on are the vendor element's own defaults and the
 * ones the design preview shipped — naming them here would fork the design's
 * defaults into a second home.
 *
 * The fire canvas is absolutely positioned and reaches 2.4× the pin's size
 * ABOVE it and one size to each side, so it costs no layout but every board
 * row it lands in has to not clip it (see the `overflow: visible` notes in the
 * three board stylesheets).
 *
 * Never a link and never inside the company `<a>` — it is a fact about the
 * company, not a destination.
 */
import './fireBadge/fire-badge.vendor.js';
import styles from './FounderBadge.module.scss';

export const FOUNDER_BADGE_LABEL = 'Founding distributor';

interface FounderBadgeProps {
  /** Rendered size in CSS px — 22 beside Platinum's name, 18 Gold, 15 Silver. */
  size?: number;
  className?: string;
}

export default function FounderBadge({ size = 18, className }: FounderBadgeProps) {
  const cls = className ? `${styles.badge} ${className}` : styles.badge;

  return (
    <fire-badge
      className={cls}
      badge="true"
      size={size}
      role="img"
      aria-label={FOUNDER_BADGE_LABEL}
      title={FOUNDER_BADGE_LABEL}
      data-founder-badge=""
    />
  );
}
