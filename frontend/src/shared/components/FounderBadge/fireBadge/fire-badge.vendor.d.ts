// Types for the vendored `<fire-badge>` element (see PROVENANCE.md — the .js
// beside this file is byte-identical to the owner's design export and carries
// no types of its own). Two jobs:
//
//   1. Give `import './fire-badge.vendor.js'` something to resolve to — TS
//      substitutes `.d.ts` for the `.js` extension, and since `allowJs` is off
//      with `noUncheckedSideEffectImports` on, without this file `tsc -b` fails
//      on the side-effect import outright.
//   2. Declare the element for JSX. React 19 moved the JSX namespace under the
//      `react` module, so the augmentation goes there — and this file must stay
//      a MODULE (the `export {}` below) or `declare module 'react'` would
//      REPLACE React's types instead of merging into them.
//
// The module exports nothing: importing it registers the element, and the only
// interface is the attribute set below.
import type { HTMLAttributes } from 'react';

/** The element's own attributes. Everything except `badge` is optional because
 *  the vendor file defaults them (orange / 1 / 0.75 / sparks on), and the site
 *  deliberately ships those defaults. `size` in CSS px; omit it and the element
 *  measures its slotted child with a ResizeObserver instead. */
interface FireBadgeAttributes extends HTMLAttributes<HTMLElement> {
  /** `"true"` renders the pin the vendor file draws; no slotted child needed. */
  badge?: 'true' | 'false';
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
  /** 0.3–2. */
  intensity?: number;
  /** 0–1. */
  opacity?: number;
  sparks?: 'true' | 'false';
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'fire-badge': FireBadgeAttributes;
    }
  }
}

export {};
