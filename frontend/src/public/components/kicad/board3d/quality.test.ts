import { afterEach, describe, expect, it } from 'vitest';
import { currentQuality, decideQuality, setQualityOverride } from './quality';

// One setting, decided once, from three inputs and nothing else (spec §6). The
// override exists for tests and for the day the owner wants the same tier
// everywhere; it must beat the heuristic without changing it.
afterEach(() => {
  setQualityOverride(null);
});

const env = (webgl2: boolean, innerWidth: number, devicePixelRatio: number) => ({ webgl2, innerWidth, devicePixelRatio });

describe('decideQuality', () => {
  it.each([
    ['a desktop', env(true, 1440, 1), 'full'],
    ['both thresholds exactly met', env(true, 900, 2), 'full'],
    ['a narrow window', env(true, 899, 1), 'reduced'],
    ['a dense display', env(true, 1440, 3), 'reduced'],
    ['no WebGL2', env(false, 1440, 1), 'reduced'],
    ['a phone', env(true, 390, 3), 'reduced'],
  ])('%s → %s', (_label, e, want) => {
    expect(decideQuality(e)).toBe(want);
  });
});

describe('the override', () => {
  it('wins over the heuristic in both directions', () => {
    const phone = env(true, 390, 3), desktop = env(true, 1440, 1);
    expect(currentQuality(phone)).toBe('reduced');
    setQualityOverride('full');
    expect(currentQuality(phone)).toBe('full');
    setQualityOverride('reduced');
    expect(currentQuality(desktop)).toBe('reduced');
  });
  it('clears back to the heuristic, and never changes decideQuality itself', () => {
    setQualityOverride('full');
    expect(decideQuality(env(true, 390, 3))).toBe('reduced');
    setQualityOverride(null);
    expect(currentQuality(env(true, 390, 3))).toBe('reduced');
  });
});
