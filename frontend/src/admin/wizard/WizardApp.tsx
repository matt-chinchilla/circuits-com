import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import Fab from './Fab';
import Menu from './Menu';
import WelcomeBubble from './WelcomeBubble';
import Spotlight from './Spotlight';
import LivePreviewModal from './LivePreviewModal';
import { FLOWS, SAMPLE_CSV_TEXT } from './flows';
import { autofillField, findFieldInput, getRoute, navTo } from './helpers';
import { useExposeGlobals } from './useExposeGlobals';
import {
  cleanupAllDemoEntities,
  clearCreatedEntityBridge,
  clearCreatedListingBridge,
  hasCommittedCreate,
  isForwardNavigation,
  mayHaveCommittedCreate,
  readCreatedEntityBridge,
  readCreatedListingBridge,
  trackDemoEntity,
  trackDemoListing,
} from './demoCleanup';
import type { BackGuard, Flow, Step } from './types';

const WELCOMED_KEY = 'wiz-welcomed';

// The attach-existing-part tour. It borrows a REAL catalog part and creates
// exactly one demo LISTING on it, so its cleanup is listing-scoped. Routes
// are matched against getRoute() output — no /admin prefix.
const ATTACH_FLOW_ID = 'add-part-supplier';
const ATTACH_FORM_ROUTE = /^parts\/([^/]+)\/listings\/new$/;

// Every tour that creates a REAL Part row via parts/new → parts/<id>. Both
// belong here: 'add-part-general' was missing until 2026-07-29, so its demo
// part was never tracked and never cleaned up.
const PART_CREATE_FLOW_IDS = new Set(['add-part-to-supplier', 'add-part-general']);

// How often the tours drain the id-from-response bridges (listing + entity).
// Short enough that the id is tracked while the submitting form is still
// mounted — the POST resolves 700ms (attach) / 900ms (supplier, part) before
// the form navigates away — so tracking never waits on, or depends on, a route
// change.
const BRIDGE_POLL_MS = 200;

// The demo-entity kind a flow creates, or null when it creates nothing
// addressable by a single id (the attach tour creates a LISTING, which has its
// own key). SINGLE home for the flow→kind map: the tracker and the Back veto
// both read it, so they can never disagree about what a flow makes.
function createKindForFlow(flowId: string): 'supplier' | 'part' | null {
  if (flowId === 'add-supplier') return 'supplier';
  if (PART_CREATE_FLOW_IDS.has(flowId)) return 'part';
  return null;
}

// Where a step's `goto` directive will send the app on entry, or null when it
// declares none (or resolves to nothing). SINGLE resolution site: the goto
// RUNNER navigates by it, and goBack names the route the rewind LANDS on by it
// (see the Back guard it sets) — resolving the directive twice, two different
// ways, is how the guard would end up naming a route the runner never went to.
// A throwing function reads as "no target" rather than taking the wizard down.
function resolveGoto(step: Step): string | null {
  if (step.goto === undefined) return null;
  try {
    return (typeof step.goto === 'function' ? step.goto() : step.goto) ?? null;
  } catch {
    return null;
  }
}

// Top-level wizard state machine. Owns:
//   - active flow + step index
//   - menu open/closed
//   - body class for overscroll-contain while a flow is active
//   - the goto-directive runner that drives admin navigation on step entry
export default function WizardApp() {
  useExposeGlobals();

  const location = useLocation();
  // How the router arrived at the current location: 'POP' means the browser's
  // Back/Forward button. The create-detector refuses to run on a POP — see the
  // tracking effect and isForwardNavigation.
  const navType = useNavigationType();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeFlowId, setActiveFlowId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [welcomeShown, setWelcomeShown] = useState(
    () => localStorage.getItem(WELCOMED_KEY) === '1',
  );
  // Raised by goBack, consumed by Spotlight → useAdvance. See BackGuard.
  const [backGuard, setBackGuard] = useState<BackGuard | null>(null);

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
  // navigation like "go to the just-created supplier's detail page") —
  // through resolveGoto, so this runner and goBack's landing-route
  // calculation can't drift on what a step's goto resolves to.
  useEffect(() => {
    if (!step) return;
    const target = resolveGoto(step);
    if (target == null) return;
    // Skip navigation if we're already at the target — avoids router
    // double-pushes and unnecessary remounts. This also covers `goto: ''`
    // (the admin dashboard), which navTo now treats as a real address.
    if (target === getRoute()) return;
    navTo(target);
  }, [activeFlowId, stepIndex, step]);

  // Remember the route each step was FIRST seen on, so Back can put the
  // user back where that step's anchor actually exists. Only the first
  // observation counts: a step's own advance often lands the NEXT route
  // while stepIndex is still on the old step (advance is debounced 240ms),
  // and that later route belongs to the next step, not this one.
  const stepRoutesRef = useRef<Map<number, string>>(new Map());
  useEffect(() => {
    if (!activeFlowId) return;
    if (!stepRoutesRef.current.has(stepIndex)) {
      stepRoutesRef.current.set(stepIndex, currentRoute);
    }
  }, [activeFlowId, stepIndex, currentRoute]);

  // ─── Attach tour: id-from-response capture ────────────────────────────────
  // The demo listing's id arrives from the POST response itself, published on
  // `window.__wizardCreatedListing` by AttachListingPage. Two effects:
  //   ARM   — remember the part whose attach FORM this pass actually opened;
  //   DRAIN — adopt a bridge for that part, then clear it.
  //
  // This REPLACED a set-difference inference (snapshot the part's listing ids
  // while the form is open, diff after the submit-navigation). The inference
  // was only as reliable as the navigation: a browser Back during the form's
  // 700ms post-submit toast delay meant the wizard never saw the transition, so
  // the synthetic listing on a REAL catalog SKU was never tracked and never
  // cleaned — public best_price pollution. Nothing below consults navType or
  // the route trail, which is the whole point.
  //
  // ⚠ DATA SAFETY / FAIL CLOSED. The tracked listing is later hard-DELETEd, and
  // EVERY attach — tour or not — writes the same bridge. It is therefore
  // honoured only for the ARMED part: real admin work on some other part
  // mid-tour must never hand a customer's distributor listing to cleanup. And
  // there is deliberately no fallback: bridge absent ⇒ track nothing (never
  // "the newest listing on the part" — that guess is what put real rows at
  // risk). Reseed stays the documented backstop, as the CSV tour says.
  const armedAttachPartRef = useRef<string | null>(null);

  // STICKY per pass. This used to re-arm to WHATEVER attach form opened while
  // the tour was active, so a mid-tour visit to a DIFFERENT part's attach form
  // stole the arming — the demo listing's own bridge then failed the
  // armed-part check and was dropped (untracked synthetic row on a real SKU),
  // while a real listing on that other part became the adoptable one. Arm only
  // when nothing is armed yet, or when the same part's form re-opens (a Back
  // and forward through it, which must stay adoptable). Clearing a stale
  // pre-visit bridge belongs to that same first arming, not to every re-render
  // on the route — otherwise re-entering the form would discard the id the
  // submit just published.
  useEffect(() => {
    if (activeFlowId !== ATTACH_FLOW_ID) return;
    const m = currentRoute.match(ATTACH_FORM_ROUTE);
    if (!m) return;
    const partId = m[1];
    const armed = armedAttachPartRef.current;
    if (armed != null && armed !== partId) return;
    if (armed == null) {
      // A bridge already sitting there as the form FIRST opens predates this
      // visit, so it belongs to work the tour didn't do. Drop it, then arm.
      clearCreatedListingBridge();
    }
    armedAttachPartRef.current = partId;
  }, [activeFlowId, currentRoute]);

  // Adopt a published listing id — but ONLY for the armed part. Hoisted out of
  // the effect below so every path that is about to DISCARD the bridge (effect
  // teardown, fresh flow start) can drain it first.
  //
  // ⚠ PER-SUBMISSION, and the bridge is the SOLE source. What gets tracked is
  // the id ONE POST returned — never "the newest listing on the armed part" and
  // never "any listing that appeared on it during the pass". Those two guesses
  // are per-PART, so a real distributor the admin attached to the same part
  // mid-tour would be adopted as the tour's own and handed to a hard DELETE.
  // Displacement is guarded the same way (trackDemoListing → readListingMarker),
  // so even an adopted-but-wrong id can only ever fail to delete something.
  const drainCreatedListing = useCallback(() => {
    const created = readCreatedListingBridge();
    if (created == null) return;
    if (created.partId !== armedAttachPartRef.current) return;
    clearCreatedListingBridge();
    trackDemoListing(created.partId, created.listingId);
  }, []);

  // Deps are the FLOW only, never the route: a route-keyed effect would tear
  // this down (clearing the bridge, disarming) on the very Back-navigation the
  // capture exists to survive.
  useEffect(() => {
    if (activeFlowId !== ATTACH_FLOW_ID) return;
    drainCreatedListing();
    const poll = setInterval(drainCreatedListing, BRIDGE_POLL_MS);
    return () => {
      clearInterval(poll);
      // DRAIN BEFORE CLEARING. A POST that resolved between the last poll tick
      // and this teardown has its id sitting on the bridge right now; wiping it
      // unread orphans a synthetic listing on a REAL catalog SKU. Adopt first,
      // then retire both — anything written after this belongs to whatever the
      // admin does next and must not be adopted on a later pass.
      drainCreatedListing();
      clearCreatedListingBridge();
      armedAttachPartRef.current = null;
    };
  }, [activeFlowId, drainCreatedListing]);

  // ─── Entity creates: the same id-from-response bridge ─────────────────────
  // The supplier/part forms publish `{ kind, id }` off their POST response, so
  // the demo row is tracked while the submitting form is still mounted. Route
  // inference ('suppliers/new' → 'suppliers/<id>') was the only previous
  // signal, and a browser Back during the form's 900ms post-submit toast delay
  // meant the wizard never saw that transition — leaving an untracked demo
  // supplier, or a DEMO- part visible on the PUBLIC catalog.
  //
  // ⚠ FAIL CLOSED, exactly like the listing bridge: adopted only when the
  // published kind is the kind THIS flow creates, and there is no fallback —
  // no bridge ⇒ track nothing. The marker-guarded cleanup (which refuses to
  // delete a row that no longer looks like tour data) and `--reseed` remain the
  // backstops, and an untracked demo row is strictly better than a deleted real
  // one. A bridge of the wrong kind is dropped rather than kept: it was written
  // by admin work outside this tour, so no later pass may adopt it either.
  const drainCreatedEntity = useCallback((kind: 'supplier' | 'part' | null) => {
    const created = readCreatedEntityBridge();
    if (created == null) return;
    // Consumed either way: a bridge of the wrong kind was written by admin work
    // outside this tour, and leaving it on `window` would let a later pass adopt
    // it as its own demo row.
    clearCreatedEntityBridge();
    if (kind == null || created.kind !== kind) return;
    trackDemoEntity(created.kind, created.id);
  }, []);

  useEffect(() => {
    if (!activeFlowId) return;
    const kind = createKindForFlow(activeFlowId);
    if (kind == null) return;
    const drain = () => drainCreatedEntity(kind);
    drain();
    const poll = setInterval(drain, BRIDGE_POLL_MS);
    return () => {
      clearInterval(poll);
      // Same order as above: adopt what the last POST published, then retire.
      drain();
      clearCreatedEntityBridge();
    };
  }, [activeFlowId, drainCreatedEntity]);

  // The flow whose pass is in progress, readable OUTSIDE render. Beginning a
  // fresh pass has to know which pass it is RETIRING for bridge adoption to
  // stay attributable, and React state can't answer that there — the state
  // update IS the thing being started. (An unattributable entity bridge is
  // dropped, never adopted: it may be a real row from admin work done before
  // the tour opened.)
  const activeFlowIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeFlowIdRef.current = activeFlowId;
  }, [activeFlowId]);

  // Route observation, now for ONE purpose only: the '/new' re-entry veto's
  // mutation flag. No demo id is ever derived from a route any more — all three
  // kinds (supplier, part, listing) come from their POST response via the
  // bridges above.
  //
  // ⚠ DATA SAFETY, and why route inference is gone. Everything tracked is later
  // HARD-DELETED (cascading), and a route transition is not proof of creation:
  // both the browser's Back button and goBack() can synthesise the exact
  // 'suppliers/new' → 'suppliers/<id>' shape on a REAL entity the user was
  // merely sitting on — and, worse in the other direction, a Back DURING the
  // form's post-submit delay means the transition is never observed at all, so
  // a real demo row goes untracked. Both failure modes are properties of the
  // inference itself, which is why the id now comes from the response.
  // Remaining guards on the flag:
  //   (0) isForwardNavigation(navType) — a POP (browser Back/Forward) never
  //       counts as a commit.
  //   (1) rewindingRef — goBack's synthetic navigation is a PUSH, so the POP
  //       guard can't see it; the ref makes it invisible to this detector.
  const prevRouteRef = useRef(currentRoute);
  const rewindingRef = useRef(false);
  const [mutatedThisPass, setMutatedThisPass] = useState(false);

  useEffect(() => {
    const prev = prevRouteRef.current;
    prevRouteRef.current = currentRoute;

    if (!activeFlowId) return;

    // (0) Browser Back/Forward. Nothing below this line may run on a POP.
    // rewindingRef is deliberately left armed: a swallowed observation is the
    // fail-closed direction.
    if (!isForwardNavigation(navType)) return;

    // (1) A rewind consumes the guard exactly once.
    if (rewindingRef.current) {
      rewindingRef.current = false;
      return;
    }

    // FLOW-AGNOSTIC mutation flag. Set synchronously, the instant the
    // form → detail transition is recognized, for EVERY flow: a per-flow set
    // leaves the veto inert for any tour the tracker has no branch for.
    // Over-setting is safe — the only thing it does is forbid rewinding into a
    // create form.
    if (mayHaveCommittedCreate(prev, currentRoute)) setMutatedThisPass(true);
  }, [activeFlowId, currentRoute, navType]);

  // Adopt-then-discard both id bridges and the attach arming — everything the
  // OUTGOING pass published — before a fresh pass claims the tracking keys.
  // Draining before clearing matters twice over: an id wiped unread is a
  // synthetic row nothing can ever clean up, and adopting it FIRST means the
  // sweep that follows is what removes it. A restart of the same flow needs this
  // explicitly, because activeFlowId doesn't change and the drain effects (whose
  // teardowns would otherwise do it) aren't torn down.
  const retirePassBridges = useCallback(() => {
    drainCreatedListing();
    // Attributed to the pass being retired. An entity bridge that can't be —
    // no previous flow, or the wrong kind — is DROPPED, never adopted: with no
    // flow active nothing drains that bridge, so it may well be a REAL row from
    // ordinary admin work done before the wizard was opened.
    drainCreatedEntity(createKindForFlow(activeFlowIdRef.current ?? ''));
    clearCreatedListingBridge();
    clearCreatedEntityBridge();
    // Disarm: a bridge adopted for a part THIS pass never opened the form for
    // could be real admin work.
    armedAttachPartRef.current = null;
  }, [drainCreatedEntity, drainCreatedListing]);

  // ⚠ RESUME MUST NOT CLEAN UP. Menu's "Resume" continues the SAME pass, and the
  // demo entity that pass created is exactly what the next step points at —
  // deleting it here dead-ends the tour on a vanished row (the delete step has
  // nothing left to remove, so its predicate never fires). A fresh start still
  // cleans, which is how orphans from a crashed/refreshed session go away;
  // resume is consistent with the stepRoutesRef / mutatedThisPass handling below.
  const startFlow = useCallback((flowId: string, resume: boolean) => {
    if (!resume) {
      retirePassBridges();
      cleanupAllDemoEntities();
    }
    setActiveFlowId(flowId);
    // Resuming continues the SAME pass — wiping the route trail here would
    // strand Back on the resumed step (nothing recorded ⇒ nothing to rewind to).
    if (!resume) {
      setStepIndex(0);
      stepRoutesRef.current = new Map();
      setMutatedThisPass(false);
    }
    rewindingRef.current = false;
    setBackGuard(null);
    setMenuOpen(false);
  }, [retirePassBridges]);

  // ⚠ DRAIN BEFORE SWEEP, exactly as startFlow does. cleanupAllDemoEntities
  // acts on the TRACKING KEYS, so anything still sitting on a bridge is
  // invisible to it. Exit used to sweep first: a POST that resolved inside the
  // last poll interval (or during the form's post-submit delay) had its id on
  // the bridge and no key yet, so the sweep found nothing, the bridge was then
  // discarded with the pass, and the row was orphaned — a synthetic listing left
  // on a REAL catalog SKU, or a DEMO- part left on the PUBLIC catalog. Adopting
  // first means the sweep that follows is what removes it.
  const exitFlow = useCallback(() => {
    retirePassBridges();
    cleanupAllDemoEntities();
    setActiveFlowId(null);
    setStepIndex(0);
    stepRoutesRef.current = new Map();
    setMutatedThisPass(false);
    rewindingRef.current = false;
    setBackGuard(null);
  }, [retirePassBridges]);

  const advance = useCallback(() => {
    if (!activeFlow) return;
    if (stepIndex + 1 >= activeFlow.steps.length) {
      // Flow completed normally — CLEAN UP, exactly as Exit does. "Completed"
      // only means the coach reached its last step; it is NOT proof the delete
      // step was performed. A user who clicked Next straight through it (or
      // whose delete spotlight never resolved) still has the demo row, and this
      // was the one termination path that deleted nothing — the row then sat on
      // real data until the NEXT flow start happened to sweep it, and a DEMO-
      // part is publicly visible the whole time.
      //
      // Idempotent + 404-tolerant, and marker-guarded (a row that no longer
      // looks like tour data is never deleted), so calling it here can only
      // remove demo data. NOTE: this is a DELETE, not the key-clear that was
      // correctly dropped from this branch — the tracking keys must never be
      // dropped without the rows going with them.
      //
      // ⚠ DRAIN BEFORE SWEEP, the same ordering startFlow and exitFlow use: the
      // sweep reads the TRACKING KEYS, so a create still sitting unread on a
      // bridge (a POST that resolved inside the last poll interval) is invisible
      // to it and would be discarded with the pass — orphaning the row.
      retirePassBridges();
      cleanupAllDemoEntities();
      setActiveFlowId(null);
      setStepIndex(0);
      stepRoutesRef.current = new Map();
      setMutatedThisPass(false);
      rewindingRef.current = false;
      setBackGuard(null);
    } else {
      setStepIndex((i) => i + 1);
      // Any forward move retires the Back guard — it is scoped to the step
      // we just left, and a guarded step's Next must not leave it standing.
      setBackGuard(null);
    }
  }, [activeFlow, retirePassBridges, stepIndex]);

  // Is rewinding to `target` (the step BEFORE the current one) safe AND
  // useful? Three vetoes:
  //   - re-entering a '.../new' create form after this pass already committed
  //     a mutation: the user would submit a SECOND demo row, and the single-key
  //     tracker can only own one, so the first would be orphaned on real data;
  //   - the target advances by `predicate`: its condition is a fact about the
  //     HOST page's own sub-step (import stepper position, reply status), and
  //     that state has already moved on with no way to rewind it — the coach
  //     would sit a sub-step behind the page, pointing at a vanished anchor;
  //   - there is no step before step 0.
  const backVeto = useCallback(
    (target: number): boolean => {
      if (!activeFlow) return true;
      if (target < 0) return true;
      const targetStep = activeFlow.steps[target];
      if (targetStep.advance.kind === 'predicate') return true;
      const recorded = stepRoutesRef.current.get(target);
      if (
        recorded != null &&
        recorded.endsWith('/new') &&
        // NOT `mutatedThisPass` alone. That flag is only ever set from an
        // OBSERVED forward transition, so a missed one (browser Back during the
        // post-submit navigation delay) disarmed the veto and let a
        // Back-then-resubmit orphan the FIRST row. hasCommittedCreate also asks
        // the tracker itself, which — now that ids come from the POST response —
        // knows about the row the instant it exists.
        hasCommittedCreate(mutatedThisPass, createKindForFlow(activeFlow.id))
      ) {
        return true;
      }
      return false;
    },
    [activeFlow, mutatedThisPass],
  );

  const canGoBack = stepIndex > 0 && !backVeto(stepIndex - 1);

  // Step back one. Steps that declare their own `goto` are re-navigated by
  // the goto runner on entry; for everything else we restore the route the
  // step was first seen on, so its spotlight anchor exists again (going back
  // from a form field to the button that opened the form, say). The guard
  // then stops the returned-to step from instantly re-advancing.
  const goBack = useCallback(() => {
    if (!activeFlow) return;
    if (stepIndex <= 0) return;
    const target = stepIndex - 1;
    if (backVeto(target)) return;
    const targetStep = activeFlow.steps[target];
    const recorded = stepRoutesRef.current.get(target);
    const nav =
      targetStep.goto === undefined && recorded != null && recorded !== currentRoute
        ? recorded
        : null;
    // Forget the trail we're rewinding past — a second pass through those
    // steps may take a different route.
    Array.from(stepRoutesRef.current.keys()).forEach((i) => {
      if (i > target) stepRoutesRef.current.delete(i);
    });
    // The guard's route is where the rewind LANDS, not the route being left.
    // For a target step that declares its own `goto`, `nav` is null (the goto
    // runner does that navigation on entry) — recording currentRoute there left
    // the guard naming the route we were LEAVING, and since re-doing the step's
    // action returns to exactly that route, the step's route-advance stayed
    // suppressed forever. The tour dead-ended on it, moved on only by
    // CoachCard's 900ms fallback. Naming the landing route means the trip away
    // from it and back is a FRESH transition, which re-enables the runner.
    const landing = nav ?? resolveGoto(targetStep) ?? currentRoute;
    setBackGuard({ stepIndex: target, route: landing });
    setStepIndex(target);
    if (nav != null) {
      // ⚠ DATA SAFETY: this navigation is synthetic, and it is a PUSH (navTo →
      // navigate), so the POP guard cannot see it. It can reproduce the exact
      // create-transition shape ('suppliers/new' → 'suppliers/<id>') on an
      // entity the user never created. Mark it so the create-detector skips the
      // next route observation entirely.
      //
      // Armed only if navTo actually ISSUED the navigation. A no-op call (no
      // __adminNavigate binding) would otherwise leave the flag standing and
      // swallow an unrelated later transition — including a real creation.
      rewindingRef.current = true;
      if (!navTo(nav)) rewindingRef.current = false;
    }
  }, [activeFlow, backVeto, stepIndex, currentRoute]);

  const handleAutofill = useCallback((s: Step) => {
    if (s.suggested === '__sample_csv__') {
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
    if (s.type !== 'annotation' && s.type !== 'preview' && s.fieldName) {
      if (s.suggested === '__auto_select__') {
        const el = findFieldInput(s.fieldName);
        if (el instanceof HTMLSelectElement) {
          // Skip the placeholder AND any disabled option — the attach-listing
          // form greys out distributors that already carry the part, and
          // auto-picking one of those submits straight into a 409.
          const first = Array.from(el.options).find(
            (o) => o.value && o.value !== '' && !o.disabled,
          );
          if (first) autofillField(s.fieldName, first.value);
        }
        return;
      }
      if (s.suggested != null) {
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
          backGuard={backGuard}
          canGoBack={canGoBack}
          onNext={advance}
          onBack={goBack}
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
