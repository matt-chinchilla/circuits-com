import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import Fab from './Fab';
import Menu from './Menu';
import WelcomeBubble from './WelcomeBubble';
import Spotlight from './Spotlight';
import LivePreviewModal from './LivePreviewModal';
import { FLOWS, SAMPLE_CSV_TEXT } from './flows';
import { autofillField, getRoute, navTo } from './helpers';
import { useExposeGlobals } from './useExposeGlobals';
import { cleanupAllDemoEntities, clearDemoEntity, trackDemoEntity } from './demoCleanup';
import type { Flow, Step } from './types';

const WELCOMED_KEY = 'wiz-welcomed';

// Top-level wizard state machine. Owns:
//   - active flow + step index
//   - menu open/closed
//   - body class for overscroll-contain while a flow is active
//   - the goto-directive runner that drives admin navigation on step entry
export default function WizardApp() {
  useExposeGlobals();

  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeFlowId, setActiveFlowId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [welcomeShown, setWelcomeShown] = useState(
    () => localStorage.getItem(WELCOMED_KEY) === '1',
  );

  const activeFlow: Flow | null = useMemo(
    () => FLOWS.find((f) => f.id === activeFlowId) ?? null,
    [activeFlowId],
  );
  const step: Step | undefined = activeFlow?.steps[stepIndex];

  // Pass the live route into hooks that key on it (useAdvance for route
  // kinds). Stripping the /admin/ prefix matches the flow DSL.
  const currentRoute = useMemo(() => {
    const m = location.pathname.match(/^\/admin\/?(.*)$/);
    return m ? m[1] : '';
  }, [location.pathname]);

  // Lock overscroll while a flow is active so the spotlight target
  // doesn't drift away under the cursor. Cleanup also wipes any orphan
  // overlay nodes (defensive — React's reconciliation should handle this,
  // but a stray transition could leave a stale dim layer blanking the
  // screen until refresh).
  useEffect(() => {
    if (activeFlow) {
      document.body.classList.add('wiz-active');
      return () => {
        document.body.classList.remove('wiz-active');
        document
          .querySelectorAll('.wiz-orphan')
          .forEach((el) => el.parentElement?.removeChild(el));
      };
    }
    return undefined;
  }, [activeFlow]);

  // Run the step's `goto` directive when entering it. Handles both
  // string and function forms (function form supports context-dependent
  // navigation like "go to the just-created supplier's detail page").
  useEffect(() => {
    if (!step) return;
    if (step.goto === undefined) return;
    const target = typeof step.goto === 'function' ? step.goto() : step.goto;
    if (target == null) return;
    if (target === '') {
      navTo('');
      return;
    }
    // Skip navigation if we're already at the target — avoids router
    // double-pushes and unnecessary remounts.
    if (target === getRoute()) return;
    navTo(target);
  }, [activeFlowId, stepIndex, step]);

  // Track demo entity IDs created during flows so we can clean them up
  // if the user exits early or refreshes. The previous route lets us detect
  // the new→detail transition that signals entity creation.
  const prevRouteRef = useRef(currentRoute);
  useEffect(() => {
    const prev = prevRouteRef.current;
    prevRouteRef.current = currentRoute;
    if (!activeFlowId) return;

    if (activeFlowId === 'add-supplier' && prev === 'suppliers/new') {
      const m = currentRoute.match(/^suppliers\/([^/]+)$/);
      if (m) trackDemoEntity('supplier', m[1]);
    }
    if (activeFlowId === 'add-part-to-supplier' && prev === 'parts/new') {
      const m = currentRoute.match(/^parts\/([^/]+)$/);
      if (m) trackDemoEntity('part', m[1]);
    }
  }, [activeFlowId, currentRoute]);

  const startFlow = useCallback((flowId: string, resume: boolean) => {
    cleanupAllDemoEntities();
    setActiveFlowId(flowId);
    if (!resume) setStepIndex(0);
    setMenuOpen(false);
  }, []);

  const exitFlow = useCallback(() => {
    cleanupAllDemoEntities();
    setActiveFlowId(null);
    setStepIndex(0);
  }, []);

  const advance = useCallback(() => {
    if (!activeFlow) return;
    if (stepIndex + 1 >= activeFlow.steps.length) {
      // Flow completed normally — entity was already deleted by the user
      // during the tutorial's cleanup steps. Clear tracking so next start
      // doesn't fire a wasted 404.
      if (activeFlow.id === 'add-supplier') clearDemoEntity('supplier');
      if (activeFlow.id === 'add-part-to-supplier') clearDemoEntity('part');
      setActiveFlowId(null);
      setStepIndex(0);
    } else {
      setStepIndex((i) => i + 1);
    }
  }, [activeFlow, stepIndex]);

  const handleAutofill = useCallback((s: Step) => {
    if (s.suggested === '__sample_csv__') {
      // Synthesize a File from the sample CSV text and feed it into the
      // dropzone's hidden file input. ImportPage uses react-dropzone,
      // which listens on the input's onChange via getInputProps().
      const file = new File([SAMPLE_CSV_TEXT], 'demo-import.csv', { type: 'text/csv' });
      const dz = document.querySelector('[data-tour="csv-dropzone"]');
      const fileInput = dz?.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (fileInput) {
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    if (s.type === 'spotlight' || s.type === undefined) {
      if (s.fieldName && s.suggested != null) {
        autofillField(s.fieldName, s.suggested);
      }
    }
  }, []);

  const dismissWelcome = useCallback(() => {
    localStorage.setItem(WELCOMED_KEY, '1');
    setWelcomeShown(true);
  }, []);

  const progress = activeFlow ? (stepIndex + 1) / activeFlow.steps.length : 0;
  const isPreviewStep = step?.type === 'preview';

  return (
    <>
      {!welcomeShown && !activeFlow && !menuOpen && (
        <WelcomeBubble onDismiss={dismissWelcome} />
      )}
      {activeFlow && step && !isPreviewStep && (
        <Spotlight
          step={step}
          stepIndex={stepIndex}
          totalSteps={activeFlow.steps.length}
          flow={activeFlow}
          currentRoute={currentRoute}
          onNext={advance}
          onExit={exitFlow}
          onAutofill={handleAutofill}
        />
      )}
      {activeFlow && step && isPreviewStep && (
        <LivePreviewModal step={step} flow={activeFlow} onClose={advance} onNext={advance} />
      )}
      {menuOpen && (
        <Menu
          onPick={startFlow}
          onClose={() => setMenuOpen(false)}
          activeFlow={activeFlow}
          stepIndex={stepIndex}
        />
      )}
      <Fab
        menuOpen={menuOpen}
        onClick={() => {
          dismissWelcome();
          setMenuOpen((o) => !o);
        }}
        pulse={!welcomeShown && !activeFlow && !menuOpen}
        progress={progress}
      />
    </>
  );
}
