// BoardScene → three.js, and back to nothing again (spec 2026-09-21 §5, §7).
//
// This is the ONLY module in the codebase that touches three, and it touches it
// through `import()` so the library lands in its own `board3d-three` chunk: a
// visitor who never opens the 3D tab never downloads a renderer.
//
// Three things it is careful about, all of them learnt from the 2D viewer next
// door. (1) A WebGL context is scarce — browsers cap live contexts and force-lose
// the OLDEST, which would blank the schematic in the other tab — so `dispose()`
// releases it explicitly rather than waiting for the GC. (2) The render loop is
// DEMAND-DRIVEN: a perpetual rAF on a static board is a battery bug, so frames
// are drawn only while something is moving. (3) The camera's up axis is +Z,
// because MeshBuilder puts the board's thickness on z; fighting that with a
// rotated model would put every later "which way is up" question in two places.
import type { BoardScene, ClassRange, Material, MeshGroup, PartRange, Quality } from '@public/services/kicad/board3d/types';
import { fitDistance as fitDistanceFor, type Box3Like } from '@public/services/kicad/board3d/framing';
import {
  classSlices, highlightSlices, netRangesOf, partAtFace, type IndexRange,
} from '@public/services/kicad/board3d/partRanges';
import { BACKGROUND, CAMERA, FLIP_MS, LIGHTS, MATERIALS, ORBIT, highlightSpecFor, type MaterialSpec } from './board3dTheme';

// Types from the dynamic imports themselves: a `typeof import(...)` is erased at
// compile time, so the library is named for the type checker without any static
// import that a bundler could follow into the entry chunk.
type Three = typeof import('three');
type OrbitModule = typeof import('three/examples/jsm/controls/OrbitControls.js');

export type ViewName = 'top' | 'bottom' | 'reset';

/** The object classes the Board panel's Objects tab can fade or hide in 3D
 *  (spec 2026-09-22 §2.2). Tracks, pads and zones are slices of the copper
 *  groups; the rest are whole materials — vias are the drilled hole walls. */
export type ObjectClass3D = 'tracks' | 'vias' | 'pads' | 'zones' | 'silk' | 'mask' | 'bodies';
type CopperClass = ClassRange['kind'];

/** A class that is a whole MATERIAL rather than a slice of the copper. */
const MATERIAL_CLASS: Partial<Record<Material, ObjectClass3D>> = { body: 'bodies', silk: 'silk', mask: 'mask', 'hole-wall': 'vias' };
/** In the order their materials are appended to a copper mesh. */
const COPPER_CLASSES: readonly CopperClass[] = ['tracks', 'pads', 'zones'];
/** What a layer toggle never hides: the board itself and the drilled walls
 *  through it, which belong to no one layer. */
const NEVER_HIDDEN: ReadonlySet<Material> = new Set<Material>(['substrate', 'hole-wall']);

export interface SceneRenderer {
  /** Loads three, builds the meshes, draws ONE frame, then resolves. The host
   *  reads `info()` straight after, which is why the first frame is not deferred. */
  mount(host: HTMLElement, scene: BoardScene, quality: Quality): Promise<void>;
  setView(view: ViewName): void;
  /** 180° about the board's long axis, animated over FLIP_MS — or cut straight
   *  to the other side when the reader asked the OS for reduced motion. */
  flip(): void;
  /** Incremental orbit in degrees, for the host's arrow keys. Optional: a renderer
   *  that has no notion of an incremental turn ignores the keys rather than
   *  forcing every fake in a test to implement it. */
  orbit?(azimuthDeg: number, elevationDeg: number): void;
  pause(): void;
  resume(): void;
  dispose(): void;
  info(): { calls: number; triangles: number; /** The last pick's raycast, ms; 0 before any. */ pickMs: number };
  /** Draw `ref`'s body and pads in the highlight material; null clears. A ref the
   *  scene does not draw (no courtyard, no pads) simply highlights nothing. */
  highlight?(ref: string | null): void;
  /** Show or hide every group drawn on `layerName` (`F.Cu`, `B.Mask`, `F.SilkS`…).
   *  The substrate and the hole walls belong to no layer and are never hidden. */
  setLayerVisible?(layerName: string, visible: boolean): void;
  /** The groups on `layerName` take the highlight material, as a selected part
   *  does; null clears. */
  highlightLayer?(layerName: string | null): void;
  /** 0..1, where 0 hides the class outright. Tracks, pads and zones by the
   *  copper groups' class ranges; bodies, silk, mask and vias by material. */
  setObjectOpacity?(kind: ObjectClass3D, opacity: number): void;
  /** The copper of net `net` in the highlight material, via the copper groups'
   *  net ranges; null (or 0, "no net") clears. */
  highlightNet?(net: number | null): void;
  /** Who to tell when the reader clicks a part (a designator) or empty board or
   *  sky (null). A click is a pointer-up within a few pixels of its pointer-down;
   *  an orbit drag never picks. */
  onPick?(handler: ((ref: string | null) => void) | null): void;
}

export interface SceneRendererOptions {
  /** The reader asked for reduced motion: no auto-orbit on load, and a flip cuts
   *  instead of turning. Read from `prefers-reduced-motion` at mount when not
   *  given, which is what the page does; a test hands it in. */
  reducedMotion?: boolean;
}

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** A click is this much movement or less between pointer-down and pointer-up.
 *  OrbitControls owns anything larger. */
const CLICK_SLOP_PX = 6;
const CLICK_MAX_MS = 500;
/** When a TOUCH lands on nothing pickable, four more rays this far out are
 *  tried — a fingertip beside a 0402's pad on a phone, where the bodies are not
 *  drawn, still identifies the part. Each cast is ~20 ms on a 300k-triangle
 *  board (measured), so a touch miss costs five casts; a mouse or pen is precise
 *  and a click on bare board (the common "deselect") costs exactly one. */
const PICK_TOLERANCE_PX = 6;

/** The scheduler `deferTeardown` uses: `requestIdleCallback` where the browser has
 *  it, else a macrotask. Named so a test can hand in a fake. */
export interface TeardownScheduler {
  requestIdleCallback?: (fn: () => void, options?: { timeout: number }) => number;
  setTimeout: (fn: () => void, ms: number) => number;
}

/** Idle at the latest this long after the tab has switched; a busy page must
 *  not hold a dead context indefinitely. */
const TEARDOWN_TIMEOUT_MS = 1000;

/**
 * Run the expensive half of a dispose OFF the task that asked for it.
 *
 * Losing a WebGL context is synchronous and, on a software rasteriser, seconds
 * long (measured 4.7 s under SwiftShader; the perf audit of 2026-09-22). It
 * used to run inside the tab click's own React commit, so the tab the reader
 * had just chosen could not paint until the one they left had finished dying.
 * Deferring it lets the new tab paint first; the context is still lost, once,
 * within the idle window. Never the current task, whatever the scheduler.
 */
export function deferTeardown(fn: () => void, scheduler: TeardownScheduler = window): void {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    fn();
  };
  if (typeof scheduler.requestIdleCallback === 'function') scheduler.requestIdleCallback(once, { timeout: TEARDOWN_TIMEOUT_MS });
  else scheduler.setTimeout(once, 0);
}

const DEG = Math.PI / 180;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
/** Width / height, never divided by zero (happy-dom and a collapsed host lay out nothing). */
const aspectOf = (el: HTMLElement) => Math.max(1, el.clientWidth) / Math.max(1, el.clientHeight);
/** Smoothstep: the flip starts and ends at rest, which reads as a board being
 *  turned over rather than a sprite being spun. */
const ease = (t: number) => t * t * (3 - 2 * t);

type StandardMaterial = InstanceType<Three['MeshStandardMaterial']>;

/** A material at `opacity` of its theme look: 1 is the theme exactly, 0 is not
 *  drawn. Anything below 1 blends and stops writing depth, or it would hide
 *  what is behind it while looking see-through. */
function fade(material: StandardMaterial, spec: MaterialSpec, opacity: number): void {
  const transparent = spec.transparent || opacity < 1;
  // Blending is compiled into the program; only a flip of it needs a rebuild.
  if (material.transparent !== transparent) material.needsUpdate = true;
  material.transparent = transparent;
  material.opacity = spec.opacity * opacity;
  material.depthWrite = spec.depthWrite && opacity >= 1;
  material.visible = opacity > 0;
}

export function createSceneRenderer(options: SceneRendererOptions = {}): SceneRenderer {
  let renderer: InstanceType<Three['WebGLRenderer']> | null = null;
  let scene: InstanceType<Three['Scene']> | null = null;
  let camera: InstanceType<Three['PerspectiveCamera']> | null = null;
  let controls: InstanceType<OrbitModule['OrbitControls']> | null = null;
  let model: InstanceType<Three['Group']> | null = null;
  let host: HTMLElement | null = null;
  let observer: ResizeObserver | null = null;
  const geometries: InstanceType<Three['BufferGeometry']>[] = [];
  /** EVERY material made, the per-class clones included: dispose frees this list. */
  const materials: StandardMaterial[] = [];
  /** The meshes a reader can pick from: those whose group has a `parts` table
   *  (bodies at `full`, pads on every copper layer). */
  const parted: { mesh: InstanceType<Three['Mesh']>; parts: PartRange[] }[] = [];
  /** Every mesh with what `applyView` needs to redraw it: its material array is
   *  [own, highlight?, …one clone of the copper per class], and its draw groups
   *  are recomputed from the view state on every change. */
  interface Drawn {
    mesh: InstanceType<Three['Mesh']>;
    group: MeshGroup;
    total: number;
    base: StandardMaterial;
    lit: StandardMaterial | null;
    classes: { kind: CopperClass; index: number; material: StandardMaterial }[];
  }
  const drawn: Drawn[] = [];
  const hiddenLayers = new Set<string>();
  let highlightedLayer: string | null = null;
  let highlightedNet: number | null = null;
  const opacity = new Map<ObjectClass3D, number>();
  let three: Three | null = null;
  let modelBox: Box3Like | null = null;
  let pickHandler: ((ref: string | null) => void) | null = null;
  let pointerDown: { x: number; y: number; at: number } | null = null;
  /** Pointers currently down. A second finger (a pinch) voids the click: the
   *  finger lifted last may not have moved, and it must not pick. */
  const pointers = new Set<number>();
  let highlighted: string | null = null;
  /** How long the last raycast took — the measurement hook `info()` reports, so
   *  a browser step can separate the pick from the software raster around it. */
  let pickMs = 0;

  let disposed = false;
  let paused = false;
  let frame = 0;
  let lastMs = 0;
  let settleUntil = 0;

  let fitDistance = 1;
  /** Set for real at mount, from the reader's motion preference. */
  let autoOrbit = false;
  let reducedMotion = false;
  let longAxis: 'x' | 'y' = 'x';

  let flipping = false;
  let flipStart = 0;
  let flipFrom = 0;

  /** Where the camera is, as (azimuth, elevation, distance) around the target.
   *  DERIVED every time rather than remembered: once the visitor drags, the
   *  controls own the camera, and a remembered angle would be a lie. */
  function orbitOf(): { az: number; el: number; dist: number } {
    if (camera == null || controls == null) return { az: CAMERA.azimuthDeg, el: CAMERA.elevationDeg, dist: fitDistance };
    const t = controls.target;
    const dx = camera.position.x - t.x, dy = camera.position.y - t.y, dz = camera.position.z - t.z;
    const dist = Math.hypot(dx, dy, dz) || fitDistance;
    return { az: Math.atan2(dx, dy) / DEG, el: Math.asin(clamp(dz / dist, -1, 1)) / DEG, dist };
  }

  function placeCamera(azDeg: number, elDeg: number, dist: number): void {
    if (camera == null || controls == null) return;
    const t = controls.target;
    const az = azDeg * DEG, el = clamp(elDeg, -CAMERA.poleDeg, CAMERA.poleDeg) * DEG;
    camera.position.set(
      t.x + dist * Math.cos(el) * Math.sin(az),
      t.y + dist * Math.cos(el) * Math.cos(az),
      t.z + dist * Math.sin(el),
    );
    camera.lookAt(t);
    controls.update();
  }

  const moving = (now: number) => autoOrbit || flipping || now < settleUntil;

  function wake(): void {
    if (disposed || paused || ticking || frame !== 0 || renderer == null) return;
    frame = requestAnimationFrame(tick);
  }

  /** True while `tick` runs. The controls fire 'change' from INSIDE a tick
   *  (auto-orbit and damping move the camera there), and a `wake()` from that
   *  handler must not queue a second frame beside the one the tick queues itself
   *  — that doubled the queued ticks every frame of a drag (measured 3,355
   *  renders per frame after one second). The tick decides the next frame alone. */
  let ticking = false;

  function tick(now: number): void {
    frame = 0;
    ticking = true;
    try {
      step(now);
    } finally {
      ticking = false;
    }
    if (disposed || renderer == null) return;
    if (!paused && moving(now)) {
      if (frame === 0) frame = requestAnimationFrame(tick);
    } else {
      lastMs = 0;
    }
  }

  function step(now: number): void {
    if (disposed || renderer == null || scene == null || camera == null || controls == null) return;
    // Clamped: a tab that was hidden for a minute must not jump a minute of orbit
    // on its first frame back.
    const dt = lastMs === 0 ? 0 : Math.min(0.05, (now - lastMs) / 1000);
    lastMs = now;

    if (autoOrbit) {
      const o = orbitOf();
      placeCamera(o.az + ORBIT.autoDegPerSec * dt, o.el, o.dist);
    }
    if (flipping && model != null) {
      if (flipStart === 0) flipStart = now;
      const t = clamp((now - flipStart) / FLIP_MS, 0, 1);
      model.rotation[longAxis] = flipFrom + Math.PI * ease(t);
      if (t >= 1) {
        flipping = false;
        // Kept inside one turn so repeated flips cannot accumulate a huge angle.
        model.rotation[longAxis] = (flipFrom + Math.PI) % (2 * Math.PI);
      }
    }
    controls.update();
    renderer.render(scene, camera);
  }

  /** Any controls change keeps the loop alive long enough for damping to settle. */
  const onChange = (): void => {
    settleUntil = performance.now() + ORBIT.settleMs;
    wake();
  };
  /** The first touch of the controls ends the auto-orbit for the tab's lifetime:
   *  a view that keeps drifting under the visitor's hand is the classic demo bug. */
  const onStart = (): void => {
    autoOrbit = false;
  };

  function buildMesh(T: Three, group: MeshGroup): InstanceType<Three['Mesh']> {
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.BufferAttribute(group.positions, 3));
    geometry.setAttribute('normal', new T.BufferAttribute(group.normals, 3));
    geometry.setIndex(new T.BufferAttribute(group.indices, 1));
    geometry.computeBoundingSphere();
    const total = group.indices.length;
    const spec = MATERIALS[group.material];
    // A spec is exactly MeshStandardMaterial parameters, so it is handed over whole.
    const base = new T.MeshStandardMaterial({ ...spec });
    geometries.push(geometry);
    materials.push(base);
    // Every mesh draws through a material array, and which triangles use which
    // material is a matter of the geometry's draw ranges: a selection, a faded
    // class or a lit net costs a range rewrite and a few draw calls — never a
    // colour attribute over 300k vertices. Index 0 is the group's own material,
    // 1 the highlight for anything that can be lit (a part, a layer, a net).
    const array: StandardMaterial[] = [base];
    let lit: StandardMaterial | null = null;
    if (group.parts != null || group.layerName != null || (group.nets?.length ?? 0) > 0) {
      lit = new T.MeshStandardMaterial({ ...highlightSpecFor(group.material) });
      materials.push(lit);
      array.push(lit);
    }
    // A copper group's tracks, pads and zones each get their own clone of the
    // copper, so each can carry its own opacity.
    const classes: Drawn['classes'] = [];
    if (group.material === 'copper' && group.classes != null) {
      for (const kind of COPPER_CLASSES) {
        if (!group.classes.some((c) => c.kind === kind)) continue;
        const material = base.clone();
        materials.push(material);
        classes.push({ kind, index: array.length, material });
        array.push(material);
      }
    }
    const mesh = new T.Mesh(geometry, array);
    // Drawn whole until the first `applyView`, which runs before any frame.
    geometry.addGroup(0, total, 0);
    if (group.parts != null) parted.push({ mesh, parts: group.parts });
    drawn.push({ mesh, group, total, base, lit, classes });
    mesh.name = `${group.material}/${group.layerName ?? ''}`;
    // Translucent bodies last, so they blend over the board rather than the board
    // being sorted over them.
    mesh.renderOrder = spec.transparent ? 1 : 0;
    return mesh;
  }

  const opacityOf = (kind: ObjectClass3D): number => {
    const o = opacity.get(kind);
    return o == null || !Number.isFinite(o) ? 1 : clamp(o, 0, 1);
  };

  /**
   * The whole view state onto every mesh: which are shown, each class's
   * opacity, and each geometry's draw groups — the part, layer and net
   * highlights re-sliced together, so they never fight over a range. A dozen
   * meshes and a few hundred ranges: cheap enough to redo on any change.
   */
  function applyView(): void {
    for (const d of drawn) {
      const { group } = d;
      const kind = MATERIAL_CLASS[group.material];
      const own = kind == null ? 1 : opacityOf(kind);
      const layerHidden = group.layerName != null && !NEVER_HIDDEN.has(group.material) && hiddenLayers.has(group.layerName);
      d.mesh.visible = !layerHidden && own > 0;
      if (kind != null) fade(d.base, MATERIALS[group.material], own);

      /** Each class's material index for this pass: null = not drawn (opacity
       *  0, and a highlight must not bring it back); 0 = the group's own
       *  material, for a class at full opacity, so an untouched copper layer
       *  stays ONE draw call and only a faded class pays for its own. */
      const classMaterial = new Map<CopperClass, number | null>();
      for (const c of d.classes) {
        const o = opacityOf(c.kind);
        fade(c.material, MATERIALS.copper, o);
        classMaterial.set(c.kind, o <= 0 ? null : o >= 1 ? 0 : c.index);
      }

      const lit: IndexRange[] = [];
      if (d.lit != null) {
        if (group.layerName != null && group.layerName === highlightedLayer) {
          lit.push({ start: 0, count: d.total });
        } else {
          if (highlighted != null && group.parts != null) {
            for (const slice of highlightSlices(group.parts, highlighted, d.total)) if (slice.materialIndex === 1) lit.push(slice);
          }
          lit.push(...netRangesOf(group.nets, highlightedNet));
        }
      }

      // One partRanges tiling for classes and highlights together; adjacent
      // slices that land on the same material are joined — each is a draw call.
      const geometry = d.mesh.geometry;
      geometry.clearGroups();
      let run: { start: number; count: number; materialIndex: number } | null = null;
      const flush = () => { if (run != null) geometry.addGroup(run.start, run.count, run.materialIndex); run = null; };
      for (const slice of classSlices(group.classes, lit, d.total)) {
        // A class with no material of its own (not present when the mesh was
        // built) draws in the group's; a hidden class (null) is left out.
        const own: number | null = slice.kind == null ? 0 : classMaterial.get(slice.kind) ?? (classMaterial.has(slice.kind) ? null : 0);
        if (own == null) { flush(); continue; }
        const materialIndex = slice.highlighted && d.lit != null ? 1 : own;
        if (run != null && run.materialIndex === materialIndex && run.start + run.count === slice.start) run.count += slice.count;
        else { flush(); run = { start: slice.start, count: slice.count, materialIndex }; }
      }
      flush();
    }
    if (renderer != null) onChange();
  }

  /** The reset-pose distance for the canvas's CURRENT shape. Re-read on every
   *  resize, so a Reset after the reader widens the window still fills it. */
  function refit(): void {
    if (modelBox == null || host == null) return;
    fitDistance = fitDistanceFor(modelBox, {
      fovDeg: CAMERA.fov, aspect: aspectOf(host), elevationDeg: CAMERA.elevationDeg, margin: CAMERA.fitMargin,
    });
  }

  /** The footprint under ONE ray, through the nearest hit of ANY mesh: the
   *  substrate and mask take part as occluders, so a click on the bottom face
   *  never picks a top-side body through the board. */
  function castAt(T: Three, cam: NonNullable<typeof camera>, group: NonNullable<typeof model>, rect: DOMRect, x: number, y: number): string | null {
    const ndc = new T.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    const ray = new T.Raycaster();
    ray.setFromCamera(ndc, cam);
    // A hidden layer neither draws nor stands in the way of a pick.
    const hit = ray.intersectObjects(group.children.filter((c) => c.visible), false)[0];
    if (hit == null || hit.faceIndex == null) return null;
    const entry = parted.find((p) => p.mesh === hit.object);
    return entry == null ? null : partAtFace(entry.parts, hit.faceIndex);
  }

  /** The footprint under a canvas point — or, for a touch, under one of four
   *  points a few pixels around it when the point itself is bare board. */
  function pickAt(clientX: number, clientY: number, pointerType: string): string | null {
    if (three == null || renderer == null || camera == null || model == null) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const t0 = performance.now();
    let ref = castAt(three, camera, model, rect, clientX, clientY);
    if (ref == null && pointerType === 'touch') {
      const d = PICK_TOLERANCE_PX;
      for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
        ref = castAt(three, camera, model, rect, clientX + dx, clientY + dy);
        if (ref != null) break;
      }
    }
    pickMs = performance.now() - t0;
    return ref;
  }

  const onPointerDown = (e: PointerEvent): void => {
    pointers.add(e.pointerId);
    if (pointers.size > 1) {
      pointerDown = null;
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    pointerDown = { x: e.clientX, y: e.clientY, at: performance.now() };
  };
  const onPointerUp = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    const down = pointerDown;
    pointerDown = null;
    if (down == null || pickHandler == null || pointers.size > 0) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
    if (performance.now() - down.at > CLICK_MAX_MS) return;
    pickHandler(pickAt(e.clientX, e.clientY, e.pointerType));
  };
  const onPointerCancel = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    pointerDown = null;
  };

  function resize(): void {
    if (renderer == null || camera == null || host == null) return;
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    refit();
    onChange();
  }

  return {
    async mount(element, board, quality) {
      host = element;
      reducedMotion = options.reducedMotion ?? prefersReducedMotion();
      autoOrbit = !reducedMotion;
      const [T, orbit] = await Promise.all([
        import('three'),
        import('three/examples/jsm/controls/OrbitControls.js'),
      ]);
      // dispose() can land while the two chunks are still in flight — leaving the
      // tab is exactly the moment a slow connection is noticed.
      if (disposed) return;
      three = T;

      renderer = new T.WebGLRenderer({ antialias: quality === 'full', powerPreference: 'high-performance' });
      renderer.setPixelRatio(quality === 'full' ? Math.min(window.devicePixelRatio, 2) : 1);
      renderer.setSize(Math.max(1, element.clientWidth), Math.max(1, element.clientHeight), false);
      const canvas = renderer.domElement;
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      element.appendChild(canvas);

      scene = new T.Scene();
      scene.background = new T.Color(BACKGROUND);
      model = new T.Group();
      for (const group of board.groups) model.add(buildMesh(T, group));
      scene.add(model);

      const width = board.bounds.max.x - board.bounds.min.x;
      const height = board.bounds.max.y - board.bounds.min.y;
      longAxis = width >= height ? 'x' : 'y';
      const diagonal = Math.max(1e-3, Math.hypot(width, height));
      // The model's real box, bodies included: what the framing fits to the
      // canvas. `board.bounds` is the outline alone and knows nothing of height.
      const box = new T.Box3().setFromObject(model);
      modelBox = { min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } };
      refit();

      camera = new T.PerspectiveCamera(CAMERA.fov, aspectOf(element), diagonal / 100, diagonal * 20);
      camera.up.set(0, 0, 1);
      const light = new T.DirectionalLight(LIGHTS.directional.color, LIGHTS.directional.intensity);
      light.position.set(
        LIGHTS.directional.offset.x * diagonal,
        LIGHTS.directional.offset.y * diagonal,
        LIGHTS.directional.offset.z * diagonal,
      );
      // Parented to the camera, and the camera parented to the scene: a child of
      // an unattached camera never gets a world matrix, so the light would sit at
      // the origin inside the board.
      camera.add(light);
      scene.add(camera);
      scene.add(new T.HemisphereLight(LIGHTS.hemisphere.sky, LIGHTS.hemisphere.ground, LIGHTS.hemisphere.intensity));

      controls = new orbit.OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = ORBIT.dampingFactor;
      controls.minDistance = ORBIT.minDistanceFactor * diagonal;
      controls.maxDistance = ORBIT.maxDistanceFactor * diagonal;
      controls.target.set(0, 0, 0);
      controls.addEventListener('change', onChange);
      controls.addEventListener('start', onStart);
      placeCamera(CAMERA.azimuthDeg, CAMERA.elevationDeg, fitDistance);

      observer = new ResizeObserver(resize);
      observer.observe(element);
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerCancel);
      // The view state — a selection, hidden layers, faded classes — asked for
      // before the meshes existed is applied now, before the first frame.
      applyView();

      renderer.render(scene, camera);
      wake();
    },

    highlight(ref) {
      highlighted = ref;
      applyView();
    },

    setLayerVisible(layerName, visible) {
      if (visible) hiddenLayers.delete(layerName);
      else hiddenLayers.add(layerName);
      applyView();
    },

    highlightLayer(layerName) {
      highlightedLayer = layerName;
      applyView();
    },

    setObjectOpacity(kind, value) {
      opacity.set(kind, value);
      applyView();
    },

    highlightNet(net) {
      // Net 0 is KiCad's "no net": lighting it would light every unconnected pad.
      highlightedNet = net == null || net <= 0 ? null : net;
      applyView();
    },

    onPick(handler) {
      pickHandler = handler;
    },

    setView(view) {
      if (camera == null || controls == null) return;
      autoOrbit = false;
      if (view === 'reset') {
        if (model != null) model.rotation.set(0, 0, 0);
        flipping = false;
        placeCamera(CAMERA.azimuthDeg, CAMERA.elevationDeg, fitDistance);
      } else {
        placeCamera(orbitOf().az, view === 'top' ? CAMERA.poleDeg : -CAMERA.poleDeg, fitDistance);
      }
      onChange();
    },

    flip() {
      if (model == null || flipping) return;
      autoOrbit = false;
      if (reducedMotion) {
        model.rotation[longAxis] = (model.rotation[longAxis] + Math.PI) % (2 * Math.PI);
        onChange();
        return;
      }
      flipFrom = model.rotation[longAxis];
      flipStart = 0;
      flipping = true;
      wake();
    },

    orbit(azimuthDeg, elevationDeg) {
      if (camera == null) return;
      autoOrbit = false;
      const o = orbitOf();
      placeCamera(o.az + azimuthDeg, o.el + elevationDeg, o.dist);
      onChange();
    },

    pause() {
      paused = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      lastMs = 0;
    },

    resume() {
      if (disposed) return;
      paused = false;
      onChange();
    },

    dispose() {
      disposed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      observer?.disconnect();
      observer = null;
      controls?.removeEventListener('change', onChange);
      controls?.removeEventListener('start', onStart);
      controls?.dispose();
      controls = null;
      // The cheap, synchronous half: nothing above touches the GPU. The canvas
      // leaves the DOM now, so the tab the reader picked paints without it.
      const gone = { renderer, geometries: geometries.slice(), materials: materials.slice() };
      geometries.length = 0;
      materials.length = 0;
      parted.length = 0;
      drawn.length = 0;
      pickHandler = null;
      modelBox = null;
      if (gone.renderer != null) {
        const canvas = gone.renderer.domElement;
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerCancel);
        canvas.remove();
      }
      renderer = null;
      scene = null;
      camera = null;
      model = null;
      host = null;
      three = null;
      // The expensive half, off this task. WEBGL_lose_context by its three.js
      // name: without it the context lives until the GC runs, and the 2D embed
      // can be the one the browser evicts — so it is still lost, just not inside
      // the click that left the tab.
      if (gone.renderer != null) {
        deferTeardown(() => {
          for (const geometry of gone.geometries) geometry.dispose();
          for (const material of gone.materials) material.dispose();
          gone.renderer?.forceContextLoss();
          gone.renderer?.dispose();
        });
      }
    },

    info() {
      const render = renderer?.info.render;
      return { calls: render?.calls ?? 0, triangles: render?.triangles ?? 0, pickMs };
    },
  };
}
