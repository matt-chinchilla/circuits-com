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
  const r = { mounted: 0, disposed: 0, views: [] as string[], flips: 0, mount: async () => { r.mounted++; }, setView: (v: string) => { r.views.push(v); }, flip: () => { r.flips++; }, pause: () => {}, resume: () => {}, dispose: () => { r.disposed++; }, info: () => ({ calls: 0, triangles: 0 }) };
  return r;
}
function setWebgl(ok: boolean) { resetWebgl2ProbeForTests(); HTMLCanvasElement.prototype.getContext = (() => (ok ? { getExtension: () => null } : null)) as never; }

let root: Root, el: HTMLDivElement;
beforeEach(() => { el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); setWebgl(true); });
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
    r.info = () => ({ calls: 7, triangles: 1234 });
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => r as never, quality: 'full' })); });
    const host = el.querySelector<HTMLElement>('[tabindex="0"]')!;
    expect(host.dataset.calls).toBe('7');
    expect(host.dataset.triangles).toBe('1234');
    expect(host.dataset.buildMs).toBe('12');
  });
  it('lists warnings in the fixed order', async () => {
    state.scene = scene([{ kind: 'zones-unfilled', count: 2 }, { kind: 'no-stackup' }, { kind: 'holes-merged', count: 3 }, { kind: 'no-courtyard', count: 1 }], false);
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => fakeRenderer() as never, quality: 'full' })); });
    const note = el.querySelector('[role="note"]')!.textContent!;
    expect(note.indexOf('Layer thicknesses are not in this file')).toBeLessThan(note.indexOf('2 copper pours were saved unfilled'));
    expect(note).toContain('4 features simplified');
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
  it('shows the no-WebGL copy and never mounts', async () => {
    setWebgl(false);
    const r = fakeRenderer();
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => r as never })); });
    expect(el.textContent).toContain('This browser has WebGL disabled');
    expect(r.mounted).toBe(0);
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

// Class names are echoed back by vitest's CSS-off module proxy, so they prove
// nothing about the stylesheet. This one reads the SOURCE: the canvas has no
// content of its own, so without a reserved height the 3D tab is a 0px box.
describe('the stylesheet the frame depends on', () => {
  const scss = readFileSync(join(__dirname, 'Board3DView.module.scss'), 'utf8');
  it('reserves a real height on desktop and a shorter one on a phone', () => {
    expect(scss).toMatch(/\.wrap \{[^{}]*min-height:\s*420px/);
    expect(scss).toMatch(/min-height:\s*300px/);
  });
  it('gives the canvas host its own paintable box', () => {
    expect(scss).toMatch(/\.canvasHost \{[^{}]*flex:\s*1 1 auto/);
    expect(scss).toMatch(/\.canvasHost \{[^{}]*min-height:\s*0/);
  });
});
