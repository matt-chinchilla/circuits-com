import type { ReactNode } from 'react';

// Wizard step DSL. One of three shapes:
//   - 'spotlight' (default): selector OR fieldName → spotlight + coachmark
//   - 'annotation': no target; full-dim + center-floating coach
//   - 'preview': opens the live-site iframe modal
//
// `goto` runs on step entry. String or function so context-dependent
// navigation (e.g. "go to the demo supplier's just-created detail page")
// can be expressed.
//
// `advance` describes how the runner knows when to move on. See useAdvance
// for semantics.
export type AdvanceSpec =
  | { kind: 'manual' }
  | { kind: 'route'; test: (route: string) => boolean }
  | { kind: 'value'; fieldName?: string; test: (value: string) => boolean }
  | { kind: 'predicate'; test: () => boolean }
  | { kind: 'modal' }
  | { kind: 'modalGone' };

export type StepGoto = string | (() => string | null | undefined);

export interface BaseStep {
  goto?: StepGoto;
  title: string;
  body: ReactNode | (() => ReactNode);
  hint?: string;
  suggested?: string;
  suggestedLabel?: string;
  advance: AdvanceSpec;
}

export interface SpotlightStep extends BaseStep {
  type?: 'spotlight';
  selector?: string | (() => Element | null);
  fieldName?: string;
}

export interface AnnotationStep extends BaseStep {
  type: 'annotation';
}

export interface PreviewStep extends BaseStep {
  type: 'preview';
  preview: { page: string; arg?: string };
}

export type Step = SpotlightStep | AnnotationStep | PreviewStep;

// Set when the user clicks Back in the coach footer. The step we rewound TO
// usually has its forward advance-condition already satisfied (the field
// still holds what you typed, the route already matches), so the runner
// would instantly skip forward again and Back would look like a no-op.
// `stepIndex` scopes the guard to that one step; `route` is the route we
// expect to be standing on after the rewind — a route-kind advance stays
// blocked until the route actually changes, and polling kinds stay blocked
// until their condition goes false→true. See useAdvance.
export interface BackGuard {
  stepIndex: number;
  route: string;
}

export type FlowAccent =
  | 'primary'
  | 'blue'
  | 'gold'
  | 'violet'
  | 'rose'
  | 'cyan'
  | 'amber'
  | 'teal';

export interface Flow {
  id: string;
  title: string;
  summary: string;
  icon: string;
  accent: FlowAccent;
  minutes: number;
  steps: Step[];
}

// What window.__adminGetStore() returns. API-backed entities resolve to
// the cached snapshot last fetched by the admin app; localStorage-backed
// entities (sponsors) read live from disk.
export interface WizardStoreSnapshot {
  suppliers: Array<{ id: string; name: string }>;
  parts: Array<{ id: string; sku: string }>;
  sponsors: Array<{ id: string; tier: string }>;
  messages: Array<{ id: string; status: string }>;
  imports: Array<{ filename?: string }>;
}

// ─── Attach-listing id bridge ──────────────────────────────────────────────
// How a just-created distributor listing's id reaches the wizard.
// POST /parts/{id}/listings RETURNS the row it created, but that response
// lands in AttachListingPage — the id appears in neither the URL nor any step
// anchor, so the form publishes it on `window` the instant the POST resolves.
//
// Why not infer it? The wizard used to diff the part's listing ids across the
// submit-navigation. That inference is only ever as reliable as the
// navigation: a browser Back during the form's post-submit toast delay MISSED
// the create outright, leaving a synthetic demo listing on a REAL catalog SKU
// with nothing tracking it for cleanup. An id handed over at the source is
// independent of navigation timing, Back included.
//
// `supplierId` is informational (which distributor the demo row points at) —
// cleanup's DELETE is keyed on partId + listingId alone.
export interface WizardCreatedListing {
  partId: string;
  listingId: string;
  supplierId: string;
}

// ─── Entity id bridge (supplier / part creates) ─────────────────────────────
// Same contract as the listing bridge, for the two entity forms. Route
// inference ('suppliers/new' → 'suppliers/<id>') was the only way the wizard
// learned these ids, and it MISSES the create whenever the transition isn't
// observed — a browser Back during the form's post-submit toast delay is
// enough. An untracked demo part is worse than an untracked demo supplier: a
// DEMO- SKU shows up on the PUBLIC catalog. The forms therefore hand the id
// over at the source, synchronously, before they navigate.
export interface WizardCreatedEntity {
  kind: 'supplier' | 'part';
  id: string;
}

declare global {
  interface Window {
    // Returns whether the navigation was actually issued — the wizard's Back
    // arms a create-detector guard off that answer, so a swallowed throw must
    // not report success. See useExposeGlobals + helpers.navTo.
    __adminNavigate?: (path: string) => boolean;
    __adminGetStore?: () => WizardStoreSnapshot;
    __wizardCreatedListing?: WizardCreatedListing;
    __wizardCreatedEntity?: WizardCreatedEntity;
  }
}
