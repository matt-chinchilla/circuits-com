// CausticField — the slow light field behind the About page's "Why" section.
//
// A WebGL1 port of Figma's "Water caustic" shader fill (GLSL in ./caustic.ts),
// drawn as a faint accent tint over the section's ground. Spec:
// docs/superpowers/specs/2026-09-25-about-page-design.md, "<CausticField />".
//
// Two paths, stamped on the host as data-caustic:
//   webgl  — a <canvas> child, painted once at mount, then a ≤30 fps loop that
//            runs only while the field is on screen AND the tab is visible;
//   static — no canvas; the SCSS paints two soft accent pools. Taken when the
//            context is null, the shader fails to compile/link, the context
//            is lost, or anything in the GL setup throws.
// prefers-reduced-motion paints the one frame at t = 23 and never loops.
//
// The canvas is created INSIDE the effect, not rendered by React: cleanup
// calls loseContext(), and StrictMode's dev remount would otherwise get the
// same, now lost, context back from the same element and fall to static.
// A `destroyed` flag closes every post-unmount entry point (the csFx law:
// a stray callback must never resurrect a loop nobody can stop).
import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  FALLBACK_ACCENT,
  FALLBACK_BASE,
  FRAGMENT_SRC,
  FULLSCREEN_TRIANGLE,
  VERTEX_SRC,
  backingSize,
  parseHexColor,
  type Rgb,
} from './caustic';
import styles from './CausticField.module.scss';

export interface CausticFieldProps {
  className?: string;
  /** Test seam: how the component asks the canvas for a context. Default
   *  `canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' })`. */
  getContext?: (canvas: HTMLCanvasElement) => WebGLRenderingContext | null;
}

/** 30 fps cap: a tick closer than this to the last drawn frame is skipped. */
const FRAME_MS = 33;
/** A resumed loop (back on screen, tab shown) continues where it paused, not ahead by the pause. */
const MAX_STEP_MS = 100;

const defaultGetContext = (canvas: HTMLCanvasElement): WebGLRenderingContext | null =>
  canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' });

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

function link(gl: WebGLRenderingContext): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

function themeColor(name: string, fallback: Rgb): Rgb {
  return parseHexColor(getComputedStyle(document.documentElement).getPropertyValue(name)) ?? fallback;
}

/**
 * Wire a caustic field into `host`. Returns its teardown, or null when this
 * device cannot draw it (the caller shows the static fallback).
 */
function mountField(
  host: HTMLElement,
  getContext: (canvas: HTMLCanvasElement) => WebGLRenderingContext | null,
  onLost: () => void,
): (() => void) | null {
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);

  let gl: WebGLRenderingContext | null = null;
  let uRes: WebGLUniformLocation | null = null;
  let uTime: WebGLUniformLocation | null = null;
  try {
    gl = getContext(canvas);
    const program = gl && link(gl);
    if (gl && program) {
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRIANGLE, gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(program, 'a_pos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      uRes = gl.getUniformLocation(program, 'u_res');
      uTime = gl.getUniformLocation(program, 'u_time');
      // Read ONCE at mount: the field is the section's ground, not a theme
      // preview, and a per-frame getComputedStyle would force style recalc.
      gl.uniform3f(gl.getUniformLocation(program, 'u_base'), ...themeColor('--theme-nav-bg', FALLBACK_BASE));
      gl.uniform3f(gl.getUniformLocation(program, 'u_accent'), ...themeColor('--theme-accent', FALLBACK_ACCENT));
    } else {
      gl = null;
    }
  } catch {
    gl = null;
  }
  if (!gl) {
    canvas.remove();
    return null;
  }
  const ctx = gl;
  const loseExt = ctx.getExtension('WEBGL_lose_context');

  const reducedMQ = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let destroyed = false;
  let running = false;
  let raf = 0;
  let last = 0; // rAF timestamp of the last DRAWN frame; 0 = none since (re)start
  let clock = 0; // seconds of drift shown so far → u_time
  let onScreen = typeof IntersectionObserver === 'undefined'; // no IO → treat as visible
  let w = 0;
  let h = 0;

  const draw = () => {
    ctx.uniform1f(uTime, clock);
    ctx.drawArrays(ctx.TRIANGLES, 0, 3);
  };

  /** Match the backing store to the box; true when it changed (which also cleared it). */
  const size = (): boolean => {
    const next = backingSize(host.clientWidth, host.clientHeight, window.devicePixelRatio);
    if (next.w === w && next.h === h) return false;
    w = next.w;
    h = next.h;
    canvas.width = w;
    canvas.height = h;
    ctx.viewport(0, 0, w, h);
    ctx.uniform2f(uRes, w, h);
    return true;
  };

  const tick = (now: number) => {
    if (destroyed || !running) return;
    raf = requestAnimationFrame(tick);
    if (last && now - last < FRAME_MS) return;
    clock += last ? Math.min(now - last, MAX_STEP_MS) / 1000 : 0;
    last = now;
    draw();
  };

  const start = () => {
    if (destroyed || running || !onScreen || document.hidden || reducedMQ?.matches) return;
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
  draw(); // the first frame at t = 23 — all reduced motion ever shows, and the loop's starting picture
  start();

  // A resize clears the backing store; repaint at once rather than show the
  // cleared buffer until the next tick (or forever, when no loop runs).
  const ro =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (!destroyed && size()) draw();
        });
  ro?.observe(host);

  const io =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
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

  // Turning reduced motion on freezes the current frame (the canvas keeps
  // showing it); turning it off resumes.
  const onMotionPref = () => {
    if (reducedMQ?.matches) stop();
    else start();
  };
  reducedMQ?.addEventListener?.('change', onMotionPref);

  const onContextLost = () => {
    if (destroyed) return;
    stop();
    onLost();
  };
  canvas.addEventListener('webglcontextlost', onContextLost);

  return () => {
    destroyed = true;
    stop();
    ro?.disconnect();
    io?.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    reducedMQ?.removeEventListener?.('change', onMotionPref);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    // Hand the GPU context back now rather than whenever GC finds the canvas:
    // browsers cap live WebGL contexts and evict the oldest page's first.
    if (!ctx.isContextLost?.()) loseExt?.loseContext();
    canvas.remove();
  };
}

export default function CausticField({ className, getContext = defaultGetContext }: CausticFieldProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'webgl' | 'static'>('webgl');

  useEffect(() => {
    const host = hostRef.current;
    if (mode !== 'webgl' || !host) return;
    const teardown = mountField(host, getContext, () => setMode('static'));
    if (!teardown) {
      setMode('static');
      return;
    }
    return teardown;
    // getContext is deliberately NOT a dependency: it is a mount-time test
    // seam, the context is acquired once, and a new function identity must
    // not tear down and rebuild the field.
  }, [mode]);

  const cls = className ? `${styles.field} ${className}` : styles.field;
  return <div ref={hostRef} className={cls} aria-hidden="true" data-caustic={mode} />;
}
