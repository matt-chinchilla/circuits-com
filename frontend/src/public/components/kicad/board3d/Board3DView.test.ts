// @vitest-environment happy-dom
// The host's states, caption order and lifecycle (spec §5, §7). The scene comes
// from a mocked useBoardScene — the same shape viewerPage.test.ts uses for the 2D
// canvas — so nothing here builds geometry, and the renderer is a fake that just
// records what it was told.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardScene } from '@public/services/kicad/board3d/types';
import type { KicadProject } from '@public/services/kicad/types';
import { resetWebgl2ProbeForTests } from '../webgl';
import { VIEW_MODE_STORAGE_KEY, resetViewModeForTests } from './viewMode';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scene = (warnings: BoardScene['warnings'], withBody = true): BoardScene => ({
  bounds: { min: { x: -1, y: -1 }, max: { x: 1, y: 1 } }, thicknessMm: 1.6,
  groups: withBody ? [{ material: 'body', layerName: null, positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) }] : [],
  warnings, stats: { footprints: 2, pads: 4, vias: 1, tracks: 3, triangles: 1, buildMs: 12 },
});
const state = { status: 'ready', scene: scene([]), error: null as string | null, retry: vi.fn() };
vi.mock('./useBoardScene', () => ({ useBoardScene: () => state }));

import Board3DView from './Board3DView';

const project = { name: 'p', files: new Map(), board: 'b.kicad_pcb', sheets: [], root: null } as unknown as KicadProject;
function fakeRenderer() {
  const r = {
    mounted: 0, disposed: 0, views: [] as string[], flips: 0,
    highlights: [] as (string | null)[],
    modes: [] as string[],
    pick: null as ((ref: string | null) => void) | null,
    mount: async () => { r.mounted++; }, setView: (v: string) => { r.views.push(v); }, flip: () => { r.flips++; },
    pause: () => {}, resume: () => {}, dispose: () => { r.disposed++; }, info: () => ({ calls: 0, triangles: 0, pickMs: 0 }),
    highlight: (ref: string | null) => { r.highlights.push(ref); },
    setViewMode: (mode: string) => { r.modes.push(mode); },
    onPick: (h: ((ref: string | null) => void) | null) => { r.pick = h; },
  };
  return r;
}
function setWebgl(ok: boolean) { resetWebgl2ProbeForTests(); HTMLCanvasElement.prototype.getContext = (() => (ok ? { getExtension: () => null } : null)) as never; }

let root: Root, el: HTMLDivElement;
beforeEach(() => {
  el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); setWebgl(true);
  localStorage.clear(); resetViewModeForTests();
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('Board3DView', () => {
  it('mounts the renderer once ready and captions the estimate', async () => {
    const r = fakeRenderer();
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => r as never, quality: 'full' })); });
    expect(r.mounted).toBe(1);
    expect(el.querySelector('[role="note"]')?.textContent).toContain('Component bodies are estimates from courtyards, not part shapes.');
    expect(el.textContent).toContain('2 footprints');
  });
  it('publishes the measurement hook on the host after the first frame', async () => {
    const r = fakeRenderer();
    r.info = () => ({ calls: 7, triangles: 1234, pickMs: 0 });
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => r as never, quality: 'full' })); });
    const host = el.querySelector<HTMLElement>('[tabindex="0"]')!;
    expect(host.dataset.calls).toBe('7');
    expect(host.dataset.triangles).toBe('1234');
    expect(host.dataset.buildMs).toBe('12');
  });
  it('lists warnings in the fixed order', async () => {
    state.scene = scene([{ kind: 'zones-unfilled', count: 2 }, { kind: 'no-stackup' }, { kind: 'holes-merged', count: 3 }, { kind: 'no-courtyard', count: 1 }, { kind: 'holes-marked', count: 2 }], false);
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => fakeRenderer() as never, quality: 'full' })); });
    const note = el.querySelector('[role="note"]')!.textContent!;
    expect(note.indexOf('Layer thicknesses are not in this file')).toBeLessThan(note.indexOf('2 copper pours were saved unfilled'));
    expect(note).toContain('6 features simplified');
    expect(note).not.toContain('Component bodies');
    state.scene = scene([]);
  });
  it('toolbar drives the renderer and unmount disposes it', async () => {
    const r = fakeRenderer();
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => r as never, quality: 'full' })); });
    const byLabel = (t: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === t)!;
    act(() => { byLabel('Bottom').click(); byLabel('Flip').click(); byLabel('Reset').click(); });
    expect(r.views).toEqual(['bottom', 'reset']);
    expect(r.flips).toBe(1);
    act(() => root.unmount());
    expect(r.disposed).toBe(1);
    root = createRoot(el); // afterEach unmounts again harmlessly
  });
  it('lights the selected part once the renderer is live, follows changes, and reports picks', async () => {
    const r = fakeRenderer();
    const picked: (string | null)[] = [];
    const render = (selectedRef: string | null) =>
      root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => r as never, quality: 'full', selectedRef, onSelect: (ref: string | null) => picked.push(ref) }));
    await act(async () => { render('U30'); });
    // Applied on mount (the ref was set before the renderer existed), not lost.
    expect(r.highlights.at(-1)).toBe('U30');
    await act(async () => { render('C7'); });
    expect(r.highlights.at(-1)).toBe('C7');
    await act(async () => { render(null); });
    expect(r.highlights.at(-1)).toBeNull();
    act(() => { r.pick?.('R1'); r.pick?.(null); });
    expect(picked).toEqual(['R1', null]);
  });
  it('says a board with no outline has none, rather than that it did not close', async () => {
    state.scene = scene([{ kind: 'outline-open', segments: 0 }]);
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => fakeRenderer() as never, quality: 'full' })); });
    const note = el.querySelector('[role="note"]')!.textContent!;
    expect(note).toContain('This board has no outline yet');
    expect(note).not.toContain('did not close');
    state.scene = scene([]);
  });
  it('a reduced-tier board says its bodies are not drawn and that pads still answer', async () => {
    state.scene = scene([], false);
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => fakeRenderer() as never, quality: 'reduced' })); });
    expect(el.querySelector('[role="note"]')?.textContent).toContain('Component bodies are not drawn on this display. Select a pad');
    state.scene = scene([]);
  });
  it('shows the no-WebGL copy and never mounts', async () => {
    setWebgl(false);
    const r = fakeRenderer();
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => r as never })); });
    expect(el.textContent).toContain('This browser has WebGL disabled');
    expect(r.mounted).toBe(0);
  });
  it('a renderer that cannot start says so and Try again mounts a fresh one', async () => {
    const made: ReturnType<typeof fakeRenderer>[] = [];
    let fail = true;
    const create = () => {
      const r = fakeRenderer();
      const ok = r.mount;
      r.mount = async () => { await ok(); if (fail) throw new Error('no context'); };
      made.push(r);
      return r as never;
    };
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: create, quality: 'full' })); });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("Couldn't start the 3D view");
    // No live-looking controls over an empty box.
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Try again']);
    fail = false;
    await act(async () => { [...el.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!.click(); });
    expect(made).toHaveLength(2);
    expect(made[0].disposed).toBe(1);
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toContain('Flip');
    expect(state.retry).not.toHaveBeenCalled();
  });
  it('pauses while the canvas is scrolled off-screen and resumes when it returns', async () => {
    let callback: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
    let disconnected = 0;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: typeof callback) { callback = cb; }
      observe() {}
      disconnect() { disconnected++; }
    });
    const r = fakeRenderer();
    const calls: string[] = [];
    r.pause = () => { calls.push('pause'); };
    r.resume = () => { calls.push('resume'); };
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => r as never, quality: 'full' })); });
    act(() => { callback?.([{ isIntersecting: false }]); });
    act(() => { callback?.([{ isIntersecting: true }]); });
    expect(calls).toEqual(['pause', 'resume']);
    act(() => root.unmount());
    expect(disconnected).toBe(1);
    root = createRoot(el);
    vi.unstubAllGlobals();
  });
  it('error state offers Try again which calls retry', async () => {
    state.status = 'error'; state.error = 'That board file is truncated'; state.scene = null;
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => fakeRenderer() as never, quality: 'full' })); });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('truncated');
    act(() => { [...el.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!.click(); });
    expect(state.retry).toHaveBeenCalled();
    state.status = 'ready'; state.scene = scene([]); state.error = null;
  });
});

describe('Board3DView — the Board panel state (spec 2026-09-22 §2.4)', () => {
  function viewRenderer() {
    const r = fakeRenderer();
    const calls: unknown[][] = [];
    return Object.assign(r, {
      calls,
      setLayerVisible: (name: string, visible: boolean) => { calls.push(['setLayerVisible', name, visible]); },
      highlightLayer: (name: string | null) => { calls.push(['highlightLayer', name]); },
      setObjectOpacity: (kind: string, o: number) => { calls.push(['setObjectOpacity', kind, o]); },
      highlightNet: (net: number | null) => { calls.push(['highlightNet', net]); },
    });
  }
  type ViewProps = { hiddenLayers?: Set<string>; highlightedLayer?: string | null; opacity?: Record<string, number>; highlightedNet?: number | null };
  const renderWith = (r: object, view: ViewProps) =>
    root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => r as never, quality: 'full', ...view }));

  it('applies the whole state to the renderer on mount, 3D classes only', async () => {
    const r = viewRenderer();
    await act(async () => {
      renderWith(r, { hiddenLayers: new Set(['F.SilkS']), highlightedLayer: 'F.Cu', opacity: { tracks: 0.4, grid: 0.2, page: 0 }, highlightedNet: 5 });
    });
    expect(r.mounted).toBe(1);
    expect(r.calls).toEqual([
      ['setLayerVisible', 'F.SilkS', false],
      ['highlightLayer', 'F.Cu'],
      ['highlightNet', 5],
      ['setObjectOpacity', 'tracks', 0.4],
    ]);
  });

  it('on a change, tells the renderer only what changed', async () => {
    const r = viewRenderer();
    await act(async () => { renderWith(r, { hiddenLayers: new Set(['F.SilkS']), highlightedLayer: 'F.Cu', opacity: { tracks: 0.4 }, highlightedNet: 5 }); });
    r.calls.length = 0;
    await act(async () => { renderWith(r, { hiddenLayers: new Set(['B.Cu']), highlightedLayer: 'F.Cu', opacity: { mask: 0 }, highlightedNet: null }); });
    expect(r.calls).toEqual([
      ['setLayerVisible', 'B.Cu', false],
      ['setLayerVisible', 'F.SilkS', true],
      ['highlightNet', null],
      ['setObjectOpacity', 'tracks', 1],
      ['setObjectOpacity', 'mask', 0],
    ]);
    // A re-render with equal state (new objects, same contents) is silent.
    r.calls.length = 0;
    await act(async () => { renderWith(r, { hiddenLayers: new Set(['B.Cu']), highlightedLayer: 'F.Cu', opacity: { mask: 0 }, highlightedNet: null }); });
    expect(r.calls).toEqual([]);
    expect(r.mounted).toBe(1);
  });

  it('with no state given, only clears the highlights on mount', async () => {
    const r = viewRenderer();
    await act(async () => { renderWith(r, {}); });
    expect(r.calls).toEqual([['highlightLayer', null], ['highlightNet', null]]);
  });

  it('a fresh renderer (Try again) is given the whole state again', async () => {
    const made: ReturnType<typeof viewRenderer>[] = [];
    let fail = true;
    const create = () => {
      const r = viewRenderer();
      const ok = r.mount;
      r.mount = async () => { await ok(); if (fail) throw new Error('no context'); };
      made.push(r);
      return r as never;
    };
    const view = { hiddenLayers: new Set(['F.Mask']), highlightedLayer: null, opacity: {}, highlightedNet: null };
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: create, quality: 'full', ...view })); });
    fail = false;
    await act(async () => { [...el.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!.click(); });
    expect(made).toHaveLength(2);
    expect(made[1].calls).toContainEqual(['setLayerVisible', 'F.Mask', false]);
  });

  it('leaves a renderer without the optional members alone', async () => {
    const r = fakeRenderer();
    await act(async () => { renderWith(r, { hiddenLayers: new Set(['F.SilkS']), highlightedLayer: 'F.Cu', opacity: { tracks: 0.4 }, highlightedNet: 5 }); });
    await act(async () => { renderWith(r, { hiddenLayers: new Set(), highlightedLayer: null, opacity: {}, highlightedNet: 2 }); });
    expect(r.mounted).toBe(1);
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('Board3DView — the View toggle (Solid / See-through / X-ray)', () => {
  const mount = (r: object, quality: 'full' | 'reduced' = 'full') =>
    act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => r as never, quality })); });
  const viewGroup = () => el.querySelector('[role="group"][aria-labelledby]')!;
  const buttons = () => [...viewGroup().querySelectorAll('button')];

  it('offers the three states under a visible "View" label, pressed per the stored choice', async () => {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, 'see-through');
    const r = fakeRenderer();
    await mount(r);
    expect(buttons().map((b) => b.textContent)).toEqual(['Solid', 'See-through', 'X-ray']);
    expect(document.getElementById(viewGroup().getAttribute('aria-labelledby')!)?.textContent).toBe('View');
    expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    // Every button says what it does, for a mouse reader who pauses on it.
    for (const b of buttons()) expect(b.getAttribute('title')?.length).toBeGreaterThan(10);
  });
  it('tells the renderer the stored mode before the first frame, and every change after', async () => {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, 'see-through');
    const r = fakeRenderer();
    await mount(r);
    expect(r.modes[0]).toBe('see-through');
    expect(new Set(r.modes)).toEqual(new Set(['see-through']));
    await act(async () => { buttons()[2].click(); });
    expect(r.modes.at(-1)).toBe('xray');
    expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
    expect(localStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe('xray');
  });
  it('remembers the choice for the next visit', async () => {
    const r1 = fakeRenderer();
    await mount(r1);
    await act(async () => { buttons()[1].click(); });
    act(() => root.unmount());
    root = createRoot(el);
    resetViewModeForTests();
    const r2 = fakeRenderer();
    await mount(r2);
    expect(r2.modes[0]).toBe('see-through');
    expect(buttons()[1].getAttribute('aria-pressed')).toBe('true');
  });
  it('on the reduced tier the toggle is still offered and the caption says what is left for it to do', async () => {
    state.scene = scene([], false);
    const r = fakeRenderer();
    await mount(r, 'reduced');
    expect(buttons()).toHaveLength(3);
    expect(el.querySelector('[role="note"]')?.textContent).toContain('See-through and X-ray fade the solder mask only.');
    state.scene = scene([]);
  });
  it('a renderer without the member is simply not asked', async () => {
    const r = fakeRenderer() as Partial<ReturnType<typeof fakeRenderer>>;
    delete r.setViewMode;
    await mount(r);
    await act(async () => { buttons()[2].click(); });
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(buttons()[2].getAttribute('aria-pressed')).toBe('true');
  });
});

// Class names are echoed back by vitest's CSS-off module proxy, so they prove
// nothing about the stylesheet. This one reads the SOURCE: the canvas has no
// content of its own, so without a reserved height the 3D tab is a 0px box.
describe('the stylesheet the frame depends on', () => {
  const scss = readFileSync(join(__dirname, 'Board3DView.module.scss'), 'utf8');
  it('reserves a real height on desktop and a shorter one on a phone', () => {
    expect(scss).toMatch(/\.wrap \{[^{}]*min-height:\s*420px/);
    expect(scss).toMatch(/min-height:\s*300px/);
  });
  it('keeps the caption at AA and the canvas focus ring on the dark canvas', () => {
    expect(scss).toMatch(/\$footer-ink:\s*#676c71/);
    expect(scss).toMatch(/\.caption \{[^{}]*color:\s*\$footer-ink/);
    expect(scss).toMatch(/\.stats \{[^{}]*color:\s*\$footer-ink/);
    expect(scss).toMatch(/\.canvasHost \{[\s\S]*?&:focus-visible \{[^{}]*outline-offset:\s*-3px/);
  });
  it('gives the canvas host its own paintable box', () => {
    expect(scss).toMatch(/\.canvasHost \{[^{}]*flex:\s*1 1 auto/);
    expect(scss).toMatch(/\.canvasHost \{[^{}]*min-height:\s*0/);
  });
  it('lays the two toolbar tracks at the two ends of one wrapping row', () => {
    expect(scss).toMatch(/\.toolbar \{[^{}]*flex-wrap:\s*wrap/);
    expect(scss).toMatch(/\.toolbar \{[^{}]*justify-content:\s*space-between/);
    expect(scss).toMatch(/\.track \{[^{}]*border-radius:\s*13px/);
  });
});
