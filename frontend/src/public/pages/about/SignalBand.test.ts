// @vitest-environment happy-dom
/**
 * SignalBand — the component that owns the band's canvas and clock.
 *
 * happy-dom lays nothing out and rasterises nothing, so the host's size is
 * stubbed (800 × 180) and `getContext('2d')` hands back a recording fake: one
 * `clearRect` per `paint`, and the `fillText`/`strokeStyle` it saw. That pins
 * the component's RULES — reduced motion paints one still frame and never
 * loops; the loop waits for the band to be on screen and for a visible tab;
 * the 30 fps cap; acquisition from the first on-screen tick; and that nothing
 * outlives unmount — without pretending to render.
 *
 * createRoot + act, no testing library (the founderBadge.test.ts shape).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SignalBand from './SignalBand';
import { ACQUIRE_S, LANES } from './signalBand';

const noop = () => undefined;

function stubReducedMotion(on: boolean) {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: on,
    media,
    onchange: null,
    addListener: noop,
    removeListener: noop,
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => false,
  }));
}

/** A 2D context that records calls and property writes. */
function recordingContext() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const ctx = new Proxy(
    {},
    {
      get: (_t, key) => {
        const op = String(key);
        if (op === 'measureText') return (s: string) => ({ width: s.length * 6 });
        if (op === 'createLinearGradient') return () => ({ addColorStop: noop });
        return (...args: unknown[]) => {
          calls.push({ op, args });
        };
      },
      set: (_t, key, value) => {
        calls.push({ op: `${String(key)}=`, args: [value] });
        return true;
      },
    },
  );
  const of = (op: string) => calls.filter((c) => c.op === op).map((c) => c.args);
  return { ctx, calls, of, paints: () => of('clearRect').length };
}

/** An IntersectionObserver whose callback the test fires by hand. */
function stubIntersection() {
  const callbacks: IntersectionObserverCallback[] = [];
  class IO {
    constructor(cb: IntersectionObserverCallback) {
      callbacks.push(cb);
    }
    observe = noop;
    unobserve = noop;
    disconnect = noop;
    takeRecords = () => [];
  }
  vi.stubGlobal('IntersectionObserver', IO);
  return (isIntersecting: boolean) =>
    act(() => {
      for (const cb of callbacks)
        cb([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
}

describe('SignalBand', () => {
  let host: HTMLDivElement;
  let root: Root;
  let frames: FrameRequestCallback[];
  let raf: ReturnType<typeof vi.fn>;
  let caf: ReturnType<typeof vi.fn>;
  let rec: ReturnType<typeof recordingContext>;
  let hidden: boolean;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    frames = [];
    raf = vi.fn((cb: FrameRequestCallback) => frames.push(cb)); // ids 1, 2, … (never 0)
    caf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);
    vi.stubGlobal('ResizeObserver', undefined);
    vi.stubGlobal('IntersectionObserver', undefined); // no IO → counts as on screen
    stubReducedMotion(false);
    rec = recordingContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => rec.ctx as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(180);
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const render = () => {
    act(() => root.render(createElement(SignalBand, { className: 'extra' })));
    return host.firstElementChild as HTMLElement;
  };
  /** Run the pending animation frame(s) at time `now` (ms). */
  const runFrames = (now: number) => {
    const pending = frames.splice(0);
    for (const cb of pending) cb(now);
  };

  it('renders one aria-hidden host with one canvas, sized to the box at device scale', () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const band = render();
    expect(band.getAttribute('aria-hidden')).toBe('true');
    expect(band.className).toContain('extra');
    const canvases = band.querySelectorAll('canvas');
    expect(canvases).toHaveLength(1);
    // dpr capped at 2
    expect(canvases[0].width).toBe(1600);
    expect(canvases[0].height).toBe(360);
  });

  it('under reduced motion: data-signal="still", exactly one fully acquired frame, no animation frame ever', () => {
    stubReducedMotion(true);
    const band = render();
    expect(band.getAttribute('data-signal')).toBe('still');
    expect(rec.paints()).toBe(1);
    expect(raf).not.toHaveBeenCalled();
    // fully acquired: the clip spans the whole wave area, and no sweep line
    expect(rec.of('rect')).toEqual([[65, -2, 800 - 66 + 1, 184]]);
    expect(rec.of('fillRect').filter((a) => a[2] === 1.5)).toEqual([]);
  });

  it('a frame labels and strokes all five lanes', () => {
    render();
    expect(rec.of('fillText').map((a) => a[0])).toEqual(LANES.map((l) => l.name));
    expect(rec.of('strokeStyle=').map((a) => a[0])).toEqual(LANES.map((l) => `rgba(${l.rgb},.34)`));
  });

  it('with motion: data-signal="live", the loop starts, and unmount cancels it', () => {
    const band = render();
    expect(band.getAttribute('data-signal')).toBe('live');
    expect(raf).toHaveBeenCalledTimes(1);
    const pending = raf.mock.results[0].value as number;
    act(() => root.unmount());
    expect(caf).toHaveBeenCalledWith(pending);
  });

  it('the mount frame shows labels only; acquisition starts on the first tick, not at mount', () => {
    render();
    expect(rec.of('rect')).toEqual([[65, -2, 1, 184]]); // acq = 0
    runFrames(5000); // first tick, long after mount: still acq = 0
    expect(rec.paints()).toBe(2);
    const rects = rec.of('rect');
    expect(rects[rects.length - 1]).toEqual([65, -2, 1, 184]);
    runFrames(5050); // 50 ms later
    const after = rec.of('rect');
    const width = after[after.length - 1][2] as number;
    expect(width - 1).toBeCloseTo((800 - 66) * (0.05 / ACQUIRE_S), 6);
    // the sweep line rides the reveal edge while acquiring
    expect(rec.of('fillRect').filter((a) => a[2] === 1.5)).toHaveLength(1);
  });

  it('caps at 30 fps: one rAF per tick, a tick under 33 ms from the last frame draws nothing', () => {
    render();
    runFrames(1000);
    expect(rec.paints()).toBe(2);
    runFrames(1016);
    expect(rec.paints()).toBe(2);
    expect(frames).toHaveLength(1); // still ticking
    runFrames(1034);
    expect(rec.paints()).toBe(3);
  });

  it('waits for the band to be on screen, and pauses when it leaves', () => {
    const intersect = stubIntersection();
    render();
    expect(rec.paints()).toBe(1); // the mount frame
    expect(raf).not.toHaveBeenCalled();
    intersect(true);
    expect(raf).toHaveBeenCalledTimes(1);
    const pending = raf.mock.results[0].value as number;
    intersect(false);
    expect(caf).toHaveBeenCalledWith(pending);
  });

  it('pauses while the tab is hidden and resumes when it is shown', () => {
    render();
    const pending = raf.mock.results[0].value as number;
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(caf).toHaveBeenCalledWith(pending);
    frames.length = 0;
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(raf).toHaveBeenCalledTimes(2);
  });

  it('nothing resurrects the loop after unmount (a stray frame, observer or visibility event)', () => {
    const intersect = stubIntersection();
    render();
    intersect(true);
    act(() => root.unmount());
    const paints = rec.paints();
    const calls = raf.mock.calls.length;
    runFrames(2000);
    intersect(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(rec.paints()).toBe(paints);
    expect(raf.mock.calls.length).toBe(calls);
  });
});
