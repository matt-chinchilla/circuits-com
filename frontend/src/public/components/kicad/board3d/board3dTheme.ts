// Every colour and light the 3D board is drawn with, in ONE file (spec 2026-09-21
// §5). The values are the materials a bare PCB actually shows edge-on — mask
// green over copper, olive dielectric, cream silk — and they are the same reading
// the Stackup tab's figure gives, so the two tabs agree about what a board is.
//
// Hex numbers rather than CSS tokens on purpose: these feed three.js `Color`s, and
// a theme variable would have to be read out of the DOM at mount and re-read on
// every theme change for a canvas that is already un-themed chrome.
import { PART_FAMILIES, type PartFamily } from '@public/services/kicad/board3d/partFamily';
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

/** `0xc8873a` → `#c8873a`, for the DOM legend that names these colours. */
export function cssHex(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

const SUBSTRATE = 0x2f4a2a;
const HOLE_WALL = shade(SUBSTRATE, 0.8);
const COPPER = 0xc8873a;
const MASK = 0x1f6b3a;
const SILK = 0xf2f0e6;
/** The smoked glass every body was drawn in before the families (spec D2),
 *  and still is for a part the names cannot place. */
const SMOKE = 0x1a1c1f;

/**
 * Lit by the room environment below, the copper reads as metal at .9 and the
 * mask at .45 roughness shows the soft highlight of a real gloss finish — both
 * were matte under two plain lights. `body` is the GLASS body material: the
 * family tint rides in a vertex colour (see `FAMILY_TINTS`), so its own colour
 * is white and the opaque families draw through `BODY_OPAQUE` instead.
 */
export const MATERIALS: Record<Material, MaterialSpec> = {
  substrate: { color: SUBSTRATE, roughness: 0.85, metalness: 0, opacity: 1, transparent: false, depthWrite: true },
  'hole-wall': { color: HOLE_WALL, roughness: 0.9, metalness: 0, opacity: 1, transparent: false, depthWrite: true },
  copper: { color: COPPER, roughness: 0.35, metalness: 0.9, opacity: 1, transparent: false, depthWrite: true },
  mask: { color: MASK, roughness: 0.45, metalness: 0, opacity: 1, transparent: false, depthWrite: true },
  silk: { color: SILK, roughness: 0.9, metalness: 0, opacity: 1, transparent: false, depthWrite: true },
  body: { color: 0xffffff, roughness: 0.45, metalness: 0, opacity: 0.55, transparent: true, depthWrite: false },
};

/** The opaque body material — an IC's package, a ceramic chip, a housing. Same
 *  white base as `body`; the tint is per vertex. */
export const BODY_OPAQUE: MaterialSpec = { color: 0xffffff, roughness: 0.62, metalness: 0.04, opacity: 1, transparent: false, depthWrite: true };

export interface FamilyTint {
  /** The vertex colour every vertex of the body takes. */
  color: number;
  /** Multiplier on the colour of the body's CAPS (its walls stay at 1): an
   *  IC's marked top face is lighter than its sides, which is what makes a
   *  black box read as a package rather than a hole. */
  capShade: number;
  /** Drawn in the translucent `body` material rather than `BODY_OPAQUE`. */
  glass: boolean;
  /** What the legend calls it. */
  label: string;
}

/**
 * The colours the parts actually are on a real board — a black package, a tan
 * ceramic chip, a grey-black housing, an amber lens — so the legend teaches
 * what a board looks like rather than what this app chose.
 */
export const FAMILY_TINTS: Record<PartFamily, FamilyTint> = {
  ic: { color: 0x141516, capShade: 1.7, glass: false, label: 'Chip (IC)' },
  passive: { color: 0xa6957a, capShade: 1.08, glass: false, label: 'Capacitor, resistor, inductor' },
  connector: { color: 0x2a2d31, capShade: 1.18, glass: false, label: 'Connector' },
  led: { color: 0xe8d7a0, capShade: 1.1, glass: true, label: 'LED' },
  other: { color: SMOKE, capShade: 1.15, glass: true, label: 'Other part' },
};

/** The rim drawn over every body's outline: a thin dark line, never capped by
 *  the view mode, so a see-through body still has a crisp edge. */
export const BODY_EDGE = { color: 0x0b0d0e, opacity: 0.55 };

/**
 * The procedural room the materials reflect (three's RoomEnvironment through a
 * PMREM generator, built once per mount, no asset file). The directional
 * light stays: the room gives the copper its reflections and the mask its
 * gloss; the light still draws the shading that separates a wall from a top.
 */
export const ENVIRONMENT = { intensity: 1, blur: 0.04 };

export interface LegendItem { id: string; label: string; css: string }

const glassCss = (hex: number, opacity: number) =>
  `rgba(${(hex >> 16) & 0xff}, ${(hex >> 8) & 0xff}, ${hex & 0xff}, ${opacity})`;

/** The legend's rows, in the order it lists them: the board's own materials,
 *  then the body — named as the estimate it is. */
export const LEGEND: readonly LegendItem[] = [
  { id: 'copper', label: 'Copper', css: cssHex(COPPER) },
  { id: 'mask', label: 'Solder mask', css: cssHex(MASK) },
  { id: 'silk', label: 'Silkscreen', css: cssHex(SILK) },
  { id: 'holes', label: 'Holes', css: cssHex(HOLE_WALL) },
  { id: 'body', label: 'Body — estimated from the courtyard', css: cssHex(FAMILY_TINTS.ic.color) },
];

/** The body tints, one row per family, under the body's own legend row. */
export const FAMILY_LEGEND: readonly (LegendItem & { family: PartFamily })[] = PART_FAMILIES.map((family) => {
  const tint = FAMILY_TINTS[family];
  return { id: family, family, label: tint.label, css: tint.glass ? glassCss(tint.color, MATERIALS.body.opacity) : cssHex(tint.color) };
});

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
 * the shadowed side is readable. No shadow maps, no post-processing: this is a
 * board, not a render. Both are dimmer than they were before the room
 * environment (2.2 / .6), which now carries most of the ambient light.
 */
export const LIGHTS = {
  directional: { color: 0xffffff, intensity: 1.6, offset: { x: -0.35, y: 0.25, z: 0.9 } },
  hemisphere: { sky: 0xffffff, ground: 0x444444, intensity: 0.35 },
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
