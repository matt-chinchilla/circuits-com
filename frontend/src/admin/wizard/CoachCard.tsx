import { useEffect, useState } from 'react';
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
  onNext: () => void;
  onExit: () => void;
  onAutofill: (step: Step) => void;
}

const COACH_W = 360;

// Tooltip card that sits next to (or in the center of) the spotlight.
// Renders the title, body, optional hint, optional "Try / Use it"
// autofill chip, step pip-bar, and Exit / Next buttons.
//
// Next is ALWAYS clickable — auto-advance is a nicety, not a gate.
// Clicking Next on a step with suggested data auto-fills first, then
// lets useAdvance handle the transition. No "Skip" label — the tutorial
// should always demonstrate the action, not bypass it.
export default function CoachCard({
  step,
  stepIndex,
  totalSteps,
  flow,
  pos,
  onNext,
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
    const advance = step.advance;
    const check = () => {
      try {
        const val = advance.fieldName ? getFieldValue(advance.fieldName) : '';
        setDetected(advance.test(val));
      } catch {
        setDetected(false);
      }
    };
    check();
    const t = setInterval(check, 280);
    return () => clearInterval(t);
  }, [step, stepIndex]);

  const showSuggested = !!step.suggested && step.suggested !== '__sample_csv__';
  const showSampleCSV = step.suggested === '__sample_csv__';
  const body = typeof step.body === 'function' ? step.body() : step.body;
  const isLast = stepIndex === totalSteps - 1;

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
            onClick={() => {
              if (!detected && step.suggested) {
                onAutofill(step);
                return;
              }
              if (!detected && step.type !== 'annotation' && step.type !== 'preview') {
                const sel = step.fieldName
                  ? `[data-field="${step.fieldName}"]`
                  : step.selector;
                if (sel) {
                  const el = findEl(sel);
                  if (el instanceof HTMLElement) {
                    el.click();
                    return;
                  }
                }
              }
              onNext();
            }}
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
