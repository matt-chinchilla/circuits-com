/**
 * FounderBadge — the founding-distributor mark that sits beside a company
 * name on the Platinum, Gold and Silver sponsor boards (owner brief
 * 2026-09-17, "Burning Badge" revision 2026-09-17; the flag became a badge
 * HOLDING with its own look in migration 055).
 *
 * This is a THIN HOST. The mark itself — the enamel pin and the particle fire
 * that burns behind it — is the owner's design, vendored byte-identical at
 * `fireBadge/fire-badge.vendor.js` (read `fireBadge/PROVENANCE.md`). The
 * side-effect import registers the `<fire-badge>` custom element once; this
 * component only decides WHICH element, at what size, with what accessible
 * name. Nothing here paints, so re-tuning the fire is a re-export of one
 * vendor file and no change to this file at all.
 *
 * WITH NO `look`, the fire attributes are left OFF on purpose. `scheme`
 * orange, `intensity` 1, `opacity` 0.75 and `sparks` on are the vendor
 * element's own defaults and the ones the design preview shipped — naming them
 * here would fork the design's defaults into a second home. A `look` is the
 * supplier's OWN saved settings (`supplier_badges`, served on every sponsor
 * payload as `badge`), so all four are spelled out; anything the caller does
 * not have is the server's job to default, never this file's.
 *
 * There is ONE artwork today, so `founder_badge_2` and any key this build has
 * never heard of render the same pin. `key` is carried for the editor and for
 * the day a second artwork lands.
 *
 * The fire canvas is absolutely positioned and reaches 2.4× the pin's size
 * ABOVE it and one size to each side, so it costs no layout but every board
 * row it lands in has to not clip it (see the `overflow: visible` notes in the
 * three board stylesheets).
 *
 * Never a link and never inside the company `<a>` — it is a fact about the
 * company, not a destination.
 */
import type { BadgeLook } from '@shared/types/badge';
import './fireBadge/fire-badge.vendor.js';
import styles from './FounderBadge.module.scss';

export const FOUNDER_BADGE_LABEL = 'Founding distributor';

interface FounderBadgeProps {
  /** Rendered size in CSS px — 22 beside Platinum's name, 18 Gold, 15 Silver. */
  size?: number;
  /** The supplier's saved fire settings. Absent/null → the element's defaults. */
  look?: BadgeLook | null;
  className?: string;
}

export default function FounderBadge({ size = 18, look, className }: FounderBadgeProps) {
  const cls = className ? `${styles.badge} ${className}` : styles.badge;

  return (
    <fire-badge
      className={cls}
      badge="true"
      size={size}
      {...(look
        ? {
            scheme: look.scheme,
            intensity: look.intensity,
            opacity: look.opacity,
            // the element parses its own attributes — `sparks` is a string
            // there, and a bare boolean prop would serialise as "" / absent.
            sparks: look.sparks ? ('true' as const) : ('false' as const),
          }
        : {})}
      role="img"
      aria-label={FOUNDER_BADGE_LABEL}
      title={FOUNDER_BADGE_LABEL}
      data-founder-badge=""
    />
  );
}
