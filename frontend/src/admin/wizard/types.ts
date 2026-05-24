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

export type FlowAccent = 'primary' | 'blue' | 'gold' | 'violet' | 'rose' | 'cyan' | 'amber';

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

declare global {
  interface Window {
    __adminNavigate?: (path: string) => void;
    __adminGetStore?: () => WizardStoreSnapshot;
  }
}
