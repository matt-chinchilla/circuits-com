// The 3D tab's single-key controls (owner, 2026-09-24, for the promo video):
// the four "Board view" buttons and the three "View" buttons, each on one key,
// and a spin about each board axis (x/y/z; Shift turns it the other way).
// Pure and DOM-free — the one home for the map. Board3DView listens on window
// (guarded by `isPlainKey`), lowercases `e.key` and asks here; the buttons
// carry the same keys as `aria-keyshortcuts`. The viewer page's tab keys
// (s/p/k/d/m) live beside the page and must never collide with these.
import type { SpinAxis } from './sceneRenderer';
import type { ViewMode } from './viewMode';

export type BoardAction = 'top' | 'bottom' | 'flip' | 'reset';

export const BOARD_KEYS: Readonly<Record<BoardAction, string>> = {
  top: 't',
  bottom: 'b',
  flip: 'f',
  reset: 'r',
};

/** Each board action's name, as its toolbar button and the key legend say it. */
export const BOARD_ACTION_LABEL: Readonly<Record<BoardAction, string>> = {
  top: 'Top',
  bottom: 'Bottom',
  flip: 'Flip',
  reset: 'Reset',
};

export const VIEW_MODE_KEYS: Readonly<Record<ViewMode, string>> = {
  solid: '1',
  'see-through': '2',
  xray: '3',
};

/** A spin about each of the board's axes (owner, 2026-09-24: "a way to
 *  re-initiate the rotating-animation … across all axes"). The same key again
 *  stops it; with Shift it turns the other way. */
export const SPIN_KEYS: Readonly<Record<SpinAxis, string>> = {
  x: 'x',
  y: 'y',
  z: 'z',
};

export const SPIN_AXES = Object.keys(SPIN_KEYS) as SpinAxis[];

/** Each spin as the key legend says it. */
export const SPIN_LABEL: Readonly<Record<SpinAxis, string>> = {
  x: "Spin around X, the board's width",
  y: "Spin around Y, the board's height",
  z: "Spin around Z, the board's normal",
};

/** What the toolbar's Spin button starts: the load orbit's turn, again. */
export const DEFAULT_SPIN_AXIS: SpinAxis = 'z';

const keyOf = <K extends string>(map: Readonly<Record<K, string>>, key: string): K | null =>
  (Object.keys(map) as K[]).find((k) => map[k] === key) ?? null;

/** The board action on `key` (already lowercased by the caller), or null. */
export const boardActionForKey = (key: string): BoardAction | null => keyOf(BOARD_KEYS, key);

/** The view mode on `key`, or null. */
export const viewModeForKey = (key: string): ViewMode | null => keyOf(VIEW_MODE_KEYS, key);

/** How a key is announced in `aria-keyshortcuts`: letters upper-case. */
export const ariaKey = (key: string): string => key.toUpperCase();

/** The spin on `key` (lowercased by the caller), or null. */
export const spinAxisForKey = (key: string): SpinAxis | null => keyOf(SPIN_KEYS, key);
