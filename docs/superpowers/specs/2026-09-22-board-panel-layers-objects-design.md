# Board panel: Layers · Objects · Nets (with Parts) — design

**Date:** 2026-09-22 · **Branch:** `updates` (base 64262cc) · **Migrations:** none · **Backend:** none · **Status:** owner asked for it 2026-09-22 16:07 ("implement the view I spoke about before my final review"): an Altium-365-style Layers and Objects panel for the PCB viewer, driving the Board (2D) and 3D tabs together, with the existing part panel as its Parts tab.

## 1. What ships

One panel beside the canvas — the existing part-panel chrome (desktop sidebar, phone bottom sheet, `/` focuses search, Esc clears) becomes the **Board panel** with three tabs:

| Tab | Board (2D) tab | 3D tab | Schematic tab |
|---|---|---|---|
| **Parts** | today's part panel, unchanged | unchanged | unchanged |
| **Layers** | every physical layer of the board: colour swatch, name, visibility checkbox, click the name to highlight (dims the rest, click again to clear), "Show all / Hide all" | same list drives the 3D mesh groups' visibility; highlight = the 3D highlight material on that layer's groups | tab disabled with the hint "Open the Board or 3D tab" |
| **Objects** | classes Tracks · Vias · Pads · Through-holes · Zones · Grid · Page, each a checkbox (hide at 0) + opacity slider 0–100 %; below it **Nets**: searchable list, click to highlight a net (click again clears) | classes Tracks · Vias · Pads · Zones · Silkscreen · Mask · Bodies with the same controls (Grid/Page absent); Nets highlights the net's copper in 3D | disabled, same hint |

The state is ONE object on the viewer page (`boardView`), applied to whichever drawing is live, so a layer hidden on the Board tab is hidden on the 3D tab too and survives tab switches. It resets when the project changes.

## 2. Interfaces (binding — three seats build against these in parallel)

### 2.1 Seam (`frontend/src/public/components/kicad/canvasController.ts`)
```ts
export type LayerKind = 'copper' | 'mask' | 'paste' | 'silk' | 'courtyard' | 'fab' | 'edge' | 'user' | 'other';
export interface LayerInfo { name: string; kind: LayerKind; side: 'F' | 'B' | 'In' | null; color: string /* CSS colour */; visible: boolean; highlighted: boolean }
export type ObjectClass2D = 'tracks' | 'vias' | 'pads' | 'holes' | 'zones' | 'grid' | 'page';
export interface NetInfo { number: number; name: string }
// New OPTIONAL members on CanvasController (a renderer without them shows no Layers/Objects controls):
layers?(): LayerInfo[];                                   // the BOARD's physical layers in KiCanvas display order; virtual layers (netnames, holewalls…) never listed
setLayerVisible?(name: string, visible: boolean): void;
highlightLayer?(name: string | null): void;               // null clears
setObjectOpacity?(kind: ObjectClass2D, opacity: number): void;   // 0..1; 0 hides
nets?(): NetInfo[];                                       // from the loaded board; [] before load
highlightNet?(net: number | null): void;                  // null clears
// New event: emitted after every board load and after any layer change the controller itself made
| { type: 'layers'; layers: LayerInfo[] }
```
`kicanvasController.ts` implements them over `app.viewer` (a `BoardViewer` when the board is active): `viewer.layers` (`LayerSet`: `in_display_order()`, `by_name`, `ViewLayer.visible/color/highlighted`, `highlight(layer|null)`), `viewer.track_opacity / via_opacity / pad_opacity / pad_hole_opacity / zone_opacity / grid_opacity / page_opacity`, `viewer.board.nets`, `viewer.highlight_net(number)` (clear = a number no net has, e.g. −1 — read `highlight_net` to confirm). Colour: `ViewLayer.color.to_css()` (check the Color class). Only the PHYSICAL layers are listed: KiCanvas's virtual layers (`:Pads:*`, `:Via:*`, `:Zones:*`, `:Pad:Holes*`) are filtered by name prefix `:`. Every call is a no-op (and `layers()` returns `[]`) when the live viewer is the schematic. NEVER import the vendored tree elsewhere — the boundary rule stands; `DesignCanvas` forwards the calls through its handle.

### 2.2 3D renderer (`components/kicad/board3d/sceneRenderer.ts`)
```ts
export type ObjectClass3D = 'tracks' | 'vias' | 'pads' | 'zones' | 'silk' | 'mask' | 'bodies';
// New OPTIONAL members on SceneRenderer:
setLayerVisible?(layerName: string, visible: boolean): void;   // every MeshGroup whose layerName matches; substrate + hole walls are never hidden
highlightLayer?(layerName: string | null): void;               // the groups on that layer take the highlight material (same mechanism as part highlight)
setObjectOpacity?(kind: ObjectClass3D, opacity: number): void; // 0 hides; bodies/silk/mask/vias by material, tracks/pads/zones by the copper groups' class ranges (§2.3)
highlightNet?(net: number | null): void;                       // copper geometry of that net in the highlight material via net ranges (§2.3)
```
Draw groups: a copper `MeshGroup` becomes one `BufferGeometry` with `addGroup` per class range (tracks, pads, zones) so each class can carry its own material opacity; a highlight (part, layer or net) is applied by re-slicing the groups exactly as `partRanges.highlightSlices` does today — extend that module rather than duplicating it.

### 2.3 Pipeline (`services/kicad/board3d/`)
```ts
// types.ts additions
export interface NetInfo { number: number; name: string }
export interface ClassRange { kind: 'tracks' | 'pads' | 'zones'; start: number; count: number }   // triangle index range (in indices/3)
export interface NetRange { net: number; start: number; count: number }
// BoardModel: nets: NetInfo[]; PadModel.net, ViaModel.net, TrackModel.net, ZoneFill.net: number (0 = none)
// MeshGroup: classes?: ClassRange[]; nets?: NetRange[]   (copper groups only, like `parts`)
// readBoardModel: parses the top-level (net N "name") table and (net N) on pads/vias/segments/arcs/zones
// NEW cheap reader for the Layers tab before any drawing is loaded:
export function readLayerTable(boardText: string): LayerDef[];   // the (layers …) block only, via topLevelBlocks — the 3D tab's Layers list must not wait for a full parse
```
`buildScene` appends tracks, pads and zones to a copper group in a fixed order and records the class + net ranges as it goes (it already records part ranges); vias are the `hole-wall` group (no class ranges needed: opacity by material).

### 2.4 Page state (`pages/viewer/`)
```ts
export interface BoardViewState {
  hiddenLayers: Set<string>;                 // by layer name
  highlightedLayer: string | null;
  opacity: Partial<Record<ObjectClass2D | ObjectClass3D, number>>;   // absent = 1
  highlightedNet: number | null;
}
```
One `useState` on the page; `applyToCanvas(controllerHandle, state)` after each `'layers'` event and on every state change while the Board tab is live; `applyToRenderer(renderer, state)` on 3D mount and on change. Layer list for the panel: `layers()` from the controller when the board has loaded, else `readLayerTable` + `layerColors.ts` (a copy of KiCanvas's default board colours — MIT, note it in NOTICE.txt under the existing KiCanvas block) so the 3D tab and a not-yet-loaded board still list the layers. Nets list: `nets()` when loaded, else `BoardModel.nets` from the 3D scene's read (the page already has the board text; a cheap `readNetTable(text)` is acceptable if the seat prefers).

## 3. Hard rules (unchanged)
No edits under `frontend/vendor/`; `board3dBoundary.test.ts` and `vendorIntegrity.test.ts` stay green (they grep comments); nothing outside `kicanvasController.ts` touches KiCanvas; no network request from a design; no fabricated numbers; the privacy sentence stays verbatim; TS strict; the quality tier and its 2× pixel cap unchanged; tap targets ≥ 44px; sliders are native `<input type="range">` with labels; the panel stays keyboard-operable (tabs roving, Esc clears highlight then selection).

## 4. Tests
Pipeline: net table + per-item nets on Glasgow (count of nets = the file's table; a known pad's net), class/net ranges cover every copper triangle exactly once and are in bounds, `readLayerTable` on all four fixtures. Seam: a fake `viewer` object exercising `layers()` filtering of virtual layers, `setLayerVisible`, `highlightLayer`, opacity setters, `nets()`, `highlightNet`, and the `'layers'` event after load. Renderer: `Board3DView.test.ts` gains layer/opacity/net calls through the fake renderer; `sceneRenderer` slicing logic tested as a pure function in `partRanges.ts`. Page: `viewerPage.test.ts` — the panel's tabs, disabled state on Schematic, state survives Board→3D→Board, reset on project change. Gates as always.

## 5. Out of scope
Layer colour editing, layer sets/presets, per-object visibility inside a class, measuring, 3D nets on inner layers (inner copper is not drawn in v1), any vendored-code change.
