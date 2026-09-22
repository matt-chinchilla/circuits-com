// Every colour and light the 3D board is drawn with, in ONE file (spec 2026-09-21
// §5). The values are the materials a bare PCB actually shows edge-on — mask
// green over copper, olive dielectric, cream silk — and they are the same reading
// the Stackup tab's figure gives, so the two tabs agree about what a board is.
//
// Hex numbers rather than CSS tokens on purpose: these feed three.js `Color`s, and
// a theme variable would have to be read out of the DOM at mount and re-read on
// every theme change for a canvas that is already un-themed chrome.
import type { Material } from '@public/services/kicad/board3d/types';
import type { ViewMode } from './viewMode';

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
 * The selected footprint, lit from within so it reads at any orbit and against
 * either the mask green or the copper. Cyan is the colour EDA tools have used
 * for "selected" since KiCad 5's own highlight, and it sits away from every
 * material on the board (copper orange, mask green, silk cream, body smoke) —
 * a reader never has to ask whether a part is selected or merely bright.
 * `emissive` is what makes it independent of the lights; the colour is also
 * the base so a lit face and a shadowed one are the same hue.
 */
const HIGHLIGHT = 0x4fc3f7;

export interface HighlightSpec extends MaterialSpec {
  emissive: number;
  emissiveIntensity: number;
}

/** Per material that can carry a highlight: the body block and the copper (a
 *  selected part, a highlighted net or layer), and `surface` for the rest of a
 *  highlighted layer — its mask, silk and drill marks. */
export const HIGHLIGHT_MATERIALS: Record<'body' | 'copper' | 'surface', HighlightSpec> = {
  body: {
    color: HIGHLIGHT, emissive: HIGHLIGHT, emissiveIntensity: 0.55,
    roughness: 0.5, metalness: 0, opacity: 0.88, transparent: true, depthWrite: false,
  },
  copper: {
    color: HIGHLIGHT, emissive: HIGHLIGHT, emissiveIntensity: 0.5,
    roughness: 0.4, metalness: 0.2, opacity: 1, transparent: false, depthWrite: true,
  },
  surface: {
    color: HIGHLIGHT, emissive: HIGHLIGHT, emissiveIntensity: 0.45,
    roughness: 0.7, metalness: 0, opacity: 1, transparent: false, depthWrite: true,
  },
};

/**
 * What each view mode does to the board's opacities (owner, 2026-09-22: a
 * "transparency mode"). Each value CAPS a material's own opacity — the
 * smoked-glass body stays at .55 in Solid and drops to the cap in See-through;
 * an opaque mask is untouched until X-ray. The Objects tab's sliders multiply
 * on top, and the selected part's highlight material is never capped: in a
 * see-through board the part the reader asked about stays the solid one.
 */
export interface ViewModeLook {
  /** Cap on every body's opacity. */
  body: number;
  /** Cap on the solder mask's opacity. */
  mask: number;
}

export const VIEW_MODE_LOOK: Record<ViewMode, ViewModeLook> = {
  solid: { body: 1, mask: 1 },
  'see-through': { body: 0.22, mask: 1 },
  xray: { body: 0.16, mask: 0.3 },
};

/** The highlight a group of this material takes. */
export function highlightSpecFor(material: Material): HighlightSpec {
  return material === 'body' || material === 'copper' ? HIGHLIGHT_MATERIALS[material] : HIGHLIGHT_MATERIALS.surface;
}

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
  /** Slack beyond an exact fit of the board's corners to the canvas edges (see
   *  `services/kicad/board3d/framing.ts`); 1 is edge to edge. */
  fitMargin: 1.04,
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
