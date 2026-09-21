// Types for the vendored `<fire-edge>` element (see PROVENANCE.md — the .js
// beside this file is byte-identical to the owner's design export and carries
// no types of its own). Two jobs, exactly as with `<fire-badge>`:
//
//   1. Give `import './fire-edge.vendor.js'` something to resolve to — TS
//      substitutes `.d.ts` for the `.js` extension, and since `allowJs` is off
//      with `noUncheckedSideEffectImports` on, without this file `tsc -b` fails
//      on the side-effect import outright.
//   2. Declare the element for JSX. React 19 moved the JSX namespace under the
//      `react` module, so the augmentation goes there — and this file must stay
//      a MODULE (the `export {}` below) or `declare module 'react'` would
//      REPLACE React's types instead of merging into them.
//
// The module exports nothing: importing it registers the element, and the only
// interface is the attribute set below. Every attribute is optional — the
// element's `_o` getter defaults all of them — and every one is accepted as a
// string as well as a number, because JSX writes attributes on a custom element
// as strings and the element parses them back with `+`/`parseFloat`.
//
// Two knobs are deliberately ABSENT: `coalGlow` and `coalDensity` are read off
// `document.documentElement.dataset`, not off the element, so they are not
// attributes at all.
import type { HTMLAttributes } from 'react';

/** Booleans travel as the STRINGS the element compares against (`'false'` /
 *  `'0'` / `''` are off for `active`; anything else is on). */
type BoolAttr = 'true' | 'false' | boolean;

interface FireEdgeAttributes extends HTMLAttributes<HTMLElement> {
  /** `"true"` starts a burn, `"false"` clears it — re-flip to replay. */
  active?: BoolAttr;
  /** `lip` rides the host's bottom edge · `line` runs a head from (x1,y1) to
   *  (x2,y2) · `sweep` (default) moves a vertical front left → right. */
  mode?: 'lip' | 'line' | 'sweep';
  /** Seconds before the burn starts. Default 0. */
  delay?: string | number;
  /** Seconds the burn front takes to cross. Default 1.2. */
  duration?: string | number;
  /** Flame size in px (≈ the text height it burns). Default 12. */
  scale?: string | number;
  /** 0.3–2. Default 1. */
  intensity?: string | number;
  /** 0–1. Default 0.85. */
  opacity?: string | number;
  /** `add` = `'lighter'`, for dark grounds (default); `over` for light ones. */
  blend?: 'add' | 'over';
  scheme?: 'orange' | 'red';
  /** Canvas overscan in px so flames may exceed the host box. Default 30. */
  pad?: string | number;
  /** `line` endpoints, in % of the host box. Defaults 0 / 100 / 100 / 0. */
  x1?: string | number;
  y1?: string | number;
  x2?: string | number;
  y2?: string | number;
  /** `"true"` lays a glowing coal bed under the burn front. Default off. */
  coals?: BoolAttr;
  /** 0–1: the level the flame settles to once the front has crossed — 0 goes
   *  out, >0 keeps a `lip` burning while the panel stays open. Default 0. */
  sustain?: string | number;
  /** `line`: seconds the flame trail lags behind the head. Default 1. */
  hold?: string | number;
  /** `line`: seconds the whole drawn line keeps burning after the head lands,
   *  before it dies out. Default 0. */
  linger?: string | number;
  /** `"true"` moves the front linearly instead of on the slash's draw curve. */
  linear?: BoolAttr;
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'fire-edge': FireEdgeAttributes;
    }
  }
}

export {};
