// The only surface pages, the session and the BOM units see of a renderer
// (spec §5.5). Stage 1 ships one implementation (KiCanvas, read-only). The
// later editor stage implements the same interface over KiCad-as-WebAssembly
// and starts emitting `documentChanged` and `selection`; nothing here emits
// them yet and nothing outside this folder may import a renderer directly.
import type { KicadProject } from '@public/services/kicad/types';

export type CanvasView = 'schematic' | 'board';
export type CanvasStateName = 'loading' | 'ready' | 'no-webgl' | 'timeout' | 'error';
export type FocusResult = 'focused' | 'not-found' | 'unsupported';

export type CanvasEvent =
  | { type: 'state'; state: CanvasStateName; detail?: string }
  | { type: 'selection'; ref: string | null }
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
  /** Fit the page, or step the zoom. False when the renderer exposes no such control (the buttons then hide). */
  zoom(action: ZoomAction): Promise<boolean>;
  dispose(): void;
  on<T extends CanvasEventType>(type: T, handler: CanvasHandler<T>): () => void;
}

export type ZoomAction = 'fit' | 'in' | 'out';

export interface CanvasSource {
  name: string;
  type: 'project' | 'schematic' | 'board';
  text: string;
}
