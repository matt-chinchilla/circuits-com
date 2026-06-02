/**
 * useEntrance — staggered fade-up entrance for [data-enter] descendants.
 *
 * TypeScript port of useEntrance from
 * design-handoff-v9/circuits-com-design-system/project/category-sponsor/csb-shared.jsx (L71-95).
 *
 * Behavior:
 * - Skipped entirely when prefers-reduced-motion: reduce.
 * - Double-RAF guard ensures the DOM has painted (and any sibling layout effects
 *   have run) before we query, so first-frame nodes aren't missed.
 * - Each [data-enter] node gets a 460ms fade+rise with a 50 + i*80 ms stagger.
 * - Re-fires whenever `dep` changes (e.g. category slug swap).
 *
 * Why `fill: "none"` (not "forwards"):
 * The chips/CTAs are already visible at rest via CSS — this animation just plays
 * a one-shot transition ON TOP of the steady state. Using `fill: "forwards"`
 * would commit the KEYFRAME state at finish; if the animation is cancelled
 * mid-flight (component unmount, dep change, tab hidden), the node could be
 * stranded at `opacity: 0` until something else repaints it. With `fill: "none"`
 * the underlying CSS always wins after the animation releases — safe under
 * cancellation, no FOUC risk.
 */
import { useEffect, type RefObject } from 'react';

export function useEntrance<T>(
  ref: RefObject<HTMLElement | null>,
  dep: T,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let r1 = 0;
    let r2 = 0;
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        const ease = 'cubic-bezier(.2,.8,.3,1)';
        el.querySelectorAll<HTMLElement>('[data-enter]').forEach((node, i) => {
          node.animate(
            [
              { opacity: 0, transform: 'translateY(10px)' },
              { opacity: 1, transform: 'translateY(0)' },
            ],
            {
              duration: 460,
              delay: 50 + i * 80,
              easing: ease,
              fill: 'none',
            },
          );
        });
      });
    });

    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);
}
