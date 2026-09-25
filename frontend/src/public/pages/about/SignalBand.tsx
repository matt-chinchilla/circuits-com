// SignalBand — the logic-analyzer band between the About page's manifesto and
// its commitments rail: five slow signal lanes, acquired left to right once
// the band is on screen, then rolling. Spec:
// docs/superpowers/specs/2026-09-25-about-page-design.md, "Revision 2".
//
// The drawing is the pure `paint` in ./signalBand; this file only owns the
// canvas and the clock. Stamped on the host as data-signal:
//   live  — one frame at mount (labels, nothing acquired yet), then a ≤30 fps
//           loop that runs only while the band is on screen AND the tab is
//           visible; acquisition starts on its first tick, not at mount;
//   still — prefers-reduced-motion: one fully acquired frame, never a loop.
// A `destroyed` flag closes every post-unmount entry point (the csFx law: a
// stray callback must never resurrect a loop nobody can stop). No GPU context
// is held, so React may own the <canvas>.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { FRAME_MS, MAX_DPR, advance, paint, type BandState } from './signalBand';
import styles from './SignalBand.module.scss';

export interface SignalBandProps {
  className?: string;
}

const reducedMotionQuery = (): MediaQueryList | null =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/** Wire the band's canvas. Returns its teardown. */
function runBand(host: HTMLElement, canvas: HTMLCanvasElement, still: boolean): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => undefined;

  let destroyed = false;
  let running = false;
  let raf = 0;
  let last = 0; // rAF timestamp of the last DRAWN frame; 0 = none since (re)start
  let onScreen = typeof IntersectionObserver === 'undefined'; // no IO → treat as visible
  let width = 0;
  let height = 0;
  let dpr = 1;
  let state: BandState = { acq: still ? 1 : 0, scroll: 0 };

  const draw = () => paint(ctx, { width, height, dpr, ...state });

  /** Match the backing store to the box; true when it changed (which also cleared it). */
  const size = (): boolean => {
    const nextDpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w === width && h === height && nextDpr === dpr) return false;
    width = w;
    height = h;
    dpr = nextDpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    return true;
  };

  const tick = (now: number) => {
    if (destroyed || !running) return;
    raf = requestAnimationFrame(tick);
    if (last && now - last < FRAME_MS) return;
    state = advance(state, last ? (now - last) / 1000 : 0);
    last = now;
    draw();
  };

  const start = () => {
    if (destroyed || still || running || !onScreen || document.hidden) return;
    running = true;
    last = 0;
    raf = requestAnimationFrame(tick);
  };
  const stop = () => {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  size();
  draw();
  start();

  // A resize clears the backing store; repaint at once rather than show the
  // cleared canvas until the next tick (or forever, when no loop runs).
  const ro =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (!destroyed && size()) draw();
        });
  ro?.observe(host);

  if (still) {
    return () => {
      destroyed = true;
      ro?.disconnect();
    };
  }

  const io =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            if (destroyed) return;
            onScreen = entries.some((e) => e.isIntersecting);
            if (onScreen) start();
            else stop();
          },
          { threshold: 0 },
        );
  io?.observe(host);

  const onVisibility = () => {
    if (document.hidden) stop();
    else start();
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    destroyed = true;
    stop();
    ro?.disconnect();
    io?.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

export default function SignalBand({ className }: SignalBandProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [still, setStill] = useState(() => reducedMotionQuery()?.matches ?? false);

  // Turning reduced motion on mid-visit swaps the loop for the still frame;
  // turning it off starts a fresh acquisition.
  useEffect(() => {
    const mq = reducedMotionQuery();
    if (!mq) return;
    const onChange = () => setStill(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    return runBand(host, canvas, still);
  }, [still]);

  const cls = className ? `${styles.band} ${className}` : styles.band;
  return (
    <div ref={hostRef} className={cls} aria-hidden="true" data-signal={still ? 'still' : 'live'}>
      <canvas ref={canvasRef} />
    </div>
  );
}
