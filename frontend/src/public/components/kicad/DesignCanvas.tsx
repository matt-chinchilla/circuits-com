// The React host over a CanvasController (spec §5.2). Owns the container, the
// WebGL2 probe, the ready timeout's user-facing states and the "Try again".
// Never touches the embed: everything goes through the controller.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { KicadProject } from '@public/services/kicad/types';
import type { CanvasController, CanvasStateName, CanvasView, FocusResult, ZoomAction } from './canvasController';
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
   * How much room the frame takes. `default` fills the parent (the viewer hands
   * it the viewport below the tabs); `compact` is a fixed slice of the viewport,
   * for a host where the drawing is context beside its real subject — the BOM
   * page's panel above the priced table.
   */
  height?: 'default' | 'compact';
  /** Test seam. Defaults to a KicanvasController. */
  createController?: () => CanvasController;
}

export interface DesignCanvasHandle {
  focusRef(ref: string, sheet?: string): Promise<FocusResult>;
  zoom(action: ZoomAction): Promise<boolean>;
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
  { project, view, activeSheet, onState, onUnrenderableSheets, height = 'default', createController },
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
    void controller.mount(host, project);
    return () => {
      cancelled = true;
      off();
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

  // Both members read `controllerRef.current` at CALL time, so the handle never goes
  // stale and `[]` keeps its identity fixed — a parent may hold it in a dep array.
  useImperativeHandle(ref, () => ({
    focusRef: (r, sheet) => controllerRef.current?.focusRef(r, sheet) ?? Promise.resolve('unsupported' as const),
    zoom: (action) => controllerRef.current?.zoom(action) ?? Promise.resolve(false),
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
  const toggleFullscreen = () => {
    const el = frameRef.current;
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
            <button type="button" className={styles.ctl} onClick={toggleFullscreen} aria-label="Fullscreen">&#x26F6;</button>
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
