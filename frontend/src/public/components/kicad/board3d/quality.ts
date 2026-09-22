// The one device decision this feature makes (spec 2026-09-21 §6, decision D3).
//
// Exactly one setting, from exactly three inputs, evaluated once at mount.
// Nothing else in the 3D viewer branches on the device: a second heuristic
// somewhere else is how a renderer ends up fast on the machine it was written on
// and unusable everywhere else.
import type { Quality } from '@public/services/kicad/board3d/types';

export interface QualityEnv { webgl2: boolean; innerWidth: number; devicePixelRatio: number }   // dpr kept in the env for the renderer's cap; not a tier input

/** Below this width the board is too small on screen to read the detail `full`
 *  buys. The pixel ratio is deliberately NOT a gate (2026-09-22): the owner's
 *  desktop displays run at 2.24 and 2.52, and a `dpr <= 2` rule meant to catch
 *  phones put an RTX 4070 Ti on the reduced tier — a 1× backing store (blur)
 *  with no component bodies. Phones are caught by width; the pixel COST is
 *  bounded where it is paid, by the renderer's `setPixelRatio(min(dpr, 2))`. */
const FULL_MIN_WIDTH = 900;

let override: Quality | null = null;

export function decideQuality(env: QualityEnv): Quality {
  return env.webgl2 && env.innerWidth >= FULL_MIN_WIDTH ? 'full' : 'reduced';
}

/** For tests, and for the day the owner wants one tier everywhere. `null` clears. */
export function setQualityOverride(quality: Quality | null): void {
  override = quality;
}

export function currentQuality(env: QualityEnv): Quality {
  return override ?? decideQuality(env);
}
