// Fire — the thin React wrapper over the vendored <fire-edge> particle burn
// (fire-edge.vendor.js beside this file; PROVENANCE.md records the export).
// Its own module so a page that only wants a burn (the About page's Founder
// block) does not pull the Join page's stylesheet in through
// FounderDiscount.tsx (43 KB of CSS for one lip, measured 2026-09-25).
import './fire-edge.vendor.js';

interface FireProps {
  on: boolean;
  mode?: 'lip' | 'line' | 'sweep';
  delay?: string | number;
  dur?: string | number;
  scale?: string | number;
  blend?: 'add' | 'over';
  intensity?: string | number;
  scheme?: 'orange' | 'red';
  x1?: string | number;
  y1?: string | number;
  x2?: string | number;
  y2?: string | number;
  coals?: boolean;
  sustain?: string | number;
  hold?: string | number;
  linger?: string | number;
  linear?: boolean;
}

/** Thin wrapper over the vendored element — every attribute spelled the way
 *  the design's own `Fire` helper spells it, defaults included. */
export function Fire(p: FireProps) {
  return (
    <fire-edge
      active={p.on ? 'true' : 'false'}
      mode={p.mode}
      delay={p.delay}
      duration={p.dur}
      scale={p.scale}
      blend={p.blend || 'add'}
      intensity={p.intensity || 1}
      scheme={p.scheme || 'orange'}
      x1={p.x1}
      y1={p.y1}
      x2={p.x2}
      y2={p.y2}
      coals={p.coals ? 'true' : 'false'}
      sustain={p.sustain || 0}
      hold={p.hold || 1}
      linger={p.linger || 0}
      linear={p.linear ? 'true' : 'false'}
      aria-hidden="true"
    />
  );
}
