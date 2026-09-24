// The one device decision this feature makes (spec 2026-09-21 §6, decision D3).
//
// Exactly one setting, evaluated once at mount.
// Nothing else in the 3D viewer branches on the device: a second heuristic
// somewhere else is how a renderer ends up fast on the machine it was written on
// and unusable everywhere else.
import type { Quality } from '@public/services/kicad/board3d/types';

/** Deliberately ONE input. Width and pixel ratio were each a tier input once,
 *  and each put the wrong device on the wrong tier (see below); the renderer
 *  bounds the pixel cost itself with `setPixelRatio(min(dpr, 2))`. */
export interface QualityEnv { webgl2: boolean }

/**
 * Every device with WebGL2 draws the whole board (AMENDED 2026-09-23, the
 * owner on a phone: "there arent even the renderings of the 3D objects like
 * the mosfets"). The width gate this replaced (`innerWidth >= 900`) sent every
 * phone to `reduced`: a 1× backing store on a 3× screen (a ninth of the
 * pixels, stretched), no antialiasing, no component bodies. It was a guess at
 * phone GPUs that never measured one — and the phone canvas is the SMALL one:
 * 370×414 CSS px at the renderer's `min(dpr, 2)` cap is 740×828, ~0.6 MP,
 * under a fifth of a 1376×616 desktop canvas at 2× (measured 2026-09-23). The pixel ratio was already ruled out as a
 * gate (2026-09-22: 2.24×/2.52× desktops). `reduced` stays reachable through
 * the override and for a device without WebGL2 (which renders nothing anyway).
 */
let override: Quality | null = null;

export function decideQuality(env: QualityEnv): Quality {
  return env.webgl2 ? 'full' : 'reduced';
}

/** For tests, and for the day the owner wants one tier everywhere. `null` clears. */
export function setQualityOverride(quality: Quality | null): void {
  override = quality;
}

export function currentQuality(env: QualityEnv): Quality {
  return override ?? decideQuality(env);
}
