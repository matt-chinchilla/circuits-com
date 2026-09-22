// Every colour and light the 3D board is drawn with, in ONE file (spec 2026-09-21
// §5). The values are the materials a bare PCB actually shows edge-on — mask
// green over copper, olive dielectric, cream silk — and they are the same reading
// the Stackup tab's figure gives, so the two tabs agree about what a board is.
//
// Hex numbers rather than CSS tokens on purpose: these feed three.js `Color`s, and
// a theme variable would have to be read out of the DOM at mount and re-read on
// every theme change for a canvas that is already un-themed chrome.
import type { Material } from '@public/services/kicad/board3d/types';

export interface MaterialSpec {
  color: number;
  roughness: number;
  metalness: number;
  opacity: number;
  transparent: boolean;
  /** Translucent bodies must not write depth, or the board behind them vanishes. */
  depthWrite: boolean;
}

/** Every channel scaled. The drilled wall IS the substrate seen in shadow, so it
 *  is derived from the substrate rather than typed out beside it — one edit moves
 *  both, and they can never drift into two different greens. */
export function shade(hex: number, factor: number): number {
  const channel = (shift: number) => Math.max(0, Math.min(255, Math.round(((hex >> shift) & 0xff) * factor)));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

const SUBSTRATE = 0x2f4a2a;

export const MATERIALS: Record<Material, MaterialSpec> = {
  substrate: { color: SUBSTRATE, roughness: 0.85, metalness: 0, opacity: 1, transparent: false, depthWrite: true },
  'hole-wall': { color: shade(SUBSTRATE, 0.8), roughness: 0.9, metalness: 0, opacity: 1, transparent: false, depthWrite: true },
  copper: { color: 0xc8873a, roughness: 0.35, metalness: 0.9, opacity: 1, transparent: false, depthWrite: true },
  mask: { color: 0x1f6b3a, roughness: 0.6, metalness: 0, opacity: 1, transparent: false, depthWrite: true },
  silk: { color: 0xf2f0e6, roughness: 0.9, metalness: 0, opacity: 1, transparent: false, depthWrite: true },
  body: { color: 0x1a1c1f, roughness: 0.5, metalness: 0, opacity: 0.55, transparent: true, depthWrite: false },
};

/**
 * One directional light parented to the camera so it travels with the view — a
 * fixed light leaves half of an orbited board black — plus a hemisphere fill so
 * the shadowed side is readable. No shadow maps, no environment map, no
 * post-processing: this is a board, not a render.
 */
export const LIGHTS = {
  directional: { color: 0xffffff, intensity: 2.2, offset: { x: -0.35, y: 0.25, z: 0.9 } },
  hemisphere: { sky: 0xffffff, ground: 0x444444, intensity: 0.6 },
};

export const CAMERA = {
  fov: 35,
  elevationDeg: 35,
  azimuthDeg: 30,
  /** Slack around the board's diagonal so the framing never clips a corner. */
  fitMargin: 1.18,
  /** Straight down would put the view axis on the up vector and the roll would be
   *  undefined; one degree off is indistinguishable and stable. */
  poleDeg: 89,
};

export const ORBIT = {
  autoDegPerSec: 6,
  minDistanceFactor: 0.4,
  maxDistanceFactor: 6,
  keyStepDeg: 10,
  dampingFactor: 0.08,
  /** How long a frame keeps being drawn after the controls report a change: long
   *  enough for damping to settle, short enough that an idle tab stops. */
  settleMs: 600,
};

export const FLIP_MS = 500;
/** Matches `.canvasHost`'s CSS background, so a resize never flashes a pale gap. */
export const BACKGROUND = 0x0f1512;
