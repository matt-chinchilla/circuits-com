// @vitest-environment happy-dom
// The Board panel's controls on the REAL renderer (spec 2026-09-22 §2.2): layer
// visibility, per-class opacity and the layer / net highlights, read straight
// off the three.js meshes the renderer builds. Only the WebGL renderer is faked
// (happy-dom has no GPU), exactly as in sceneRenderer.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardScene, MeshGroup } from '@public/services/kicad/board3d/types';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    domElement = document.createElement('canvas');
    info = { render: { calls: 1, triangles: 2 } };
    setPixelRatio() {}
    setSize() {}
    render() {}
    forceContextLoss() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import * as THREE from 'three';
import { MATERIALS } from './board3dTheme';
import { createSceneRenderer, type SceneRenderer } from './sceneRenderer';

/** Six triangles (18 indices) over one quad: enough for three class ranges. */
function group(material: MeshGroup['material'], layerName: string | null, extra: Record<string, unknown> = {}): MeshGroup {
  const quad = [0, 1, 2, 0, 2, 3];
  return {
    material, layerName,
    positions: new Float32Array([-10, -5, 0, 10, -5, 0, 10, 5, 0, -10, 5, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([...quad, ...quad, ...quad]),
    ...extra,
  } as MeshGroup;
}

// The copper as buildScene lays it out: pads first (triangles 0–1), then
// tracks (2–3), then zones (4–5). Class and net ranges count TRIANGLES.
const copper = () => group('copper', 'F.Cu', {
  parts: [{ ref: 'R1', start: 0, count: 6 }],
  classes: [{ kind: 'pads', start: 0, count: 2 }, { kind: 'tracks', start: 2, count: 2 }, { kind: 'zones', start: 4, count: 2 }],
  nets: [{ net: 7, start: 1, count: 2 }, { net: 3, start: 3, count: 3 }],
});

const board = (): BoardScene => ({
  bounds: { min: { x: -10, y: -5 }, max: { x: 10, y: 5 } }, thicknessMm: 1.6,
  groups: [
    group('substrate', null), group('hole-wall', null), copper(), group('mask', 'F.Mask'),
    group('hole-wall', 'F.Marks'), group('silk', 'F.SilkS'), group('body', null, { parts: [{ ref: 'R1', start: 0, count: 18 }] }),
  ],
  warnings: [], stats: { footprints: 1, pads: 2, vias: 0, tracks: 1, triangles: 42, buildMs: 1 },
});

type Mesh = InstanceType<typeof THREE.Mesh>;
type StdMat = InstanceType<typeof THREE.MeshStandardMaterial>;
let meshes: Mesh[] = [];
let host: HTMLDivElement;
let r: SceneRenderer;

const byName = (name: string): Mesh => {
  const m = meshes.find((x) => x.name === name);
  if (m == null) throw new Error(`no mesh ${name}`);
  return m;
};
const mats = (m: Mesh) => m.material as StdMat[];
const groups = (m: Mesh) => m.geometry.groups.map((g) => [g.start, g.count, g.materialIndex]);

beforeEach(() => {
  meshes = [];
  const add = THREE.Group.prototype.add;
  vi.spyOn(THREE.Group.prototype, 'add').mockImplementation(function (this: InstanceType<typeof THREE.Group>, ...objects) {
    for (const o of objects) if (o instanceof THREE.Mesh) meshes.push(o);
    return add.apply(this, objects);
  });
  vi.stubGlobal('requestAnimationFrame', () => 1);
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

async function mounted(): Promise<SceneRenderer> {
  r = createSceneRenderer({ reducedMotion: true });
  await r.mount(host, board(), 'full');
  return r;
}

describe('the copper draws each class in its own material', () => {
  it('one clone of the copper per class, yet an untouched layer is ONE draw group', async () => {
    await mounted();
    const cu = byName('copper/F.Cu');
    // [own, highlight, tracks, pads, zones]
    expect(mats(cu)).toHaveLength(5);
    expect(groups(cu)).toEqual([[0, 18, 0]]);
  });

  it('fades one class without touching the others, and 0 stops drawing it', async () => {
    await mounted();
    const cu = byName('copper/F.Cu');
    r.setObjectOpacity?.('tracks', 0.5);
    const tracks = mats(cu)[2];
    expect(tracks.opacity).toBeCloseTo(0.5);
    expect(tracks.transparent).toBe(true);
    expect(tracks.depthWrite).toBe(false);
    expect(mats(cu)[3].opacity).toBe(1);
    // Only the faded class draws in its own material.
    expect(groups(cu)).toEqual([[0, 6, 0], [6, 6, 2], [12, 6, 0]]);

    r.setObjectOpacity?.('tracks', 0);
    expect(tracks.visible).toBe(false);
    expect(groups(cu)).toEqual([[0, 6, 0], [12, 6, 0]]);

    r.setObjectOpacity?.('tracks', 1);
    expect(tracks.visible).toBe(true);
    expect(tracks.transparent).toBe(false);
    expect(tracks.depthWrite).toBe(true);
    expect(groups(cu)).toEqual([[0, 18, 0]]);
  });

  it('fades whole materials for bodies, silk, mask and vias', async () => {
    await mounted();
    r.setObjectOpacity?.('bodies', 0.5);
    expect(mats(byName('body/'))[0].opacity).toBeCloseTo(MATERIALS.body.opacity * 0.5);
    r.setObjectOpacity?.('mask', 0.25);
    expect(mats(byName('mask/F.Mask'))[0].opacity).toBeCloseTo(0.25);
    expect(mats(byName('mask/F.Mask'))[0].transparent).toBe(true);
    r.setObjectOpacity?.('silk', 0);
    expect(byName('silk/F.SilkS').visible).toBe(false);
    r.setObjectOpacity?.('vias', 0);
    expect(byName('hole-wall/').visible).toBe(false);
    expect(byName('hole-wall/F.Marks').visible).toBe(false);
    expect(byName('substrate/').visible).toBe(true);
  });
});

describe('layers', () => {
  it('hides every group on a layer and shows it again', async () => {
    await mounted();
    r.setLayerVisible?.('F.Cu', false);
    expect(byName('copper/F.Cu').visible).toBe(false);
    expect(byName('mask/F.Mask').visible).toBe(true);
    r.setLayerVisible?.('F.Cu', true);
    expect(byName('copper/F.Cu').visible).toBe(true);
  });

  it('never hides the substrate or the hole walls', async () => {
    await mounted();
    r.setLayerVisible?.('F.Marks', false);
    expect(byName('hole-wall/F.Marks').visible).toBe(true);
  });

  it('a highlighted layer draws whole in the highlight material; null clears', async () => {
    await mounted();
    r.highlightLayer?.('F.Mask');
    expect(groups(byName('mask/F.Mask'))).toEqual([[0, 18, 1]]);
    expect(groups(byName('copper/F.Cu'))).toEqual([[0, 18, 0]]);
    r.highlightLayer?.(null);
    expect(groups(byName('mask/F.Mask'))).toEqual([[0, 18, 0]]);
  });

  it('a hidden class stays hidden under a layer highlight', async () => {
    await mounted();
    r.setObjectOpacity?.('zones', 0);
    r.highlightLayer?.('F.Cu');
    expect(groups(byName('copper/F.Cu'))).toEqual([[0, 12, 1]]);
  });
});

describe('nets', () => {
  it("lights the net's copper through its ranges, across class boundaries", async () => {
    await mounted();
    r.highlightNet?.(7);
    // Net 7 is triangles 1–2: indices [3, 9), half a pad and half a track.
    expect(groups(byName('copper/F.Cu'))).toEqual([[0, 3, 0], [3, 6, 1], [9, 9, 0]]);
    r.highlightNet?.(null);
    expect(groups(byName('copper/F.Cu'))).toEqual([[0, 18, 0]]);
  });

  it('net 0 ("no net") lights nothing', async () => {
    await mounted();
    r.highlightNet?.(0);
    expect(groups(byName('copper/F.Cu'))).toEqual([[0, 18, 0]]);
  });

  it('a part highlight and a net highlight share the one slicing', async () => {
    await mounted();
    r.highlight?.('R1');
    r.highlightNet?.(3);
    // R1's pads are indices [0, 6); net 3 is triangles 3–5, indices [9, 18).
    expect(groups(byName('copper/F.Cu'))).toEqual([[0, 6, 1], [6, 3, 0], [9, 9, 1]]);
    expect(groups(byName('body/'))).toEqual([[0, 18, 1]]);
  });
});

describe('state set before the meshes exist', () => {
  it('is applied at mount, before the first frame', async () => {
    r = createSceneRenderer({ reducedMotion: true });
    r.setLayerVisible?.('F.SilkS', false);
    r.setObjectOpacity?.('pads', 0);
    r.highlightNet?.(7);
    await r.mount(host, board(), 'full');
    expect(byName('silk/F.SilkS').visible).toBe(false);
    expect(groups(byName('copper/F.Cu'))).toEqual([[6, 3, 1], [9, 9, 0]]);
  });
});

describe('dispose', () => {
  it('releases every material it made, the per-class clones included', async () => {
    const idle: (() => void)[] = [];
    (window as unknown as { requestIdleCallback: (fn: () => void) => number }).requestIdleCallback = (fn) => { idle.push(fn); return idle.length; };
    await mounted();
    const all = new Set(meshes.flatMap((m) => mats(m)));
    // own + highlight + 3 classes on the copper; own + highlight on everything a layer names or a part owns.
    expect(all.size).toBe(1 + 1 + 5 + 2 + 2 + 2 + 2);
    const spies = [...all].map((m) => vi.spyOn(m, 'dispose'));
    r.dispose();
    for (const fn of idle) fn();
    expect(spies.every((s) => s.mock.calls.length === 1)).toBe(true);
    delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
  });
});
