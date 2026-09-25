import { describe, expect, it } from 'vitest';

import { BOARD_KEYS, SPIN_KEYS, VIEW_MODE_KEYS } from '@public/components/kicad/board3d/shortcuts';

import { VIEW_KEY } from './viewLabels';

/**
 * The page's view keys and the 3D tab's own keys are two maps in two homes;
 * both listen on `window`, so one letter in both would fire twice. `/` and
 * Esc are the page's older shortcuts.
 */
describe('the viewer claims each single key once', () => {
  it('no key is shared between the view tabs, the 3D controls and the older shortcuts', () => {
    const claimed = [...Object.values(VIEW_KEY), ...Object.values(BOARD_KEYS), ...Object.values(VIEW_MODE_KEYS), ...Object.values(SPIN_KEYS), '/', 'Escape'];
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it('every key is a single lowercase character, as callers compare e.key.toLowerCase()', () => {
    for (const key of [...Object.values(VIEW_KEY), ...Object.values(BOARD_KEYS), ...Object.values(VIEW_MODE_KEYS), ...Object.values(SPIN_KEYS)]) {
      expect(key).toMatch(/^[a-z0-9]$/);
    }
  });
});
