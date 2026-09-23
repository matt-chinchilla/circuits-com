// The Board panel's dock: which tab the rail has selected and whether the
// drawer is open beside the stage. Remembered per browser so a reader who
// closed the drawer to see the whole board finds it closed next time, and one
// who works with Layers open finds Layers open.
//
// Storage is best-effort by design (the same rule as `mapMemory.ts`): every
// read and write sits inside a try/catch that degrades to the default, because
// Safari private mode throws on `localStorage` access itself and a viewer that
// crashes over a preference is worse than one that forgets it. Stored content
// is hostile input for the same reason: it survives deploys, so an old or
// hand-edited value must validate to the default, never reach the rail as a
// tab it does not have.

export type PanelTab = 'sheets' | 'parts' | 'layers' | 'objects';

export interface PanelDock {
  tab: PanelTab;
  /** Desktop only: is the drawer open beside the stage? The phone sheet has
   *  its own open/closed state, which is never persisted. */
  docked: boolean;
}

export const PANEL_DOCK_KEY = 'cc.viewer.panel';

/** A first visit opens on Parts: the invitation to click a part and the `/`
 *  hint live there. */
export const DEFAULT_DOCK: PanelDock = Object.freeze({ tab: 'parts', docked: true });

const TABS: readonly PanelTab[] = ['sheets', 'parts', 'layers', 'objects'];

export function isPanelTab(value: unknown): value is PanelTab {
  return typeof value === 'string' && (TABS as readonly string[]).includes(value);
}

/** The subset of `Storage` this module needs; a test hands in a plain object. */
export interface DockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): DockStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Accessing `localStorage` at all throws where storage is denied.
    return null;
  }
}

export function readDock(storage: DockStorage | null = defaultStorage()): PanelDock {
  if (storage == null) return DEFAULT_DOCK;
  try {
    const raw = storage.getItem(PANEL_DOCK_KEY);
    if (raw == null) return DEFAULT_DOCK;
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_DOCK;
    const { tab, docked } = parsed as { tab?: unknown; docked?: unknown };
    if (!isPanelTab(tab) || typeof docked !== 'boolean') return DEFAULT_DOCK;
    return { tab, docked };
  } catch {
    return DEFAULT_DOCK;
  }
}

export function writeDock(dock: PanelDock, storage: DockStorage | null = defaultStorage()): void {
  if (storage == null) return;
  try {
    storage.setItem(PANEL_DOCK_KEY, JSON.stringify({ tab: dock.tab, docked: dock.docked }));
  } catch {
    // Quota, private mode, a denied origin: the preference is simply not kept.
  }
}
