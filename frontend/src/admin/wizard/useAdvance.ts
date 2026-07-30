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
//
// `suppressedRoute` (2026-07-29, wizard-wide Back button): non-null means
// the user just REWOUND onto this step, and its forward condition is very
// likely already true — the route still matches, the input still holds what
// they typed. Firing would bounce them straight back where they came from,
// so both runners demand a FRESH transition first:
//   - route kind: blocked while currentRoute equals the suppressed route;
//     any real route change re-enables it.
//   - polling kinds: the runner starts un-armed and arms itself the first
//     time it observes the condition FALSE, so only a false→true edge fires.
// The guard is scoped per-step by the caller (Spotlight passes null unless
// the guard's index matches the rendered step), so it can never leak into
// the next step.
export function useAdvance(
  advance: AdvanceSpec | undefined,
  onAdvance: () => void,
  stepKey: string,
  currentRoute: string,
  suppressedRoute?: string | null,
): void {
  // Route advances: re-run the effect whenever the route changes. If the
  // test passes for the current route, advance. No grace window — the user
  // just clicked the spotlighted button, they expect instant feedback.
  useEffect(() => {
    if (!advance || advance.kind !== 'route') return;
    if (suppressedRoute != null && currentRoute === suppressedRoute) return;
    if (!advance.test(currentRoute)) return;
    const t = setTimeout(onAdvance, 240);
    return () => clearTimeout(t);
  }, [stepKey, currentRoute, advance, onAdvance, suppressedRoute]);

  // Polling advances. Two timing modes:
  //
  // - `fire()` (graced): used by value/predicate. 450ms grace before any
  //   signal can trigger — guards against stale-DOM false-positives
  //   carrying over from the previous step (a half-torn-down modal, a
  //   lingering input value with the previous step's content matching the
  //   current step's predicate, etc).
  //
  // - `fireImmediate()` (grace-free): used by modal/modalGone. A
  //   confirm-delete modal only appears because the user EXPLICITLY
  //   clicked the spotlighted Delete button — there's no stale-modal
  //   scenario to defend against. Applying the grace here makes the
  //   wizard feel sluggish (~900ms perceived lag between Delete click
  //   and the spotlight moving to the Confirm button). 2026-05-24 bug.
  useEffect(() => {
    if (!advance || advance.kind === 'manual' || advance.kind === 'route') return;

    let fired = false;
    // Post-Back arming (see suppressedRoute above). Normal step entry starts
    // ARMED, so every timing semantic below is untouched. A rewound step
    // starts un-armed and `arm()` — called on any poll tick that reads the
    // condition as false — re-enables it, so only a false→true edge fires.
    let armed = suppressedRoute == null;
    const arm = () => {
      armed = true;
    };
    const startedAt = Date.now();
    const fire = () => {
      if (fired || !armed) return;
      if (Date.now() - startedAt < 450) return;
      fired = true;
      setTimeout(onAdvance, 240);
    };
    const fireImmediate = () => {
      if (fired || !armed) return;
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
          else arm();
        } else if (advance.kind === 'predicate') {
          if (advance.test()) fire();
          else arm();
        } else if (advance.kind === 'modal') {
          if (document.querySelector('[data-modal="confirm-delete"]')) fireImmediate();
          else arm();
        } else if (advance.kind === 'modalGone') {
          if (!document.querySelector('[data-modal="confirm-delete"]')) fireImmediate();
          else arm();
        }
      } catch {
        // Bad selector etc. — swallow and keep polling.
      }
    }, 220);

    return () => clearInterval(poll);
  }, [stepKey, advance, onAdvance, suppressedRoute]);
}
