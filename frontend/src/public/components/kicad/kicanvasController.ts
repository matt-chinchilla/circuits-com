// The KiCanvas implementation of CanvasController — the ONLY file that
// reaches into KiCanvas (spec §5.3). Everything is feature-detected: the app
// element's `project` and `viewer` are public fields upstream, but they are
// alpha internals with no versioning, so every reach returns a result rather
// than throwing.
import { basename } from '@public/services/kicad/project';
import type { KicadProject } from '@public/services/kicad/types';
import type {
  CanvasController,
  CanvasEvent,
  CanvasEventType,
  CanvasHandler,
  CanvasSource,
  CanvasView,
  FocusResult,
  ZoomAction,
} from './canvasController';

interface KicanvasPage {
  type: 'pcb' | 'schematic';
  filename: string;
  sheet_path: string;
  project_path: string;
  /** `ProjectPage.document` — `file_by_name(filename)` (vendor kicanvas/project.ts:393-395),
   *  so it is ONE object shared by every instance page of a file. */
  document?: unknown;
}

interface KicanvasProject {
  pages(): Iterable<KicanvasPage>;
  active_page: KicanvasPage | null;
  root_schematic_page: KicanvasPage | null;
  set_active_page(page: KicanvasPage | string): void;
}

interface KicanvasViewer {
  document?: { filename?: string } | null;
  selected?: unknown;
  select?: (ref: string) => void;
  zoom_to_selection?: () => void;
  /** Repaints the canvas after a camera change (vendor viewers/base/viewer.ts:165,
   *  overridden at viewers/base/document-viewer.ts:138). The Viewport has no draw. */
  draw?: () => void;
}

type KicanvasApp = HTMLElement & { project?: KicanvasProject; viewer?: KicanvasViewer };

export interface KicanvasControllerOptions {
  loadModule?: () => Promise<unknown>;
  createEmbed?: () => HTMLElement;
  /** 15 s: the first GPU mount of Glasgow took 4.3 s to the app element; the deadline pauses while the tab is hidden (spec §5.2). */
  readyMs?: number;
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock. The hidden-tab refund is arithmetic on elapsed time, and a
   *  test cannot demonstrate it against a wall clock without sleeping for real. */
  now?: () => number;
  visibility?: () => DocumentVisibilityState;
}

export const CANVAS_READY_MS = 15000;
const POLL_MS = 50;

/** `KiCanvasLoadEvent.type` (vendor viewers/base/events.ts:13-14). The viewer
 *  dispatches it from `resolve_loaded` for every document it finishes loading. */
const KICANVAS_LOAD = 'kicanvas:load';

/** Upstream's own interactive zoom limits, mirrored. `Viewer.setup()` is the only
 *  call site and passes them as literals — `this.viewport.enable_pan_and_zoom(0.5, 190)`
 *  (vendor viewers/base/viewer.ts:80), overriding PanAndZoom's 0.5/10 field defaults
 *  (base/dom/pan-and-zoom.ts:36-37) — and the clamp runs inside `#handle_zoom`
 *  (pan-and-zoom.ts:210-215). They sit on an ECMAScript-private field
 *  (`Viewport.#pan_and_zoom`), so nothing exports them to read at runtime; this
 *  citation is what keeps the literals honest. A zoom BUTTON must respect the same
 *  bounds as the wheel, or it walks the camera somewhere the wheel can never reach
 *  (24 steps in from 1.0 passes 190; the same out reaches ~0.005 — a board drawn as
 *  a dot until the next wheel event silently re-clamps it). */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 190;
const ZOOM_STEP = 1.25;

function sourceType(path: string): CanvasSource['type'] {
  const lower = path.toLowerCase();
  if (lower.endsWith('.kicad_pro')) return 'project';
  if (lower.endsWith('.kicad_pcb')) return 'board';
  return 'schematic';
}

/** KiCanvas resolves Sheetfile references by bare filename inside its virtual
 *  file system, so sources are named by basename; a second file with the same
 *  basename cannot be represented and is dropped (the reader still read it). */
export function sourcesFor(project: KicadProject): { sources: CanvasSource[]; dropped: string[] } {
  const ordered: string[] = [];
  for (const path of project.files.keys()) if (sourceType(path) === 'project') ordered.push(path);
  for (const sheet of project.sheets) ordered.push(sheet.path);
  for (const path of project.files.keys()) if (sourceType(path) === 'schematic' && !ordered.includes(path)) ordered.push(path);
  if (project.board != null) ordered.push(project.board);
  const seen = new Set<string>();
  const sources: CanvasSource[] = [];
  const dropped: string[] = [];
  for (const path of ordered) {
    const name = basename(path);
    if (seen.has(name)) {
      dropped.push(path);
      continue;
    }
    seen.add(name);
    sources.push({ name, type: sourceType(path), text: project.files.get(path) ?? '' });
  }
  return { sources, dropped };
}

/** `app.viewer` is a GETTER over a private field that upstream assigns only in
 *  render() (vendor kicanvas/src/kicanvas/elements/common/app.ts: field at :44,
 *  getter at :56, assignment at :200), so reading it before the first render
 *  throws a TypeError. Every reach into the renderer must return a result
 *  rather than throw — that is what the seam is for. */
function viewerOf(app: KicanvasApp | null): KicanvasViewer | null {
  try {
    return app?.viewer ?? null;
  } catch {
    return null;
  }
}

/** The identity upstream's own early return compares. `KCViewerElement.load` hands the
 *  viewer `src.document`, never the page (vendor kicanvas/elements/common/viewer.ts:77-79),
 *  and `DocumentViewer.load` returns at once when it already holds that object
 *  (viewers/base/document-viewer.ts:58-60) — BEFORE `resolve_loaded`, the sole dispatcher
 *  of `kicanvas:load` (viewers/base/viewer.ts:128-132). So when this is true, NO event is
 *  coming and waiting for one would burn the whole settle budget. */
function holdsDocument(viewer: KicanvasViewer | null, page: KicanvasPage): boolean {
  const held: unknown = viewer?.document;
  const wanted: unknown = page.document;
  return held != null && wanted != null && held === wanted;
}

/** A load listener armed BEFORE a page switch, so a renderer that loads
 *  synchronously cannot dispatch before anyone is listening. */
interface LoadWatch {
  fired: boolean;
  /** False when the viewer is not an EventTarget — then the filename fallback is all there is. */
  listening: boolean;
  cancel: () => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultVisibility = (): DocumentVisibilityState =>
  typeof document === 'undefined' ? 'visible' : document.visibilityState;

export class KicanvasController implements CanvasController {
  private readonly options: Required<KicanvasControllerOptions>;
  private embed: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private disposed = false;
  /** Bumped by every mount(). A superseded mount must not emit and must not run
   *  disposeEmbed() — its deadline would otherwise tear down the embed that
   *  replaced it. Remounting is the "Try again" gesture, so this is reachable. */
  private epoch = 0;
  /** Bumped by every activate(). The `hidden` writes happen after an await, so a slow
   *  earlier switch must not land on top of a newer one — that IS the "screen duplicates
   *  itself" class, arriving late. */
  private activation = 0;
  /** Path keys sourcesFor() could not hand to the embed (basename collision). */
  private droppedPaths = new Set<string>();
  private readonly handlers = new Map<CanvasEventType, Set<(e: CanvasEvent) => void>>();

  constructor(options: KicanvasControllerOptions = {}) {
    this.options = {
      loadModule: options.loadModule ?? (() => import('@vendor-build/kicanvas')),
      createEmbed: options.createEmbed ?? (() => document.createElement('kicanvas-embed')),
      readyMs: options.readyMs ?? CANVAS_READY_MS,
      settleMs: options.settleMs ?? 1500,
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? (() => Date.now()),
      visibility: options.visibility ?? defaultVisibility,
    };
  }

  on<T extends CanvasEventType>(type: T, handler: CanvasHandler<T>): () => void {
    const set = this.handlers.get(type) ?? new Set();
    const wrapped = handler as unknown as (e: CanvasEvent) => void;
    set.add(wrapped);
    this.handlers.set(type, set);
    return () => {
      set.delete(wrapped);
    };
  }

  private emit(event: CanvasEvent): void {
    for (const h of this.handlers.get(event.type) ?? []) h(event);
  }

  /** True once this mount has been superseded or disposed: it must go quiet. */
  private stale(epoch: number): boolean {
    return this.disposed || epoch !== this.epoch;
  }

  private apps(): { schematic: KicanvasApp | null; board: KicanvasApp | null } {
    const root = this.embed?.shadowRoot ?? null;
    return {
      schematic: (root?.querySelector('kc-schematic-app') as KicanvasApp | null) ?? null,
      board: (root?.querySelector('kc-board-app') as KicanvasApp | null) ?? null,
    };
  }

  private project(): KicanvasProject | null {
    const { schematic, board } = this.apps();
    return schematic?.project ?? board?.project ?? null;
  }

  /** The app showing the active page. Both `focusRef` and `zoom` must reach the
   *  same one, or they act on whatever the schematic viewer last held. */
  private activeApp(): KicanvasApp | null {
    const { schematic, board } = this.apps();
    return this.project()?.active_page?.type === 'pcb' ? board : schematic;
  }

  async mount(host: HTMLElement, project: KicadProject): Promise<void> {
    const epoch = ++this.epoch;
    this.disposeEmbed();
    this.host = host;
    this.disposed = false;
    this.emit({ type: 'state', state: 'loading' });
    try {
      // No memo here on purpose. A dynamic import() of one specifier already
      // evaluates the module body exactly once and hands back the same namespace
      // (proven for concurrent calls too), so the bundle is fetched once anyway.
      // A module-level cache would instead PIN the first failure forever — one
      // failed chunk fetch and no later mount in the page could ever recover —
      // and would hand every later controller the first one's loader.
      await this.options.loadModule();
    } catch (err) {
      if (this.stale(epoch)) return;
      this.emit({ type: 'state', state: 'error', detail: err instanceof Error ? err.message : 'renderer failed to load' });
      return;
    }
    if (this.stale(epoch)) return;
    const { sources, dropped } = sourcesFor(project);
    this.droppedPaths = new Set(dropped);
    const embed = this.options.createEmbed();
    embed.setAttribute('controls', 'basic');
    embed.setAttribute('controlslist', 'nodownload nooverlay');
    embed.setAttribute('theme', 'kicad');
    for (const source of sources) {
      const el = document.createElement('kicanvas-source');
      el.setAttribute('name', source.name);
      el.setAttribute('type', source.type);
      el.textContent = source.text;
      embed.appendChild(el);
    }
    this.embed = embed;
    host.replaceChildren(embed);

    let deadline = this.options.now() + this.options.readyMs;
    while (this.options.now() < deadline) {
      if (this.stale(epoch)) return;
      if (this.project()?.active_page != null) {
        // The embed activates `root_schematic_page` as soon as it has loaded
        // (vendor kicanvas/elements/kicanvas-embed.ts:173) — and that field is
        // whatever page came FIRST, because project.ts:274 reassigns it
        // unconditionally, which on any board-bearing project is the BOARD
        // (PCB pages are inserted at file-load time, :133-144). Neither app's
        // `hidden` belongs to us until we set it, so the mount ENDS with an
        // activate (spec §5.3): one enforced view before anyone sees `ready`.
        await this.activate(project.sheets.length > 0 ? 'schematic' : 'board');
        if (this.stale(epoch)) return;
        this.emit({ type: 'state', state: 'ready' });
        return;
      }
      const t0 = this.options.now();
      await this.options.sleep(POLL_MS);
      // A hidden tab throttles chained timers to about a second, so refunding a
      // fixed POLL_MS gives back ~1/20th of what the wait actually spent and fires
      // a FALSE timeout on a mount that was fine. Refund the real elapsed time.
      if (this.options.visibility() === 'hidden') deadline += this.options.now() - t0;
    }
    if (this.stale(epoch)) return;
    this.disposeEmbed();
    this.emit({ type: 'state', state: 'timeout' });
  }

  private findPage(view: CanvasView, sheet?: string): KicanvasPage | null {
    const project = this.project();
    if (project == null) return null;
    const pages = [...project.pages()];
    if (view === 'board') return pages.find((p) => p.type === 'pcb') ?? null;
    if (sheet == null) {
      // `root_schematic_page` is NOT trustworthy as a schematic: upstream assigns
      // it the first page unconditionally (vendor kicanvas/project.ts:274 — the
      // guard below it only logs) and PCB pages are inserted before the schematic
      // hierarchy (:133-144), so on any board-bearing project — Glasgow revC3, the
      // canonical fixture — that field IS the board. Take it only when it is
      // really a schematic; otherwise the first page that is one.
      const root = project.root_schematic_page;
      if (root?.type === 'schematic') return root;
      return pages.find((p) => p.type === 'schematic') ?? null;
    }
    // A file the embed never received cannot be shown, and its basename twin is a
    // DIFFERENT file — the fallback below would happily show it and report success.
    if (this.droppedPaths.has(sheet)) return null;
    const wanted = sheet.toLowerCase();
    const byInstance = pages.find((p) => p.type === 'schematic' && p.sheet_path.toLowerCase() === wanted);
    if (byInstance) return byInstance;
    const name = basename(sheet).toLowerCase();
    return pages.find((p) => p.type === 'schematic' && basename(p.filename).toLowerCase() === name) ?? null;
  }

  private watchLoad(viewer: KicanvasViewer | null): LoadWatch {
    const target = viewer as unknown as EventTarget | null;
    if (
      target == null ||
      typeof target.addEventListener !== 'function' ||
      typeof target.removeEventListener !== 'function'
    ) {
      return { fired: false, listening: false, cancel: () => undefined };
    }
    const watch: LoadWatch = { fired: false, listening: true, cancel: () => undefined };
    const onLoad = () => {
      watch.fired = true;
    };
    target.addEventListener(KICANVAS_LOAD, onLoad);
    watch.cancel = () => target.removeEventListener(KICANVAS_LOAD, onLoad);
    return watch;
  }

  /** Waits for one `kicanvas:load`, bounded. Only reached when the viewer does NOT
   *  already hold the requested document — see holdsDocument(). `Viewer extends
   *  EventTarget` (vendor viewers/base/viewer.ts:22), so an unlistenable watch means
   *  there is no viewer at all yet: nothing is coming, and waiting would only burn
   *  the budget. (The basename comparison this replaced could never observe a
   *  same-file instance switch, and was unreachable for any real viewer.) */
  private async settle(watch: LoadWatch): Promise<void> {
    if (!watch.listening) return;
    const deadline = this.options.now() + this.options.settleMs;
    while (this.options.now() < deadline) {
      if (watch.fired) return;
      await this.options.sleep(POLL_MS);
    }
  }

  async activate(view: CanvasView, sheet?: string): Promise<boolean> {
    const seq = ++this.activation;
    const mountEpoch = this.epoch;
    const project = this.project();
    const page = this.findPage(view, sheet);
    if (project == null || page == null) return false;
    const { schematic, board } = this.apps();
    const app = view === 'board' ? board : schematic;
    // When the target viewer already holds this page's document upstream dispatches
    // nothing (holdsDocument), and that is the COMMON gesture: a same-file instance
    // switch, a return to an app already visited, a second focusRef on the sheet on
    // screen, mount's closing activate on a single-type project. Arm the listener only
    // when a load really has to happen — and arm it BEFORE the switch, since
    // set_active_page dispatches "change" synchronously and the app loads from there.
    const watch = holdsDocument(viewerOf(app), page) ? null : this.watchLoad(viewerOf(app));
    try {
      // The PAGE OBJECT, never the path string: upstream's set_active_page falls
      // back to first_page when a path does not resolve (vendor kicanvas/src/
      // kicanvas/project.ts:353-355), which would show the wrong sheet and still
      // look like success. findPage decides, so a miss is an honest false.
      project.set_active_page(page);
    } catch {
      watch?.cancel();
      return false;
    }
    if (watch != null) {
      await this.settle(watch);
      watch.cancel();
    }
    // A newer activate, or a newer mount, owns the view now: this one is late and must
    // not write `hidden` at all. Upstream's app.load() assigns `hidden = false` AFTER an
    // await, so two quick page changes can leave both apps visible side by side (the
    // owner's "screen duplicates itself", reproduced 2026-09-12) — the writes below are
    // how we prevent that, and a stale one would re-create it.
    if (seq !== this.activation || this.stale(mountEpoch)) return false;
    if (schematic) schematic.hidden = view !== 'schematic';
    if (board) board.hidden = view !== 'board';
    return true;
  }

  async focusRef(ref: string, sheet?: string): Promise<FocusResult> {
    if (sheet != null && !(await this.activate('schematic', sheet))) return 'not-found';
    // The app showing the ACTIVE page, exactly as zoom() picks it: BoardViewer.select()
    // also takes a string and resolves a footprint by uuid or reference (vendor
    // viewers/board/viewer.ts:94-106), so with the board active the honest answer is
    // reachable — hard-coding the schematic app answered 'unsupported' forever.
    const viewer = viewerOf(this.activeApp());
    if (viewer?.document == null || typeof viewer.select !== 'function' || typeof viewer.zoom_to_selection !== 'function') {
      return 'unsupported';
    }
    try {
      // SchematicViewer.select takes a string and resolves it to a symbol or sheet
      // (vendor viewers/schematic/viewer.ts:62-77); an unresolved ref lands on
      // DocumentViewer.select as undefined, which sets `selected` to null rather
      // than throwing (viewers/base/document-viewer.ts:148-157).
      viewer.select(ref);
    } catch {
      return 'unsupported';
    }
    if (!viewer.selected) return 'not-found';
    try {
      viewer.zoom_to_selection();
    } catch {
      return 'unsupported';
    }
    this.emit({ type: 'selection', ref });
    return 'focused';
  }

  /** The camera API, read out of the vendored source: `zoom_to_page()` is abstract on
   *  Viewer (viewers/base/viewer.ts:244) and implemented on DocumentViewer
   *  (viewers/base/document-viewer.ts:133) — it repaints itself. The steps move
   *  `viewer.viewport.camera.zoom`, a plain number (base/math/camera2.ts:32, reached
   *  through viewers/base/viewport.ts:23), and then repaint with the VIEWER's draw():
   *  Viewport exposes no draw at all, and viewer.draw() (viewers/base/viewer.ts:165,
   *  overridden public at document-viewer.ts:138) is what upstream's own
   *  zoom_to_page and zoom_to_selection call. Every path feature-detects and
   *  returns false. */
  async zoom(action: ZoomAction): Promise<boolean> {
    const viewer = viewerOf(this.activeApp()) as (KicanvasViewer & { zoom_to_page?: () => void; viewport?: { camera?: { zoom: number } } }) | null;
    if (viewer?.document == null) return false;
    try {
      if (action === 'fit') {
        if (typeof viewer.zoom_to_page !== 'function') return false;
        viewer.zoom_to_page();
        return true;
      }
      const camera = viewer.viewport?.camera;
      if (camera == null || typeof camera.zoom !== 'number') return false;
      const next = action === 'in' ? camera.zoom * ZOOM_STEP : camera.zoom / ZOOM_STEP;
      camera.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
      viewer.draw?.();
      return true;
    } catch {
      return false;
    }
  }

  private disposeEmbed(): void {
    if (this.embed != null) {
      // Release the renderer's GL contexts before dropping the element: browsers cap
      // live contexts and a visitor opening several projects in one tab would otherwise
      // accumulate them (the spike's repeated loads degraded visibly).
      const canvases: HTMLCanvasElement[] = [];
      const walk = (root: ParentNode) => {
        for (const el of root.querySelectorAll('*')) {
          if (el instanceof HTMLCanvasElement) canvases.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      if (this.embed.shadowRoot) walk(this.embed.shadowRoot);
      for (const canvas of canvases) {
        try {
          const gl = canvas.getContext('webgl2') as { getExtension?: (n: string) => { loseContext: () => void } | null } | null;
          gl?.getExtension?.('WEBGL_lose_context')?.loseContext();
        } catch {
          // a canvas with a 2d context, or none — nothing to release
        }
      }
      if (this.host != null && this.embed.parentNode === this.host) this.host.removeChild(this.embed);
    }
    this.embed = null;
  }

  dispose(): void {
    this.disposed = true;
    this.disposeEmbed();
    this.host = null;
    this.droppedPaths.clear();
    // Handler closures reach the page that mounted us; a disposed controller must
    // not keep them alive, and must not call them if a stray turn still lands.
    this.handlers.clear();
  }
}
