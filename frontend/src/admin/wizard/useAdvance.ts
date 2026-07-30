import { useEffect } from 'react';
import { findFieldInput } from './helpers';
import type { AdvanceSpec } from './types';

// How long a still-focused field's value must hold steady before a passing
// `value` test counts as COMMITTED.
//
// Bug fix (2026-07-29, wizard-wide): every value step fired the instant the
// typed value first passed its own minimum (`name` at 3 characters, `sku` at 3,
// `description` at 10, …), so the coach yanked the user to the next step in the
// MIDDLE of typing the first word — on every field step of every tour. The test
// answers "is this value acceptable", which is not the same question as "is the
// user done". Committed means one of:
//   - the input no longer holds focus (blur / Tab / click-away) → advance now;
//   - it still holds focus but the value hasn't changed for this long → the
//     user typed something and stopped, so advance;
// and while the value keeps changing under an active caret, NEVER. 1500ms is
// comfortably longer than the gap between keystrokes mid-word (~100-300ms) and
// short enough that pausing to read the coach card moves the tour on by itself.
const VALUE_SETTLE_MS = 1500;

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
//
// `value` kinds additionally wait for the field to be COMMITTED — see
// VALUE_SETTLE_MS above.
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
  //
  // The `value` kind carries a THIRD condition on top of the grace: the field
  // must be COMMITTED, not merely passing. See VALUE_SETTLE_MS.
  useEffect(() => {
    if (!advance || advance.kind === 'manual' || advance.kind === 'route') return;

    let fired = false;
    // The 240ms debounce timer, tracked so step-change cleanup can cancel it.
    // Without this a pending advance outlived the step it belonged to and
    // landed AFTER a manual Next — two advances, one step skipped.
    let pending: ReturnType<typeof setTimeout> | null = null;
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
      pending = setTimeout(onAdvance, 240);
    };
    const fireImmediate = () => {
      if (fired || !armed) return;
      fired = true;
      pending = setTimeout(onAdvance, 240);
    };

    // Commit tracking for the `value` kind. `lastValue` is the previous poll's
    // reading and `changedAt` the moment it last differed, so "the user stopped
    // typing" is answerable without listening to the input at all (these fields
    // are React-controlled and the wizard also writes them via autofill, so a
    // keydown/blur listener would miss half the mutations).
    let lastValue: string | null = null;
    let changedAt = Date.now();

    const poll = setInterval(() => {
      try {
        if (fired) {
          clearInterval(poll);
          return;
        }
        if (advance.kind === 'value') {
          // ONE node lookup per tick, and both readings come off it: the value
          // AND the focus state. getFieldValue() + findFieldInput() walked the
          // same [data-field] wrapper twice every 220ms, and could in principle
          // answer about two different nodes if the field remounted in between.
          // `?.value ?? ''` is exactly what getFieldValue does.
          const input = advance.fieldName ? findFieldInput(advance.fieldName) : null;
          const val = input?.value ?? '';
          // `val` is always a string, so the first tick (lastValue === null)
          // records a change here on its own — no separate null test needed.
          if (val !== lastValue) {
            lastValue = val;
            changedAt = Date.now();
          }
          if (!advance.test(val)) {
            arm();
            return;
          }
          // Passing is NOT enough — see VALUE_SETTLE_MS. Advance the moment the
          // user leaves the field (blur / Tab / click-away), or once the value
          // has held still for the settle window while they keep the caret in
          // it. Actively typing satisfies neither, so the coach stays put.
          const focused = input != null && document.activeElement === input;
          if (!focused || Date.now() - changedAt >= VALUE_SETTLE_MS) fire();
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

    return () => {
      clearInterval(poll);
      // A fired-but-not-yet-delivered advance belongs to the step being torn
      // down. Leaving it queued is how a Next click could double-advance.
      if (pending != null) clearTimeout(pending);
    };
  }, [stepKey, advance, onAdvance, suppressedRoute]);
}
