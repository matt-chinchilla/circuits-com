// The 3D tab's key map: every control has one key, no key does two things,
// and the page's tab keys (s/p/k/d/m) are never taken here.
import { describe, expect, it } from 'vitest';
import { VIEW_MODES } from './viewMode';
import {
  BOARD_KEYS, SPIN_AXES, SPIN_KEYS, VIEW_MODE_KEYS, ariaKey, boardActionForKey, spinAxisForKey, viewModeForKey, type BoardAction,
} from './shortcuts';

const ACTIONS: BoardAction[] = ['top', 'bottom', 'flip', 'reset'];

describe('3D shortcuts', () => {
  it('maps the owner\'s keys: t/b/f/r and 1/2/3', () => {
    expect(BOARD_KEYS).toEqual({ top: 't', bottom: 'b', flip: 'f', reset: 'r' });
    expect(VIEW_MODES.map((m) => VIEW_MODE_KEYS[m.id])).toEqual(['1', '2', '3']);
  });
  it('gives every action and every view mode a key, and each key round-trips', () => {
    for (const a of ACTIONS) expect(boardActionForKey(BOARD_KEYS[a])).toBe(a);
    for (const m of VIEW_MODES) expect(viewModeForKey(VIEW_MODE_KEYS[m.id])).toBe(m.id);
  });
  it('spins on x/y/z, one key per board axis, round-tripping', () => {
    expect(SPIN_KEYS).toEqual({ x: 'x', y: 'y', z: 'z' });
    expect(SPIN_AXES).toEqual(['x', 'y', 'z']);
    for (const a of SPIN_AXES) expect(spinAxisForKey(SPIN_KEYS[a])).toBe(a);
    expect(spinAxisForKey('t')).toBeNull();
  });
  it('never binds one key twice, and stays off the page\'s tab keys', () => {
    const keys = [...Object.values(BOARD_KEYS), ...Object.values(VIEW_MODE_KEYS), ...Object.values(SPIN_KEYS)];
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of 'spkdm') expect(keys).not.toContain(k);
  });
  it('an unknown key is null, and the lookup is exact: the caller lowercases', () => {
    expect(boardActionForKey('q')).toBeNull();
    expect(viewModeForKey('4')).toBeNull();
    expect(boardActionForKey('')).toBeNull();
    expect(boardActionForKey('T')).toBeNull();
    expect(boardActionForKey('T'.toLowerCase())).toBe('top');
    expect(viewModeForKey('t')).toBeNull();
  });
  it('announces letters upper-case for aria-keyshortcuts', () => {
    expect(ariaKey('t')).toBe('T');
    expect(ariaKey('2')).toBe('2');
  });
});
