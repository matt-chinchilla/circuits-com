import type { BomRowStatus, RowState } from '../lib/types';
import styles from './MatchBadge.module.scss';

/**
 * The confidence badge on a BOM row.
 *
 * The render contract is spec §5 and it is deliberately split across two
 * channels: HUE carries status and TEXTURE carries confidence, never both on
 * one channel. So EXACT is solid, APPROX is the same family of ink but
 * hatched, and NO MATCH is an outline with no fill at all — a colour-blind
 * reader gets the answer from the texture and the word, not the colour.
 *
 * An APPROX row is never silently upgraded: the reason the matcher gave
 * ("suffix differs", "successor/base part") rides along as the tooltip, and
 * the package warning renders under the description where it is readable
 * without hovering.
 */

interface MatchBadgeProps {
  /** Null when the server never answered for this line. */
  status: BomRowStatus | null;
  state: RowState;
  approxReason: string | null;
  /** Why live lookups are unavailable — phase-2 copy, tooltip only. */
  detail: string | null;
}

export default function MatchBadge({ status, state, approxReason, detail }: MatchBadgeProps) {
  if (state === 'resolving') {
    return (
      <span className={`${styles.badge} ${styles.badgeResolving}`} title="Looking this part up live">
        LOOKING UP&#8230;
      </span>
    );
  }

  if (status === 'exact_live') {
    // The live tick is the visible difference between "we had this" and "we
    // just went and got this" — the row healed itself while you watched.
    return (
      <span className={`${styles.badge} ${styles.badgeLive}`} title="Found by a live distributor lookup">
        <span className={styles.liveTick} aria-hidden="true">
          &#9679;
        </span>
        EXACT &#183; LIVE
      </span>
    );
  }

  if (status === 'exact') {
    return (
      <span className={`${styles.badge} ${styles.badgeExact}`} title="Part number matched the catalog exactly">
        EXACT
      </span>
    );
  }

  if (status === 'approx') {
    return (
      <span
        className={`${styles.badge} ${styles.badgeApprox}`}
        title={approxReason ?? 'Close match — check the part number before you order'}
      >
        APPROX
      </span>
    );
  }

  return (
    <span
      className={`${styles.badge} ${styles.badgeNone}`}
      title={detail ?? 'No catalog part matched this line'}
    >
      NO MATCH
    </span>
  );
}
