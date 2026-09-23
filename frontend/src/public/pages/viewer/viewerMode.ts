// Day or night (owner, 2026-09-22: "everything is bright all the time"). ONE
// attribute on the workspace root, `data-mode`, that the workspace's own
// stylesheets read; the drawings are not touched (the board is dark already,
// the schematic is a white sheet on the desk either way, and the BOM and
// stackup stay the printed pages they are). Remembered per browser; a first
// visit follows the system's own preference.
//
// Same storage rules as panelDock.ts: try/catch on every read and write, a
// stored value that is not one of ours is the default.

export type ViewerMode = 'day' | 'night';

export const VIEWER_MODE_KEY = 'cc.viewer.mode';

export function isViewerMode(value: unknown): value is ViewerMode {
  return value === 'day' || value === 'night';
}

/** The subset of `Storage` this module needs; a test hands in a plain object. */
export interface ModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): ModeStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** What the system asks for, when nothing has been chosen here yet. */
function systemPrefersNight(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function readMode(storage: ModeStorage | null = defaultStorage(), prefersNight: boolean = systemPrefersNight()): ViewerMode {
  const fallback: ViewerMode = prefersNight ? 'night' : 'day';
  if (storage == null) return fallback;
  try {
    const raw = storage.getItem(VIEWER_MODE_KEY);
    return isViewerMode(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

export function writeMode(mode: ViewerMode, storage: ModeStorage | null = defaultStorage()): void {
  if (storage == null) return;
  try {
    storage.setItem(VIEWER_MODE_KEY, mode);
  } catch {
    // Quota, private mode, a denied origin: the choice is simply not kept.
  }
}
