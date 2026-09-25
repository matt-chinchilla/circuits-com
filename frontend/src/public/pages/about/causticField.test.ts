// @vitest-environment happy-dom
/**
 * CausticField — the WebGL light field behind the About page's "Why" section.
 *
 * happy-dom has no WebGL, so the GL is the component's own `getContext` seam
 * handed a minimal fake: an object that records drawArrays, answers "yes" to
 * every compile/link query and treats every other call as a no-op. That is
 * enough to pin the component's RULES — when it falls back to static, how
 * many frames reduced motion paints, that the loop starts and dies with the
 * component — without pretending to render. The picture itself is pinned by
 * a source witness on the fragment shader (the port is Figma's math).
 *
 * createRoot + act, no testing library (the founderBadge.test.ts shape).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CausticField from './CausticField';
import { FRAGMENT_SRC, backingSize, parseHexColor } from './caustic';

const noop = () => undefined;

function fakeGL(opts: { compiles?: boolean; loseContext?: () => void } = {}) {
  const drawArrays = vi.fn();
  const known: Record<string | symbol, unknown> = {
    createShader: () => ({}),
    createProgram: () => ({}),
    getShaderParameter: () => opts.compiles ?? true,
    getProgramParameter: () => true,
    drawArrays,
    getExtension: (name: string) =>
      name === 'WEBGL_lose_context' && opts.loseContext ? { loseContext: opts.loseContext } : null,
  };
  const gl = new Proxy(known, { get: (t, k) => (k in t ? t[k] : noop) });
  return { gl: gl as unknown as WebGLRenderingContext, drawArrays };
}

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

describe('CausticField', () => {
  let host: HTMLDivElement;
  let root: Root;
  let frames: FrameRequestCallback[];
  let raf: ReturnType<typeof vi.fn>;
  let caf: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    frames = [];
    raf = vi.fn((cb: FrameRequestCallback) => frames.push(cb)); // ids 1, 2, … (never 0)
    caf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);
    // No observers: the field sizes once and counts as on screen.
    vi.stubGlobal('IntersectionObserver', undefined);
    vi.stubGlobal('ResizeObserver', undefined);
    stubReducedMotion(false);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const render = (getContext: () => WebGLRenderingContext | null) => {
    act(() => root.render(createElement(CausticField, { getContext })));
    return host.firstElementChild as HTMLElement;
  };

  it('with no WebGL context: the static fallback, no canvas, no animation frame', () => {
    const field = render(() => null);
    expect(field.getAttribute('data-caustic')).toBe('static');
    expect(field.getAttribute('aria-hidden')).toBe('true');
    expect(field.querySelector('canvas')).toBeNull();
    expect(raf).not.toHaveBeenCalled();
  });

  it('under reduced motion: exactly one frame is drawn and the loop never starts', () => {
    stubReducedMotion(true);
    const { gl, drawArrays } = fakeGL();
    const field = render(() => gl);
    expect(field.getAttribute('data-caustic')).toBe('webgl');
    expect(field.querySelector('canvas')).not.toBeNull();
    expect(drawArrays).toHaveBeenCalledTimes(1);
    expect(raf).not.toHaveBeenCalled();
  });

  it('with motion allowed: the loop starts, and unmount cancels it and hands the context back', () => {
    const loseContext = vi.fn();
    const { gl } = fakeGL({ loseContext });
    render(() => gl);
    expect(raf.mock.calls.length).toBeGreaterThanOrEqual(1);
    const pending = raf.mock.results[raf.mock.results.length - 1].value as number;

    act(() => root.unmount());
    expect(caf).toHaveBeenCalledWith(pending);
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it('the fragment shader is the Figma "Water caustic" math, not an approximation', () => {
    expect(FRAGMENT_SRC).toContain('pow(abs(c), 8.0)');
    expect(FRAGMENT_SRC).toContain('1.17 - pow(c, 1.4)');
    // and the spec's fixed values around it
    expect(FRAGMENT_SRC).toContain('const int MAX_ITER = 5;');
    expect(FRAGMENT_SRC).toContain('mix(0.002519, 0.01178, INTENSITY)');
    expect(FRAGMENT_SRC).toContain('const float INTENSITY = 0.35;');
    expect(FRAGMENT_SRC).toContain('const float SCALE = 1.6;');
    expect(FRAGMENT_SRC).toContain('u_time * 0.10 + 23.0');
    expect(FRAGMENT_SRC).toContain('mix(u_base, u_accent, causticMask * 0.30)');
  });

  it('a shader that fails to compile falls back to static and draws nothing', () => {
    const { gl, drawArrays } = fakeGL({ compiles: false });
    const field = render(() => gl);
    expect(field.getAttribute('data-caustic')).toBe('static');
    expect(field.querySelector('canvas')).toBeNull();
    expect(drawArrays).not.toHaveBeenCalled();
    expect(raf).not.toHaveBeenCalled();
  });

  it('a lost context stops the loop and falls back to static', () => {
    const { gl } = fakeGL();
    const field = render(() => gl);
    const canvas = field.querySelector('canvas')!;
    act(() => {
      canvas.dispatchEvent(new Event('webglcontextlost'));
    });
    expect(field.getAttribute('data-caustic')).toBe('static');
    expect(field.querySelector('canvas')).toBeNull();
    expect(caf).toHaveBeenCalled();
  });

  it('caps the loop at 30 fps: one rAF per tick, a tick under 33 ms from the last frame draws nothing', () => {
    const { gl, drawArrays } = fakeGL();
    render(() => gl);
    expect(drawArrays).toHaveBeenCalledTimes(1); // the mount frame
    const step = (now: number) => frames[frames.length - 1](now);
    step(1000); // first tick after start draws
    expect(drawArrays).toHaveBeenCalledTimes(2);
    step(1016.7); // 16.7 ms later — skipped
    expect(drawArrays).toHaveBeenCalledTimes(2);
    step(1033.4); // 33.4 ms after the last drawn frame
    expect(drawArrays).toHaveBeenCalledTimes(3);
    // every tick queued exactly one successor
    expect(raf).toHaveBeenCalledTimes(4);
  });
});

describe('caustic helpers', () => {
  it('parses the theme hexes to 0-1 channels and refuses anything else', () => {
    expect(parseHexColor('#0e1113')).toEqual([14 / 255, 17 / 255, 19 / 255]);
    expect(parseHexColor(' #44BD13 ')).toEqual([0x44 / 255, 0xbd / 255, 0x13 / 255]);
    expect(parseHexColor('#fff')).toEqual([1, 1, 1]);
    expect(parseHexColor('#44bd13cc')).toEqual([0x44 / 255, 0xbd / 255, 0x13 / 255]);
    expect(parseHexColor('')).toBeNull();
    expect(parseHexColor('rgb(1, 2, 3)')).toBeNull();
    expect(parseHexColor('#12345')).toBeNull();
  });

  it('draws at half resolution and never more on a dense screen', () => {
    expect(backingSize(1180, 640, 1)).toEqual({ w: 590, h: 320 });
    expect(backingSize(1180, 640, 3)).toEqual({ w: 590, h: 320 });
    expect(backingSize(0, 0, 1)).toEqual({ w: 1, h: 1 });
  });
});
