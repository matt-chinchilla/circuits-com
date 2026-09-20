// Types for the vendored `<glow-badge>` element (see PROVENANCE.md). Same two
// jobs as `../fireBadge/fire-badge.vendor.d.ts`: give the side-effect import a
// declaration (`allowJs` is off) and add the tag to React 19's JSX namespace —
// this file must stay a MODULE (`export {}`) so the augmentation MERGES.
import type { HTMLAttributes } from 'react';

interface GlowBadgeAttributes extends HTMLAttributes<HTMLElement> {
  size?: number;
  scheme?:
    | 'red'
    | 'orange'
    | 'yellow'
    | 'green'
    | 'blue'
    | 'indigo'
    | 'violet'
    | 'white'
    | 'black';
  /** 0–2; the site feeds the holding's `intensity` here. */
  glow?: number;
  /** Seconds per prestige cycle, 1–6. */
  speed?: number;
  paused?: '' | 'true';
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'glow-badge': GlowBadgeAttributes;
    }
  }
}

export {};
