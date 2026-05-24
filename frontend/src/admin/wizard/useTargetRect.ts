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

    const measure = () => {
      if (!alive) return;
      const el = findEl(selector);
      if (!el) {
        tries++;
        if (tries < 40) setTimeout(measure, 120);
        else if (alive) setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) {
        setTimeout(measure, 120);
        return;
      }
      setRect({
        top: r.top - padding,
        left: r.left - padding,
        width: r.width + padding * 2,
        height: r.height + padding * 2,
      });
    };

    measure();
    const interval = setInterval(measure, 280);
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);

    return () => {
      alive = false;
      clearInterval(interval);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [selector, padding]);

  return rect;
}
