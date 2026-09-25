import { useEffect, useState, type RefObject } from 'react';

/** How much of the Founder block must be on screen before the lip ignites. */
export const IGNITE_AT = 0.35;

/** With no IntersectionObserver the block is treated as seen this long after mount. */
export const IGNITE_FALLBACK_MS = 800;

export interface FounderBlockState {
  /** The lip is burning. Flips true ONCE and never back; never under reduced motion. */
  ignited: boolean;
  /** Any of the block is on screen — the badge colours cycle only then. */
  onScreen: boolean;
}

/**
 * The About page's one orchestrated moment: the Founder's Deal block catches
 * fire the first time a third of it is in view, and stays lit.
 *
 * Reduced motion is read ONCE, at mount — the same moment `<fire-edge>` reads
 * its own gate — so the lip can never be half-decided by a later media change.
 */
export function useFounderBlock(ref: RefObject<HTMLElement | null>): FounderBlockState {
  const [ignited, setIgnited] = useState(false);
  const [onScreen, setOnScreen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (typeof IntersectionObserver === 'undefined') {
      setOnScreen(true);
      if (reduced) return undefined;
      const t = window.setTimeout(() => setIgnited(true), IGNITE_FALLBACK_MS);
      return () => window.clearTimeout(t);
    }

    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          setOnScreen(e.isIntersecting);
          // A crossing can report a hair under its own threshold (sub-pixel
          // rounding), so the check carries a small tolerance.
          if (!reduced && e.isIntersecting && e.intersectionRatio >= IGNITE_AT - 0.01) {
            setIgnited(true);
          }
        }
      },
      { threshold: [0, IGNITE_AT] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);

  return { ignited, onScreen };
}
