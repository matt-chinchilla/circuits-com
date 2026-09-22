// The React host over a SceneRenderer (spec 2026-09-21 §5, §7). Owns the toolbar,
// the three states, the caption — and the renderer's LIFETIME: mounting it when a
// scene is ready and disposing it, with its WebGL context, the moment this
// component goes away. The 3D tab is unmounted when it is not selected, so that
// disposal is the mechanism keeping one live context on the page, not two.
//
// It never touches three, a canvas or a geometry. Everything goes through the
// SceneRenderer seam, which is also what lets the tests drive it with a fake.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { BoardScene, Quality } from '@public/services/kicad/board3d/types';
import type { BoardStackup, KicadProject } from '@public/services/kicad/types';
import { webgl2Supported } from '../webgl';
import { ORBIT } from './board3dTheme';
import { currentQuality } from './quality';
import { createSceneRenderer, type SceneRenderer, type ViewName } from './sceneRenderer';
import { useBoardScene } from './useBoardScene';
import styles from './Board3DView.module.scss';

export interface Board3DViewProps {
  /** Referentially stable: the scene cache and the mount both key on identity. */
  project: KicadProject;
  stackup: BoardStackup | null;
  /** Test seam. Defaults to the three.js renderer. Stable by convention — it is
   *  deliberately NOT a mount dependency, so an inline arrow cannot remount the
   *  renderer (and re-acquire a context) on every parent render. */
  createRenderer?: () => SceneRenderer;
  /** Overrides the device heuristic, which is otherwise decided once at mount. */
  quality?: Quality;
  /** The designator to draw highlighted, or null/undefined for none. Applied
   *  whenever it changes and again when a renderer mounts, so a selection made
   *  on another tab is already lit when this one opens. */
  selectedRef?: string | null;
  /** The reader clicked a part (its designator) or nothing (null). Held through
   *  a ref like `createRenderer`, so an inline arrow cannot remount the renderer. */
  onSelect?: (ref: string | null) => void;
}

/**
 * Word for word the copy DesignCanvas shows for the same condition
 * (`DesignCanvas.tsx` COPY['no-webgl']). Duplicated rather than imported on
 * purpose: the two hosts have no shared component yet, and a visitor who meets
 * this wall in both tabs must read the same sentence, not a paraphrase.
 */
const NO_WEBGL = {
  title: 'This browser has WebGL disabled',
  body: 'The drawing needs WebGL 2 to render. Enable hardware acceleration or try another browser — the BOM and stackup tabs work without it.',
};

/** When the scene built but the renderer could not start: no WebGL context
 *  (the GPU process was blocklisted after a crash, too many live contexts), or
 *  the renderer's own chunk failed to load. */
const NO_START = {
  title: "Couldn't start the 3D view",
  body: 'The browser could not open a 3D drawing surface for this board. Try again, or use the Board tab.',
};

const DOT = ' · ';

/**
 * The caption, in the fixed order of spec §5 — the estimate disclaimer first,
 * then each warning. Every sentence here is an admission about what the drawing
 * is NOT, which is why the order is pinned by a test rather than left to however
 * the warnings happened to be appended.
 */
export function captionOf(scene: BoardScene, quality: Quality = 'full'): string {
  const parts: string[] = [];
  if (scene.groups.some((g) => g.material === 'body')) {
    parts.push('Component bodies are estimates from courtyards, not part shapes.');
  } else if (quality === 'reduced') {
    // Nothing was attempted, so nothing is disclaimed — but a reader seeing a
    // bare board needs to know the bodies are missing by design, and that the
    // pads still answer. Device-neutral: the reduced tier is a narrow window OR
    // a dense display, and a mouse reader must not be told to "tap".
    parts.push('Component bodies are not drawn on this display. Select a pad to identify a part.');
  }
  const has = (kind: BoardScene['warnings'][number]['kind']) => scene.warnings.some((w) => w.kind === kind);
  if (has('no-stackup')) parts.push('Layer thicknesses are not in this file.');
  const open = scene.warnings.find((w) => w.kind === 'outline-open');
  if (open != null) {
    // Zero segments means there was no outline to close at all.
    parts.push(open.segments === 0
      ? 'This board has no outline yet; showing the box around its copper.'
      : 'Board outline did not close; showing its bounding box.');
  }
  for (const w of scene.warnings) {
    if (w.kind !== 'zones-unfilled') continue;
    parts.push(`${w.count} copper pour${w.count === 1 ? ' was' : 's were'} saved unfilled.`);
  }
  // Three different simplifications, one number: a visitor needs to know the
  // drawing was approximated somewhere, not which of our passes did it.
  let simplified = 0;
  for (const w of scene.warnings) {
    if (w.kind === 'holes-merged' || w.kind === 'holes-marked' || w.kind === 'no-courtyard' || w.kind === 'arc-degenerate') simplified += w.count;
  }
  if (simplified > 0) parts.push(`${simplified} feature${simplified === 1 ? '' : 's'} simplified.`);
  return parts.join(' ');
}

const statsLine = (stats: BoardScene['stats']): string =>
  [
    `${stats.footprints.toLocaleString('en-US')} footprints`,
    `${stats.pads.toLocaleString('en-US')} pads`,
    `${stats.vias.toLocaleString('en-US')} vias`,
    `built in ${Math.round(stats.buildMs).toLocaleString('en-US')} ms`,
  ].join(DOT);

export default function Board3DView({ project, stackup, createRenderer, quality, selectedRef, onSelect }: Board3DViewProps) {
  const supported = webgl2Supported();
  // Decided ONCE, at mount (spec §6): a window the visitor drags wider must not
  // silently re-tessellate the board underneath them.
  const [autoQuality] = useState<Quality>(() =>
    currentQuality({ webgl2: supported, innerWidth: window.innerWidth, devicePixelRatio: window.devicePixelRatio }),
  );
  const tier = quality ?? autoQuality;
  // No WebGL2 means no renderer, so there is nothing for a build to feed — the
  // null project keeps a worker from ever being spawned for a board nobody sees.
  const { status, scene, error, retry } = useBoardScene(supported ? project : null, stackup, tier);

  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);
  const [view, setView] = useState<'top' | 'bottom' | null>(null);
  /** Bumped when a renderer has mounted, so the highlight effect below re-runs
   *  against the live one rather than the null it saw before. */
  const [live, setLive] = useState(0);
  /** The renderer's mount rejected. `attempt` is what "Try again" bumps to
   *  run the mount effect afresh (the scene itself is fine and cached). */
  const [mountFailed, setMountFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const selectedRefRef = useRef(selectedRef ?? null);
  selectedRefRef.current = selectedRef ?? null;

  useEffect(() => {
    if (!supported || status !== 'ready' || scene == null) return;
    const host = hostRef.current;
    if (host == null) return;
    const renderer = (createRenderer ?? createSceneRenderer)();
    rendererRef.current = renderer;
    let cancelled = false;
    renderer.onPick?.((ref) => {
      if (cancelled) return;
      // The pick's own cost, for the browser measurement step (like `calls`).
      host.dataset.pickMs = String(Math.round(renderer.info().pickMs));
      onSelectRef.current?.(ref);
    });
    void renderer
      .mount(host, scene, tier)
      .then(() => {
        if (cancelled) return;
        // The measurement hook the browser step reads (spec §9, §11): draw calls
        // and triangles as the renderer itself counted them on the first frame,
        // beside the build time the worker reported.
        const drawn = renderer.info();
        host.dataset.calls = String(drawn.calls);
        host.dataset.triangles = String(drawn.triangles);
        host.dataset.buildMs = String(Math.round(scene.stats.buildMs));
        renderer.highlight?.(selectedRefRef.current);
        setLive((n) => n + 1);
      })
      .catch(() => {
        if (!cancelled) setMountFailed(true);
      });

    // The loop runs only while the canvas can be SEEN: a hidden tab, or a
    // canvas scrolled off-screen in a visible one (which the browser does not
    // throttle), must not burn a frame budget on an orbit nobody watches.
    let onScreen = true;
    const sync = () => {
      if (document.hidden || !onScreen) renderer.pause();
      else renderer.resume();
    };
    document.addEventListener('visibilitychange', sync);
    const io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry == null) return;
        onScreen = entry.isIntersecting;
        sync();
      })
      : null;
    io?.observe(host);
    if (document.hidden) renderer.pause();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', sync);
      io?.disconnect();
      rendererRef.current = null;
      renderer.dispose();
    };
  }, [supported, status, scene, tier, attempt]);

  useEffect(() => {
    rendererRef.current?.highlight?.(selectedRef ?? null);
  }, [selectedRef, live]);

  const go = (next: ViewName) => {
    rendererRef.current?.setView(next);
    setView(next === 'reset' ? null : next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const renderer = rendererRef.current;
    if (renderer == null) return;
    const step = ORBIT.keyStepDeg;
    if (event.key === 'ArrowLeft') renderer.orbit?.(-step, 0);
    else if (event.key === 'ArrowRight') renderer.orbit?.(step, 0);
    else if (event.key === 'ArrowUp') renderer.orbit?.(0, step);
    else if (event.key === 'ArrowDown') renderer.orbit?.(0, -step);
    else if (event.key === 'Home') go('reset');
    else return;
    event.preventDefault();
  };

  const ready = supported && status === 'ready' && scene != null && !mountFailed;
  const failed = supported && (status === 'error' || mountFailed);
  const tryAgain = () => {
    if (mountFailed) {
      setMountFailed(false);
      setAttempt((n) => n + 1);
    } else {
      retry();
    }
  };
  const caption = scene == null ? '' : captionOf(scene, tier);
  return (
    <div className={styles.wrap}>
      {ready && (
        <div className={styles.toolbar} role="group" aria-label="Board view">
          <button type="button" className={styles.ctl} aria-pressed={view === 'top'} onClick={() => go('top')}>
            Top
          </button>
          <button type="button" className={styles.ctl} aria-pressed={view === 'bottom'} onClick={() => go('bottom')}>
            Bottom
          </button>
          <button type="button" className={styles.ctl} onClick={() => rendererRef.current?.flip()}>
            Flip
          </button>
          <button type="button" className={styles.ctl} onClick={() => go('reset')}>
            Reset
          </button>
        </div>
      )}
      <div
        ref={hostRef}
        className={styles.canvasHost}
        role="group"
        aria-label="3D board, arrow keys orbit"
        tabIndex={ready ? 0 : -1}
        onKeyDown={onKeyDown}
      >
        {supported && status === 'building' && (
          <p className={styles.status} role="status">
            Building the board&#8230;
          </p>
        )}
        {(!supported || failed) && (
          <div className={styles.problem} role="alert">
            <p className={styles.problemTitle}>
              {!supported ? NO_WEBGL.title : mountFailed ? NO_START.title : "Couldn't build this board"}
            </p>
            <p className={styles.problemBody}>
              {!supported ? NO_WEBGL.body : mountFailed ? NO_START.body : (error ?? 'The board could not be built.')}
            </p>
            {supported && (
              <button type="button" className={styles.retry} onClick={tryAgain}>
                Try again
              </button>
            )}
          </div>
        )}
      </div>
      {scene != null && (
        <div className={styles.footer}>
          {caption !== '' && (
            <p className={styles.caption} role="note">
              {caption}
            </p>
          )}
          <p className={styles.stats}>{statsLine(scene.stats)}</p>
        </div>
      )}
    </div>
  );
}
