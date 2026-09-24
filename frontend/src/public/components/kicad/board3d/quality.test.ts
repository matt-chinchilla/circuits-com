import { afterEach, describe, expect, it } from 'vitest';
import { currentQuality, decideQuality, setQualityOverride } from './quality';

// One setting, decided once, from WebGL2 and nothing else (spec §6). Two device
// rules came and went, each for putting the wrong device on the wrong tier:
// the pixel ratio (2026-09-22 — a 2.24× desktop display, a real GPU, got no
// bodies) and the width (2026-09-23 — every phone got no bodies). `QualityEnv`
// now has no field to hang a third on. The override exists for tests and for
// the day the owner wants the same tier everywhere; it must beat the rule
// without changing it.
afterEach(() => {
  setQualityOverride(null);
});

describe('decideQuality', () => {
  it('draws the whole board wherever WebGL2 exists — phones included', () => {
    expect(decideQuality({ webgl2: true })).toBe('full');
  });
  it('is reduced only without WebGL2, where nothing renders anyway', () => {
    expect(decideQuality({ webgl2: false })).toBe('reduced');
  });
});

describe('the override', () => {
  it('wins over the rule in both directions', () => {
    setQualityOverride('reduced');
    expect(currentQuality({ webgl2: true })).toBe('reduced');
    setQualityOverride('full');
    expect(currentQuality({ webgl2: false })).toBe('full');
  });
  it('clears back to the rule, and never changes decideQuality itself', () => {
    setQualityOverride('reduced');
    expect(decideQuality({ webgl2: true })).toBe('full');
    setQualityOverride(null);
    expect(currentQuality({ webgl2: true })).toBe('full');
  });
});
