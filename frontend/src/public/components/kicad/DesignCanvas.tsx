// The React host over a CanvasController (spec §5.2). Owns the container, the
// WebGL2 probe, the ready timeout's user-facing states and the "Try again".
// Never touches the embed: everything goes through the controller.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { KicadProject } from '@public/services/kicad/types';
import type {
  CanvasController,
  CanvasStateName,
  CanvasView,
  FocusResult,
  LayerInfo,
  NetInfo,
  ObjectClass2D,
  ZoomAction,
} from './canvasController';

/** What the drawing's selection became, and where. See `CanvasEvent`'s `selection`. */
export interface CanvasSelection {
  ref: string | null;
  sheet?: string;
  view?: CanvasView;
}
import { KicanvasController } from './kicanvasController';
import { webgl2Supported } from './webgl';
import styles from './DesignCanvas.module.scss';

export interface DesignCanvasProps {
  /**
   * The project to render. **Referentially stable:** the host keys its mount on object
   * identity, so a new identity disposes the renderer and reloads the whole project.
   * Callers pass the SAME object across renders (the design session holds one) — never
   * a `buildProject(...)` call in a render body or a `useMemo` with an unstable dep.
   */
  project: KicadProject;
  view: CanvasView;
  /** Path key of the schematic to show, or an instance path; default root. */
  activeSheet?: string;
  onState?: (state: CanvasStateName, detail?: string) => void;
  /**
   * The drawing's selection changed — the reader clicked a symbol or footprint
   * (or nothing), or a `focusRef`/`selectRef` landed. Held through a ref like
   * `onState`, so an inline arrow never remounts the embed.
   */
  onSelection?: (selection: CanvasSelection) => void;
  /**
   * The sheets the mounted renderer cannot draw for this project, reported once
   * per mount and BEFORE the renderer bundle is even fetched — so a host can
   * mark them on the first paint instead of a frame later.
   *
   * Always called, with `[]` when the renderer answers none or when there is no
   * renderer at all (no WebGL2): a host must never be left holding a set from a
   * previous project, and "this renderer drops nothing" is an answer, not a
   * silence.
   */
  onUnrenderableSheets?: (paths: string[]) => void;
  /**
   * The board's layer list changed or was rebuilt — the controller's `layers` event.
   * Arrives after every board load (the renderer has just discarded every layer,
   * opacity and net choice), when the board comes back on screen, and after a
   * handle call that changed a layer. A host re-applies its board-view state here.
   * Held through a ref like `onSelection`, so an inline arrow never remounts.
   */
  onLayers?: (layers: LayerInfo[]) => void;
  /**
   * How much room the frame takes. `default` fills the parent (the viewer hands
   * it the viewport below the tabs); `compact` is a fixed slice of the viewport,
   * for a host where the drawing is context beside its real subject — the BOM
   * page's panel above the priced table.
   */
  height?: 'default' | 'compact';
  /**
   * What the overlay's fullscreen button takes fullscreen. Default: this frame,
   * which is right where the drawing is context beside its subject (/bom). The
   * viewer hands in its whole workspace instead, so the top bar, the rail and
   * the drawer come along and the reader keeps every tool in fullscreen. Read at
   * CLICK time, so a ref that is not yet populated is fine.
   */
  fullscreenTarget?: () => HTMLElement | null;
  /** Test seam. Defaults to a KicanvasController. */
  createController?: () => CanvasController;
}

export interface DesignCanvasHandle {
  focusRef(ref: string, sheet?: string, view?: CanvasView): Promise<FocusResult>;
  /** Select without moving the camera; null clears. See `CanvasController.selectRef`. */
  selectRef(ref: string | null, sheet?: string, view?: CanvasView): Promise<FocusResult>;
  zoom(action: ZoomAction): Promise<boolean>;
  /** True while the mounted renderer implements the board controls below; a host
   *  shows no Layers/Objects controls without them. False with no renderer at all. */
  hasBoardControls(): boolean;
  // The board controls, forwarded to the mounted controller at CALL time (see
  // `CanvasController`): they act on the board only while it is on screen, and
  // with no renderer — or one without them — answer [] and do nothing.
  layers(): LayerInfo[];
  setLayerVisible(name: string, visible: boolean): void;
  highlightLayer(name: string | null): void;
  setObjectOpacity(kind: ObjectClass2D, opacity: number): void;
  nets(): NetInfo[];
  highlightNet(net: number | null): void;
}

const COPY: Record<Exclude<CanvasStateName, 'loading' | 'ready'>, { title: string; body: string }> = {
  'no-webgl': {
    title: 'This browser has WebGL disabled',
    body: 'The drawing needs WebGL 2 to render. Enable hardware acceleration or try another browser — the BOM and stackup tabs work without it.',
  },
  timeout: {
    title: "Couldn't render this file in time",
    body: 'The renderer did not finish. It reads KiCad 6 and newer files; very large boards can take longer on this device.',
  },
  error: {
    title: "Couldn't render this file",
    body: 'The renderer failed while reading it. It reads KiCad 6 and newer files.',
  },
};

const DesignCanvas = forwardRef<DesignCanvasHandle, DesignCanvasProps>(function DesignCanvas(
  { project, view, activeSheet, onState, onSelection, onUnrenderableSheets, onLayers, height = 'default', fullscreenTarget, createController },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<CanvasController | null>(null);
  const [state, setState] = useState<CanvasStateName>('loading');
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const supported = webgl2Supported();
  // `onState` is NOT an effect dep on purpose: a parent passing an inline arrow would
  // remount the canvas — and reload the project — on every one of its renders. The ref
  // is what keeps the callback current without paying that.
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  // Same reason as `onState` above: a parent passing an inline arrow must not
  // remount the canvas — and this one reloads the project.
  const onUnrenderableRef = useRef(onUnrenderableSheets);
  onUnrenderableRef.current = onUnrenderableSheets;
  const onSelectionRef = useRef(onSelection);
  onSelectionRef.current = onSelection;
  const onLayersRef = useRef(onLayers);
  onLayersRef.current = onLayers;

  useEffect(() => {
    if (!supported) {
      setState('no-webgl');
      onStateRef.current?.('no-webgl');
      // No renderer means nothing is unrenderable for renderer-specific
      // reasons. Reporting [] rather than nothing keeps the host from carrying
      // a previous project's answer into this one.
      onUnrenderableRef.current?.([]);
      return;
    }
    const host = hostRef.current;
    if (host == null) return;
    let cancelled = false;
    const controller = (createController ?? (() => new KicanvasController()))();
    controllerRef.current = controller;
    // BEFORE mount(): that is where the renderer bundle is dynamically imported
    // and awaited, so answering here costs the host nothing and lands on the
    // same commit that first paints the sheet chips.
    onUnrenderableRef.current?.(controller.unrenderableSheets?.(project) ?? []);
    const off = controller.on('state', (e) => {
      if (cancelled) return;
      setState(e.state);
      setDetail(e.detail);
      onStateRef.current?.(e.state, e.detail);
    });
    const offSelection = controller.on('selection', (e) => {
      if (cancelled) return;
      onSelectionRef.current?.({ ref: e.ref, sheet: e.sheet, view: e.view });
    });
    const offLayers = controller.on('layers', (e) => {
      if (cancelled) return;
      onLayersRef.current?.(e.layers);
    });
    void controller.mount(host, project);
    return () => {
      cancelled = true;
      off();
      offSelection();
      offLayers();
      controller.dispose();
      controllerRef.current = null;
    };
    // `attempt` re-mounts on "Try again"; onState/createController are stable by
    // convention. The react-hooks plugin isn't installed here, so no disable comment
    // (an unknown rule in a directive is itself an eslint error).
  }, [project, attempt, supported]);

  useEffect(() => {
    if (state !== 'ready') return;
    void controllerRef.current?.activate(view, activeSheet);
  }, [state, view, activeSheet]);

  // Every member reads `controllerRef.current` at CALL time, so the handle never goes
  // stale and `[]` keeps its identity fixed — a parent may hold it in a dep array.
  useImperativeHandle(ref, () => ({
    focusRef: (r, sheet, view) => controllerRef.current?.focusRef(r, sheet, view) ?? Promise.resolve('unsupported' as const),
    selectRef: (r, sheet, view) => controllerRef.current?.selectRef(r, sheet, view) ?? Promise.resolve('unsupported' as const),
    zoom: (action) => controllerRef.current?.zoom(action) ?? Promise.resolve(false),
    hasBoardControls: () => typeof controllerRef.current?.layers === 'function',
    layers: () => controllerRef.current?.layers?.() ?? [],
    setLayerVisible: (name, visible) => controllerRef.current?.setLayerVisible?.(name, visible),
    highlightLayer: (name) => controllerRef.current?.highlightLayer?.(name),
    setObjectOpacity: (kind, opacity) => controllerRef.current?.setObjectOpacity?.(kind, opacity),
    nets: () => controllerRef.current?.nets?.() ?? [],
    highlightNet: (net) => controllerRef.current?.highlightNet?.(net),
  }), []);

  const frameRef = useRef<HTMLDivElement>(null);
  // The mount effect's `cancelled` is per ATTEMPT; this is per COMPONENT, which is the
  // lifetime `zoom` below needs — it is not owned by that effect and awaits across it.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const [zoomable, setZoomable] = useState(true);
  const zoom = async (action: ZoomAction) => {
    const ok = await controllerRef.current?.zoom(action);
    if (ok === false && aliveRef.current) setZoomable(false);
  };
  const fullscreenEnabled = typeof document !== 'undefined' && document.fullscreenEnabled;
  const fullscreenTargetRef = useRef(fullscreenTarget);
  fullscreenTargetRef.current = fullscreenTarget;
  const target = () => fullscreenTargetRef.current?.() ?? frameRef.current;
  /** Is OUR element the fullscreen one? Tracked so the button reads as pressed
   *  and offers the exit — the reader may also have left by Esc, which only
   *  the document's event reports. */
  const [inFullscreen, setInFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreenEnabled) return;
    const sync = () => setInFullscreen(document.fullscreenElement != null && document.fullscreenElement === target());
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [fullscreenEnabled]);
  const toggleFullscreen = () => {
    const el = target();
    if (el == null) return;
    // Both reject on reachable paths — a permissions-policy denial, an iframe without
    // allow="fullscreen", a request the browser does not count as user-activated. `void`
    // discards the VALUE, not the rejection, so without this a plain button click raises
    // an unhandledrejection.
    if (document.fullscreenElement === el) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen().catch(() => undefined);
  };

  const failed = state === 'no-webgl' || state === 'timeout' || state === 'error';
  return (
    <div
      ref={frameRef}
      className={height === 'compact' ? `${styles.frame} ${styles.frameCompact}` : styles.frame}
    >
      <div ref={hostRef} className={styles.host} hidden={failed} />
      {state === 'ready' && (
        <div className={styles.controls} role="group" aria-label="View controls">
          {zoomable && (
            <>
              <button type="button" className={styles.ctl} onClick={() => void zoom('fit')} aria-label="Fit to page">Fit</button>
              <button type="button" className={styles.ctl} onClick={() => void zoom('in')} aria-label="Zoom in">&#43;</button>
              <button type="button" className={styles.ctl} onClick={() => void zoom('out')} aria-label="Zoom out">&#8722;</button>
            </>
          )}
          {fullscreenEnabled && (
            <button
              type="button"
              className={styles.ctl}
              onClick={toggleFullscreen}
              aria-label={inFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              aria-pressed={inFullscreen}
            >
              &#x26F6;
            </button>
          )}
        </div>
      )}
      {state === 'loading' && (
        <p className={styles.status} role="status">
          Rendering&#8230;
        </p>
      )}
      {failed && (
        <div className={styles.problem} role="alert">
          <p className={styles.problemTitle}>{COPY[state].title}</p>
          <p className={styles.problemBody}>
            {COPY[state].body}
            {detail != null && state === 'error' ? ` (${detail})` : ''}
          </p>
          {state !== 'no-webgl' && (
            <button type="button" className={styles.retry} onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
});

export default DesignCanvas;
