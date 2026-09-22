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

/** What a physical board layer is for. */
export type LayerKind = 'copper' | 'mask' | 'paste' | 'silk' | 'courtyard' | 'fab' | 'edge' | 'user' | 'other';

/** One PHYSICAL board layer as the renderer holds it now. Virtual layers a
 *  renderer invents for its own drawing (pads, hole walls, zone fills, net
 *  names…) are never listed. */
export interface LayerInfo {
  /** KiCad's canonical layer name — `F.Cu`, `B.SilkS`, `Edge.Cuts`. */
  name: string;
  kind: LayerKind;
  side: 'F' | 'B' | 'In' | null;
  /** The colour the renderer draws the layer in, as a CSS colour. */
  color: string;
  visible: boolean;
  highlighted: boolean;
}

/** The object classes of the 2D board drawing that carry their own opacity. */
export type ObjectClass2D = 'tracks' | 'vias' | 'pads' | 'holes' | 'zones' | 'grid' | 'page';

export interface NetInfo {
  number: number;
  name: string;
}

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
  /**
   * The board's layer list, as `layers()` answers it. Emitted after every board
   * load — a renderer rebuilds its layer state per load, so a host re-applies its
   * own visibility, highlight, opacity and net choices on this event — when the
   * board becomes the drawing on screen, and after any layer change the
   * controller made (a visibility or highlight call that actually changed
   * something; one that changes nothing emits nothing, so a host re-applying on
   * this event settles instead of looping). Never emitted with an empty list.
   */
  | { type: 'layers'; layers: LayerInfo[] }
  | { type: 'documentChanged'; path: string; text: string };

export type CanvasEventType = CanvasEvent['type'];
export type CanvasHandler<T extends CanvasEventType> = (event: Extract<CanvasEvent, { type: T }>) => void;

export interface CanvasController {
  /** Load every file of the project into the host element. Resolves on `ready`; rejects never — failures arrive as `state` events. */
  mount(host: HTMLElement, project: KicadProject): Promise<void>;
  /** Show the board, or a schematic sheet (a path key from the project, or an instance path). True when a page was found. */
  activate(view: CanvasView, sheet?: string): Promise<boolean>;
  /**
   * Select and zoom to a reference designator, switching sheet first when one
   * is given. `view` names the drawing to select on: `'board'` shows the board
   * first (a footprint), `'schematic'` a sheet (a symbol; `sheet` is its
   * instance path). Absent, the drawing on screen is used as it stands.
   */
  focusRef(ref: string, sheet?: string, view?: CanvasView): Promise<FocusResult>;
  /**
   * Select a reference designator WITHOUT moving the camera — the selection
   * outline appears where the part already is — switching sheet or view first
   * on the same terms as `focusRef`. `null` clears the selection on the
   * visible drawing. A host uses this to carry a selection made elsewhere (the
   * 3D view, the part panel) onto the drawing the reader arrives at;
   * `focusRef` is for a gesture that asked to be TAKEN to the part.
   */
  selectRef(ref: string | null, sheet?: string, view?: CanvasView): Promise<FocusResult>;
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
  // The board controls below are OPTIONAL: a renderer without them gets no
  // Layers/Objects controls. Each acts on the BOARD drawing only, and only while
  // it is the one on screen — with a schematic showing, `layers()` and `nets()`
  // answer [] and every setter does nothing. A host keeps its own copy of the
  // choices and re-applies them on the `layers` event.
  /** The board's physical layers in the renderer's layer-panel order; [] before the board has loaded. */
  layers?(): LayerInfo[];
  setLayerVisible?(name: string, visible: boolean): void;
  /** Draw `name` above the rest and dim everything else; null clears. */
  highlightLayer?(name: string | null): void;
  /** 0..1; 0 hides the class. */
  setObjectOpacity?(kind: ObjectClass2D, opacity: number): void;
  /** The board's nets, from the loaded board; [] before load. */
  nets?(): NetInfo[];
  /** Highlight one net's copper; null clears. */
  highlightNet?(net: number | null): void;
  dispose(): void;
  on<T extends CanvasEventType>(type: T, handler: CanvasHandler<T>): () => void;
}

export type ZoomAction = 'fit' | 'in' | 'out';

export interface CanvasSource {
  name: string;
  type: 'project' | 'schematic' | 'board';
  text: string;
}
