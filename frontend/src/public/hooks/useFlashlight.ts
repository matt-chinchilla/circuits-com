/**
 * useFlashlight — cursor-tracking lamp for the CSB v14 banner board.
 *
 * Sets `--mx` / `--my` (CSS custom properties, in the element's local
 * unscaled coords) plus `data-lit="true|false"` on the referenced element so
 * SCSS can render a radial flashlight overlay that follows the pointer.
 *
 * RELATIONSHIP TO SponsorBlock:
 *   This is a STRICT SUPERSET of the inline pointer-capture variant baked into
 *   @public/pages/category/components/SponsorBlock.tsx (the sub-category
 *   "backlit PCB flashlight" card). It adds two things the SponsorBlock
 *   inline version does not have:
 *     1. A `(pointer: fine)` matchMedia gate (SponsorBlock only checks
 *        `(hover: hover)` indirectly via CSS). Coarse pointers paint nothing.
 *     2. Runtime re-evaluation of the media queries via `change` listeners,
 *        so plugging in a mouse on a tablet attaches the listeners live.
 *   SponsorBlock should eventually be refactored to consume this hook — it is
 *   the future unification target. Until then, the two implementations are
 *   intentionally separate (SponsorBlock's pointer-capture path also handles
 *   the v11 touch-drag reveal, which this hook deliberately omits).
 *
 * INTENTIONAL OMISSIONS:
 *   This hook DOES NOT call `setPointerCapture()`. Touch support is
 *   deliberately absent — the lamp is CSS-hidden on coarse pointers
 *   (mix-blend-mode: screen is gated to `(hover: hover) and (pointer: fine)`
 *   per the v11.2 perf gotcha — see CategorySponsorBanner notes in CLAUDE.md),
 *   so wiring up touch tracking would burn cycles painting an invisible
 *   overlay. If a tap-to-reveal interaction is later needed, do NOT bolt it
 *   onto this hook — clone the SponsorBlock inline variant instead.
 *
 * Notes:
 *   - Single rAF in flight at a time; `pointermove` bails early if one is
 *     queued, so the read+write stays at most one per frame.
 *   - `rect` is cached on `pointerenter` and invalidated on scroll (capture)
 *     and resize, so the per-frame work is just two writes.
 *   - Handles a `transform: scale(...)` ancestor by dividing the screen
 *     offset by `r.width / el.offsetWidth` (and same for y) — keeps the lamp
 *     pinned to the real cursor inside zoomed/panned canvases.
 */

import { useEffect, type RefObject } from 'react';

export function useFlashlight(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

    let rect: DOMRect | null = null;
    let rafId = 0;
    let attached = false;

    const onEnter = () => {
      rect = el.getBoundingClientRect();
      el.setAttribute('data-lit', 'true');
    };

    const onLeave = () => {
      el.setAttribute('data-lit', 'false');
    };

    const onMove = (e: PointerEvent) => {
      if (rafId) return;
      const r = rect ?? el.getBoundingClientRect();
      rect = r;
      // The board may sit inside a `transform: scale()` ancestor (e.g. a
      // design-canvas pan/zoom). getBoundingClientRect() returns the SCALED
      // on-screen rect, but `--mx` / `--my` are read in the element's
      // UNSCALED local coords. Divide the screen offset by the live scale so
      // the glow tracks the real cursor.
      const sx = r.width / el.offsetWidth || 1;
      const sy = r.height / el.offsetHeight || 1;
      const x = (e.clientX - r.left) / sx;
      const y = (e.clientY - r.top) / sy;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        el.style.setProperty('--mx', `${x}px`);
        el.style.setProperty('--my', `${y}px`);
      });
    };

    const invalidate = () => {
      rect = null;
    };

    const attach = () => {
      if (attached) return;
      attached = true;
      el.addEventListener('pointerenter', onEnter);
      el.addEventListener('pointerleave', onLeave);
      el.addEventListener('pointermove', onMove);
      window.addEventListener('scroll', invalidate, true);
      window.addEventListener('resize', invalidate);
    };

    const detach = () => {
      if (!attached) return;
      attached = false;
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointermove', onMove);
      window.removeEventListener('scroll', invalidate, true);
      window.removeEventListener('resize', invalidate);
      el.setAttribute('data-lit', 'false');
    };

    const sync = () => {
      if (fine.matches && !reduced.matches) attach();
      else detach();
    };

    sync();
    fine.addEventListener('change', sync);
    reduced.addEventListener('change', sync);

    return () => {
      detach();
      fine.removeEventListener('change', sync);
      reduced.removeEventListener('change', sync);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [ref]);
}
