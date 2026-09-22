// The vocabulary of the pure 3D board pipeline (spec 2026-09-21 §4). Every module
// under board3d/ speaks these types and nothing else: no DOM, no three.js, no
// KiCanvas. Coordinates are KiCad millimetres, y-DOWN, exactly as the file states
// them; buildScene flips y once at the very end.
export interface Vec2 { x: number; y: number }
export interface Ring { pts: Vec2[] }                       // closed; last point NOT repeated
export interface PolygonWithHoles { outer: Ring; holes: Ring[] }
export type Side = 'F' | 'B';
export type LayerKind = 'copper' | 'mask' | 'silk' | 'courtyard' | 'edge' | 'other';
export interface LayerDef { ordinal: number; name: string; kind: LayerKind; side: Side | 'In' }
export interface Placement { at: Vec2; rotDeg: number; side: Side }
export type Shape =
  | { kind: 'line'; a: Vec2; b: Vec2; width: number }
  | { kind: 'arc'; a: Vec2; mid: Vec2; b: Vec2; width: number }
  | { kind: 'circle'; c: Vec2; r: number; width: number; filled: boolean }
  | { kind: 'rect'; a: Vec2; b: Vec2; width: number; filled: boolean }
  | { kind: 'poly'; pts: Vec2[]; width: number; filled: boolean };
export interface ShapeOnLayer { layer: string; shape: Shape }         // absolute coordinates
export type PadShape = 'circle' | 'oval' | 'rect' | 'roundrect' | 'trapezoid' | 'custom';
export interface PadDrill { d: number; slotW?: number; slotH?: number }  // slot: (drill oval w h)
/** One row of the board's net table. Net 0 is KiCad's "no net" row and is never
 *  listed: every item below carries `net: 0` for "not on a net". */
export interface NetInfo { number: number; name: string }
export interface PadModel {
  ref: string; number: string; kind: 'smd' | 'thru_hole' | 'np_thru_hole' | 'connect';
  shape: PadShape; at: Vec2; rotDeg: number; size: Vec2; rratio: number | null; layers: string[]; drill: PadDrill | null;
  net: number;
}
export interface FootprintModel {
  ref: string; lib: string; place: Placement; pads: PadModel[];
  courtyard: Shape[];                 // fp_* graphics on <side>.CrtYd, FOOTPRINT-LOCAL coords (unplaced)
  silk: Shape[];                      // fp_* graphics on <side>.SilkS, footprint-local
}
export interface ViaModel { at: Vec2; size: number; drill: number; layers: [string, string]; net: number }
export interface TrackModel { layer: string; width: number; pts: Vec2[]; net: number }   // arcs pre-flattened
export interface ZoneFill { layer: string; ring: Ring; net: number }
export type BoardWarning =
  | { kind: 'outline-open'; segments: number }
  | { kind: 'no-stackup' }
  | { kind: 'zones-unfilled'; count: number }
  | { kind: 'holes-merged'; count: number }
  /** Drills drawn as marks, and mask openings drawn as raised pads, because one
   *  face could not afford to cut them all (buildScene's FACE_HOLE_BUDGET). */
  | { kind: 'holes-marked'; count: number }
  | { kind: 'no-courtyard'; count: number }
  | { kind: 'arc-degenerate'; count: number };
export interface BoardModel {
  version: number; layers: LayerDef[]; edgeItems: Shape[]; footprints: FootprintModel[];
  vias: ViaModel[]; tracks: TrackModel[]; zones: ZoneFill[]; zonesUnfilled: number;
  silk: ShapeOnLayer[]; warnings: BoardWarning[];
  /** The net table, ascending by number, net 0 excluded. */
  nets: NetInfo[];
}
export type Material = 'substrate' | 'copper' | 'mask' | 'silk' | 'body' | 'hole-wall';
/** The slice of a group's `indices` that belongs to one footprint: `start` is an
 *  offset INTO `indices` (not a triangle number), `count` is how many indices —
 *  always a multiple of 3. Ranges are contiguous and ascending by construction. */
export interface PartRange { ref: string; start: number; count: number }
/** The slice of a COPPER group's `indices` one class of copper draws. Same units
 *  as `PartRange` — `start` an offset into `indices`, `count` a multiple of 3 —
 *  so one set of slicing helpers (`partRanges.ts`) serves parts, classes and
 *  nets. The classes of a group tile `[0, indices.length)` exactly, pads first,
 *  then tracks, then zones; a class that drew nothing has no range. */
export interface ClassRange { kind: 'tracks' | 'pads' | 'zones'; start: number; count: number }
/** The slice of a copper group one net's items drew, same units again. A net
 *  usually owns SEVERAL ranges (its pads sit in footprint order); items on no
 *  net (net 0) are in no range, so net ranges cover each triangle AT MOST once.
 *  Ascending by `start`, never overlapping. */
export interface NetRange { net: number; start: number; count: number }
export interface MeshGroup {
  material: Material; layerName: string | null; positions: Float32Array; normals: Float32Array; indices: Uint32Array;
  /** Which footprint each triangle belongs to, for the groups that draw per-part
   *  geometry (bodies at `full`; pads on every copper layer). Absent on a group
   *  that draws nothing a reader can pick — substrate, mask, silk, hole walls. */
  parts?: PartRange[];
  /** Copper groups only: which class drew each triangle (tiles the group). */
  classes?: ClassRange[];
  /** Copper groups only: which net drew each triangle (absent when none did). */
  nets?: NetRange[];
}
export interface BoardScene {
  bounds: { min: Vec2; max: Vec2 }; thicknessMm: number | null; groups: MeshGroup[]; warnings: BoardWarning[];
  stats: { footprints: number; pads: number; vias: number; tracks: number; triangles: number; buildMs: number };
  /** The board's net table (`BoardModel.nets`), so a view that has only the
   *  scene can name the nets its `NetRange`s number. Optional only so a scene
   *  built by hand (a test's fake) need not carry one. */
  nets?: NetInfo[];
}
export type Quality = 'full' | 'reduced';
export const TOL_MM: Record<Quality, number> = { full: 0.01, reduced: 0.05 };
