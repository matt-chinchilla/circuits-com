// Design Viewer — open a KiCad project in the browser (spec §7.1). Stage 1
// tabs: Schematic, Board; Phase 3 adds BOM, Phase 4 adds Stackup. ONE canvas
// element serves both drawing tabs (one embed per project); it is hidden, not
// unmounted, when another tab is active.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useLocation } from 'react-router-dom';
import PageHead from '@public/components/PageHead';
import PageHeaderBand from '@public/components/layout/PageHeaderBand';
import DesignCanvas, { type DesignCanvasHandle } from '@public/components/kicad/DesignCanvas';
import type { CanvasStateName } from '@public/components/kicad/canvasController';
import { basename } from '@public/services/kicad/project';
import type { KicadProject } from '@public/services/kicad/types';
import { clearDesignSession, getDesignSession, openDesign, type DesignSession } from '@public/services/designSession';
import { STATIC_PAGE_SEO } from '@public/services/seoRoutes';
import ViewerIntake from './components/ViewerIntake';
import styles from './ViewerPage.module.scss';

type Tab = 'schematic' | 'board' | 'stackup' | 'bom';

export const POSITIONING =
  'Open your KiCad project in the browser and get every line of the BOM priced across our whole distributor catalog — read straight out of your schematic, with no CSV export, no account, and nobody trying to win your board order.';

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
  const canvasRef = useRef<DesignCanvasHandle>(null);
  const pendingFocus = useRef<string | null>(location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : null);

  // The session is opened HERE and only here — never in an effect. React 19's
  // StrictMode double-invokes effects, and openDesign re-parses the schematic.
  const handleProject = useCallback((project: KicadProject) => {
    const next = openDesign(project);
    setSession(next);
    setTab(defaultTab(next));
    setActiveSheet(undefined);
    setCanvasState('loading');
  }, []);

  // Deliberately NOT called on unmount: surviving the /viewer ↔ /bom trip is
  // the whole point of the session. Only this button ends it.
  const openAnother = () => {
    clearDesignSession();
    setSession(null);
    setActiveSheet(undefined);
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

  // A #ref arrival (from /bom) focuses once, after the canvas is ready.
  useEffect(() => {
    if (canvasState !== 'ready' || pendingFocus.current == null || session == null) return;
    const ref = pendingFocus.current;
    pendingFocus.current = null;
    void focus(ref);
  }, [canvasState, session, focus]);

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
    // Phase 3: { id: 'bom', label: 'BOM' } when root != null
    return out;
  }, [session]);

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
                  {session.project.sheets.map((s) => (
                    <button
                      key={s.path}
                      type="button"
                      className={styles.chip}
                      aria-current={(activeSheet ?? session.project.root) === s.path}
                      onClick={() => setActiveSheet(s.path)}
                    >
                      {sheetLabel(session.project, s.path)}
                    </button>
                  ))}
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

              {/* Phase 4: {tab === 'stackup' && <StackupPanel … />} */}
              {/* Phase 3: {tab === 'bom' && … workbench … onRefClick={(ref) => void focus(ref)} } */}
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
