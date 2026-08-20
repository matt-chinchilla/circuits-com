// The checklist disc — the ONE geometry that carries an outcome across the
// list, the lead profile and the rep page.
//
// No .module.scss by design: this primitive renders inside three separate
// CSS-Module scopes, and its only real variable is a hex that already lives in
// OUTCOME_META. Inline styles keep that hex->pixel path one hop long, and the
// surface halo still resolves because `var(--a-card)` inherits from the .admin
// cascade rather than from a scoped class.
//
// Geometry language is PresenceBubbles': a filled disc with a surface-coloured
// ring so overlapping/adjacent discs read as separate objects, white 700
// initials, static (never animated). The fill is FLAT rather than a gradient —
// here the colour IS the datum, and a gradient would put two luminances on one
// meaning. Contrast against #ffffff, computed: #153f80 10.9:1, #4d189e 10.2:1,
// #b91c1c 6.2:1 — all clear of 4.5.
//
// Colour NEVER travels alone (chartTheme's CVD rule): every caller renders the
// word beside the disc. The glyph inside an EMPTY disc is nothing at all — an
// unchecked box is the universal "not done yet".

import { OUTCOME_META, firstInitial } from './outcome';
import type { LeadOutcome } from '@admin/types/leads';

interface OutcomeDiscProps {
  outcome: LeadOutcome | null;
  /** Whose initial goes in the disc. null (company-only row) -> centred dot. */
  contactName: string | null;
  /** Diameter in px. 28 = list/profile, 22 = timeline/rep rows. */
  size?: number;
}

export default function OutcomeDisc({ outcome, contactName, size = 28 }: OutcomeDiscProps) {
  const initial = firstInitial(contactName);

  if (outcome == null) {
    // Unchecked control: hairline ring, no fill, no glyph.
    return (
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: size,
          height: size,
          borderRadius: '50%',
          border: '1.5px solid var(--a-fg4)',
          background: 'transparent',
          boxSizing: 'border-box',
        }}
      />
    );
  }

  const meta = OUTCOME_META[outcome];
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: '50%',
        background: meta.hex,
        color: '#ffffff',
        // Structural, not decoration — separates the disc from a row hover
        // tint or an adjacent disc without touching the layout box.
        boxShadow: '0 0 0 1.5px var(--a-card)',
        fontSize: Math.round(size * 0.4),
        fontWeight: 700,
        lineHeight: 1,
        letterSpacing: '0.02em',
        userSelect: 'none',
        boxSizing: 'border-box',
      }}
    >
      {/* No initial => a centred dot. NEVER a fabricated letter: a
          company-only row has no person's name to abbreviate. */}
      {initial ?? '\u00B7'}
    </span>
  );
}
