// Outcome metadata — the ONE home for the outcome trio (spec L5).
//
// CVD CONSTRAINT (chartTheme.ts records it as HARD): #2563eb (blue) and
// #7c3aed (purple) collapse under deuteranopia (dE 0.4) and may never coexist.
// These deepened values preserve the owner's blue->violet->red intent and
// already ship in PresenceBubbles' board-finish palettes; every surface must
// ALSO render the word + glyph — colour never carries outcome alone.

import type { LeadOutcome } from '../../types/leads';

export const OUTCOME_META: Record<
  LeadOutcome,
  { word: string; hex: string; glyph: string }
> = {
  converted: { word: 'Converted', hex: '#153f80', glyph: '✓' },
  maybe: { word: 'Maybe', hex: '#4d189e', glyph: '?' },
  rejected: { word: 'Rejected', hex: '#b91c1c', glyph: '✕' },
};

export const OUTCOME_ORDER: LeadOutcome[] = ['converted', 'maybe', 'rejected'];

// First initial for the checklist disc. NOT lettermark(): 189 of 359 rows are
// company-only placeholders — those get a centred dot from the caller, never
// a fake "E" (for ENRICHMENT).
export function firstInitial(name: string | null): string | null {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return null;
  return trimmed[0].toUpperCase();
}
