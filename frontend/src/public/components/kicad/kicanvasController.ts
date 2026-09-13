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
}

export const CANVAS_READY_MS = 15000;
const POLL_MS = 50;

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

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class KicanvasController implements CanvasController {
  private readonly options: Required<KicanvasControllerOptions>;
  private embed: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private disposed = false;
  private readonly handlers = new Map<CanvasEventType, Set<(e: CanvasEvent) => void>>();

  constructor(options: KicanvasControllerOptions = {}) {
    this.options = {
      loadModule: options.loadModule ?? (() => import('@vendor-build/kicanvas')),
      createEmbed: options.createEmbed ?? (() => document.createElement('kicanvas-embed')),
      readyMs: options.readyMs ?? CANVAS_READY_MS,
      settleMs: options.settleMs ?? 1500,
      sleep: options.sleep ?? defaultSleep,
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

  async mount(host: HTMLElement, project: KicadProject): Promise<void> {
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
      this.emit({ type: 'state', state: 'error', detail: err instanceof Error ? err.message : 'renderer failed to load' });
      return;
    }
    if (this.disposed) return;
    const embed = this.options.createEmbed();
    embed.setAttribute('controls', 'basic');
    embed.setAttribute('controlslist', 'nodownload nooverlay');
    embed.setAttribute('theme', 'kicad');
    for (const source of sourcesFor(project).sources) {
      const el = document.createElement('kicanvas-source');
      el.setAttribute('name', source.name);
      el.setAttribute('type', source.type);
      el.textContent = source.text;
      embed.appendChild(el);
    }
    this.embed = embed;
    host.replaceChildren(embed);

    let deadline = Date.now() + this.options.readyMs;
    while (Date.now() < deadline) {
      if (this.disposed) return;
      if (this.project()?.active_page != null) {
        // The embed's own initial page is whatever `first_page` is (the board, on
        // Glasgow) — the host's first activate() sets the requested view.
        this.emit({ type: 'state', state: 'ready' });
        return;
      }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        // Background tabs throttle animation frames; the mount just waits. Do not
        // count hidden time against the deadline.
        deadline += POLL_MS;
      }
      await this.options.sleep(POLL_MS);
      if (this.options.sleep !== defaultSleep && Date.now() >= deadline) break;
    }
    this.disposeEmbed();
    this.emit({ type: 'state', state: 'timeout' });
  }

  private findPage(view: CanvasView, sheet?: string): KicanvasPage | null {
    const project = this.project();
    if (project == null) return null;
    const pages = [...project.pages()];
    if (view === 'board') return pages.find((p) => p.type === 'pcb') ?? null;
    if (sheet == null) return project.root_schematic_page ?? pages.find((p) => p.type === 'schematic') ?? null;
    const wanted = sheet.toLowerCase();
    const byInstance = pages.find((p) => p.type === 'schematic' && p.sheet_path.toLowerCase() === wanted);
    if (byInstance) return byInstance;
    const name = basename(sheet).toLowerCase();
    return pages.find((p) => p.type === 'schematic' && basename(p.filename).toLowerCase() === name) ?? null;
  }

  async activate(view: CanvasView, sheet?: string): Promise<boolean> {
    const project = this.project();
    const page = this.findPage(view, sheet);
    if (project == null || page == null) return false;
    try {
      // The PAGE OBJECT, never the path string: upstream's set_active_page falls
      // back to first_page when a path does not resolve (vendor kicanvas/src/
      // kicanvas/project.ts:353-355), which would show the wrong sheet and still
      // look like success. findPage decides, so a miss is an honest false.
      project.set_active_page(page);
    } catch {
      return false;
    }
    const { schematic, board } = this.apps();
    const app = view === 'board' ? board : schematic;
    const deadline = Date.now() + this.options.settleMs;
    while (Date.now() < deadline) {
      const doc = viewerOf(app)?.document;
      if (doc == null || doc.filename == null || basename(doc.filename) === basename(page.filename)) break;
      await this.options.sleep(POLL_MS);
      if (this.options.sleep !== defaultSleep) break;
    }
    // Upstream's app.load() assigns `hidden = false` AFTER an await, so two quick page
    // changes can leave both apps visible side by side (the owner's "screen duplicates
    // itself", reproduced 2026-09-12). Visibility is ours to enforce, every time.
    if (schematic) schematic.hidden = view !== 'schematic';
    if (board) board.hidden = view !== 'board';
    return true;
  }

  async focusRef(ref: string, sheet?: string): Promise<FocusResult> {
    if (sheet != null && !(await this.activate('schematic', sheet))) return 'not-found';
    const viewer = viewerOf(this.apps().schematic);
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
    const { schematic, board } = this.apps();
    const app = this.project()?.active_page?.type === 'pcb' ? board : schematic;
    const viewer = viewerOf(app) as (KicanvasViewer & { zoom_to_page?: () => void; viewport?: { camera?: { zoom: number } } }) | null;
    if (viewer?.document == null) return false;
    try {
      if (action === 'fit') {
        if (typeof viewer.zoom_to_page !== 'function') return false;
        viewer.zoom_to_page();
        return true;
      }
      const camera = viewer.viewport?.camera;
      if (camera == null || typeof camera.zoom !== 'number') return false;
      camera.zoom = action === 'in' ? camera.zoom * 1.25 : camera.zoom / 1.25;
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
  }
}
