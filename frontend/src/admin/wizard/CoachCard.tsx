import { useEffect, useRef, useState } from 'react';
import styles from './Wizard.module.scss';
import { WI } from './icons';
import type { Flow, Step } from './types';
import { findEl, getFieldValue } from './helpers';

export interface CoachPos {
  top: number;
  left: number;
  side: 'top' | 'bottom' | 'left' | 'right' | 'center';
}

interface CoachCardProps {
  step: Step;
  stepIndex: number;
  totalSteps: number;
  flow: Flow;
  pos: CoachPos;
  canGoBack: boolean;
  /** True while this step sits under a Back guard — see the Next handler. */
  guarded: boolean;
  onNext: () => void;
  onBack: () => void;
  onExit: () => void;
  onAutofill: (step: Step) => void;
}

const COACH_W = 360;

// How long a GUARDED step's Next waits after clicking its anchor before it
// force-advances. Long enough to cover a real transition (route change → the
// 240ms useAdvance debounce → render), short enough that a click which turned
// out to be a no-op doesn't read as a dead end.
const GUARDED_CLICK_FALLBACK_MS = 900;

// Tooltip card that sits next to (or in the center of) the spotlight.
// Renders the title, body, optional hint, optional "Try / Use it"
// autofill chip, step pip-bar, and Exit / Next buttons.
//
// Next is ALWAYS clickable — auto-advance is a nicety, not a gate.
// Clicking Next on a step with suggested data auto-fills first; a field step
// whose fill satisfies its own advance test then moves on immediately, and
// anything else leaves the transition to useAdvance. No "Skip" label — the
// tutorial should always demonstrate the action, not bypass it.
//
// Back is the mirror of that: pinned left, red, hidden on step 1. It
// rewinds one step and re-navigates to the route that step lived on
// (WizardApp.goBack), which is why it reads as the destructive-ish control.
export default function CoachCard({
  step,
  stepIndex,
  totalSteps,
  flow,
  pos,
  canGoBack,
  guarded,
  onNext,
  onBack,
  onExit,
  onAutofill,
}: CoachCardProps) {
  // Value-type advance: re-check periodically so the Next label flips
  // from Skip→Next once the user types valid input. The advance hook
  // handles the actual auto-firing; we just mirror state for the label.
  const [detected, setDetected] = useState<boolean>(() => isManualOrAnnotation(step));

  useEffect(() => {
    if (isManualOrAnnotation(step) || step.advance.kind !== 'value') {
      setDetected(isManualOrAnnotation(step));
      return;
    }
    const check = () => setDetected(valueAdvancePasses(step));
    check();
    const t = setInterval(check, 280);
    return () => clearInterval(t);
  }, [step, stepIndex]);

  // One autofill attempt per step. Without this, a step whose suggestion
  // can't satisfy its own test (an empty `__auto_select__` dropdown, say)
  // swallows EVERY Next click and the tour dead-ends. The first click fills;
  // from then on the click falls through to the anchor-click / onNext path
  // below, so a suggestion that can't satisfy the step is never a dead end.
  //
  // A field step whose autofill DID produce a passing value advances on that
  // same first click (see the Next handler) — everything else, including a
  // no-op autofill and every non-field suggestion, waits for the poll or the
  // next click.
  const autofilledRef = useRef(false);
  useEffect(() => {
    autofilledRef.current = false;
  }, [step, stepIndex]);

  // Dead-end insurance for a GUARDED step's Next (see the Next handler). The
  // cleanup runs whenever the step changes, so a click that DID transition
  // cancels its own fallback and can never double-advance.
  const fallbackRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (fallbackRef.current != null) {
        window.clearTimeout(fallbackRef.current);
        fallbackRef.current = null;
      }
    },
    [step, stepIndex],
  );

  const showSuggested = !!step.suggested && step.suggested !== '__sample_csv__';
  const showSampleCSV = step.suggested === '__sample_csv__';
  const body = typeof step.body === 'function' ? step.body() : step.body;
  const isLast = stepIndex === totalSteps - 1;

  // Next, in three layers: autofill the suggestion (once), else demonstrate the
  // step's action by clicking its anchor, else just advance. Order matters —
  // each layer is the fallback for the one above it, and none of them may leave
  // the tour with no way forward.
  function handleNext() {
    if (!detected && step.suggested && !autofilledRef.current) {
      autofilledRef.current = true;
      onAutofill(step);
      // Field steps: advance on this same click instead of waiting for the
      // async value-poll (grace + interval + settle window). A brisk run of
      // Next clicks used to outrun the poll and skip a field, so the submit
      // step landed with an empty required value (e.g. unit price) and the
      // POST failed.
      //
      // But ONLY if the autofill actually landed a value the step accepts.
      // `__auto_select__` no-ops while the <select>'s options are still
      // fetching (handleAutofill finds nothing to pick), and advancing on that
      // walked the tour past an empty REQUIRED select — the submit step then
      // blocked with no way forward. Re-read the field through the SAME check
      // the poll uses: no passing value ⇒ stay put and let the poll (or the
      // next click, now that the one-shot is spent) carry it once the options
      // arrive.
      if (valueAdvancePasses(step)) onNext();
      return;
    }
    // The anchor-click fallback demonstrates the action for the user.
    // It runs on GUARDED steps too: skipping it (the pre-2026-07-29
    // behaviour) meant Next never performed the transition the step
    // exists to demonstrate — Add-a-Supplier step 2 → Back → Next
    // moved the coach on while the page stayed put, which reads as
    // "Next does nothing".
    //
    // A guarded step's own advance stays suppressed until a FRESH
    // transition, so if the click happens to be a no-op (the anchor
    // is the route we're already standing on) nothing would ever move
    // it forward. Hence the timer: click, then force-advance if we're
    // still on this step a beat later. Unguarded steps keep their
    // original click-and-wait semantics — a timer there would advance
    // past input steps the user hasn't filled in yet.
    if (!detected && step.type !== 'annotation' && step.type !== 'preview') {
      const sel = step.fieldName ? `[data-field="${step.fieldName}"]` : step.selector;
      if (sel) {
        const el = findEl(sel);
        if (el instanceof HTMLElement) {
          el.click();
          if (guarded) {
            if (fallbackRef.current != null) {
              window.clearTimeout(fallbackRef.current);
            }
            fallbackRef.current = window.setTimeout(() => {
              fallbackRef.current = null;
              onNext();
            }, GUARDED_CLICK_FALLBACK_MS);
          }
          return;
        }
      }
    }
    onNext();
  }

  return (
    <div
      className={styles.coach}
      role="dialog"
      aria-modal="false"
      aria-labelledby="wiz-coach-title"
      data-side={pos.side}
      style={{ top: pos.top, left: pos.left, width: COACH_W }}
    >
      <div className={styles.coachHead}>
        <span className={styles.coachStep}>
          Step {stepIndex + 1} of {totalSteps}
        </span>
        <span className={styles.coachFlow}>{flow.title}</span>
        <button
          type="button"
          className={styles.coachExit}
          onClick={onExit}
          aria-label="Exit tour"
        >
          <WI.X />
        </button>
      </div>
      <div id="wiz-coach-title" className={styles.coachTitle}>
        {step.title}
      </div>
      <div className={styles.coachBody}>{body}</div>
      {step.hint && (
        <div className={styles.coachHint}>
          <span className={styles.hintBullet}>→</span>
          <span>{step.hint}</span>
        </div>
      )}
      {(showSuggested || showSampleCSV) && (
        <div className={styles.coachSuggested}>
          <span className={styles.label}>{showSampleCSV ? 'Sample' : 'Try'}</span>
          <span className={styles.val} title={step.suggestedLabel ?? step.suggested}>
            {step.suggestedLabel ?? step.suggested}
          </span>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnFill}`}
            onClick={() => onAutofill(step)}
          >
            <WI.Sparkle /> Use it
          </button>
        </div>
      )}
      <div className={styles.coachFoot}>
        {canGoBack && (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnBack}`}
            onClick={onBack}
            aria-label="Back one step"
          >
            &larr; Back
          </button>
        )}
        <div className={styles.coachProgress} aria-hidden="true">
          {Array.from({ length: totalSteps }).map((_, i) => {
            const cls = [
              styles.pip,
              i < stepIndex ? styles.pipDone : '',
              i === stepIndex ? styles.pipCurrent : '',
            ]
              .filter(Boolean)
              .join(' ');
            return <span key={i} className={cls} />;
          })}
        </div>
        <div className={styles.coachActions}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={onExit}
          >
            Exit
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={handleNext}
          >
            {isLast ? (
              <>
                Finish <WI.Check />
              </>
            ) : detected ? (
              <>
                Next <WI.Check />
              </>
            ) : (
              <>
                Next <WI.ArrowRight />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function isManualOrAnnotation(step: Step): boolean {
  return step.advance.kind === 'manual' || step.type === 'annotation' || step.type === 'preview';
}

// Does this step's `value` advance test pass against the field's CURRENT DOM
// value? ONE answer to that question, asked from both places that need it:
//   - the label poll above (does Next show a check mark yet), and
//   - the Next handler's advance-after-autofill check (did the suggestion it
//     just wrote actually satisfy the step).
// Sharing it is what keeps them from disagreeing — same field (`advance`'s own
// fieldName, the one useAdvance polls), same test, same read path.
//
// Anything that is not a `value` advance answers false. For the poll that means
// "no check mark"; for the autofill path it means "don't advance yet", never
// "dead end" — the click falls through to the anchor-click / onNext path on the
// NEXT press.
function valueAdvancePasses(step: Step): boolean {
  const advance = step.advance;
  if (advance.kind !== 'value') return false;
  try {
    return advance.test(advance.fieldName ? getFieldValue(advance.fieldName) : '');
  } catch {
    return false;
  }
}
