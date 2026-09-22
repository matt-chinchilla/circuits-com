// The one device decision this feature makes (spec 2026-09-21 §6, decision D3).
//
// Exactly one setting, from exactly three inputs, evaluated once at mount.
// Nothing else in the 3D viewer branches on the device: a second heuristic
// somewhere else is how a renderer ends up fast on the machine it was written on
// and unusable everywhere else.
import type { Quality } from '@public/services/kicad/board3d/types';

export interface QualityEnv { webgl2: boolean; innerWidth: number; devicePixelRatio: number }

/** Below this width the board is too small on screen to read the detail `full`
 *  buys; above this ratio the pixel count, not the triangle count, is the cost. */
const FULL_MIN_WIDTH = 900;
const FULL_MAX_DPR = 2;

let override: Quality | null = null;

export function decideQuality(env: QualityEnv): Quality {
  return env.webgl2 && env.innerWidth >= FULL_MIN_WIDTH && env.devicePixelRatio <= FULL_MAX_DPR ? 'full' : 'reduced';
}

/** For tests, and for the day the owner wants one tier everywhere. `null` clears. */
export function setQualityOverride(quality: Quality | null): void {
  override = quality;
}

export function currentQuality(env: QualityEnv): Quality {
  return override ?? decideQuality(env);
}
