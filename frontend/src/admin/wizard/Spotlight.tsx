import { useEffect, useLayoutEffect, useState } from 'react';
import styles from './Wizard.module.scss';
import CoachCard, { type CoachPos } from './CoachCard';
import { useTargetRect, type Rect } from './useTargetRect';
import { useAdvance } from './useAdvance';
import { findEl, findFieldInput } from './helpers';
import type { Flow, Step, SpotlightStep } from './types';

function isSpotlightStep(step: Step): step is SpotlightStep {
  return step.type === undefined || step.type === 'spotlight';
}

interface SpotlightProps {
  step: Step;
  stepIndex: number;
  totalSteps: number;
  flow: Flow;
  currentRoute: string;
  onNext: () => void;
  onExit: () => void;
  onAutofill: (step: Step) => void;
}

const COACH_W = 360;
const COACH_GAP = 16;
const COACH_EST_H = 240;

// Decide which side of the target to render the tooltip on, given
// available viewport space. Falls back to center when there's no target
// (annotation steps).
function placeCoach(rect: Rect | null): CoachPos {
  if (!rect) {
    return {
      top: window.innerHeight / 2 - 140,
      left: window.innerWidth / 2 - COACH_W / 2,
      side: 'center',
    };
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const spaceRight = vw - (rect.left + rect.width) - COACH_GAP;
  const spaceLeft = rect.left - COACH_GAP;
  const spaceBottom = vh - (rect.top + rect.height) - COACH_GAP;

  if (spaceRight >= COACH_W + 12) {
    return {
      side: 'left',
      left: rect.left + rect.width + COACH_GAP,
      top: Math.max(16, Math.min(vh - COACH_EST_H - 16, rect.top + rect.height / 2 - COACH_EST_H / 2)),
    };
  }
  if (spaceLeft >= COACH_W + 12) {
    return {
      side: 'right',
      left: rect.left - COACH_GAP - COACH_W,
      top: Math.max(16, Math.min(vh - COACH_EST_H - 16, rect.top + rect.height / 2 - COACH_EST_H / 2)),
    };
  }
  if (spaceBottom >= COACH_EST_H + 12) {
    return {
      side: 'top',
      top: rect.top + rect.height + COACH_GAP,
      left: Math.max(16, Math.min(vw - COACH_W - 16, rect.left + rect.width / 2 - COACH_W / 2)),
    };
  }
  return {
    side: 'bottom',
    top: Math.max(16, rect.top - COACH_GAP - COACH_EST_H),
    left: Math.max(16, Math.min(vw - COACH_W - 16, rect.left + rect.width / 2 - COACH_W / 2)),
  };
}

// Resolves the effective DOM selector for a step. fieldName is shorthand
// for [data-field="<name>"] (the wrapper div that owns the label+input).
function selectorForStep(step: Step): string | (() => Element | null) | undefined {
  if (step.type === 'annotation' || step.type === 'preview') return undefined;
  if (step.fieldName) return `[data-field="${step.fieldName}"]`;
  return step.selector;
}

// Spotlight = dim layer + cutout rectangle + coachmark.
// The dim layer is pointer-events:none so the user can actually CLICK
// the spotlighted button underneath. Annotation steps use a full-dim
// variant (pointer-events:auto) that swallows clicks since there's no
// specific target.
export default function Spotlight({
  step,
  stepIndex,
  totalSteps,
  flow,
  currentRoute,
  onNext,
  onExit,
  onAutofill,
}: SpotlightProps) {
  const selector = selectorForStep(step);
  const isAnnotation = step.type === 'annotation';
  const rect = useTargetRect(selector ?? null, isSpotlightStep(step) && step.fieldName ? 6 : 8);
  const [coachPos, setCoachPos] = useState<CoachPos>(() => placeCoach(null));

  useLayoutEffect(() => {
    setCoachPos(placeCoach(rect));
  }, [rect?.top, rect?.left, rect?.width, rect?.height]);

  useAdvance(step.advance, onNext, `${flow.id}-${stepIndex}`, currentRoute);

  // Auto-focus the field input when stepping onto an input step. Helps
  // keyboard-driven users stay on the home row.
  const fieldName = isSpotlightStep(step) ? step.fieldName : undefined;
  useEffect(() => {
    if (!fieldName) return;
    const t = setTimeout(() => {
      const inp = findFieldInput(fieldName);
      if (inp && document.activeElement !== inp) inp.focus({ preventScroll: false });
    }, 360);
    return () => clearTimeout(t);
  }, [fieldName, stepIndex]);

  // Scroll target into view if it's offscreen.
  useEffect(() => {
    if (!selector) return;
    const el = findEl(selector);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 80 || r.bottom > window.innerHeight - 80) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [selector, stepIndex]);

  // Mobile drawer auto-open: when spotlighting a sidebar item, the
  // sidebar lives off-screen as a drawer on viewports under the admin
  // breakpoint. The target rect lands at negative left and the user
  // sees a tooltip pointing at nothing. Click the hamburger button to
  // slide the drawer in so the spotlighted nav link is actually visible.
  //
  // The drawer closes itself via AdminLayout's location.pathname effect
  // once the user clicks through, so no symmetric "close" step needed.
  useEffect(() => {
    if (typeof selector !== 'string') return;
    if (!selector.startsWith('[data-tour="side-')) return;
    // Only act on mobile widths where the sidebar is a drawer.
    if (window.innerWidth > 820) return;
    const sidebar = document.getElementById('admin-sidebar');
    const burger = document.querySelector<HTMLButtonElement>(
      '[data-tour="open-mobile-menu"]',
    );
    if (!sidebar || !burger) return;
    // The drawer is "open" when its left rect is non-negative. Reading
    // aria-hidden alone isn't enough — that toggles to false BEFORE the
    // CSS transition completes.
    const rect = sidebar.getBoundingClientRect();
    if (rect.left < 0) {
      burger.click();
    }
  }, [selector, stepIndex]);

  return (
    <>
      <div className={`${styles.dim} ${isAnnotation ? styles.dimFull : ''}`} />
      {!isAnnotation && rect && (
        <div
          className={styles.spotlight}
          style={{
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            borderRadius: rect.height > 60 ? 12 : 8,
          }}
        />
      )}
      <CoachCard
        step={step}
        stepIndex={stepIndex}
        totalSteps={totalSteps}
        flow={flow}
        pos={coachPos}
        onNext={onNext}
        onExit={onExit}
        onAutofill={onAutofill}
      />
    </>
  );
}
