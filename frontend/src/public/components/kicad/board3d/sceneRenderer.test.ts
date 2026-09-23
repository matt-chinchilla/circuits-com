// @vitest-environment happy-dom
// The render loop and the pick against the REAL three.js and the REAL
// OrbitControls; only the WebGL renderer is faked (happy-dom has no GPU) and
// requestAnimationFrame runs off a manual queue, so a test can count exactly
// how many ticks each frame queues.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardScene } from '@public/services/kicad/board3d/types';

const renders = { count: 0 };
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    domElement: HTMLCanvasElement;
    info = { render: { calls: 1, triangles: 2 } };
    constructor() {
      this.domElement = document.createElement('canvas');
      this.domElement.setPointerCapture = () => {};
      this.domElement.releasePointerCapture = () => {};
      // OrbitControls divides a drag by the element's height; happy-dom lays
      // nothing out, and a zero here turns the camera into NaNs.
      Object.defineProperty(this.domElement, 'clientWidth', { value: 400 });
      Object.defineProperty(this.domElement, 'clientHeight', { value: 300 });
      this.domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) });
    }
    setPixelRatio() {}
    setSize() {}
    render() { renders.count++; }
    forceContextLoss() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import * as THREE from 'three';
import { HOVER_DELAY_MS, createSceneRenderer, type SceneRenderer } from './sceneRenderer';

let queue: ((now: number) => void)[] = [];
let clock = 0;
function frame(): number {
  clock += 16;
  vi.spyOn(performance, 'now').mockReturnValue(clock);
  const due = queue;
  queue = [];
  for (const fn of due) fn(clock);
  return due.length;
}

/** A 20 × 10 board of two triangles: substrate only, nothing pickable. */
const board = (): BoardScene => ({
  bounds: { min: { x: -10, y: -5 }, max: { x: 10, y: 5 } }, thicknessMm: 1.6,
  groups: [{
    material: 'substrate', layerName: null,
    positions: new Float32Array([-10, -5, 0, 10, -5, 0, 10, 5, 0, -10, 5, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  }],
  warnings: [], stats: { footprints: 0, pads: 0, vias: 0, tracks: 0, triangles: 2, buildMs: 1, bodiesFromFab: 0 },
});

let host: HTMLDivElement;
let r: SceneRenderer;
beforeEach(() => {
  queue = [];
  clock = 1000;
  renders.count = 0;
  vi.spyOn(performance, 'now').mockReturnValue(clock);
  vi.stubGlobal('requestAnimationFrame', (fn: (now: number) => void) => { queue.push(fn); return queue.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: 400 });
  Object.defineProperty(host, 'clientHeight', { value: 300 });
  document.body.appendChild(host);
});
afterEach(() => {
  r?.dispose();
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const canvas = () => host.querySelector('canvas')!;
const pointer = (target: EventTarget, type: string, x: number, y: number, pointerType = 'mouse') =>
  target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType, button: 0, buttons: 1, bubbles: true }));

describe('the render loop keeps ONE frame in flight', () => {
  it('during the auto-orbit', async () => {
    r = createSceneRenderer({ reducedMotion: false });
    await r.mount(host, board(), 'full');
    const perFrame = Array.from({ length: 60 }, frame);
    expect(Math.max(...perFrame)).toBe(1);
    expect(perFrame.every((n) => n === 1)).toBe(true);
  });

  it('during a drag and the damping after it', async () => {
    r = createSceneRenderer({ reducedMotion: false });
    await r.mount(host, board(), 'full');
    frame();
    pointer(canvas(), 'pointerdown', 100, 100);
    const perFrame: number[] = [];
    for (let i = 1; i <= 60; i++) {
      pointer(document, 'pointermove', 100 + i * 3, 100 + i);
      perFrame.push(frame());
    }
    pointer(document, 'pointerup', 280, 160);
    for (let i = 0; i < 60; i++) perFrame.push(frame());
    expect(Math.max(...perFrame)).toBe(1);
    // …and it does settle: once damping and the settle window are spent, the
    // queue empties rather than drawing a static board forever.
    for (let i = 0; i < 200; i++) frame();
    expect(queue.length).toBe(0);
  });
});

describe('reduced motion', () => {
  it('does not orbit on load', async () => {
    r = createSceneRenderer({ reducedMotion: true });
    await r.mount(host, board(), 'full');
    for (let i = 0; i < 80; i++) frame();
    expect(queue.length).toBe(0);
  });

  it('flips in one frame instead of turning', async () => {
    r = createSceneRenderer({ reducedMotion: true });
    await r.mount(host, board(), 'full');
    for (let i = 0; i < 80; i++) frame();
    const before = renders.count;
    r.flip();
    frame();
    const after = renders.count;
    expect(after).toBe(before + 1);
  });
});

describe('the pick', () => {
  it('casts once for a mouse click on bare board, five times for a touch', async () => {
    r = createSceneRenderer({ reducedMotion: true });
    await r.mount(host, board(), 'full');
    const picks: (string | null)[] = [];
    r.onPick?.((ref) => picks.push(ref));
    const cast = vi.spyOn(THREE.Raycaster.prototype, 'intersectObjects');
    pointer(canvas(), 'pointerdown', 200, 150);
    pointer(canvas(), 'pointerup', 200, 150);
    expect(cast).toHaveBeenCalledTimes(1);
    cast.mockClear();
    pointer(canvas(), 'pointerdown', 200, 150, 'touch');
    pointer(canvas(), 'pointerup', 200, 150, 'touch');
    expect(cast).toHaveBeenCalledTimes(5);
    expect(picks).toEqual([null, null]);
  });
});

describe('the hover (mouse only, after a pause)', () => {
  it('casts once per pause, never per move, and never wakes the loop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      r = createSceneRenderer({ reducedMotion: true });
      await r.mount(host, board(), 'full');
      // The mount's own first tick and the settle window after it, drained:
      // with reduced motion nothing is moving, so the loop sleeps here.
      for (let i = 0; i < 80; i++) frame();
      expect(queue).toHaveLength(0);
      const hits: unknown[] = [];
      r.onHover?.((hit) => hits.push(hit));
      const cast = vi.spyOn(THREE.Raycaster.prototype, 'intersectObjects');
      const before = renders.count;
      for (let i = 0; i < 6; i++) pointer(canvas(), 'pointermove', 100 + i, 100);
      expect(cast).not.toHaveBeenCalled();
      vi.advanceTimersByTime(HOVER_DELAY_MS - 1);
      expect(cast).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(cast).toHaveBeenCalledTimes(1);
      // Nothing pickable on this board, and nothing was hovered before: no call.
      expect(hits).toEqual([]);
      // The loop stayed asleep: no frame drawn, none queued.
      expect(renders.count).toBe(before);
      expect(queue).toHaveLength(0);
      // Touch and pen never hover.
      pointer(canvas(), 'pointermove', 120, 100, 'touch');
      vi.advanceTimersByTime(HOVER_DELAY_MS);
      expect(cast).toHaveBeenCalledTimes(1);
      // A press cancels a pending hover.
      pointer(canvas(), 'pointermove', 130, 100);
      pointer(canvas(), 'pointerdown', 130, 100);
      vi.advanceTimersByTime(HOVER_DELAY_MS);
      expect(cast).toHaveBeenCalledTimes(1);
      pointer(canvas(), 'pointerup', 130, 100);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the label anchor', () => {
  it('is projected onto the canvas, faces the camera from above and hides from below', async () => {
    r = createSceneRenderer({ reducedMotion: true });
    await r.mount(host, board(), 'full');
    const seen: ({ x: number; y: number; visible: boolean } | null)[] = [];
    r.onAnchorMove?.((at) => seen.push(at));
    // No anchor yet: told so once.
    expect(seen).toEqual([null]);
    r.setAnchor?.({ x: 0, y: 0, z: 0, side: 'F', body: false });
    const top = seen.at(-1)!;
    expect(top).not.toBeNull();
    expect(top!.visible).toBe(true);
    // The origin, framed: near the middle of a 400×300 canvas.
    expect(top!.x).toBeGreaterThan(100);
    expect(top!.x).toBeLessThan(300);
    expect(top!.y).toBeGreaterThan(50);
    expect(top!.y).toBeLessThan(250);
    // The same point on the BACK face is hidden from a camera above the board.
    r.setAnchor?.({ x: 0, y: 0, z: 0, side: 'B', body: false });
    expect(seen.at(-1)!.visible).toBe(false);
    // Looking from below, the back face shows and the front hides.
    r.setView('bottom');
    frame();
    expect(seen.at(-1)!.visible).toBe(true);
    r.setAnchor?.({ x: 0, y: 0, z: 0, side: 'F', body: false });
    expect(seen.at(-1)!.visible).toBe(false);
    // Cleared: told null.
    r.setAnchor?.(null);
    expect(seen.at(-1)).toBeNull();
  });
  it('is re-projected after every frame the camera moves on', async () => {
    r = createSceneRenderer({ reducedMotion: true });
    await r.mount(host, board(), 'full');
    r.setAnchor?.({ x: 5, y: 0, z: 0, side: 'F', body: false });
    const seen: unknown[] = [];
    r.onAnchorMove?.((at) => seen.push(at));
    const n = seen.length;
    r.orbit?.(30, 0);
    frame();
    expect(seen.length).toBeGreaterThan(n);
  });
});
