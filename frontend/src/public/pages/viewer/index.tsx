// Design Viewer — open a KiCad project in the browser (spec §7.1). Stage 1
// tabs: Schematic, Board, BOM; Phase 4 adds Stackup. ONE canvas element serves
// both drawing tabs (one embed per project); it is hidden, not unmounted, when
// another tab is active.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useLocation } from 'react-router-dom';
import PageHead from '@public/components/PageHead';
import PageHeaderBand from '@public/components/layout/PageHeaderBand';
import DesignCanvas, { type DesignCanvasHandle } from '@public/components/kicad/DesignCanvas';
import type { CanvasStateName } from '@public/components/kicad/canvasController';
// The one thing this page asks the renderer that is not a command: which files
// its basename-keyed virtual file system had to drop. `sourcesFor` is the pure,
// already-tested half of that decision — the controller calls it at mount — and
// asking it HERE is what lets a chip say so before it is clicked. A post-mount
// callback would leave the chips unmarked for the first second, which is when
// they get clicked.
import { sourcesFor } from '@public/components/kicad/kicanvasController';
import BomTable from '@public/components/bom/BomTable';
import ShareBar from '@public/components/bom/ShareBar';
import { useBomWorkbench } from '@public/services/bom/useBomWorkbench';
import { basename } from '@public/services/kicad/project';
import type { KicadProject } from '@public/services/kicad/types';
import { clearDesignSession, getDesignSession, openDesign, type DesignSession } from '@public/services/designSession';
import { STATIC_PAGE_SEO } from '@public/services/seoRoutes';
import ViewerIntake from './components/ViewerIntake';
import styles from './ViewerPage.module.scss';

type Tab = 'schematic' | 'board' | 'stackup' | 'bom';

export const POSITIONING =
  'Open your KiCad project in the browser and get every line of the BOM priced across our whole distributor catalog — read straight out of your schematic, with no CSV export, no account, and nobody trying to win your board order.';

/** Why a chip is inert, in the two places that have to say it: the hover title
 *  and the toast a click raises. The renderer addresses its files by BASENAME,
 *  so a second `power.kicad_sch` cannot be represented at all. */
const DROPPED_SHEET_HINT =
  'Another sheet in this project has the same filename, so only one of them can be drawn.';

function droppedSheetToast(path: string): string {
  return `${basename(path)} can't be drawn — another sheet in this project has the same filename.`;
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

function defaultTab(session: DesignSession): Tab {
  return session.project.root != null ? 'schematic' : 'board';
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
  const canvasRef = useRef<DesignCanvasHandle>(null);
  /** A focus the canvas still owes us, held until it reports `ready`. */
  const pendingFocus = useRef<string | null>(null);

  const wb = useBomWorkbench(
    // Armed by the first BOM-tab visit and never disarmed short of a new
    // project. A parse that failed has nothing to price — the panel shows the
    // reason instead.
    bomSeen && session != null && session.parsed.error == null ? session.parsed : null,
    // No viewer route: this IS the viewer. Designator chips act in place via
    // `onRefClick`, which outranks a link (spec §6).
    null,
  );

  // The session is opened HERE and only here — never in an effect. React 19's
  // StrictMode double-invokes effects, and openDesign re-parses the schematic.
  const handleProject = useCallback((project: KicadProject) => {
    const next = openDesign(project);
    setSession(next);
    setTab(defaultTab(next));
    setActiveSheet(undefined);
    setCanvasState('loading');
    setBomSeen(false);
  }, []);

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
    setActiveSheet(undefined);
    // A toast raised a moment ago would otherwise float over the fresh intake.
    setToast(null);
    pendingFocus.current = null;
  };

  const focus = useCallback(
    async (ref: string) => {
      const s = session;
      if (s == null) return;
      if (s.project.root == null) {
        // Reachable: arrive at /viewer#U1, then open a board-only project. Without
        // this we would select a Schematic tab that the tablist does not render.
        setToast(`${ref} can't be shown — this project has no schematic.`);
        return;
      }
      const where = s.refs.get(ref);
      // Page state moves BEFORE the drawing does. DesignCanvas re-activates on
      // every `view`/`activeSheet` change, and when `setTab` really flips the
      // view that effect can land AFTER focusRef has finished — re-activating
      // whatever sheet the page still believed was current and dragging the
      // canvas off the one the focus just selected. Naming the designator's own
      // sheet first makes the late activate a no-op instead of a fight.
      if (where != null) setActiveSheet(where.sheet);
      setTab('schematic');
      const result = await canvasRef.current?.focusRef(ref, where?.instancePath);
      if (result === 'focused') setToast(`Focused ${ref}`);
      else if (result === 'not-found') setToast(where ? `${ref} was not found on sheet ${basename(where.sheet)}` : `${ref} is not in this schematic`);
      // 'unsupported' (no WebGL, or no renderer mounted) and an absent handle both
      // land here: say so rather than leaving the click with no answer at all.
      else setToast(`${ref} can't be focused — the drawing is not available in this browser.`);
    },
    [session],
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
    // Phase 4: { id: 'stackup', label: 'Stackup' } when board != null
    if (session.project.root != null) out.push({ id: 'bom', label: 'BOM' });
    return out;
  }, [session]);

  /**
   * Sheets the renderer could not be handed, because a second file shares their
   * basename. They stay LISTED — the reader really did read them, and a sheet
   * that silently vanishes from the chip bar is worse than one that says why it
   * cannot be drawn — but they are marked, and clicking one answers instead of
   * doing nothing (the controller's `activate` returns false there and nothing
   * upstream of this page surfaces that boolean).
   */
  const droppedSheets = useMemo(
    () => (session == null ? new Set<string>() : new Set(sourcesFor(session.project).dropped)),
    [session],
  );

  const chooseSheet = (path: string) => {
    if (droppedSheets.has(path)) {
      setToast(droppedSheetToast(path));
      return;
    }
    setActiveSheet(path);
  };

  const drawingVisible = tab === 'schematic' || tab === 'board';

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
                  {session.project.sheets.length} {session.project.sheets.length === 1 ? 'sheet' : 'sheets'} &middot;{' '}
                  {session.parsed.lines.reduce((n, l) => n + l.qty, 0).toLocaleString('en-US')} parts &middot; board:{' '}
                  {session.project.board != null ? 'yes' : 'no'}
                </span>
                <button type="button" className={styles.stripAction} onClick={openAnother}>
                  Open another
                </button>
              </div>

              {[...session.project.warnings, ...session.parsed.warnings].map((w) => (
                <p key={w} className={styles.phaseWarn}>
                  {w}
                </p>
              ))}
              {session.project.missingSheets.length > 0 && (
                <p className={styles.pageError} role="alert">
                  Missing sheet file{session.project.missingSheets.length === 1 ? '' : 's'}:{' '}
                  {session.project.missingSheets.join(', ')} &mdash; add {session.project.missingSheets.length === 1 ? 'it' : 'them'} to
                  the drop and the drawing and BOM will include {session.project.missingSheets.length === 1 ? 'it' : 'them'}.
                </p>
              )}

              <div className={styles.tabs} role="tablist" aria-label="Views">
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    className={styles.tab}
                    aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {tab === 'schematic' && session.project.sheets.length > 1 && (
                <div className={styles.chips} role="group" aria-label="Sheets">
                  {session.project.sheets.map((s) => {
                    const dropped = droppedSheets.has(s.path);
                    return (
                      <button
                        key={s.path}
                        type="button"
                        className={dropped ? `${styles.chip} ${styles.chipDropped}` : styles.chip}
                        aria-current={(activeSheet ?? session.project.root) === s.path}
                        aria-disabled={dropped || undefined}
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

              <div className={styles.drawing} hidden={!drawingVisible}>
                <DesignCanvas
                  ref={canvasRef}
                  project={session.project}
                  view={tab === 'board' ? 'board' : 'schematic'}
                  activeSheet={tab === 'board' ? undefined : activeSheet}
                  onState={setCanvasState}
                />
                <p className={styles.notice}>
                  Rendering by KiCanvas &mdash;{' '}
                  <a href="/vendor/kicanvas/NOTICE.txt" target="_blank" rel="noopener noreferrer">
                    licences
                  </a>
                </p>
              </div>

              {bomSeen && (
                <section hidden={tab !== 'bom'} className={styles.bomPanel} aria-label="Bill of materials">
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
                      />
                      <ShareBar rows={wb.rows} buildQty={wb.buildQty} includeDnp={wb.includeDnp} onChangeFile={openAnother} />
                    </>
                  )}
                </section>
              )}

              {/* Phase 4: {tab === 'stackup' && <StackupPanel … />} */}
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
