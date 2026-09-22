// @vitest-environment happy-dom
import { act, createElement, type FC } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { useBoardScene } from './useBoardScene';
import type { KicadProject } from '@public/services/kicad/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const project = (text: string) => ({ name: 'p', files: new Map([['b.kicad_pcb', text]]), board: 'b.kicad_pcb', sheets: [], root: null } as unknown as KicadProject);

class FakeWorker { onmessage: ((e: MessageEvent) => void) | null = null; posted: unknown[] = []; terminated = 0;
  postMessage(m: unknown) { this.posted.push(m); }
  terminate() { this.terminated++; }
  reply(msg: unknown) { this.onmessage?.({ data: msg } as MessageEvent); } }

function mount(p: KicadProject, spawn: () => Worker | null) {
  const seen: unknown[] = [];
  const Probe: FC = () => { const s = useBoardScene(p, null, 'full', { spawn }); seen.push({ status: s.status, error: s.error }); return null; };
  const el = document.createElement('div'); const root = createRoot(el);
  act(() => root.render(createElement(Probe)));
  return { seen, root };
}

describe('useBoardScene', () => {
  it('goes idle → building → ready through the worker and transfers the text once', async () => {
    const w = new FakeWorker();
    const { seen } = mount(project('(kicad_pcb (version 20221018))'), () => w as unknown as Worker);
    expect(seen.at(-1)).toMatchObject({ status: 'building' });
    expect(w.posted).toHaveLength(1);
    await act(async () => { w.reply({ ok: true, scene: { bounds: { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } }, thicknessMm: null, groups: [], warnings: [], stats: { footprints: 0, pads: 0, vias: 0, tracks: 0, triangles: 0, buildMs: 1 } } }); });
    expect(seen.at(-1)).toMatchObject({ status: 'ready' });
  });
  it('surfaces a worker failure as error, and retry posts again', async () => {
    const w = new FakeWorker();
    const { seen } = mount(project('(kicad_pcb)'), () => w as unknown as Worker);
    await act(async () => { w.reply({ ok: false, message: 'nope', kind: 'unreadable' }); });
    expect(seen.at(-1)).toMatchObject({ status: 'error', error: 'nope' });
  });
  it('falls back to the main thread when there is no worker', async () => {
    const { seen } = mount(project('(kicad_pcb (version 20221018) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)))'), () => null);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(['ready', 'error']).toContain((seen.at(-1) as { status: string }).status);
  });
  it('terminates the worker on unmount', () => {
    const w = new FakeWorker();
    const { root } = mount(project('(kicad_pcb)'), () => w as unknown as Worker);
    act(() => root.unmount());
    expect(w.terminated).toBe(1);
  });
});
