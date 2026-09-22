// Design Viewer — open a KiCad project in the browser (spec §7.1). Tabs:
// Schematic, Board, Stackup, 3D, BOM. ONE canvas element serves both drawing tabs
// (one embed per project); it is hidden, not unmounted, when another tab is
// active — and so is every other panel, so that switching tabs never bins work
// the reader has already paid for.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { motion } from 'framer-motion';
import { useLocation } from 'react-router-dom';
import PageHead from '@public/components/PageHead';
import PageHeaderBand from '@public/components/layout/PageHeaderBand';
import DesignCanvas, { type CanvasSelection, type DesignCanvasHandle } from '@public/components/kicad/DesignCanvas';
import type { CanvasStateName, CanvasView, FocusResult, LayerInfo, NetInfo } from '@public/components/kicad/canvasController';
import StackupPanel from '@public/components/kicad/StackupPanel';
import BomTable from '@public/components/bom/BomTable';
import ShareBar from '@public/components/bom/ShareBar';
import { useBomWorkbench } from '@public/services/bom/useBomWorkbench';
import { readStackup } from '@public/services/kicad/boardStackup';
import { readPlacements } from '@public/services/kicad/boardPlacements';
import { basename } from '@public/services/kicad/project';
import type { KicadProject } from '@public/services/kicad/types';
import { clearDesignSession, getDesignSession, openDesign, type DesignSession } from '@public/services/designSession';
import { STATIC_PAGE_SEO } from '@public/services/seoRoutes';
import ViewerIntake from './components/ViewerIntake';
import BoardPanel, { type BoardPanelHandle, type ShowOn } from './components/BoardPanel';
import { knownRefs, partFacts, resolveRef } from './partFacts';
import {
  EMPTY_BOARD_VIEW,
  applyToCanvas,
  clearHighlights,
  layersFromFile,
  netsFromFile,
  panelLayers,
  sameLayers,
  type BoardViewState,
  type PanelLayer,
} from './boardView';
import styles from './ViewerPage.module.scss';

/**
 * three.js and the whole 3D host, behind a dynamic import (spec 2026-09-21 §8).
 * Lazy so the renderer's chunk is fetched on the first visit to the tab and
 * never by a reader who only came for the BOM — the same bargain `/viewer`
 * already makes for KiCanvas.
 */
const Board3DView = lazy(() => import('@public/components/kicad/board3d/Board3DView'));

/** The latest the placement table is warmed after a project opens, when the
 *  browser never goes idle. */
const PLACEMENTS_IDLE_TIMEOUT_MS = 2000;

type Tab = 'schematic' | 'board' | 'stackup' | 'board3d' | 'bom';

export const POSITIONING =
  'Open your KiCad project in the browser and get every line of the BOM priced across our whole distributor catalog — read straight out of your schematic, with no CSV export, no account, and nobody trying to win your board order.';

/** Why a chip is inert, in the two places that have to say it: the hover title
 *  and the toast a click raises. The renderer addresses its files by BASENAME,
 *  so a second `power.kicad_sch` cannot be represented at all. */
const DROPPED_SHEET_HINT =
  'Another sheet in this project has the same filename, so only one of them can be drawn.';

/** One visually-hidden node carries the reason for every dropped chip; the
 *  chips point at it with `aria-describedby`, so the reason is ANNOUNCED rather
 *  than living only in a `title` (inconsistently read, invisible on touch) and
 *  the dashed styling. */
const DROPPED_REASON_ID = 'viewer-unrenderable-sheet-reason';

/** The same fact as a toast. `ref` is present when the gesture was about a
 *  designator rather than the chip itself — the reader needs to know which part
 *  they clicked went nowhere, not only that some sheet cannot be drawn. */
function droppedSheetToast(path: string, ref?: string): string {
  const subject =
    ref == null
      ? `${basename(path)} can't be drawn`
      : `${ref} is on ${basename(path)}, which can't be drawn`;
  return `${subject} — another sheet in this project has the same filename.`;
}

/**
 * The designator a URL is asking us to focus, or null.
 *
 * `decodeURIComponent` THROWS on a malformed escape, and `/viewer#%` is one a
 * truncated pasted link really does produce. The raw text is the fallback: a
 * reference that fails to match gets an honest "not in this schematic" toast,
 * where an exception out of an effect takes the page to the ErrorBoundary.
 */
function refFromHash(hash: string): string | null {
  if (hash.length <= 1) return null;
  const raw = hash.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function sheetLabel(project: KicadProject, path: string): string {
  const stem = basename(path).replace(/\.kicad_sch$/i, '');
  return path === project.root ? `${stem} (root)` : stem;
}

/**
 * The tablist's wiring, as ids.
 *
 * Every tab points `aria-controls` at the panel it opens and every panel points
 * `aria-labelledby` back at its tab, so the pairing is announced rather than
 * implied by position. The two DRAWING tabs share one panel on purpose: the
 * canvas is a single embed per project (hidden, never unmounted), so Schematic
 * and Board are two labels on one region.
 *
 * A reference to an element that is not in the document is worse than none —
 * `aria-controls` is therefore emitted only for a panel that is really mounted
 * (the BOM panel arrives with its first visit; the Stackup panel only exists for
 * a project that has a board).
 */
const TAB_ID: Record<Tab, string> = {
  schematic: 'viewer-tab-schematic',
  board: 'viewer-tab-board',
  stackup: 'viewer-tab-stackup',
  board3d: 'viewer-tab-3d',
  bom: 'viewer-tab-bom',
};

const PANEL_ID = {
  drawing: 'viewer-panel-drawing',
  stackup: 'viewer-panel-stackup',
  board3d: 'viewer-panel-3d',
  bom: 'viewer-panel-bom',
} as const;

const PANEL_OF: Record<Tab, keyof typeof PANEL_ID> = {
  schematic: 'drawing',
  board: 'drawing',
  stackup: 'stackup',
  board3d: 'board3d',
  bom: 'bom',
};

/** Why the Layers and Objects tabs are disabled, in the words the panel shows. */
const BOARD_HINT = 'Open the Board or 3D tab';
const BOARD_FAILED_HINT = 'The board drawing did not load in this browser; open the 3D tab';

const NO_LAYERS: PanelLayer[] = [];
const NO_NETS: NetInfo[] = [];

function defaultTab(session: DesignSession): Tab {
  return session.project.root != null ? 'schematic' : 'board';
}

/** Is the keyboard's target a place where `/` and Esc mean something else? */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

export default function ViewerPage() {
  const location = useLocation();
  const [session, setSession] = useState<DesignSession | null>(() => getDesignSession());
  const [tab, setTab] = useState<Tab>(() => (session ? defaultTab(session) : 'schematic'));
  const [activeSheet, setActiveSheet] = useState<string | undefined>(undefined);
  const [canvasState, setCanvasState] = useState<CanvasStateName>('loading');
  const [toast, setToast] = useState<string | null>(null);
  /**
   * Has the BOM tab been opened for THIS project? A one-way latch, not a mirror
   * of `tab`: the workbench prices once per `parsed` IDENTITY, so a flag that
   * fell back to false on leaving the tab would hand the hook null and then the
   * same object again — a fresh identity transition, a second `/api/bom/match`,
   * and a second bite of the visitor's 100-lookups-a-day resolve budget, all
   * for a tab click. Latched, the input goes null → parsed → parsed: one match,
   * and the priced panel survives every flip back to the drawing.
   */
  const [bomSeen, setBomSeen] = useState(false);
  /**
   * Has the Stackup tab been opened for THIS project? The same one-way latch as
   * `bomSeen`, for the same reason in a different currency: `readStackup`
   * re-tokenises the whole board file, which is 323 ms on an 8 MB one, and a
   * reader who never opens the tab was paying it on every project open.
   */
  const [stackupSeen, setStackupSeen] = useState(false);
  /**
   * The identified part — ONE selection for the whole page, whichever door it
   * came through: a click on the schematic or board (the canvas reports it),
   * a pick in the 3D view, a BOM designator chip, the panel's search, or the
   * URL hash. Every mounted view draws it; the part panel describes it.
   */
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  /**
   * The BOM table's supplier pins, held HERE rather than inside the table, so
   * the part panel prices a line with the supplier the reader chose there. A
   * what-if, never persisted; dropped with the project.
   */
  const [pins, setPins] = useState<Record<number, string>>({});
  useEffect(() => {
    setPins({});
  }, [session]);
  /**
   * Has the board's placement table been asked for? The same one-way latch as
   * `stackupSeen`: `readPlacements` re-scans the whole board (~40 ms on
   * Glasgow). Armed at the first IDLE moment after a project with a board
   * opens, so the first identification does not pay that scan inside its own
   * click; and still armed by the first selection or by focusing the search,
   * should either come before the browser goes idle.
   */
  const [placementsSeen, setPlacementsSeen] = useState(false);
  /**
   * The Board panel's state (spec 2026-09-22 §2.4): hidden layers, the lit
   * layer and net, and each object class's opacity. ONE record for the page,
   * drawn by the Board tab and the 3D tab alike, so a choice made on one holds
   * on the other and across every tab switch. Dropped with the project.
   */
  const [boardView, setBoardView] = useState<BoardViewState>(EMPTY_BOARD_VIEW);
  const boardViewRef = useRef(boardView);
  boardViewRef.current = boardView;
  /** What the 2D board has actually been given (see `applyToCanvas`); null for
   *  a board that has been given nothing yet. */
  const canvasApplied = useRef<BoardViewState | null>(null);
  /** The board's layers and nets as the LOADED 2D board reports them; empty
   *  until it has loaded, when the panel lists them from the file instead. */
  const [canvasLayers, setCanvasLayers] = useState<PanelLayer[]>(NO_LAYERS);
  const [canvasNets, setCanvasNets] = useState<NetInfo[]>(NO_NETS);
  /** Has the reader opened Layers or Objects for THIS project? The same one-way
   *  latch as `stackupSeen`: the file's tables are read then, not on open. */
  const [boardTablesSeen, setBoardTablesSeen] = useState(false);
  const canvasRef = useRef<DesignCanvasHandle>(null);
  const panelRef = useRef<BoardPanelHandle>(null);
  /**
   * What EACH drawing last showed selected, as the canvas itself reported it.
   * The schematic and the board are two viewers with two selections, and the
   * hidden one keeps its outline: a selection made on the schematic is not on
   * the board until the reader arrives there, and a selection cleared on the
   * board is still drawn on the schematic until the reader returns. The sync
   * below reads this per drawing, so it neither echoes a selection back to the
   * viewer that reported it nor leaves a cleared one outlined on the other.
   * (A single, view-blind record skipped the board whenever the schematic had
   * reported the same designator; the browser showed the board with no outline.)
   */
  const shown = useRef<Record<CanvasView, string | null>>({ schematic: null, board: null });
  /** The tab buttons, so an arrow key can move real DOM focus and not only the
   *  selection. Keyed by tab id rather than by index: `tabs` changes shape with
   *  the project, and a stale index would focus the wrong button. */
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  /** A focus the canvas still owes us, held until it reports `ready`. */
  const pendingFocus = useRef<string | null>(null);
  /**
   * Which gesture owns the view, and therefore the toast.
   *
   * A focus is awaited across a sheet load, and the reader can act again inside
   * that window — another designator, or a sheet chip. Whoever acted LAST is who
   * the page is answering; an older focus landing afterwards must say nothing,
   * or the reader is told "U1 was not found" about a click they have already
   * replaced, over a drawing that is showing something else entirely.
   */
  const focusSeq = useRef(0);
  /**
   * Sheets the MOUNTED renderer cannot draw for this project — its answer, not
   * this page's guess. KiCanvas keys its file system by basename and so must
   * drop a second `power.kicad_sch`; the editor renderer that replaces it later
   * is path-keyed and will answer none, at which point these chips stop being
   * marked without a line changing here.
   *
   * Reported before the renderer bundle is even fetched, so the chips carry it
   * on the commit that first paints them.
   */
  const [droppedSheets, setDroppedSheets] = useState<ReadonlySet<string>>(new Set());
  const handleUnrenderable = useCallback((paths: string[]) => {
    setDroppedSheets((prev) => {
      // The canvas remounts on every project identity, and re-reporting an
      // unchanged answer would re-render the whole page for nothing.
      if (prev.size === paths.length && paths.every((p) => prev.has(p))) return prev;
      return new Set(paths);
    });
  }, []);

  const wb = useBomWorkbench(
    // Armed by the first BOM-tab visit and never disarmed short of a new
    // project. A parse that failed has nothing to price — the panel shows the
    // reason instead.
    bomSeen && session != null && session.parsed.error == null ? session.parsed : null,
    // No viewer route: this IS the viewer. Designator chips act in place via
    // `onRefClick`, which outranks a link (spec §6).
    null,
  );

  /** A new project starts with every layer shown and nothing lit. */
  const resetBoardView = useCallback(() => {
    setBoardView(EMPTY_BOARD_VIEW);
    canvasApplied.current = null;
    setCanvasLayers(NO_LAYERS);
    setCanvasNets(NO_NETS);
    setBoardTablesSeen(false);
  }, []);

  // The session is opened HERE and only here — never in an effect. React 19's
  // StrictMode double-invokes effects, and openDesign re-parses the schematic.
  const handleProject = useCallback((project: KicadProject) => {
    const next = openDesign(project);
    setSession(next);
    setTab(defaultTab(next));
    setActiveSheet(undefined);
    setCanvasState('loading');
    setBomSeen(false);
    setStackupSeen(false);
    setSelectedRef(null);
    setPlacementsSeen(false);
    shown.current = { schematic: null, board: null };
    resetBoardView();
  }, [resetBoardView]);

  // Deliberately NOT called on unmount: surviving the /viewer ↔ /bom trip is
  // the whole point of the session. Only this button ends it.
  const openAnother = () => {
    // reset() FIRST, while the workbench still owns this BOM: it bumps the
    // generation, so a match already on the wire cannot land on the table we
    // are emptying and open a resolve stream against it. Clearing the session
    // (and the latch) is what then holds the hook at null.
    wb.reset();
    clearDesignSession();
    setSession(null);
    setBomSeen(false);
    setStackupSeen(false);
    setActiveSheet(undefined);
    // The canvas is about to unmount with the session. Leaving this at 'ready'
    // would leave the hash effect believing a drawing is on screen.
    setCanvasState('loading');
    setDroppedSheets(new Set());
    // A toast raised a moment ago would otherwise float over the fresh intake.
    setToast(null);
    pendingFocus.current = null;
    setSelectedRef(null);
    setPlacementsSeen(false);
    shown.current = { schematic: null, board: null };
    resetBoardView();
  };

  const focus = useCallback(
    async (ref: string) => {
      // Claimed before any early return, so a focus that answers immediately
      // still silences an older one that is still in flight.
      const seq = ++focusSeq.current;
      const s = session;
      if (s == null) return;
      // A focus IS a selection: the panel describes the part the reader asked
      // to be taken to, whether or not the drawing could show it.
      setSelectedRef(ref);
      setPlacementsSeen(true);
      if (s.project.root == null) {
        // Reachable: arrive at /viewer#U1, then open a board-only project. Without
        // this we would select a Schematic tab that the tablist does not render.
        setToast(`${ref} can't be shown — this project has no schematic.`);
        return;
      }
      const where = s.refs.get(ref);
      // The same wall `chooseSheet` puts in front of the chips. Without it the
      // BOM row is a second door onto the state I4 closed: `activeSheet` would
      // name a sheet the renderer never received, the chip this page marks
      // "can't be drawn" would take `aria-current`, and the canvas would not
      // move — inert and silent, through a new entrance.
      if (where != null && droppedSheets.has(where.sheet)) {
        setToast(droppedSheetToast(where.sheet, ref));
        return;
      }
      // Page state moves BEFORE the drawing does. DesignCanvas re-activates on
      // every `view`/`activeSheet` change, and when `setTab` really flips the
      // view that effect can land AFTER focusRef has finished — re-activating
      // whatever sheet the page still believed was current and dragging the
      // canvas off the one the focus just selected. Naming the designator's own
      // sheet first makes the late activate a no-op instead of a fight.
      if (where != null) setActiveSheet(where.sheet);
      setTab('schematic');
      const result = await canvasRef.current?.focusRef(ref, where?.instancePath);
      // A newer gesture took the view while this was loading. 'superseded' is
      // the renderer saying so; the sequence check catches the rest (a second
      // designator, or a focus that never reached the renderer at all).
      if (seq !== focusSeq.current || result === 'superseded') return;
      if (result === 'focused') setToast(`Focused ${ref}`);
      else if (result === 'not-found') setToast(where ? `${ref} was not found on sheet ${basename(where.sheet)}` : `${ref} is not in this schematic`);
      // 'unsupported' (no WebGL, or no renderer mounted) and an absent handle both
      // land here: say so rather than leaving the click with no answer at all.
      else setToast(`${ref} can't be focused — the drawing is not available in this browser.`);
    },
    [session, droppedSheets],
  );

  // A #ref the URL is carrying, including one that ARRIVES while this page is
  // already mounted — a BOM-row link, an in-page anchor, back/forward between
  // two refs. (Reading the hash once into a ref at mount, as this used to, only
  // ever saw the first one.)
  //
  // The hash alone is the dep list, on purpose: React runs the effect function
  // belonging to the render that just committed, so `canvasState` and `focus`
  // are read CURRENT without being depended on — while listing them would
  // re-fire this on every canvas state change and every new session, re-playing
  // a hash the reader moved past long ago (and which `openAnother` deliberately
  // drops).
  useEffect(() => {
    const ref = refFromHash(location.hash);
    pendingFocus.current = ref;
    if (ref == null || canvasState !== 'ready') return;
    pendingFocus.current = null;
    void focus(ref);
  }, [location.hash]);

  // …and the same focus when the canvas was not ready to take it yet. Declared
  // AFTER the effect above so a mount carrying #U1 has already recorded it.
  useEffect(() => {
    if (canvasState !== 'ready' || pendingFocus.current == null || session == null) return;
    const ref = pendingFocus.current;
    pendingFocus.current = null;
    void focus(ref);
  }, [canvasState, session, focus]);

  // One-way: see `bomSeen`.
  useEffect(() => {
    if (tab === 'bom') setBomSeen(true);
  }, [tab]);

  // One-way: see `stackupSeen`. The 3D tab reads the same rows (its z ladder),
  // so it latches too — otherwise leaving 3D dropped the memo and every return
  // re-tokenised the whole board inside the tab click.
  useEffect(() => {
    if (tab === 'stackup' || tab === 'board3d') setStackupSeen(true);
  }, [tab]);

  // One-way: see `placementsSeen`.
  useEffect(() => {
    if (selectedRef != null) setPlacementsSeen(true);
  }, [selectedRef]);

  // …and warmed off the click path: at the first idle moment after a project
  // with a board opens.
  useEffect(() => {
    if (session?.project.board == null || placementsSeen) return;
    const arm = () => setPlacementsSeen(true);
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(arm, { timeout: PLACEMENTS_IDLE_TIMEOUT_MS });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(arm, PLACEMENTS_IDLE_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [session, placementsSeen]);

  /** The canvas reported a selection — the reader's click, or the echo of a
   *  focus. Either way it is now what the drawing shows. */
  const handleCanvasSelection = useCallback((selection: CanvasSelection) => {
    if (selection.view != null) shown.current[selection.view] = selection.ref;
    setSelectedRef(selection.ref);
  }, []);

  /** Bring the 2D board to the panel's state; a no-op while it is not on screen. */
  const applyBoardToCanvas = useCallback(() => {
    const handle = canvasRef.current;
    if (handle == null) return;
    const next = boardViewRef.current;
    if (applyToCanvas(handle, canvasApplied.current, next)) canvasApplied.current = next;
  }, []);

  /**
   * The board loaded, came back on screen, or changed a layer. A load builds
   * its layer set afresh, so the panel's choices are re-applied here — only
   * what differs, so the echo of our own change settles. The list the panel
   * shows switches to the board's own once it has one.
   */
  const handleCanvasLayers = useCallback(
    (layers: LayerInfo[]) => {
      const rows = panelLayers(layers);
      setCanvasLayers((prev) => (sameLayers(prev, rows) ? prev : rows));
      setCanvasNets((prev) => (prev.length > 0 ? prev : canvasRef.current?.nets() ?? NO_NETS));
      applyBoardToCanvas();
    },
    [applyBoardToCanvas],
  );

  // …and on every change the reader makes while the Board tab is live.
  useEffect(() => {
    if (tab === 'board' && canvasState === 'ready') applyBoardToCanvas();
  }, [boardView, tab, canvasState, applyBoardToCanvas]);

  /**
   * Send a selection to the drawing `view` and keep `shown` honest about the
   * answer. A designator the drawing does not have ('not-found') still CLEARS
   * whatever it outlined before — the viewer's own select resets it, silently —
   * so the record goes to null too; left at the old designator, a later
   * selection of that same part was skipped as "already shown" and never drawn.
   * Only when nothing newer has been recorded for the view in the meantime.
   */
  const outline = useCallback((view: 'schematic' | 'board', send: () => Promise<FocusResult> | undefined) => {
    const before = shown.current[view];
    void send()?.then((result) => {
      if (result === 'not-found' && shown.current[view] === before) shown.current[view] = null;
    });
  }, []);

  /**
   * Carry the selection onto the drawing the reader arrives at, WITHOUT the
   * zoom: on the schematic the designator's own sheet is shown and the symbol
   * outlined; on the board the footprint is outlined where it is. Runs on a
   * tab arrival, and on a selection made off-canvas (the 3D view, the panel)
   * while a drawing is on screen. A selection the canvas itself reported is
   * already on it and is not sent back.
   */
  useEffect(() => {
    if (session == null || canvasState !== 'ready') return;
    if (tab !== 'schematic' && tab !== 'board') return;
    if (selectedRef == null) {
      // Only a drawing that still outlines something is told to clear — never
      // the fresh viewer of a project that has just opened.
      if (shown.current[tab] != null) {
        shown.current[tab] = null;
        void canvasRef.current?.selectRef(null);
      }
      return;
    }
    if (shown.current[tab] === selectedRef) return;
    const where = session.refs.get(selectedRef);
    if (tab === 'schematic') {
      if (where != null && droppedSheets.has(where.sheet)) return;
      if (where != null) {
        setActiveSheet(where.sheet);
        outline('schematic', () => canvasRef.current?.selectRef(selectedRef, where.instancePath, 'schematic'));
      } else {
        // A designator the schematic's BOM does not list (a mounting hole, a
        // footprint-only part): outline it if the sheet on screen has it, and
        // never switch sheets — naming the schematic view here would activate
        // the ROOT sheet under a reader who is on another one.
        outline('schematic', () => canvasRef.current?.selectRef(selectedRef));
      }
    } else {
      outline('board', () => canvasRef.current?.selectRef(selectedRef, undefined, 'board'));
    }
    // `droppedSheets` is read, not depended on: it changes only with the project.
  }, [tab, selectedRef, canvasState, session, outline]);

  const clearSelection = useCallback(() => {
    focusSeq.current += 1;
    setSelectedRef(null);
  }, []);

  /** The panel's search: resolve the typed designator against everything the
   *  project names, then show it on whichever drawing is live. */
  const searchRef = useCallback(
    (text: string) => {
      const s = session;
      if (s == null) return;
      setPlacementsSeen(true);
      const known = knownRefs({ lines: s.parsed.lines, refs: s.refs, placements: placementsRef.current });
      const ref = resolveRef(text, known);
      if (ref == null) {
        // The panel says "not in this project" for a designator nobody knows.
        setSelectedRef(text.trim());
        return;
      }
      if (tab === 'schematic') {
        void focus(ref);
      } else if (tab === 'board') {
        setSelectedRef(ref);
        shown.current.board = ref;
        outline('board', () => canvasRef.current?.focusRef(ref, undefined, 'board'));
      } else {
        setSelectedRef(ref);
      }
    },
    [session, tab, focus, outline],
  );

  /** The panel's "Show on" row: take the reader to the part on that view. */
  const showOn = useCallback(
    (view: ShowOn) => {
      const ref = selectedRef;
      if (ref == null) return;
      focusSeq.current += 1;
      if (view === 'schematic') {
        void focus(ref);
      } else if (view === 'board') {
        setTab('board');
        // Claimed before the tab commit, so the arrival sync does not send a
        // second, zoom-less select alongside this focus.
        shown.current.board = ref;
        outline('board', () => canvasRef.current?.focusRef(ref, undefined, 'board'));
      } else {
        setTab('board3d');
      }
    },
    [selectedRef, focus, outline],
  );

  // `/` focuses the search and Esc clears a highlight, then the selection, anywhere on the page
  // that is not itself a text field. A field owns its own Esc: the panel's
  // search empties itself first and clears the selection on a second press
  // (BoardPanel); the BOM's quantity box keeps the browser's behaviour.
  useEffect(() => {
    if (session == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typingIn(e.target)) return;
      if (e.key === '/') {
        e.preventDefault();
        panelRef.current?.focusSearch();
      } else if (e.key === 'Escape') {
        // A lit layer or net goes first, where the reader can see it; the
        // selection on the next press.
        const view = boardViewRef.current;
        if ((tab === 'board' || tab === 'board3d') && clearHighlights(view) !== view) setBoardView(clearHighlights);
        else clearSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, clearSelection, tab]);

  useEffect(() => {
    if (toast == null) return;
    const id = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(id);
  }, [toast]);

  const tabs = useMemo<{ id: Tab; label: string }[]>(() => {
    if (session == null) return [];
    const out: { id: Tab; label: string }[] = [];
    if (session.project.root != null) out.push({ id: 'schematic', label: 'Schematic' });
    if (session.project.board != null) out.push({ id: 'board', label: 'Board' });
    // Offered for any project with a board, INCLUDING one whose board this
    // reader cannot parse — the panel then says why, which is a better answer
    // than a tab that quietly is not there.
    if (session.project.board != null) out.push({ id: 'stackup', label: 'Stackup' });
    // Same rule as Stackup: offered for any project with a board, because the
    // panel itself is where an unreadable one gets its explanation.
    if (session.project.board != null) out.push({ id: 'board3d', label: '3D' });
    if (session.project.root != null) out.push({ id: 'bom', label: 'BOM' });
    return out;
  }, [session]);

  /**
   * The board's layer stack, or null when there is no board or it cannot be
   * read.
   *
   * `readStackup` THROWS a KicadReadError for a file that does not open with
   * `(kicad_pcb …)` or that is truncated — and `project.ts` picks the board by
   * EXTENSION alone, so a mis-saved or half-copied `.kicad_pcb` really does
   * reach here. Uncaught, that exception is thrown from a render and takes the
   * whole page to the ErrorBoundary: the reader loses the schematic and the BOM
   * over a file they may not even have come for. Caught, they lose only the
   * stackup, and the panel below says so.
   *
   * Read on the FIRST VISIT to the tab, never on project open: `readStackup`
   * re-tokenises the whole board, 323 ms on an 8 MB one, and most readers come
   * for the schematic. `tab === 'stackup'` is ORed in rather than left to the
   * latch's effect because the panel is mounted for the whole session — a
   * commit where the tab is live but the latch has not caught up yet would
   * paint, and `role="alert"` would ANNOUNCE, "could not be read" about a board
   * nobody has tried to read.
   *
   * The 3D tab wants the same rows — the z ladder is what gives its slab a real
   * thickness instead of an invented one — so it opens the same latch.
   */
  const stackupWanted = stackupSeen || tab === 'stackup' || tab === 'board3d';
  const stackup = useMemo(() => {
    const board = session?.project.board;
    if (session == null || board == null || !stackupWanted) return null;
    try {
      return readStackup(session.project.files.get(board) ?? '');
    } catch {
      return null;
    }
  }, [session, stackupWanted]);

  /**
   * Where every footprint sits, read from the board on the first selection
   * (see `placementsSeen`) and once per project. Null for a project with no
   * board, or a board the reader cannot scan — the panel then shows dashes
   * for side and position rather than a guess.
   */
  const placements = useMemo(() => {
    const board = session?.project.board;
    if (session == null || board == null || !placementsSeen) return null;
    try {
      return readPlacements(session.project.files.get(board) ?? '');
    } catch {
      return null;
    }
  }, [session, placementsSeen]);
  /**
   * The board's layer and net tables read from the FILE, for the panel before
   * the 2D board has loaded (and for the 3D tab, which never loads it). Read
   * when the reader first opens Layers or Objects, never on project open.
   */
  const boardTables = useMemo(() => {
    const board = session?.project.board;
    if (session == null || board == null || !boardTablesSeen) return null;
    const text = session.project.files.get(board) ?? '';
    return { layers: layersFromFile(text), nets: netsFromFile(text) };
  }, [session, boardTablesSeen]);
  const listedLayers = canvasLayers.length > 0 ? canvasLayers : boardTables?.layers ?? NO_LAYERS;
  const listedNets = canvasNets.length > 0 ? canvasNets : boardTables?.nets ?? NO_NETS;

  const placementsRef = useRef(placements);
  placementsRef.current = placements;

  const refIndex = useMemo(
    () => (session == null ? [] : knownRefs({ lines: session.parsed.lines, refs: session.refs, placements })),
    [session, placements],
  );

  const facts = useMemo(
    () =>
      session == null || selectedRef == null
        ? null
        : partFacts(selectedRef, {
            lines: session.parsed.lines,
            rows: wb.rows,
            refs: session.refs,
            placements,
            buildQty: wb.buildQty,
            pins,
          }),
    [session, selectedRef, wb.rows, wb.buildQty, placements, pins],
  );

  /**
   * Which drawing tab currently labels the shared canvas panel.
   *
   * Schematic and Board both control it, so the region's `aria-labelledby` has
   * to name whichever one is live — and must never name a tab this project does
   * not have (a board-only drop has no Schematic tab to point at, and a drop
   * with neither has no drawing tab at all).
   */
  const drawingTab: Tab | null = useMemo(() => {
    const has = (id: Tab) => tabs.some((t) => t.id === id);
    if (tab === 'board' && has('board')) return 'board';
    if (has('schematic')) return 'schematic';
    if (has('board')) return 'board';
    // A drop with neither a schematic nor a board: no drawing tab to name.
    return null;
  }, [tabs, tab]);

  /**
   * Arrow keys move focus AND selection across the tablist, as the tabs pattern
   * expects of an automatic-activation tablist; Home and End jump to the ends.
   * Together with the roving `tabIndex` below this makes the strip ONE tab stop,
   * so a keyboard reader does not have to step through four buttons to reach the
   * drawing.
   */
  const onTabKeys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (tabs.length === 0) return;
    const here = tabs.findIndex((t) => t.id === tab);
    let next: number;
    if (e.key === 'ArrowRight') next = (here + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (here - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    const target = tabs[next];
    if (target == null) return;
    // Only now, so an unhandled key (Tab out of the strip, a shortcut) keeps
    // its default behaviour.
    e.preventDefault();
    setTab(target.id);
    tabRefs.current[target.id]?.focus();
  };

  const chooseSheet = (path: string) => {
    // A sheet chip is a newer gesture than any focus still in flight. The
    // controller yields the view to it; this hands it the toast to match.
    focusSeq.current += 1;
    if (droppedSheets.has(path)) {
      setToast(droppedSheetToast(path));
      return;
    }
    setActiveSheet(path);
  };

  const drawingVisible = tab === 'schematic' || tab === 'board';
  /** The 2D drawing will not come (no WebGL, a timeout, an error): the Board
   *  tab then has nothing for Layers and Objects to act on. */
  const canvasFailed = canvasState !== 'loading' && canvasState !== 'ready';

  /**
   * The panel a tab opens, or undefined when that panel is not in the document
   * — a reference to an absent element is worse than none. The BOM panel
   * arrives with its first visit; the 3D panel exists ONLY while its tab is
   * selected, because the renderer it holds owns a WebGL context.
   */
  const panelIdFor = (id: Tab): string | undefined => {
    if (id === 'bom' && !bomSeen) return undefined;
    if (id === 'board3d' && tab !== 'board3d') return undefined;
    return PANEL_ID[PANEL_OF[id]];
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >
      <PageHead seo={STATIC_PAGE_SEO.viewer} />
      <PageHeaderBand
        page="viewer"
        title="Design Viewer"
        subtitle={
          <>
            Open a KiCad project. See the schematic and board, and price the BOM read straight from your{' '}
            <strong>schematic</strong>.
          </>
        }
      />
      <div className={styles.page}>
        <div className={styles.stack}>
          {session == null && (
            <>
              <p className={styles.intro}>{POSITIONING} Your design files never leave your browser.</p>
              <ViewerIntake onProject={handleProject} />
            </>
          )}

          {session != null && (
            <div className={styles.loaded}>
              <div className={styles.strip}>
                <span className={styles.stripName}>{session.project.name}</span>
                <span className={styles.stripMeta}>
                  {session.project.sheets.length} {session.project.sheets.length === 1 ? 'sheet' : 'sheets'},{' '}
                  {session.parsed.lines.reduce((n, l) => n + l.qty, 0).toLocaleString('en-US')} parts,{' '}
                  {session.project.board != null ? 'with a board' : 'no board'}
                </span>
                <button type="button" className={styles.stripAction} onClick={openAnother}>
                  Open another
                </button>
                {(session.project.warnings.length > 0 || session.parsed.warnings.length > 0) && (
                  <ul className={styles.stripNotes}>
                    {[...session.project.warnings, ...session.parsed.warnings].map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>

              {session.project.missingSheets.length > 0 && (
                <p className={styles.pageError} role="alert">
                  Missing sheet file{session.project.missingSheets.length === 1 ? '' : 's'}:{' '}
                  {session.project.missingSheets.join(', ')} &mdash; add {session.project.missingSheets.length === 1 ? 'it' : 'them'} to
                  the drop and the drawing and BOM will include {session.project.missingSheets.length === 1 ? 'it' : 'them'}.
                </p>
              )}

              <div className={styles.tabs} role="tablist" aria-label="Views" onKeyDown={onTabKeys}>
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    id={TAB_ID[t.id]}
                    type="button"
                    role="tab"
                    className={styles.tab}
                    aria-selected={tab === t.id}
                    // Only for a panel that is really in the document: the BOM
                    // panel arrives with its first visit.
                    aria-controls={panelIdFor(t.id)}
                    // Roving: the strip is one tab stop and the arrows move
                    // inside it.
                    tabIndex={tab === t.id ? 0 : -1}
                    ref={(el) => {
                      tabRefs.current[t.id] = el;
                    }}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <div className={styles.stage}>
              <div className={styles.stageMain}>
              {/* Inside the drawing column, not above the stage: only the drawing
                  gives up the row's height, so the part panel beside it no
                  longer jumps 35px on every switch to and from Schematic. */}
              {tab === 'schematic' && session.project.sheets.length > 1 && (
                <div className={styles.chips} role="group" aria-label="Sheets">
                  {droppedSheets.size > 0 && (
                    <span id={DROPPED_REASON_ID} className={styles.srOnly}>
                      {DROPPED_SHEET_HINT}
                    </span>
                  )}
                  {session.project.sheets.map((s) => {
                    const dropped = droppedSheets.has(s.path);
                    return (
                      <button
                        key={s.path}
                        type="button"
                        className={dropped ? `${styles.chip} ${styles.chipDropped}` : styles.chip}
                        aria-current={(activeSheet ?? session.project.root) === s.path}
                        aria-disabled={dropped || undefined}
                        aria-describedby={dropped ? DROPPED_REASON_ID : undefined}
                        title={dropped ? DROPPED_SHEET_HINT : undefined}
                        onClick={() => chooseSheet(s.path)}
                      >
                        {sheetLabel(session.project, s.path)}
                        {dropped && <span aria-hidden="true"> &#9888;</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              <div
                id={PANEL_ID.drawing}
                role="tabpanel"
                aria-labelledby={drawingTab == null ? undefined : TAB_ID[drawingTab]}
                className={styles.drawing}
                hidden={!drawingVisible}
              >
                <DesignCanvas
                  ref={canvasRef}
                  project={session.project}
                  view={tab === 'board' ? 'board' : 'schematic'}
                  activeSheet={tab === 'board' ? undefined : activeSheet}
                  onState={setCanvasState}
                  onSelection={handleCanvasSelection}
                  onUnrenderableSheets={handleUnrenderable}
                  onLayers={handleCanvasLayers}
                />
                <p className={styles.notice}>
                  Rendering by KiCanvas &mdash;{' '}
                  <a href="/vendor/kicanvas/NOTICE.txt" target="_blank" rel="noopener noreferrer">
                    licences
                  </a>
                </p>
              </div>

              {bomSeen && (
                <section
                  id={PANEL_ID.bom}
                  role="tabpanel"
                  aria-labelledby={TAB_ID.bom}
                  hidden={tab !== 'bom'}
                  className={styles.bomPanel}
                  // Kept beside `aria-labelledby` (which wins) as the name
                  // this region has always answered to.
                  aria-label="Bill of materials"
                >
                  {session.parsed.error != null && (
                    <p className={styles.pageError} role="alert">
                      {session.parsed.error}
                    </p>
                  )}
                  {wb.resolveNote != null && <p className={styles.phaseWarn}>{wb.resolveNote}</p>}
                  {wb.matchError != null && (
                    <p className={styles.pageError} role="alert">
                      {wb.matchError}
                    </p>
                  )}
                  {wb.resolveError != null && (
                    <p className={styles.phaseWarn} role="status">
                      {wb.resolveError}
                    </p>
                  )}
                  {wb.matching && (
                    <p className={styles.phaseText} role="status">
                      Pricing {session.parsed.lines.length.toLocaleString('en-US')}{' '}
                      {session.parsed.lines.length === 1 ? 'line' : 'lines'} against the catalog&#8230;
                    </p>
                  )}
                  {session.parsed.error == null && session.parsed.lines.length === 0 && (
                    <p className={styles.phaseText}>
                      Nothing to price &mdash; no BOM lines were read from this schematic. Power,
                      virtual and unreferenced symbols, and anything marked not-in-BOM, are left
                      out on purpose; the notes above this panel say what was skipped.
                    </p>
                  )}
                  {!wb.matching && wb.rows.length > 0 && (
                    <>
                      <BomTable
                        rows={wb.rows}
                        buildQty={wb.buildQty}
                        onBuildQtyChange={wb.setBuildQty}
                        onPickSimilar={wb.pickSimilar}
                        includeDnp={wb.includeDnp}
                        onIncludeDnpChange={wb.setIncludeDnp}
                        onRefClick={(ref) => void focus(ref)}
                        selectedRef={selectedRef}
                        pins={pins}
                        onPinsChange={setPins}
                      />
                      <ShareBar rows={wb.rows} buildQty={wb.buildQty} includeDnp={wb.includeDnp} onChangeFile={openAnother} />
                    </>
                  )}
                </section>
              )}

              {tab === 'board3d' && session.project.board != null && (
                // Mounted ONLY while selected (spec 2026-09-21 D5): the 3D view
                // holds its own WebGL context and releases it on the way out so
                // the 2D embed keeps the browser's one it already has.
                <section
                  id={PANEL_ID.board3d}
                  role="tabpanel"
                  aria-labelledby={TAB_ID.board3d}
                  className={styles.board3dPanel}
                >
                  <Suspense
                    fallback={
                      <p className={styles.notice} role="status">
                        Loading the 3D view&#8230;
                      </p>
                    }
                  >
                    <Board3DView
                      project={session.project}
                      stackup={stackup}
                      selectedRef={selectedRef}
                      onSelect={setSelectedRef}
                      hiddenLayers={boardView.hiddenLayers}
                      highlightedLayer={boardView.highlightedLayer}
                      opacity={boardView.opacity}
                      highlightedNet={boardView.highlightedNet}
                    />
                  </Suspense>
                </section>
              )}

              {session.project.board != null && (
                // Mounted for the whole session and hidden when another tab is
                // live, like every other panel here: the region `aria-controls`
                // names has to exist, and re-reading the board on each visit
                // would be work for nothing.
                <section
                  id={PANEL_ID.stackup}
                  role="tabpanel"
                  aria-labelledby={TAB_ID.stackup}
                  hidden={tab !== 'stackup'}
                  className={styles.stackupPanel}
                >
                  {stackup != null ? (
                    <StackupPanel stackup={stackup} />
                  ) : (
                    <p className={styles.pageError} role="alert">
                      {basename(session.project.board)} could not be read as a KiCad board, so there is no
                      layer stack to show. Open the project in KiCad 6 or newer and save it, then drop it
                      again.
                    </p>
                  )}
                </section>
              )}
              </div>

              <div className={styles.rail}>
                <BoardPanel
                  ref={panelRef}
                  facts={facts}
                  knownRefs={refIndex}
                  views={{
                    schematic: session.project.root != null,
                    board: session.project.board != null,
                    board3d: session.project.board != null,
                  }}
                  current={tab === 'schematic' || tab === 'board' || tab === 'board3d' ? tab : null}
                  onSearch={searchRef}
                  onClear={clearSelection}
                  onShow={showOn}
                  onPriceBom={() => setTab('bom')}
                  onSearchFocus={() => setPlacementsSeen(true)}
                  board={
                    session.project.board == null
                      ? null
                      : {
                          context: tab === 'board3d' ? 'board3d' : tab === 'board' && !canvasFailed ? 'board' : null,
                          hint: tab === 'board' && canvasFailed ? BOARD_FAILED_HINT : BOARD_HINT,
                          layers: listedLayers,
                          nets: listedNets,
                          view: boardView,
                          onChange: setBoardView,
                          onOpen: () => setBoardTablesSeen(true),
                        }
                  }
                />
              </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {toast != null && (
        <div className={styles.toast} role="status">
          {toast}
        </div>
      )}
    </motion.div>
  );
}
