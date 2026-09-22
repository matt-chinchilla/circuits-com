// The 3D tab's view mode — Solid, See-through, X-ray — and the one place it is
// kept (owner, 2026-09-22: "I want a 'transparency mode'"). Two controls set it
// (the toolbar over the canvas and the Objects tab beside it) and one renderer
// draws it, so it lives in a tiny module store rather than on either component:
// `useViewMode()` subscribes a control, `setViewMode()` is what a click calls,
// and localStorage remembers the choice so the next visit opens the way the
// reader left it. Storage is best-effort — a private window or a blocked origin
// simply forgets, it never throws into a render.
import { useSyncExternalStore } from 'react';

export type ViewMode = 'solid' | 'see-through' | 'xray';

export interface ViewModeOption {
  id: ViewMode;
  label: string;
  /** What the mode does, in the reader's words — the Objects tab shows it
   *  under the control and the toolbar carries it as each button's title. */
  help: string;
}

export const VIEW_MODES: readonly ViewModeOption[] = [
  { id: 'solid', label: 'Solid', help: 'Bodies and solder mask as they are.' },
  { id: 'see-through', label: 'See-through', help: 'Bodies faded, so the pads and silkscreen under them show.' },
  { id: 'xray', label: 'X-ray', help: 'Bodies and solder mask faded, so the copper shows.' },
];

export const DEFAULT_VIEW_MODE: ViewMode = 'solid';
export const VIEW_MODE_STORAGE_KEY = 'circuits.viewer.3d.view';

export function isViewMode(value: unknown): value is ViewMode {
  return VIEW_MODES.some((m) => m.id === value);
}

export function viewModeOption(mode: ViewMode): ViewModeOption {
  return VIEW_MODES.find((m) => m.id === mode) ?? VIEW_MODES[0];
}

function readStored(): ViewMode {
  try {
    const raw = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return isViewMode(raw) ? raw : DEFAULT_VIEW_MODE;
  } catch {
    return DEFAULT_VIEW_MODE;
  }
}

/** Read lazily: the module may load before any control mounts, and node (the
 *  test environment for the pure modules) has no localStorage at all. */
let current: ViewMode | null = null;
const listeners = new Set<() => void>();

export function getViewMode(): ViewMode {
  if (current == null) current = readStored();
  return current;
}

export function setViewMode(mode: ViewMode): void {
  if (!isViewMode(mode) || mode === getViewMode()) return;
  current = mode;
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Remembering is a courtesy; the mode still applies for this visit.
  }
  for (const listener of listeners) listener();
}

export function subscribeViewMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const serverSnapshot = () => DEFAULT_VIEW_MODE;

/** The mode, re-rendering the caller when any control changes it. */
export function useViewMode(): ViewMode {
  return useSyncExternalStore(subscribeViewMode, getViewMode, serverSnapshot);
}

/** Forget the in-memory value so the next read comes from storage again. */
export function resetViewModeForTests(): void {
  current = null;
}
