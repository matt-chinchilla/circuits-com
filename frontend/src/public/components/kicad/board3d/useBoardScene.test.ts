// @vitest-environment happy-dom
import { act, createElement, type FC } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILD_TIMEOUT_MS, TOO_LARGE, useBoardScene } from './useBoardScene';
import type { KicadProject } from '@public/services/kicad/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const project = (text: string) => ({ name: 'p', files: new Map([['b.kicad_pcb', text]]), board: 'b.kicad_pcb', sheets: [], root: null } as unknown as KicadProject);

class FakeWorker { onmessage: ((e: MessageEvent) => void) | null = null; posted: unknown[] = []; terminated = 0;
  postMessage(m: unknown) { this.posted.push(m); }
  terminate() { this.terminated++; }
  reply(msg: unknown) { this.onmessage?.({ data: msg } as MessageEvent); } }

function mount(p: KicadProject, spawn: () => Worker | null) {
  const seen: unknown[] = [];
  const api: { retry: () => void } = { retry: () => {} };
  const Probe: FC = () => { const s = useBoardScene(p, null, 'full', { spawn }); api.retry = s.retry; seen.push({ status: s.status, error: s.error }); return null; };
  const el = document.createElement('div'); const root = createRoot(el);
  act(() => root.render(createElement(Probe)));
  return { seen, root, api };
}

afterEach(() => { vi.useRealTimers(); });

describe('useBoardScene', () => {
  it('goes idle → building → ready through the worker and transfers the text once', async () => {
    const w = new FakeWorker();
    const { seen } = mount(project('(kicad_pcb (version 20221018))'), () => w as unknown as Worker);
    expect(seen.at(-1)).toMatchObject({ status: 'building' });
    expect(w.posted).toHaveLength(1);
    await act(async () => { w.reply({ ok: true, scene: { bounds: { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } }, thicknessMm: null, groups: [], warnings: [], stats: { footprints: 0, pads: 0, vias: 0, tracks: 0, triangles: 0, buildMs: 1, bodiesFromFab: 0 } } }); });
    expect(seen.at(-1)).toMatchObject({ status: 'ready' });
  });
  it('surfaces a worker failure as error, and retry builds again in a fresh worker', async () => {
    const workers: FakeWorker[] = [];
    const { seen, api } = mount(project('(kicad_pcb)'), () => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker; });
    await act(async () => { workers[0].reply({ ok: false, message: 'nope', kind: 'unreadable' }); });
    expect(seen.at(-1)).toMatchObject({ status: 'error', error: 'nope' });
    // The failure was NOT cached: Try again spawns and posts, and goes back
    // through building rather than re-serving the old rejection.
    await act(async () => { api.retry(); });
    expect(workers).toHaveLength(2);
    expect(workers[1].posted).toHaveLength(1);
    expect(seen.at(-1)).toMatchObject({ status: 'building' });
    await act(async () => { workers[1].reply({ ok: true, scene: { bounds: { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } }, thicknessMm: null, groups: [], warnings: [], stats: { footprints: 0, pads: 0, vias: 0, tracks: 0, triangles: 0, buildMs: 1, bodiesFromFab: 0 } } }); });
    expect(seen.at(-1)).toMatchObject({ status: 'ready' });
  });
  it('falls back to the main thread when there is no worker, and builds a real board', async () => {
    const board = [
      '(kicad_pcb (version 20221018) (generator pcbnew)',
      '(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (38 "B.Mask" user) (39 "F.Mask" user) (44 "Edge.Cuts" user))',
      '(gr_rect (start 0 0) (end 10 10) (layer "Edge.Cuts") (width 0.1))',
      '(via (at 5 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu"))',
      ')',
    ].join('\n');
    const { seen } = mount(project(board), () => null);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(seen.at(-1)).toMatchObject({ status: 'ready', error: null });
  });
  it('stops a build that runs past the watchdog and says the board is too large', async () => {
    vi.useFakeTimers();
    const w = new FakeWorker();
    const { seen } = mount(project('(kicad_pcb)'), () => w as unknown as Worker);
    await act(async () => { vi.advanceTimersByTime(BUILD_TIMEOUT_MS + 1); });
    expect(w.terminated).toBe(1);
    expect(seen.at(-1)).toMatchObject({ status: 'error', error: TOO_LARGE });
  });
  it('terminates the worker on unmount', () => {
    const w = new FakeWorker();
    const { root } = mount(project('(kicad_pcb)'), () => w as unknown as Worker);
    act(() => root.unmount());
    expect(w.terminated).toBe(1);
  });
});
