// The only surface pages, the session and the BOM units see of a renderer
// (spec §5.5). Stage 1 ships one implementation (KiCanvas, read-only). The
// later editor stage implements the same interface over KiCad-as-WebAssembly
// and starts emitting `documentChanged` and `selection`; nothing here emits
// them yet and nothing outside this folder may import a renderer directly.
import type { KicadProject } from '@public/services/kicad/types';

export type CanvasView = 'schematic' | 'board';
export type CanvasStateName = 'loading' | 'ready' | 'no-webgl' | 'timeout' | 'error';
/**
 * What a focus request came to.
 *
 * `superseded` is the one that is not a failure: a NEWER gesture — the reader
 * picking a different sheet while this focus was still loading — took the view,
 * and the focus stood down rather than dragging the drawing back to where it
 * was going. A host must treat it as "say nothing": the reader has already
 * moved on, and narrating the click they abandoned is worse than silence.
 */
export type FocusResult = 'focused' | 'not-found' | 'unsupported' | 'superseded';

export type CanvasEvent =
  | { type: 'state'; state: CanvasStateName; detail?: string }
  /**
   * The drawing's selection changed. `ref` is the reference designator of the
   * symbol or footprint now selected, or null when the reader selected nothing
   * identifiable (empty canvas, a wire, a sheet) or cleared it. `sheet` is the
   * active schematic page's instance path — the same string `focusRef` takes —
   * and `view` says which drawing the gesture came from. Emitted for the
   * renderer's own picks AND for the controller's `focusRef`/`selectRef`, so a
   * host can keep one selection whichever door it came through.
   */
  | { type: 'selection'; ref: string | null; sheet?: string; view?: CanvasView }
  | { type: 'documentChanged'; path: string; text: string };

export type CanvasEventType = CanvasEvent['type'];
export type CanvasHandler<T extends CanvasEventType> = (event: Extract<CanvasEvent, { type: T }>) => void;

export interface CanvasController {
  /** Load every file of the project into the host element. Resolves on `ready`; rejects never — failures arrive as `state` events. */
  mount(host: HTMLElement, project: KicadProject): Promise<void>;
  /** Show the board, or a schematic sheet (a path key from the project, or an instance path). True when a page was found. */
  activate(view: CanvasView, sheet?: string): Promise<boolean>;
  /** Select and zoom to a reference designator, switching sheet first when one is given. */
  focusRef(ref: string, sheet?: string): Promise<FocusResult>;
  /**
   * Select a reference designator WITHOUT moving the camera — the selection
   * outline appears where the part already is — switching sheet first when one
   * is given. `null` clears the selection on the visible drawing. A host uses
   * this to carry a selection made elsewhere (the 3D view, the part panel)
   * onto the drawing the reader arrives at; `focusRef` is for a gesture that
   * asked to be TAKEN to the part.
   */
  selectRef(ref: string | null, sheet?: string): Promise<FocusResult>;
  /** Fit the page, or step the zoom. False when the renderer exposes no such control (the buttons then hide). */
  zoom(action: ZoomAction): Promise<boolean>;
  /**
   * Path keys of sheets THIS renderer cannot draw for this project — answerable
   * from the project alone, before anything is mounted, so a host can mark them
   * on the first paint rather than a frame later.
   *
   * Optional because it is a statement about one renderer's limits, not about
   * the project: KiCanvas keys its virtual file system by basename and so must
   * drop a second `power.kicad_sch`, where a path-keyed renderer drops nothing
   * and simply does not implement this. A host MUST treat an absent
   * implementation as "none", never as "unknown".
   */
  unrenderableSheets?(project: KicadProject): string[];
  dispose(): void;
  on<T extends CanvasEventType>(type: T, handler: CanvasHandler<T>): () => void;
}

export type ZoomAction = 'fit' | 'in' | 'out';

export interface CanvasSource {
  name: string;
  type: 'project' | 'schematic' | 'board';
  text: string;
}
