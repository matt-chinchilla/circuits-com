// The React host over a SceneRenderer (spec 2026-09-21 §5, §7). Owns the toolbar,
// the three states, the caption — and the renderer's LIFETIME: mounting it when a
// scene is ready and disposing it, with its WebGL context, the moment this
// component goes away. The 3D tab is unmounted when it is not selected, so that
// disposal is the mechanism keeping one live context on the page, not two.
//
// It never touches three, a canvas or a geometry. Everything goes through the
// SceneRenderer seam, which is also what lets the tests drive it with a fake.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { hasEstimatedBody, partAnchor } from '@public/services/kicad/board3d/partAnchor';
import type { BoardScene, Quality } from '@public/services/kicad/board3d/types';
import type { BoardStackup, KicadProject } from '@public/services/kicad/types';
import { isPlainKey } from '../keyboard';
import { webgl2Supported } from '../webgl';
import { ORBIT } from './board3dTheme';
import { currentQuality } from './quality';
import { labelLines, type PartLabel } from './partLabel';
import {
  createSceneRenderer, type AnchorScreen, type HoverHit, type ObjectClass3D, type SceneRenderer, type Spin, type ViewName,
} from './sceneRenderer';
import {
  BOARD_ACTION_LABEL, BOARD_KEYS, DEFAULT_SPIN_AXIS, SPIN_KEYS, VIEW_MODE_KEYS, ariaKey, boardActionForKey, spinAxisForKey, viewModeForKey,
} from './shortcuts';
import { useBoardScene } from './useBoardScene';
import { VIEW_MODES, getViewMode, setViewMode, useViewMode } from './viewMode';
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
  /** What the callout on the selected part says under its designator: the
   *  value and footprint the page knows (partFacts). Absent, the callout is
   *  the designator alone. */
  label?: PartLabel | null;
  /** The Board panel's state (spec 2026-09-22 §2.4), shared with the Board
   *  tab: layers hidden by name, the highlighted layer and net, and each
   *  object class's opacity (absent = 1; 2D-only classes are ignored here).
   *  Applied to every renderer as it is made and again on each change. */
  hiddenLayers?: ReadonlySet<string>;
  highlightedLayer?: string | null;
  opacity?: Partial<Record<ObjectClass3D, number>>;
  highlightedNet?: number | null;
}

/** The part of the Board panel state the 3D view draws. */
export interface BoardView3D {
  hiddenLayers: ReadonlySet<string>;
  highlightedLayer: string | null;
  opacity: Partial<Record<ObjectClass3D, number>>;
  highlightedNet: number | null;
}

const OBJECT_CLASSES_3D: readonly ObjectClass3D[] = ['tracks', 'vias', 'pads', 'zones', 'silk', 'mask', 'bodies'];
const NO_LAYERS: ReadonlySet<string> = new Set();
const NO_OPACITY: Partial<Record<ObjectClass3D, number>> = {};

/**
 * Tell `renderer` what differs between the state it was last given (`prev`,
 * null for a renderer that has been given nothing) and `next`. A fresh
 * renderer gets every hidden layer, both highlights and every non-default
 * opacity; after that only the changes, so a slider drag is one call per step.
 * A renderer without a member is simply not asked.
 */
export function applyBoardView(renderer: SceneRenderer, prev: BoardView3D | null, next: BoardView3D): void {
  if (renderer.setLayerVisible != null) {
    for (const name of next.hiddenLayers) if (prev == null || !prev.hiddenLayers.has(name)) renderer.setLayerVisible(name, false);
    if (prev != null) for (const name of prev.hiddenLayers) if (!next.hiddenLayers.has(name)) renderer.setLayerVisible(name, true);
  }
  if (prev == null || prev.highlightedLayer !== next.highlightedLayer) renderer.highlightLayer?.(next.highlightedLayer);
  if (prev == null || prev.highlightedNet !== next.highlightedNet) renderer.highlightNet?.(next.highlightedNet);
  if (renderer.setObjectOpacity != null) {
    for (const kind of OBJECT_CLASSES_3D) {
      const was = prev == null ? 1 : prev.opacity[kind] ?? 1;
      const now = next.opacity[kind] ?? 1;
      if (was !== now) renderer.setObjectOpacity(kind, now);
    }
  }
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

/** When the renderer was running and the browser took its context away. */
const LOST = {
  title: 'The 3D view stopped',
  body: 'The browser took back the 3D drawing surface — phones do this when graphics memory runs short or the page sits in the background. Try again to redraw the board.',
};

/** The stats line's separator: a no-break space BEFORE the dot keeps it on the
 *  line it ends, so a phone-width wrap starts the next line with a figure,
 *  never with "·". */
const DOT = '\u00a0· ';
/** Inside one figure ("1,149 pads", "built in 786 ms") a wrap would part a
 *  number from its unit; the separators are the only breaks. */
const unbroken = (text: string): string => text.replace(/ /g, '\u00a0');

/** The callout's distance from its anchor: to the right of the dot and above
 *  it, the way a drawing's leader lifts away from the part it names. */
const CALLOUT_GAP_PX = 22;
const CALLOUT_RISE_PX = 26;
/** Inset the callout keeps from the canvas edge. */
const CALLOUT_MARGIN_PX = 8;
/** The tooltip sits down and right of the mouse, off the cursor. */
const TIP_OFFSET_PX = 14;

const clampTo = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** How many bodies the pipeline drew from a Fab outline; 0 for a scene that
 *  does not say (a test's hand-built fake predating the count). */
const bodiesFromFab = (scene: BoardScene): number => scene.stats.bodiesFromFab ?? 0;

/**
 * The caption, in the fixed order of spec §5 — the estimate disclaimer first,
 * then each warning. Every sentence here is an admission about what the drawing
 * is NOT, which is why the order is pinned by a test rather than left to however
 * the warnings happened to be appended.
 */
export function captionOf(scene: BoardScene, quality: Quality = 'full'): string {
  const parts: string[] = [];
  if (scene.groups.some((g) => g.material === 'body')) {
    // Where the bodies' outlines came from, said plainly: a board whose
    // footprints carry Fab outlines has bodies shaped like its packages, with
    // pins read from its pads; a board with none has the older courtyard boxes.
    // Either way the heights are guesses, and the caption says so.
    parts.push(bodiesFromFab(scene) > 0
      ? 'Component bodies are drawn from each footprint\'s outline and pads; their heights are estimates.'
      : 'Component bodies are estimates from courtyards, not part shapes.');
  } else if (quality === 'reduced') {
    // Nothing was attempted, so nothing is disclaimed — but a reader seeing a
    // bare board needs to know the bodies are missing by design, and that the
    // pads still answer. Since 2026-09-23 no device is sent here on its own
    // (`quality.ts`: WebGL2 alone decides, and without it nothing renders);
    // only `setQualityOverride('reduced')` is. Device-neutral all the same — a
    // mouse reader must not be told to "tap". The view toggle is still offered
    // here, so it says what is left for it to do.
    parts.push('Component bodies are not drawn on this display. Select a pad to identify a part. See-through and X-ray fade the solder mask only.');
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
  ].map(unbroken).join(DOT);

export default function Board3DView({
  project, stackup, createRenderer, quality, selectedRef, onSelect, label,
  hiddenLayers, highlightedLayer, opacity, highlightedNet,
}: Board3DViewProps) {
  const supported = webgl2Supported();
  // Decided ONCE, at mount (spec §6): the override may change between mounts,
  // and a board must not be re-tessellated underneath a reader mid-visit.
  const [autoQuality] = useState<Quality>(() => currentQuality({ webgl2: supported }));
  const tier = quality ?? autoQuality;
  // No WebGL2 means no renderer, so there is nothing for a build to feed — the
  // null project keeps a worker from ever being spawned for a board nobody sees.
  const { status, scene, error, retry } = useBoardScene(supported ? project : null, stackup, tier);

  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);
  const [view, setView] = useState<'top' | 'bottom' | null>(null);
  /** The renderer's spin as it last reported it — a drag stops it there, not here. */
  const [spin, setSpin] = useState<Spin | null>(null);
  const viewMode = useViewMode();
  const viewLabelId = useId();
  const calloutRef = useRef<HTMLDivElement>(null);
  const leaderRef = useRef<SVGSVGElement>(null);
  const leaderLineRef = useRef<SVGLineElement>(null);
  const leaderShadowRef = useRef<SVGLineElement>(null);
  const leaderDotRef = useRef<SVGCircleElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  /** Bumped when a renderer has mounted, so the highlight effect below re-runs
   *  against the live one rather than the null it saw before. */
  const [live, setLive] = useState(0);
  /** The renderer could not start (`mount` rejected), or it started and the
   *  browser later took its context away. `attempt` is what "Try again" bumps
   *  to run the mount effect afresh (the scene itself is fine and cached). */
  const [mountFailed, setMountFailed] = useState<'start' | 'lost' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const selectedRefRef = useRef(selectedRef ?? null);
  selectedRefRef.current = selectedRef ?? null;
  const boardView: BoardView3D = {
    hiddenLayers: hiddenLayers ?? NO_LAYERS,
    highlightedLayer: highlightedLayer ?? null,
    opacity: opacity ?? NO_OPACITY,
    highlightedNet: highlightedNet ?? null,
  };
  const boardViewRef = useRef(boardView);
  boardViewRef.current = boardView;
  /** What the CURRENT renderer was last told, so a change sends only the diff. */
  const appliedRef = useRef<BoardView3D | null>(null);

  /**
   * Put the callout and its leader where the renderer says the anchor is —
   * straight onto the DOM, never through React state: this runs after every
   * frame of an orbit. The plate sits up and to the right of the dot, flips to
   * the left at the canvas's right edge and drops below at its top; the
   * leader runs from the dot to the nearest point of the plate's border.
   */
  const place = useCallback((at: AnchorScreen | null) => {
    const callout = calloutRef.current, leader = leaderRef.current, line = leaderLineRef.current, dot = leaderDotRef.current, host = hostRef.current;
    // Hide FIRST: clearing the selection unmounts the plate before this runs,
    // and an early return on the missing plate left the leader standing alone
    // on the board.
    if (at == null || !at.visible || callout == null) {
      if (callout != null) callout.hidden = true;
      if (leader != null) leader.style.display = 'none';
      return;
    }
    if (leader == null || line == null || dot == null || host == null) return;
    callout.hidden = false;
    leader.style.display = '';
    const w = host.clientWidth, h = host.clientHeight;
    const cw = callout.offsetWidth, ch = callout.offsetHeight;
    let left = at.x + CALLOUT_GAP_PX;
    if (left + cw > w - CALLOUT_MARGIN_PX) left = at.x - CALLOUT_GAP_PX - cw;
    left = clampTo(left, CALLOUT_MARGIN_PX, Math.max(CALLOUT_MARGIN_PX, w - CALLOUT_MARGIN_PX - cw));
    let top = at.y - CALLOUT_RISE_PX - ch;
    if (top < CALLOUT_MARGIN_PX) top = at.y + CALLOUT_RISE_PX;
    top = clampTo(top, CALLOUT_MARGIN_PX, Math.max(CALLOUT_MARGIN_PX, h - CALLOUT_MARGIN_PX - ch));
    callout.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    const ex = clampTo(at.x, left, left + cw), ey = clampTo(at.y, top, top + ch);
    // The line and, under it, its dark shadow: the same segment twice.
    for (const l of [line, leaderShadowRef.current]) {
      if (l == null) continue;
      l.setAttribute('x1', String(at.x));
      l.setAttribute('y1', String(at.y));
      l.setAttribute('x2', String(ex));
      l.setAttribute('y2', String(ey));
    }
    dot.setAttribute('cx', String(at.x));
    dot.setAttribute('cy', String(at.y));
  }, []);

  /** The hover tooltip: the designator under a resting mouse, unless it is
   *  the selected part, whose callout already says so. */
  const showTip = useCallback((hit: HoverHit | null) => {
    const tip = tipRef.current, host = hostRef.current;
    if (tip == null || host == null) return;
    if (hit == null || hit.ref === selectedRefRef.current) {
      tip.hidden = true;
      return;
    }
    tip.textContent = hit.ref;
    tip.hidden = false;
    const left = clampTo(hit.x + TIP_OFFSET_PX, 0, Math.max(0, host.clientWidth - tip.offsetWidth));
    const top = clampTo(hit.y + TIP_OFFSET_PX, 0, Math.max(0, host.clientHeight - tip.offsetHeight));
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }, []);

  useEffect(() => {
    if (!supported || status !== 'ready' || scene == null) return;
    const host = hostRef.current;
    if (host == null) return;
    const renderer = (createRenderer ?? createSceneRenderer)();
    rendererRef.current = renderer;
    // Given before mount, so the renderer builds its meshes already in this
    // state and the first frame never flashes a hidden layer — or a solid body
    // on a board the reader left see-through.
    applyBoardView(renderer, null, boardViewRef.current);
    appliedRef.current = boardViewRef.current;
    renderer.setViewMode?.(getViewMode());
    let cancelled = false;
    renderer.onPick?.((ref) => {
      if (cancelled) return;
      // The pick's own cost, for the browser measurement step (like `calls`).
      host.dataset.pickMs = String(Math.round(renderer.info().pickMs));
      onSelectRef.current?.(ref);
    });
    renderer.onAnchorMove?.((at) => {
      if (!cancelled) place(at);
    });
    renderer.onHover?.((hit) => {
      if (!cancelled) showTip(hit);
    });
    renderer.onContextLost?.(() => {
      if (!cancelled) setMountFailed('lost');
    });
    renderer.onSpinChange?.((next) => {
      if (!cancelled) setSpin(next);
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
        if (!cancelled) setMountFailed('start');
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
      // A fresh renderer (Try again) starts still; the button must too.
      setSpin(null);
    };
  }, [supported, status, scene, tier, attempt, place, showTip]);

  useEffect(() => {
    rendererRef.current?.highlight?.(selectedRef ?? null);
  }, [selectedRef, live]);

  // The callout's anchor: the selected part's body top, else its pads; none
  // for a part the scene does not draw, and the callout stays hidden.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer == null || renderer.setAnchor == null) return;
    const anchor = scene != null && selectedRef != null ? partAnchor(scene, selectedRef) : null;
    renderer.setAnchor(anchor);
    if (anchor == null) place(null);
  }, [selectedRef, scene, live, place]);

  useEffect(() => {
    rendererRef.current?.setViewMode?.(viewMode);
  }, [viewMode, live]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer == null) return;
    applyBoardView(renderer, appliedRef.current, boardViewRef.current);
    appliedRef.current = boardViewRef.current;
  }, [hiddenLayers, highlightedLayer, opacity, highlightedNet]);

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

  const ready = supported && status === 'ready' && scene != null && mountFailed == null;

  // The single-key controls (shortcuts.ts), from anywhere on the page: this
  // component exists only while the 3D tab is shown, so the listener is scoped
  // to it. A held key does not repeat — a held F would flip the board back and
  // forth. `go` reads only a ref and a state setter, so a stale copy is fine.
  // A spin key alone admits Shift: shift+x is x the other way.
  useEffect(() => {
    if (!ready) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      const axis = spinAxisForKey(key);
      if (!isPlainKey(e, { shift: axis != null })) return;
      const action = axis == null ? boardActionForKey(key) : null;
      const mode = axis == null && action == null ? viewModeForKey(key) : null;
      if (axis == null && action == null && mode == null) return;
      e.preventDefault();
      if (axis != null) rendererRef.current?.spin?.(axis, e.shiftKey ? -1 : 1);
      else if (action === 'flip') rendererRef.current?.flip();
      else if (action != null) go(action);
      else if (mode != null) setViewMode(mode);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ready]);

  const failed = supported && (status === 'error' || mountFailed != null);
  const noStart = mountFailed === 'lost' ? LOST : NO_START;
  const tryAgain = () => {
    if (mountFailed != null) {
      setMountFailed(null);
      setAttempt((n) => n + 1);
    } else {
      retry();
    }
  };
  const caption = scene == null ? '' : captionOf(scene, tier);
  const lines = selectedRef == null ? null : labelLines(label != null && label.ref === selectedRef ? label : { ref: selectedRef, value: null, footprint: null });
  const estimated = scene != null && selectedRef != null && hasEstimatedBody(scene, selectedRef);
  return (
    <div className={styles.wrap}>
      {ready && (
        <div className={styles.toolbar}>
          <div className={styles.track} role="group" aria-label="Board view">
            <button type="button" className={styles.ctl} aria-pressed={view === 'top'} aria-keyshortcuts={ariaKey(BOARD_KEYS.top)} onClick={() => go('top')}>
              {BOARD_ACTION_LABEL.top}
            </button>
            <button type="button" className={styles.ctl} aria-pressed={view === 'bottom'} aria-keyshortcuts={ariaKey(BOARD_KEYS.bottom)} onClick={() => go('bottom')}>
              {BOARD_ACTION_LABEL.bottom}
            </button>
            <button type="button" className={styles.ctl} aria-keyshortcuts={ariaKey(BOARD_KEYS.flip)} onClick={() => rendererRef.current?.flip()}>
              {BOARD_ACTION_LABEL.flip}
            </button>
            <button type="button" className={styles.ctl} aria-keyshortcuts={ariaKey(BOARD_KEYS.reset)} onClick={() => go('reset')}>
              {BOARD_ACTION_LABEL.reset}
            </button>
            {/* The load orbit, restartable: pressed while ANY spin runs, and a
                press then stops it; otherwise it starts the default turn. */}
            <button
              type="button"
              className={styles.ctl}
              aria-pressed={spin != null}
              aria-keyshortcuts={ariaKey(SPIN_KEYS[DEFAULT_SPIN_AXIS])}
              onClick={() => rendererRef.current?.spin?.(spin == null ? DEFAULT_SPIN_AXIS : null)}
            >
              Spin
            </button>
          </div>
          {/* Solid / See-through / X-ray. Named "View" and not "Bodies": on the
              reduced tier there are no bodies and the same three states fade
              the solder mask alone (the caption says so). Mirrored on the Objects
              tab; both read and write the one store in viewMode.ts. */}
          <div className={styles.viewGroup}>
            <span id={viewLabelId} className={styles.trackLabel}>
              View
            </span>
            <div className={styles.track} role="group" aria-labelledby={viewLabelId}>
              {VIEW_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={styles.ctl}
                  aria-pressed={viewMode === mode.id}
                  aria-keyshortcuts={ariaKey(VIEW_MODE_KEYS[mode.id])}
                  title={mode.help}
                  onClick={() => setViewMode(mode.id)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
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
        {ready && (
          <>
            {/* The callout on the selected part: a leader from a dot on the
                part to a plate with its designator and what it is. Placed by
                `place`, hidden until the renderer has projected its anchor. */}
            <svg ref={leaderRef} className={styles.leader} aria-hidden="true" style={{ display: 'none' }}>
              <line ref={leaderShadowRef} className={styles.leaderShadow} />
              <line ref={leaderLineRef} className={styles.leaderLine} />
              <circle ref={leaderDotRef} className={styles.leaderDot} r={4.5} />
            </svg>
            {lines != null && (
              <div ref={calloutRef} className={styles.callout} data-callout={lines.title} hidden>
                <p className={styles.calloutTitle}>{lines.title}</p>
                {lines.detail != null && <p className={styles.calloutDetail}>{lines.detail}</p>}
                {estimated && <p className={styles.calloutTag}>estimated body</p>}
              </div>
            )}
            <div ref={tipRef} className={styles.tip} role="tooltip" hidden />
          </>
        )}
        {supported && status === 'building' && (
          <p className={styles.status} role="status">
            Building the board&#8230;
          </p>
        )}
        {(!supported || failed) && (
          <div className={styles.problem} role="alert">
            <p className={styles.problemTitle}>
              {!supported ? NO_WEBGL.title : mountFailed != null ? noStart.title : "Couldn't build this board"}
            </p>
            <p className={styles.problemBody}>
              {!supported ? NO_WEBGL.body : mountFailed != null ? noStart.body : (error ?? 'The board could not be built.')}
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
