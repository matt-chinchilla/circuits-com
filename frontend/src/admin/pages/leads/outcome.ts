import type React from 'react';

// Outcome metadata — the ONE home for the outcome trio (spec L5).
//
// CVD CONSTRAINT (chartTheme.ts records it as HARD): #2563eb (blue) and
// #7c3aed (purple) collapse under deuteranopia (dE 0.4) and may never coexist.
// These deepened values preserve the owner's blue->violet->red intent and
// already ship in PresenceBubbles' board-finish palettes; every surface must
// ALSO render the word + glyph — colour never carries outcome alone.

import type { LeadOutcome } from '../../types/leads';

// `hex` is FILL-tuned (deep, carries white type on both themes — the discs).
// `inkDark` is the same identity lifted for use as TEXT on the dark theme's
// surfaces, where the deep values sink to ~1.5-2.6:1. Consumers that render
// colored WORDS set BOTH as CSS custom properties (--oc / --oc-dark) and the
// stylesheet picks per theme; consumers that render FILLS use `hex` alone.
export const OUTCOME_META: Record<
  LeadOutcome,
  { word: string; hex: string; inkDark: string; glyph: string }
> = {
  converted: { word: 'Converted', hex: '#153f80', inkDark: '#8fb3f2', glyph: '✓' },
  maybe: { word: 'Maybe', hex: '#4d189e', inkDark: '#b79bec', glyph: '?' },
  rejected: { word: 'Rejected', hex: '#b91c1c', inkDark: '#f18f88', glyph: '✕' },
};

/** Inline style pair for colored-WORD renderers: `style={outcomeInkVars(meta)}`
 *  + a stylesheet rule `color: var(--oc)` with a dark override to var(--oc-dark). */
export function outcomeInkVars(meta: { hex: string; inkDark: string }) {
  return { '--oc': meta.hex, '--oc-dark': meta.inkDark } as React.CSSProperties;
}

export const OUTCOME_ORDER: LeadOutcome[] = ['converted', 'maybe', 'rejected'];

// First initial for the checklist disc. NOT lettermark(): 189 of 359 rows are
// company-only placeholders — those get a centred dot from the caller, never
// a fake "E" (for ENRICHMENT).
export function firstInitial(name: string | null): string | null {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return null;
  return trimmed[0].toUpperCase();
}
