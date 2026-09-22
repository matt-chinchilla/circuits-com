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
export interface PadModel {
  ref: string; number: string; kind: 'smd' | 'thru_hole' | 'np_thru_hole' | 'connect';
  shape: PadShape; at: Vec2; rotDeg: number; size: Vec2; rratio: number | null; layers: string[]; drill: PadDrill | null;
}
export interface FootprintModel {
  ref: string; lib: string; place: Placement; pads: PadModel[];
  courtyard: Shape[];                 // fp_* graphics on <side>.CrtYd, FOOTPRINT-LOCAL coords (unplaced)
  silk: Shape[];                      // fp_* graphics on <side>.SilkS, footprint-local
}
export interface ViaModel { at: Vec2; size: number; drill: number; layers: [string, string] }
export interface TrackModel { layer: string; width: number; pts: Vec2[] }   // arcs pre-flattened
export interface ZoneFill { layer: string; ring: Ring }
export type BoardWarning =
  | { kind: 'outline-open'; segments: number }
  | { kind: 'no-stackup' }
  | { kind: 'zones-unfilled'; count: number }
  | { kind: 'holes-merged'; count: number }
  | { kind: 'no-courtyard'; count: number }
  | { kind: 'arc-degenerate'; count: number };
export interface BoardModel {
  version: number; layers: LayerDef[]; edgeItems: Shape[]; footprints: FootprintModel[];
  vias: ViaModel[]; tracks: TrackModel[]; zones: ZoneFill[]; zonesUnfilled: number;
  silk: ShapeOnLayer[]; warnings: BoardWarning[];
}
export type Material = 'substrate' | 'copper' | 'mask' | 'silk' | 'body' | 'hole-wall';
export interface MeshGroup { material: Material; layerName: string | null; positions: Float32Array; normals: Float32Array; indices: Uint32Array }
export interface BoardScene {
  bounds: { min: Vec2; max: Vec2 }; thicknessMm: number | null; groups: MeshGroup[]; warnings: BoardWarning[];
  stats: { footprints: number; pads: number; vias: number; tracks: number; triangles: number; buildMs: number };
}
export type Quality = 'full' | 'reduced';
export const TOL_MM: Record<Quality, number> = { full: 0.01, reduced: 0.05 };
