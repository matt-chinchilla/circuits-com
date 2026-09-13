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
  project: KicadProject;
  view: CanvasView;
  /** Path key of the schematic to show, or an instance path; default root. */
  activeSheet?: string;
  onState?: (state: CanvasStateName, detail?: string) => void;
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
  { project, view, activeSheet, onState, createController },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<CanvasController | null>(null);
  const [state, setState] = useState<CanvasStateName>('loading');
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const supported = webgl2Supported();

  useEffect(() => {
    if (!supported) {
      setState('no-webgl');
      onState?.('no-webgl');
      return;
    }
    const host = hostRef.current;
    if (host == null) return;
    const controller = (createController ?? (() => new KicanvasController()))();
    controllerRef.current = controller;
    const off = controller.on('state', (e) => {
      setState(e.state);
      setDetail(e.detail);
      onState?.(e.state, e.detail);
    });
    void controller.mount(host, project);
    return () => {
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

  useImperativeHandle(ref, () => ({
    focusRef: (r, sheet) => controllerRef.current?.focusRef(r, sheet) ?? Promise.resolve('unsupported' as const),
    zoom: (action) => controllerRef.current?.zoom(action) ?? Promise.resolve(false),
  }));

  const frameRef = useRef<HTMLDivElement>(null);
  const [zoomable, setZoomable] = useState(true);
  const zoom = async (action: ZoomAction) => {
    const ok = await controllerRef.current?.zoom(action);
    if (ok === false) setZoomable(false);
  };
  const fullscreenEnabled = typeof document !== 'undefined' && document.fullscreenEnabled;
  const toggleFullscreen = () => {
    const el = frameRef.current;
    if (el == null) return;
    if (document.fullscreenElement === el) void document.exitFullscreen();
    else void el.requestFullscreen();
  };

  const failed = state === 'no-webgl' || state === 'timeout' || state === 'error';
  return (
    <div ref={frameRef} className={styles.frame} data-state={state}>
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
