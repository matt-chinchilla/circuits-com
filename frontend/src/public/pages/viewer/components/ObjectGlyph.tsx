// A glyph for each object class the Objects tab lists (owner, 2026-09-22:
// "Altium has symbols for the Objects"). Phosphor has no pad, via, track or
// zone, so these are small inline SVGs drawn in `currentColor`, 18px on an
// 18-unit grid, one stroke weight, so they sit in the row like a font glyph
// and dim with the row's ink when the class is hidden. Decorative: the row's
// label names the class, so every glyph is aria-hidden.
import type { ReactElement } from 'react';
import type { ObjectClass } from '../boardView';

const STROKE = 1.5;

const SHAPES: Record<ObjectClass, ReactElement> = {
  // A short diagonal with round ends.
  tracks: <path d="M4 14 L14 4" strokeWidth={2.4} strokeLinecap="round" />,
  // A ring with its drill.
  vias: (
    <>
      <circle cx="9" cy="9" r="5.5" />
      <circle cx="9" cy="9" r="1.7" fill="currentColor" stroke="none" />
    </>
  ),
  // A rounded rect on a stub of track.
  pads: (
    <>
      <rect x="2.5" y="5" width="9" height="8" rx="2" />
      <path d="M11.5 9 H16" strokeLinecap="round" />
    </>
  ),
  // The plated ring of a through-hole, open in the middle.
  holes: (
    <>
      <circle cx="9" cy="9" r="6" />
      <circle cx="9" cy="9" r="2.6" />
    </>
  ),
  // A filled pour.
  zones: <path d="M9 2.5 L15.5 7.3 L13 15 L5 15 L2.5 7.3 Z" fill="currentColor" fillOpacity={0.35} strokeLinejoin="round" />,
  // A silkscreen outline with its pin-1 mark.
  silk: (
    <>
      <path d="M4 3.5 V14.5 H14 V3.5" strokeLinejoin="round" />
      <circle cx="6.8" cy="6.3" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  // A soft square: the mask's opening.
  mask: <rect x="3" y="3" width="12" height="12" rx="3.5" fill="currentColor" fillOpacity={0.25} />,
  // A chip with its pins.
  bodies: (
    <>
      <rect x="5" y="5" width="8" height="8" rx="1" />
      <path d="M5 7 H2.5 M5 11 H2.5 M13 7 H15.5 M13 11 H15.5 M7 5 V2.5 M11 5 V2.5 M7 13 V15.5 M11 13 V15.5" strokeLinecap="round" />
    </>
  ),
  // The drawing grid.
  grid: <path d="M3 6.5 H15 M3 11.5 H15 M6.5 3 V15 M11.5 3 V15" strokeLinecap="round" />,
  // The page with its folded corner.
  page: (
    <>
      <path d="M5 2.5 H11 L14 5.5 V15.5 H5 Z" strokeLinejoin="round" />
      <path d="M11 2.5 V5.5 H14" strokeLinejoin="round" />
    </>
  ),
};

export interface ObjectGlyphProps {
  kind: ObjectClass;
  className?: string;
}

export default function ObjectGlyph({ kind, className }: ObjectGlyphProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 18 18"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      aria-hidden="true"
      focusable="false"
      data-glyph={kind}
    >
      {SHAPES[kind]}
    </svg>
  );
}
