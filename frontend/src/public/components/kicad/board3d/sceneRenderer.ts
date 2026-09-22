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
import type { BoardScene, MeshGroup, PartRange, Quality } from '@public/services/kicad/board3d/types';
import { fitDistance as fitDistanceFor, type Box3Like } from '@public/services/kicad/board3d/framing';
import { highlightSlices, partAtFace } from '@public/services/kicad/board3d/partRanges';
import { BACKGROUND, CAMERA, FLIP_MS, HIGHLIGHT_MATERIALS, LIGHTS, MATERIALS, ORBIT } from './board3dTheme';

// Types from the dynamic imports themselves: a `typeof import(...)` is erased at
// compile time, so the library is named for the type checker without any static
// import that a bundler could follow into the entry chunk.
type Three = typeof import('three');
type OrbitModule = typeof import('three/examples/jsm/controls/OrbitControls.js');

export type ViewName = 'top' | 'bottom' | 'reset';

export interface SceneRenderer {
  /** Loads three, builds the meshes, draws ONE frame, then resolves. The host
   *  reads `info()` straight after, which is why the first frame is not deferred. */
  mount(host: HTMLElement, scene: BoardScene, quality: Quality): Promise<void>;
  setView(view: ViewName): void;
  /** 180° about the board's long axis, animated over FLIP_MS. */
  flip(): void;
  /** Incremental orbit in degrees, for the host's arrow keys. Optional: a renderer
   *  that has no notion of an incremental turn ignores the keys rather than
   *  forcing every fake in a test to implement it. */
  orbit?(azimuthDeg: number, elevationDeg: number): void;
  pause(): void;
  resume(): void;
  dispose(): void;
  info(): { calls: number; triangles: number };
  /** Draw `ref`'s body and pads in the highlight material; null clears. A ref the
   *  scene does not draw (no courtyard, no pads) simply highlights nothing. */
  highlight?(ref: string | null): void;
  /** Who to tell when the reader clicks a part (a designator) or empty board or
   *  sky (null). A click is a pointer-up within a few pixels of its pointer-down;
   *  an orbit drag never picks. */
  onPick?(handler: ((ref: string | null) => void) | null): void;
}

/** A click is this much movement or less between pointer-down and pointer-up.
 *  OrbitControls owns anything larger. */
const CLICK_SLOP_PX = 6;
const CLICK_MAX_MS = 500;

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
/** Smoothstep: the flip starts and ends at rest, which reads as a board being
 *  turned over rather than a sprite being spun. */
const ease = (t: number) => t * t * (3 - 2 * t);

export function createSceneRenderer(): SceneRenderer {
  let renderer: InstanceType<Three['WebGLRenderer']> | null = null;
  let scene: InstanceType<Three['Scene']> | null = null;
  let camera: InstanceType<Three['PerspectiveCamera']> | null = null;
  let controls: InstanceType<OrbitModule['OrbitControls']> | null = null;
  let model: InstanceType<Three['Group']> | null = null;
  let host: HTMLElement | null = null;
  let observer: ResizeObserver | null = null;
  const geometries: InstanceType<Three['BufferGeometry']>[] = [];
  const materials: InstanceType<Three['MeshStandardMaterial']>[] = [];
  /** The meshes a reader can pick from and that carry a highlight: those whose
   *  group has a `parts` table (bodies at `full`, pads on every copper layer). */
  const parted: { mesh: InstanceType<Three['Mesh']>; parts: PartRange[]; total: number }[] = [];
  let three: Three | null = null;
  let modelBox: Box3Like | null = null;
  let pickHandler: ((ref: string | null) => void) | null = null;
  let pointerDown: { x: number; y: number; at: number } | null = null;
  let highlighted: string | null = null;

  let disposed = false;
  let paused = false;
  let frame = 0;
  let lastMs = 0;
  let settleUntil = 0;

  let fitDistance = 1;
  let autoOrbit = true;
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
    if (disposed || paused || frame !== 0 || renderer == null) return;
    frame = requestAnimationFrame(tick);
  }

  function tick(now: number): void {
    frame = 0;
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

    if (!paused && moving(now)) frame = requestAnimationFrame(tick);
    else lastMs = 0;
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
    const spec = MATERIALS[group.material];
    const material = new T.MeshStandardMaterial({
      color: spec.color,
      roughness: spec.roughness,
      metalness: spec.metalness,
      transparent: spec.transparent,
      opacity: spec.opacity,
      depthWrite: spec.depthWrite,
    });
    geometries.push(geometry);
    materials.push(material);
    // A group with a parts table draws through a two-material array: index 0 is
    // its own, 1 the highlight. Which triangles use which is a matter of the
    // geometry's draw ranges, so a selection costs a range rewrite and at most
    // two extra draw calls — never a colour attribute over 300k vertices.
    const highlightSpec = group.parts != null && (group.material === 'body' || group.material === 'copper')
      ? HIGHLIGHT_MATERIALS[group.material]
      : null;
    let mesh: InstanceType<Three['Mesh']>;
    if (highlightSpec != null && group.parts != null) {
      const lit = new T.MeshStandardMaterial({
        color: highlightSpec.color,
        emissive: highlightSpec.emissive,
        emissiveIntensity: highlightSpec.emissiveIntensity,
        roughness: highlightSpec.roughness,
        metalness: highlightSpec.metalness,
        transparent: highlightSpec.transparent,
        opacity: highlightSpec.opacity,
        depthWrite: highlightSpec.depthWrite,
      });
      materials.push(lit);
      geometry.addGroup(0, group.indices.length, 0);
      mesh = new T.Mesh(geometry, [material, lit]);
      parted.push({ mesh, parts: group.parts, total: group.indices.length });
    } else {
      mesh = new T.Mesh(geometry, material);
    }
    mesh.name = `${group.material}/${group.layerName ?? ''}`;
    // Translucent bodies last, so they blend over the board rather than the board
    // being sorted over them.
    mesh.renderOrder = spec.transparent ? 1 : 0;
    return mesh;
  }

  /** The reset-pose distance for the canvas's CURRENT shape. Re-read on every
   *  resize, so a Reset after the reader widens the window still fills it. */
  function refit(): void {
    if (modelBox == null || host == null) return;
    const aspect = Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight);
    fitDistance = fitDistanceFor(modelBox, {
      fovDeg: CAMERA.fov, aspect, elevationDeg: CAMERA.elevationDeg, margin: CAMERA.fitMargin,
    });
  }

  /** The footprint under a canvas point, through the nearest hit of ANY mesh:
   *  the substrate and mask take part as occluders, so a click on the bottom
   *  face never picks a top-side body through the board. */
  function pickAt(clientX: number, clientY: number): string | null {
    if (three == null || renderer == null || camera == null || model == null) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new three.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new three.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(model.children, false)[0];
    if (hit == null || hit.faceIndex == null) return null;
    const entry = parted.find((p) => p.mesh === hit.object);
    return entry == null ? null : partAtFace(entry.parts, hit.faceIndex);
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    pointerDown = { x: e.clientX, y: e.clientY, at: performance.now() };
  };
  const onPointerUp = (e: PointerEvent): void => {
    const down = pointerDown;
    pointerDown = null;
    if (down == null || pickHandler == null) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
    if (performance.now() - down.at > CLICK_MAX_MS) return;
    pickHandler(pickAt(e.clientX, e.clientY));
  };
  const onPointerCancel = (): void => {
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

      const aspect = Math.max(1, element.clientWidth) / Math.max(1, element.clientHeight);
      camera = new T.PerspectiveCamera(CAMERA.fov, aspect, diagonal / 100, diagonal * 20);
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
      // A selection asked for before the meshes existed is applied now.
      if (highlighted != null) this.highlight?.(highlighted);

      renderer.render(scene, camera);
      wake();
    },

    highlight(ref) {
      highlighted = ref;
      for (const entry of parted) {
        const geometry = entry.mesh.geometry;
        geometry.clearGroups();
        for (const slice of highlightSlices(entry.parts, ref, entry.total)) {
          geometry.addGroup(slice.start, slice.count, slice.materialIndex);
        }
      }
      if (renderer != null) onChange();
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
      return { calls: render?.calls ?? 0, triangles: render?.triangles ?? 0 };
    },
  };
}
