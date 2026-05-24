import { useEffect } from 'react';
import { getFieldValue } from './helpers';
import type { AdvanceSpec } from './types';

// Advance-condition runner. Watches for the signal a step needs to move on:
// a route change, a field value matching a predicate, a store mutation, or
// a confirm-modal opening/closing. Calls onAdvance() exactly once when the
// condition is satisfied.
//
// Bug fix (2026-05-24): the original design used a single 450ms grace
// window for ALL advance kinds. That blocked legitimate route advances when
// the user clicked the spotlighted button quickly (within 450ms of step
// entry). The grace window is real — polling kinds can false-positive off
// stale DOM from the previous step. But route advances are user-driven and
// MUST fire immediately. Now route uses a clean React-effect-key-on-route
// pattern (no setTimeout grace), while polling kinds keep the grace.
export function useAdvance(
  advance: AdvanceSpec | undefined,
  onAdvance: () => void,
  stepKey: string,
  currentRoute: string,
): void {
  // Route advances: re-run the effect whenever the route changes. If the
  // test passes for the current route, advance. No grace window — the user
  // just clicked the spotlighted button, they expect instant feedback.
  useEffect(() => {
    if (!advance || advance.kind !== 'route') return;
    if (!advance.test(currentRoute)) return;
    const t = setTimeout(onAdvance, 240);
    return () => clearTimeout(t);
  }, [stepKey, currentRoute, advance, onAdvance]);

  // Polling advances: value/predicate/modal/modalGone. 450ms grace before
  // any signal can fire — guards against stale-DOM false-positives carrying
  // over from the previous step (half-torn-down modal, lingering input
  // value, etc).
  useEffect(() => {
    if (!advance || advance.kind === 'manual' || advance.kind === 'route') return;

    let fired = false;
    const startedAt = Date.now();
    const fire = () => {
      if (fired) return;
      if (Date.now() - startedAt < 450) return;
      fired = true;
      setTimeout(onAdvance, 240);
    };

    const poll = setInterval(() => {
      try {
        if (fired) {
          clearInterval(poll);
          return;
        }
        if (advance.kind === 'value') {
          const val = advance.fieldName ? getFieldValue(advance.fieldName) : '';
          if (advance.test(val)) fire();
        } else if (advance.kind === 'predicate') {
          if (advance.test()) fire();
        } else if (advance.kind === 'modal') {
          if (document.querySelector('[data-modal="confirm-delete"]')) fire();
        } else if (advance.kind === 'modalGone') {
          if (!document.querySelector('[data-modal="confirm-delete"]')) fire();
        }
      } catch {
        // Bad selector etc. — swallow and keep polling.
      }
    }, 220);

    return () => clearInterval(poll);
  }, [stepKey, advance, onAdvance]);
}
