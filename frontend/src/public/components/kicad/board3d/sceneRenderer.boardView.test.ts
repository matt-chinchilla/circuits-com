// @vitest-environment happy-dom
// The Board panel's controls on the REAL renderer (spec 2026-09-22 §2.2): layer
// visibility, per-class opacity and the layer / net highlights, read straight
// off the three.js meshes the renderer builds. Only the WebGL renderer is faked
// (happy-dom has no GPU), exactly as in sceneRenderer.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardScene, MeshGroup } from '@public/services/kicad/board3d/types';

/** What the fake PMREM generator hands out, so the test can see it released. */
const envTexture = { disposed: 0, dispose() { envTexture.disposed++; }, isTexture: true };
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
  // The real generator renders the room through the (fake) renderer; this one
  // just answers with a texture the test can watch.
  class FakePMREMGenerator {
    disposed = 0;
    fromScene() { return { texture: envTexture }; }
    dispose() { this.disposed++; }
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer, PMREMGenerator: FakePMREMGenerator };
});

import * as THREE from 'three';
import { BODY_EDGE, BODY_OPAQUE, ENVIRONMENT, FAMILY_TINTS, HIGHLIGHT_MATERIALS, MATERIALS, VIEW_MODE_LOOK, shade } from './board3dTheme';
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

// The copper as buildScene lays it out: pads first (indices [0, 6)), then
// tracks [6, 12), then zones [12, 18). Part, class and net ranges all count
// INDICES, offsets into the group's `indices`.
const copper = () => group('copper', 'F.Cu', {
  parts: [{ ref: 'R1', start: 0, count: 6 }],
  classes: [{ kind: 'pads', start: 0, count: 6 }, { kind: 'tracks', start: 6, count: 6 }, { kind: 'zones', start: 12, count: 6 }],
  nets: [{ net: 7, start: 3, count: 6 }, { net: 3, start: 9, count: 9 }],
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
let lines: InstanceType<typeof THREE.LineSegments>[] = [];
let sceneRef: InstanceType<typeof THREE.Scene> | null = null;
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
  lines = [];
  sceneRef = null;
  envTexture.disposed = 0;
  const add = THREE.Group.prototype.add;
  vi.spyOn(THREE.Group.prototype, 'add').mockImplementation(function (this: InstanceType<typeof THREE.Group>, ...objects) {
    for (const o of objects) {
      if (o instanceof THREE.Mesh) meshes.push(o);
      else if (o instanceof THREE.LineSegments) lines.push(o);
    }
    return add.apply(this, objects);
  });
  // Scene inherits `add` from Object3D, not Group, so the spy above never sees
  // it: an own method on Scene's prototype catches the model being added.
  THREE.Scene.prototype.add = function (this: InstanceType<typeof THREE.Scene>, ...objects) {
    sceneRef = this;
    return THREE.Object3D.prototype.add.apply(this, objects);
  };
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
  delete (THREE.Scene.prototype as { add?: unknown }).add;
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
    // Net 7 is indices [3, 9): half a pad and half a track.
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
    // R1's pads are indices [0, 6); net 3 is [9, 18).
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

describe('the view mode', () => {
  it('See-through caps the bodies, X-ray caps the mask too, Solid restores; the highlight is never capped', async () => {
    await mounted();
    const body = byName('body/'), mask = byName('mask/F.Mask');
    expect(mats(body)[0].opacity).toBeCloseTo(MATERIALS.body.opacity);
    r.setViewMode?.('see-through');
    expect(mats(body)[0].opacity).toBeCloseTo(VIEW_MODE_LOOK['see-through'].body);
    expect(mats(mask)[0].opacity).toBe(1);
    expect(mats(mask)[0].transparent).toBe(false);
    r.setViewMode?.('xray');
    expect(mats(mask)[0].opacity).toBeCloseTo(VIEW_MODE_LOOK.xray.mask);
    expect(mats(mask)[0].transparent).toBe(true);
    expect(mats(mask)[0].depthWrite).toBe(false);
    expect(mats(body)[0].opacity).toBeCloseTo(VIEW_MODE_LOOK.xray.body);
    // The part the reader asked about keeps the highlight look, uncapped.
    r.highlight?.('R1');
    expect(mats(body)[1].opacity).toBeCloseTo(HIGHLIGHT_MATERIALS.body.opacity);
    expect(groups(body)).toEqual([[0, 18, 1]]);
    r.setViewMode?.('solid');
    expect(mats(body)[0].opacity).toBeCloseTo(MATERIALS.body.opacity);
    expect(mats(mask)[0].opacity).toBe(1);
    expect(mats(mask)[0].transparent).toBe(false);
    expect(mats(mask)[0].depthWrite).toBe(true);
  });
  it('multiplies with the Objects slider rather than replacing it, and the copper is never touched', async () => {
    await mounted();
    const body = byName('body/'), cu = byName('copper/F.Cu');
    r.setObjectOpacity?.('bodies', 0.5);
    r.setViewMode?.('see-through');
    expect(mats(body)[0].opacity).toBeCloseTo(VIEW_MODE_LOOK['see-through'].body * 0.5);
    r.setViewMode?.('xray');
    expect(mats(cu)[0].opacity).toBe(1);
    expect(mats(cu)[0].transparent).toBe(false);
  });
});

describe('the materials (owner, 2026-09-22: "better textures")', () => {
  it('lights the scene with a procedural room environment, and releases it with the rest', async () => {
    const idle: (() => void)[] = [];
    (window as unknown as { requestIdleCallback: (fn: () => void) => number }).requestIdleCallback = (fn) => { idle.push(fn); return idle.length; };
    await mounted();
    expect(sceneRef?.environment).toBe(envTexture);
    expect(sceneRef?.environmentIntensity).toBe(ENVIRONMENT.intensity);
    r.dispose();
    for (const fn of idle) fn();
    expect(envTexture.disposed).toBe(1);
    delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
  });

  /** Three bodies, each its own quad of four vertices (a real body never
   *  shares a vertex with another): two ICs (opaque), then an LED (glass).
   *  Every normal points +z (a cap) except vertex 1's, which is a wall. */
  const families = () => {
    const scene = board();
    const at = scene.groups.findIndex((g) => g.material === 'body');
    const quad = [-10, -5, 0, 10, -5, 0, 10, 5, 0, -10, 5, 0];
    const normals = new Float32Array(36);
    for (let v = 0; v < 12; v++) normals[v * 3 + 2] = 1;
    normals[3] = 1;
    normals[5] = 0;
    scene.groups[at] = {
      material: 'body', layerName: null,
      positions: new Float32Array([...quad, ...quad, ...quad]),
      normals,
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11]),
      parts: [
        { ref: 'U1', start: 0, count: 6, family: 'ic' },
        { ref: 'U2', start: 6, count: 6, family: 'ic' },
        { ref: 'D1', start: 12, count: 6, family: 'led' },
      ],
      edges: new Float32Array([0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 1]),
    };
    return scene;
  };
  async function mountedWith(scene: BoardScene): Promise<SceneRenderer> {
    r = createSceneRenderer({ reducedMotion: true });
    await r.mount(host, scene, 'full');
    return r;
  }

  it('draws the opaque families in their own material and the glass ones in the base: two runs, two draw groups', async () => {
    await mountedWith(families());
    const body = byName('body/');
    // [glass base, highlight, opaque]
    expect(mats(body)).toHaveLength(3);
    expect(mats(body)[2].opacity).toBe(BODY_OPAQUE.opacity);
    expect(mats(body)[2].transparent).toBe(false);
    expect(mats(body)[2].vertexColors).toBe(true);
    expect(mats(body)[0].vertexColors).toBe(true);
    expect(groups(body)).toEqual([[0, 12, 2], [12, 6, 0]]);
    // The highlight cuts through a run.
    r.highlight?.('U2');
    expect(groups(body)).toEqual([[0, 6, 2], [6, 6, 1], [12, 6, 0]]);
    r.highlight?.(null);
    // A body group with no families is one glass run, exactly as before.
    r.dispose();
    meshes = [];
    await mounted();
    expect(mats(byName('body/'))).toHaveLength(2);
    expect(groups(byName('body/'))).toEqual([[0, 18, 0]]);
  });

  it('tints each vertex by its family, the caps lighter than the walls, in linear light', async () => {
    await mountedWith(families());
    const body = byName('body/');
    const color = body.geometry.getAttribute('color');
    expect(color.itemSize).toBe(3);
    expect(color.count).toBe(12);
    // Vertex 0 is a cap of U1: the IC's cap shade, converted as a material
    // colour would be (sRGB hex → linear).
    const cap = new THREE.Color(shade(FAMILY_TINTS.ic.color, FAMILY_TINTS.ic.capShade));
    expect(color.getX(0)).toBeCloseTo(cap.r, 6);
    expect(color.getY(0)).toBeCloseTo(cap.g, 6);
    expect(color.getZ(0)).toBeCloseTo(cap.b, 6);
    // Vertex 1 is a wall of U1: the tint itself, no shade.
    const wall = new THREE.Color(FAMILY_TINTS.ic.color);
    expect(color.getX(1)).toBeCloseTo(wall.r, 6);
    expect(cap.r).toBeGreaterThan(wall.r);
    // Vertex 8 is a cap of the LED.
    const led = new THREE.Color(shade(FAMILY_TINTS.led.color, FAMILY_TINTS.led.capShade));
    expect(color.getX(8)).toBeCloseTo(led.r, 6);
    expect(color.getZ(8)).toBeCloseTo(led.b, 6);
  });

  it('see-through caps the opaque bodies too; the rim keeps its own opacity', async () => {
    await mountedWith(families());
    const body = byName('body/');
    r.setViewMode?.('see-through');
    expect(mats(body)[2].opacity).toBeCloseTo(VIEW_MODE_LOOK['see-through'].body);
    expect(mats(body)[2].transparent).toBe(true);
    expect(mats(body)[2].depthWrite).toBe(false);
    expect(lines).toHaveLength(1);
    const rim = lines[0].material as InstanceType<typeof THREE.LineBasicMaterial>;
    expect(rim.opacity).toBeCloseTo(BODY_EDGE.opacity);
    r.setViewMode?.('solid');
    expect(mats(body)[2].opacity).toBe(1);
    expect(mats(body)[2].depthWrite).toBe(true);
  });

  it('draws the bodies\' outline as ONE line object that follows the Bodies slider and never picks', async () => {
    await mountedWith(families());
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toBe('body/edges');
    expect(lines[0].renderOrder).toBe(2);
    expect(lines[0].geometry.getAttribute('position').count).toBe(4);
    expect(meshes.some((m) => m.name === 'body/edges')).toBe(false);
    const rim = lines[0].material as InstanceType<typeof THREE.LineBasicMaterial>;
    r.setObjectOpacity?.('bodies', 0.5);
    expect(rim.opacity).toBeCloseTo(BODY_EDGE.opacity * 0.5);
    r.setObjectOpacity?.('bodies', 0);
    expect(lines[0].visible).toBe(false);
    expect(byName('body/').visible).toBe(false);
    r.setObjectOpacity?.('bodies', 1);
    expect(lines[0].visible).toBe(true);
  });
});

describe('dispose', () => {
  it('releases every material it made, the per-class clones, the opaque body and the rim included', async () => {
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
