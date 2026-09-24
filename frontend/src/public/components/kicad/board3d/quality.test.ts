import { afterEach, describe, expect, it } from 'vitest';
import { currentQuality, decideQuality, setQualityOverride } from './quality';

// One setting, decided once, from WebGL2 and nothing else (spec §6, amended
// 2026-09-22: the pixel ratio is not a tier input — a 2.24× desktop display put
// a real GPU on the reduced tier; amended 2026-09-23: nor is the width — every
// phone lost its component bodies). The
// override exists for tests and for the day the owner wants the same tier
// everywhere; it must beat the heuristic without changing it.
afterEach(() => {
  setQualityOverride(null);
});

const env = (webgl2: boolean, innerWidth: number, devicePixelRatio: number) => ({ webgl2, innerWidth, devicePixelRatio });

describe('decideQuality', () => {
  it.each([
    ['a desktop', env(true, 1440, 1), 'full'],
    ['a narrow window', env(true, 899, 1), 'full'],
    ['a dense desktop display (the owner: 2.24 and 2.52)', env(true, 1715, 2.24), 'full'],
    ['a very dense desktop display', env(true, 1440, 3), 'full'],
    ['no WebGL2', env(false, 1440, 1), 'reduced'],
    ['a phone (the owner, 2026-09-23: no bodies on mobile)', env(true, 390, 3), 'full'],
    ['a small phone', env(true, 320, 2), 'full'],
  ])('%s → %s', (_label, e, want) => {
    expect(decideQuality(e)).toBe(want);
  });
});

describe('the override', () => {
  it('wins over the heuristic in both directions', () => {
    const noGl = env(false, 1440, 1), phone = env(true, 390, 3);
    expect(currentQuality(noGl)).toBe('reduced');
    setQualityOverride('full');
    expect(currentQuality(noGl)).toBe('full');
    setQualityOverride('reduced');
    expect(currentQuality(phone)).toBe('reduced');
  });
  it('clears back to the heuristic, and never changes decideQuality itself', () => {
    setQualityOverride('reduced');
    expect(decideQuality(env(true, 390, 3))).toBe('full');
    setQualityOverride(null);
    expect(currentQuality(env(true, 390, 3))).toBe('full');
  });
});
