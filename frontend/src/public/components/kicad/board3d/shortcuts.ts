// The 3D tab's single-key controls (owner, 2026-09-24, for the promo video):
// the four "Board view" buttons and the three "View" buttons, each on one key.
// Pure and DOM-free — the one home for the map. Board3DView listens on window
// (guarded by `isPlainKey`), lowercases `e.key` and asks here; the buttons
// carry the same keys as `aria-keyshortcuts`. The viewer page's tab keys
// (s/p/k/d/m) live beside the page and must never collide with these.
import type { ViewMode } from './viewMode';

export type BoardAction = 'top' | 'bottom' | 'flip' | 'reset';

export const BOARD_KEYS: Readonly<Record<BoardAction, string>> = {
  top: 't',
  bottom: 'b',
  flip: 'f',
  reset: 'r',
};

export const VIEW_MODE_KEYS: Readonly<Record<ViewMode, string>> = {
  solid: '1',
  'see-through': '2',
  xray: '3',
};

const keyOf = <K extends string>(map: Readonly<Record<K, string>>, key: string): K | null =>
  (Object.keys(map) as K[]).find((k) => map[k] === key) ?? null;

/** The board action on `key` (already lowercased by the caller), or null. */
export const boardActionForKey = (key: string): BoardAction | null => keyOf(BOARD_KEYS, key);

/** The view mode on `key`, or null. */
export const viewModeForKey = (key: string): ViewMode | null => keyOf(VIEW_MODE_KEYS, key);

/** How a key is announced in `aria-keyshortcuts`: letters upper-case. */
export const ariaKey = (key: string): string => key.toUpperCase();
