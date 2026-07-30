import { useEffect, useState } from 'react';
import { findEl } from './helpers';

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

// Resolve a target element's bounding rect with retries. Handles late-mount
// elements (route just changed, React still rendering) by polling every 120ms
// for ~4s. Once found, re-measures on resize/scroll AND every 280ms (covers
// layout shifts from list mutations, modal open/close, etc).
//
// Returns `null` until the element is found and has non-degenerate size.
export function useTargetRect(
  selector: string | (() => Element | null) | null | undefined,
  padding = 8,
): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!selector) {
      setRect(null);
      return;
    }

    let alive = true;
    let tries = 0;

    // ONE retry chain, ever. Every not-found / degenerate measurement schedules
    // a 120ms retry, and those used to be untracked: the 280ms interval and the
    // scroll/resize listeners each call measure() too, so a target that stayed
    // missing (a route mid-render) had every one of those calls fork its OWN
    // retry loop — concurrent chains, each re-entering measure() and forking
    // again. Cancelling the pending retry before scheduling the next one (and in
    // cleanup) keeps exactly one in flight.
    let retry: ReturnType<typeof setTimeout> | null = null;
    const scheduleRetry = () => {
      if (retry != null) clearTimeout(retry);
      retry = setTimeout(measure, 120);
    };

    const measure = () => {
      if (!alive) return;
      const el = findEl(selector);
      if (!el) {
        tries++;
        if (tries < 40) scheduleRetry();
        else if (alive) setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) {
        scheduleRetry();
        return;
      }
      // Round to whole pixels and skip the update when nothing moved. The
      // 280ms re-measure + scroll listeners fire constantly; getBoundingClientRect
      // drifts sub-pixel each time, so setting a fresh object every tick made the
      // spotlight re-render and re-trigger its position transition non-stop —
      // the "shaky/jittery" spotlight. Now it only updates on a real move, so the
      // transition runs once per step instead of continuously.
      const next: Rect = {
        top: Math.round(r.top - padding),
        left: Math.round(r.left - padding),
        width: Math.round(r.width + padding * 2),
        height: Math.round(r.height + padding * 2),
      };
      setRect((prev) =>
        prev &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next,
      );
    };

    measure();
    const interval = setInterval(measure, 280);
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);

    return () => {
      alive = false;
      clearInterval(interval);
      if (retry != null) clearTimeout(retry);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [selector, padding]);

  return rect;
}
