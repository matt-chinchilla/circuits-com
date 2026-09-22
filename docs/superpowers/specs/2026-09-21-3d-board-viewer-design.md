# 3D Board Viewer — design

**Date:** 2026-09-21 · **Branch:** `updates` · **Migrations:** none · **Backend:** none · **Status:** approved in conversation (sections 1–7), awaiting owner review of this document.

Context map with every `file:line` citation this spec relies on: `.superpowers/sdd/2026-09-21-3d-board-viewer/context-map.md` (2026-09-21). Prior research this supersedes in part: `docs/design-briefs/bom-kicad-research-2026-08-19.md` §3D said "not possible client-side — precompute a GLB offline"; that verdict was about full 3D with real component models. This spec builds the narrower thing it never evaluated: a **bare board extruded from the file's own geometry and stackup, with estimated component bodies**, entirely in the browser. The owner chose this explicitly on 2026-09-21.

## 1. Goal and decisions

A fifth tab on `/viewer`, **3D**, that shows a believable, orbitable 3D rendering of the dropped KiCad board: real layer thicknesses, copper, soldermask, silkscreen shapes, real holes, and component footprints as translucent estimated bodies. Polish over precision; every number that reads as a measurement must come from the file.

| # | Decision (owner, 2026-09-21) | Consequence |
|---|---|---|
| D1 | Purpose: **a convincing look at the board**, not an inspection tool, not a marketing centrepiece. | Fidelity choices favour reading well at a glance; no measured heights, no dimension tools. |
| D2 | Components: **courtyard bodies**. | Each footprint's courtyard polygon is extruded to an ESTIMATED height and rendered as translucent smoked glass with a caption saying so. No toggle in v1. |
| D3 | Phones: **full 3D at reduced detail** now; the same scene everywhere later. | One `quality: 'full' \| 'reduced'` setting decided at mount, overridable by one flag. Nothing else may branch on device. |
| D4 | Approach: **our own geometry pipeline** over our existing s-expression reader, rendered with three.js. | No import from `frontend/vendor/kicanvas/**` or `kicanvasController.ts` anywhere in the 3D code. The board text comes from the design session. |
| D5 | Tab lifecycle: the 3D view **tears down on exit** (frees its WebGL context); the 2D embed keeps its one context. | Matches `/bom`'s decision for the same reason (`pages/bom/index.tsx:43-46`). Geometry is cached per project; only meshes rebuild. |
| D6 | First cut: **real holes, pours as saved, no silkscreen lettering**. | Lettering needs a font whose licence is the viewer's one open legal question; shapes only. |
| D7 | Honesty rule (existing, `docs/design-briefs/pcb-viewer-stackup-reference.md`): **no fabricated measurements**. | No default board thickness; a board without a stackup block gets equal nominal copper thickness AND a caption. Component heights are labelled estimates. The vendored KiCanvas `general.thickness = 1.6` default is never imported. |

## 2. Non-goals (v1)

Real component models (offline GLB pipeline — separate project); silkscreen text; blind/buried via geometry beyond their span (no fixture has them; render as through if spans are absent); measurement tools; layer toggles; screenshots/export; saving; any network request derived from the design (the `(model …)` paths must never be fetched or logged).

## 3. Architecture

```
designSession.project.files.get(project.board)      (raw .kicad_pcb text, already on the page)
        │
        ▼  (Web Worker; same-thread fallback)
@public/services/kicad/board3d/                      PURE — no DOM, no three, no KiCanvas
   readBoardModel.ts    text → BoardModel            (our sexpr toolkit; KiCad 6/9 dialects normalised)
   arcs.ts              3-point arc → centre/sweep → polyline   (collinear guard, radius-based step)
   outline.ts           unordered Edge.Cuts → closed loops      (board + cutouts; fallback flag)
   strokes.ts           polyline + width → round-capped polygon
   courtyards.ts        fp graphics on F/B.CrtYd → placed closed polygon (+ estimated height)
   layers.ts            (layers …) × BoardStackup → z ladder (mm)        (nominal-thickness flag)
   tessellate.ts        polygon(+holes) → triangles (earcut), extrude → faces + walls
   buildScene.ts        BoardModel + ladder → BoardScene
        │
        ▼
@public/components/kicad/board3d/                    React + three.js (lazy chunk)
   Board3DView.tsx      host: mount/dispose, quality, toolbar, caption, errors
   sceneRenderer.ts     BoardScene → meshes per (layer, material); render loop; controls
   useBoardScene.ts     worker plumbing + per-project cache
        │
        ▼
pages/viewer/index.tsx  fifth tab '3d' — same latch as Stackup, mounted only while selected
```

### 3.1 Data contracts

```ts
// board3d/types.ts
export interface Vec2 { x: number; y: number }               // mm, KiCad y-down; the scene flips y once
export interface Ring { pts: Vec2[] }                          // closed, no repeated last point
export interface PolygonWithHoles { outer: Ring; holes: Ring[] }

export interface BoardModel {
  version: number;                       // (version N)
  layers: { ordinal: number; name: string; kind: 'copper' | 'mask' | 'silk' | 'courtyard' | 'edge' | 'other'; side: 'F' | 'B' | 'In' }[];
  edgeItems: EdgeItem[];                 // gr_line/gr_arc/gr_rect/gr_circle/gr_poly on Edge.Cuts, arcs pre-flattened
  footprints: FootprintModel[];          // ref, side, at, rot, pads[], courtyard graphics[], hasCourtyard
  pads: PadModel[];                      // absolute placement, shape → polygon, layers[], drill?: { d: number; slot?: { w: number; h: number } }
  vias: ViaModel[];                      // at, size, drill, layers[from,to]
  tracks: TrackModel[];                  // segment | arc(flattened), width, layer
  zones: ZoneFill[];                     // saved filled_polygon per layer; zonesUnfilled: number
  silk: ShapeModel[];                    // fp_* / gr_* shapes on F/B.SilkS (no text)
  warnings: BoardWarning[];              // dialect or geometry notes surfaced to the caption
}

export type BoardWarning =
  | { kind: 'outline-open'; segments: number }        // outline did not close → bbox fallback
  | { kind: 'no-stackup' }                            // equal nominal copper thickness used
  | { kind: 'zones-unfilled'; count: number }
  | { kind: 'holes-merged'; count: number }
  | { kind: 'no-courtyard'; count: number }
  | { kind: 'arc-degenerate'; count: number };

export interface BoardScene {
  bounds: { min: Vec2; max: Vec2 };      // board bbox, mm
  thicknessMm: number | null;           // designThicknessMm from the stackup reader, or null (never invented)
  groups: MeshGroup[];                   // one per (material, layer): merged, ready for BufferGeometry
  warnings: BoardWarning[];
  stats: { footprints: number; pads: number; vias: number; tracks: number; triangles: number; buildMs: number };
}
export type Material = 'substrate' | 'copper' | 'mask' | 'silk' | 'body' | 'hole-wall';
export interface MeshGroup { material: Material; layerName: string | null; positions: Float32Array; normals: Float32Array; indices: Uint32Array }
```

`BoardScene` is structured-cloneable (typed arrays + plain objects) so it crosses the worker boundary by transfer, not copy.

### 3.2 Where the text comes from

`getDesignSession()` already holds `{project, parsed, refs}` and the page reads `session.project.files.get(board)` for the Stackup tab (`pages/viewer/index.tsx:344-347`). The 3D tab reads the same string. **No change to `CanvasController`, no new export from `@vendor-build/kicanvas`, no import of `frontend/vendor/kicanvas/**`.** A vitest rule test (`board3dBoundary.test.ts`) scans `board3d/**` sources for `vendor/kicanvas`, `@vendor-build`, `kicanvasController`, `document.` and `fetch(` and fails on any hit — turning the convention into a gate for this subsystem.

### 3.3 Worker

`board3d/worker.ts` receives `{ text, stackup: BoardStackup | null, quality }` and posts `BoardScene` with the typed arrays in the transfer list. Built by Vite's `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`. If `Worker` is unavailable or construction throws, `useBoardScene` runs `buildScene` on the main thread in a `setTimeout(0)` slice. Cache: `WeakMap<KicadProject, Promise<BoardScene>>` module-level, keyed on project identity, as `useBomWorkbench` does for its snapshot.

## 4. Geometry rules

- **Reader.** Uses `topLevelBlocks` + `parse` on the slices it needs (`sexpr.ts:118, :49`); never the whole tree at once. Dialects: `(tstamp)`/`(uuid)`, `(fp_text reference …)`/`(property "Reference" …)`, bare `hide`/`(hide yes)`, `(layers F.Cu …)` on pads, top-level `(arc …)` tracks (StickHub), `(pad … (shape custom) (primitives …))` (2 repo-wide; render the anchor shape and add a warning-free fallback).
- **Arcs** (`arcs.ts`). Every fixture uses `(start mid end)`; the legacy `(angle …)` form is parsed too. Centre from the perpendicular bisectors; if `|cross| < 1e-6 × chord²` treat as a straight segment and count `arc-degenerate`. Flatten with step `θ = clamp(acos(1 − tol/r), 2°, 15°)`, `tol = 0.01 mm` (full) / `0.05 mm` (reduced).
- **Outline** (`outline.ts`). Endpoint hash with 1 µm snap; greedy chaining; loops ordered by absolute area; the largest is the board, others are cutouts, winding normalised (outer CCW, holes CW). `gr_rect`/`gr_circle`/closed `gr_poly` are loops already. If any segment remains unchained → `outline-open`, use the axis-aligned bbox of all edge items as the outer ring.
- **Substrate.** One `PolygonWithHoles`: outer = board loop, holes = cutouts ∪ via drills ∪ pad drills (round → 16/8-gon by quality; `(drill oval w h)` → stadium; `np_thru_hole` pads too). Holes whose rings intersect are unioned by dropping the smaller one and counting `holes-merged` (v1; no boolean library). Top and bottom faces triangulated with earcut using `holeIndices`; walls extruded per ring (outer + every hole → `hole-wall`). z from `layers.ts`.
- **Layers** (`layers.ts`). Copper z-ladder from `BoardStackup.stackup` rows in file order: cumulative thicknesses, copper faces at their real band. If `stackup == null`: copper layers from `(layers …)` at equal nominal `0.035 mm` with dielectric spacing dividing `designThicknessMm` if present, else the ladder is emitted with `thicknessMm: null` and the substrate drawn at a NOMINAL 1.0 mm **labelled** by the `no-stackup` warning (rendered as "Layer thicknesses are not in this file"). Never `1.6` silently.
- **Copper.** Tracks → `strokes.ts` round-capped polygons (8 segments per cap full / 4 reduced), unioned by merging triangle soup (no boolean); pads → shape polygons (`rect`, `roundrect` with `roundrect_rratio`, `circle`, `oval`, `trapezoid`, `custom` anchor) placed by footprint transform (`translate(at) · rotate(rot) · [mirror y for B side]`); saved `filled_polygon`s as-is (unfilled zones counted). Rendered as thin slabs (`copperThickness` from the ladder) on their face.
- **Mask.** A face-sized slab over each outer copper layer minus pad polygons (pads are the mask openings), minus drills. Implemented as: substrate top face polygon with pad rings appended to `holes` (drops pads that overlap each other → count into `holes-merged`). Colour by theme.
- **Silk.** F/B.SilkS `fp_line/fp_arc/fp_rect/fp_circle/fp_poly/gr_*` shapes as strokes/polygons at mask z + 0.01 mm. No text items.
- **Courtyards** (`courtyards.ts`). Chain each footprint's `F.CrtYd`/`B.CrtYd` graphics like the outline; if open or absent → `no-courtyard` (draw nothing). Height estimate `h = clamp(0.35 × sqrt(area_mm²), 0.6, 12)` mm — monotone in size, capped, documented as an estimate in the caption and in code. Bodies sit on the mask of their side. Reduced quality: bodies skipped.
- **Coordinates.** Model in KiCad mm y-down; `buildScene` flips y once and centres the board on the origin so the camera framing is independent of sheet placement.

## 5. Scene, materials, interaction

- **Materials** (hex in a single `board3dTheme.ts`, read from the 2D viewer's board theme where a token exists): substrate `#2f4a2a` roughness .85; copper `#c8873a` metalness .9 roughness .35; mask `#1f6b3a` roughness .6 (green over copper, pads exposed); silk `#f2f0e6`; body `#1a1c1f` opacity .55 transparent; hole walls the substrate colour darkened 20 %.
- **Lights.** One `DirectionalLight` (intensity 2.2, from the camera's upper-left, no shadow maps) + `HemisphereLight` (.6). No environment map, no post-processing.
- **Camera.** `PerspectiveCamera` fov 35 framed to the bbox at a 35° elevation, 30° azimuth; auto-orbit at 6°/s until the first pointer/touch/wheel, then stopped for the tab's lifetime. `OrbitControls` (three/examples/jsm) with damping, min/max distance from bbox, no auto-rotate of its own. Touch: one finger orbit, two fingers zoom + pan.
- **Toolbar** (DOM, above the canvas, same styling family as the Stackup panel): `Top` · `Bottom` · `Flip` (animated 0.5 s about the board's long axis) · `Reset`. Buttons are real `<button>`s with `aria-pressed` where stateful.
- **Caption** (DOM, below the canvas, one line, `role="note"`): always "Component bodies are estimates from courtyards, not part shapes." when any body is drawn; then each warning in fixed order: `no-stackup` → "Layer thicknesses are not in this file", `outline-open` → "Board outline did not close; showing its bounding box", `zones-unfilled` → "N copper pour(s) were saved unfilled", `holes-merged`/`no-courtyard`/`arc-degenerate` → folded into a single "N features simplified" suffix.
- **Render loop.** `requestAnimationFrame` only while `(tab visible) && (auto-orbit running || controls damping active || flip animating)`; `OrbitControls`' `change` event wakes it for one frame. `visibilitychange` and the tab's `IntersectionObserver` pause it. All handles cancelled on unmount; `renderer.dispose()`, geometries and materials disposed, `WEBGL_lose_context` invoked.

## 6. Quality tiers

`quality = webgl2 && (innerWidth >= 900 && devicePixelRatio <= 2 ? 'full' : 'reduced')`, evaluated once at mount and stored in state; a module-level `setQualityOverride('full' | 'reduced' | null)` (exported for tests and for the day the owner wants "the same everywhere") wins over the heuristic. `reduced`: `renderer.setPixelRatio(1)`, no courtyard bodies, tracks narrower than 0.2 mm skipped, arc tolerance 0.05 mm, drill polygons 8-gon. `full`: pixel ratio `min(devicePixelRatio, 2)`, everything. Draw calls: one mesh per `MeshGroup` (Glasgow ≈ substrate 1 + walls 1 + copper 4 + mask 2 + silk 2 + bodies 1 = ~11).

## 7. Tab integration and lifecycle

- `type Tab` gains `'3d'`; `TAB_ID`/`PANEL_ID`/`PANEL_OF` gain the entry; the tab is offered only when `project.board != null` (same gate as Stackup) (`pages/viewer/index.tsx:25, :90-103, :308-319`).
- Mount only while `tab === '3d'` (no first-visit latch keeps it alive — D5). `useBoardScene(project, stackup, quality)` returns `{ scene, status: 'idle'|'building'|'ready'|'error', error }`; the promise cache means the second visit skips the worker.
- States: `building` → the existing skeleton style with "Building the board…" and the elapsed stats when done; `error` → plain copy + `Try again` (re-runs the worker, bypassing the cache); no WebGL2 → the same copy DesignCanvas shows (`DesignCanvas.tsx:182-200`), reused via a shared component if extraction is clean, else duplicated verbatim.
- The 2D embed stays mounted as today; its `hidden` re-assertion is untouched. The 3D canvas is a sibling panel; `.outletWrap` stacking rules unchanged.
- Keyboard: the roving tab handler needs no change; the canvas is `tabIndex=0` with arrow keys orbiting 10° per press and `Home` = Reset.

## 8. Dependencies, bundle, licence

- `npm i three earcut` + `npm i -D @types/three @types/earcut` (via Bash — the lockfile is edit-blocked by the PreToolUse hook). Versions pinned exact in `package.json`.
- `vite.config.ts` `manualChunks`: `three` (incl. `three/examples/jsm/**`) → `board3d-three`; `earcut` and `board3d/**` → `board3d`; the worker is its own Vite emitted chunk. Nothing may import `three` outside `components/kicad/board3d/**` (the boundary test above also scans for `from 'three'` outside that folder).
- Gate: after `npm run build`, the `kicanvas-*.js` chunk stays ≤ 119 KB gzip (the 2026-09-12 spec's bundle gate, `2026-09-12-design-viewer-design.md:358`; currently 113,113 B) and the entry chunk does not contain the string `THREE.WebGLRenderer`. Recorded in the plan as a checked step.
- `frontend/public/vendor/kicanvas/NOTICE.txt` gains `=== three.js — https://github.com/mrdoob/three.js — MIT ===` and `=== earcut — https://github.com/mapbox/earcut — ISC ===` in the existing block format, plus a new test `notice.test.ts` asserting every runtime dependency under `frontend/src/public/components/kicad/**` and `services/kicad/**` is named in the notice (three, earcut, and the KiCanvas entries already present).

## 9. Testing

Pure modules first (vitest, node environment):
- `arcs.test.ts` — quarter/half/full arcs from the fixtures round-trip within tolerance; collinear guard; radius-based step counts.
- `outline.test.ts` — Glasgow closes into 1 loop from 8 items; the panel closes into its loop count (85 items) with cutouts; a synthetic open outline yields `outline-open` + bbox.
- `readBoardModel.test.ts` — Glasgow: 272 footprints, 1,149 pads, 416 vias, 4,715 segments, 32 zones all filled; StickHub: 180 top-level `(arc)` tracks parsed, KiCad 9 dialect fields; complex_hierarchy: 165 THT pads all with drills; panel: 10 zones / 3 filled → `zones-unfilled: 7`.
- `layers.test.ts` — Glasgow ladder sums to `designThicknessMm` exactly as the stackup reader reports (raw IEEE sum kept, `formatMm` at display only); panel → `no-stackup` and `thicknessMm: null`.
- `courtyards.test.ts` — Glasgow 264 closed courtyards / 8 `no-courtyard`; B-side mirroring places a known part at the mirrored x.
- `tessellate.test.ts` — a square with one hole yields 8 top triangles; extrusion normals point outward; indices in range; earcut `holeIndices` exercised.
- `buildScene.test.ts` — Glasgow builds under a budget asserted loosely (≤ 1,500 ms on the CI-ish node) and reports `stats`; typed arrays are transferable (structuredClone round-trip).
- `board3dBoundary.test.ts` — the import-boundary scan (§3.2, §8).

Host (happy-dom, `// @vitest-environment happy-dom`): `Board3DView.test.ts` with a fake `createRenderer` — building/ready/error states, caption text for each warning, dispose called on unmount and on tab change, no-WebGL2 copy; `viewerPage.test.ts` gains the fifth tab and the mount-only-while-selected assertion.

Browser measurement before the tab is declared done (not automated): chrome-devtools on `/viewer` with Glasgow — draw calls (`renderer.info.render.calls` ≤ 20), fps during orbit at both tiers (≥ 50 desktop full, ≥ 30 emulated phone reduced), JS heap before/after leaving the tab (returns within 5 MB), WebGL context count (exactly one after leaving). Numbers recorded in the progress ledger and in this spec's §11.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Two live WebGL contexts blank the 2D embed | D5: dispose on exit; measured context count in §9 |
| Overriding the August "not possible" verdict | Explicit owner decision D4, recorded here; scope is bare board + estimated bodies |
| Fabricated numbers | D7 + caption + never importing the vendored default; tests assert `thicknessMm: null` for the panel |
| Convention breach | `board3dBoundary.test.ts` makes it a gate for this subsystem |
| Bundle regression | dedicated chunks + the two build greps in §8 |
| Main-thread stall | worker + slice discipline; Glasgow build time asserted |
| Degenerate arcs "board exploded" | collinear guard + warning |
| Dialect drift | four fixtures across KiCad 6/8/9 in the reader tests |
| Overlapping holes/pads without a boolean library | drop-smaller + `holes-merged` count; revisit with a polygon-clipping library if the count is visible on real boards |

## 11. Measurements (2026-09-22, Glasgow revC3 via "Try the example project", local `docker compose` frontend at `http://localhost/viewer`)

**Scene** — the hardware-independent numbers, read off `.canvasHost`'s `data-*` after the first frame:

| | desktop (1440×900, `full`) | phone (390×844, `reduced`) | target |
|---|---|---|---|
| draw calls | **9** | **8** | ≤ 20 |
| triangles | 294,094 | 182,392 | — |
| build (worker) | 765 ms | 868 ms | — |
| tab click → first frame | 1,629 ms | 1,331 ms | — |
| second visit (cached scene) | 483 ms | — | — |
| canvas | 1376×616 | 347×491 | — |
| caption | "Component bodies are estimates from courtyards, not part shapes. 8 features simplified." | none — `reduced` draws no bodies, so there is nothing to admit *(superseded by the refinement, 32d624e: "Component bodies are not drawn on this display. Select a pad to identify a part.", device-neutral since 3e8d23a)* | — |

**Teardown (spec D5)** — leaving the 3D tab for Stackup: canvases **3 → 2** (the 2D embed's two survive), `#viewer-panel-3d` and the host gone from the DOM, heap **38.8 → 38.6 MB** (Δ −0.2 MB, target ≤ 5 MB).

**Bundle** (`npm run build`, gzip -9):

| chunk | raw | gzip | gate |
|---|---|---|---|
| `kicanvas-D85sgN60.js` | 470,487 | **113,113** | ≤ 121,856 ✓ |
| `board3d-three-Cfv-oYeU.js` | 765,788 | 194,075 | own chunk, async ✓ |
| `board3d-DJt2CeNE.js` | 31,192 | 12,237 | own chunk ✓ — *superseded 2026-09-22, below* |
| `worker-CGlb2Jev.js` | 31,129 | 12,192 | own chunk ✓ |

`grep -c WebGLRenderer dist/assets/index-*.js` = **0** and `grep -c earcut …` = **0**, across all 47 entry documents. (The worker chunk is a second copy of the pure pipeline — Vite compiles a module worker as its own graph — so a visitor with a worker pays ~12 KB gz twice. Accepted.)

**Bundle after the review round (453ed5d, 2026-09-22; the `dist/` built at 14:35 that day, gzip -9 — before the eight refactor commits, which move code inside the pipeline, so the `Board3DView`/worker rows may differ by a few hundred bytes at HEAD; the fix seat's own figure for `board3d` was "7.4 KB raw, was 30 KB").** The table above measured a `board3d` chunk that was the whole pipeline folder — and Rollup had pulled the pipeline's shared deps (`services/kicad/types.ts`, `sexpr.ts`) into it, so `useBomWorkbench` and the `/bom` + `/viewer` route chunks imported it STATICALLY: earcut and the pipeline on every visit, 3D or not. `manualChunks` now names earcut alone; the pipeline splits behind the lazy `Board3DView` by itself.

| chunk | raw | gzip | note |
|---|---|---|---|
| `board3d-CLHqjTcc.js` | **7,403** | **3,161** | earcut ALONE (was 31,192 / 12,237); statically imported only by `Board3DView` (the entry names it only as that lazy import's preload dep) |
| `Board3DView-Ixtaidcp.js` | 41,906 | 16,362 | the view + the main-thread (no-worker) copy of the pipeline |
| `worker-33XznFwH.js` | 34,258 | 13,312 | the worker's own copy |
| `board3d-three-Cfv-oYeU.js` | 765,788 | 194,075 | unchanged |
| `kicanvas-D85sgN60.js` | 470,487 | 113,113 | unchanged, gate ≤ 121,856 ✓ |

**Dense and hostile boards (review round, 2026-09-22)** — synthetic boards (`buildScene.test.ts`'s `denseBoard`: a 1 mm grid of 0.3 mm vias in a plain outline), whole-build times as the fix commits report them; the "before" via series is `reduced`:

| input | before | after | fix |
|---|---|---|---|
| grid of 0.3 mm vias: 1,000 / 2,000 / 4,000 / 8,000 | 0.96 s / 4.0 s / 17.6 s / **94.8 s** | 8,000 **2.6 s**; 50,000 **4.3 s** | `FACE_HOLE_BUDGET` 1,500 holes / 40k vertices per flat face, the rest drawn as marks / raised pads and counted (67ba1b9) |
| Glasgow F.Mask (1,317 openings / 35.6k vertices) | 294,094 triangles | 294,094 triangles | inside the budget — draws exactly as before |
| 40k coincident zero-length Edge.Cuts lines (2.4 MB) | 46.8 s to chain | 0.14 s (an 8 MB file: 0.39 s) | `chainLoops` first-live-match lookup + swap-remove (660cb58) |
| an unbounded layer table (1 MB file) | ~480 MB (every `*.Cu` pad × the copper table) | refused `unreadable` | > 32 copper layers or > 128 rows (5e91ac7) |
| anything still running | endless spinner | stopped at **45 s** with "too large" | `BUILD_TIMEOUT_MS` in `useBoardScene` (1deab2c) |

**fps: NOT MEASURED.** This WSL2 host has no `/dev/dri`, so no browser on it has hardware GL: the chrome-devtools MCP browser reports `webgl2: false` outright, and Playwright's Chromium falls back to SwiftShader (`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)`). Under it the loop runs 0.75 fps desktop / 1.75 fps phone, which measures the CPU rasteriser (1,934 ms per frame at 0.85 Mpx with MSAA vs 700 ms at 0.17 Mpx without — it scales with pixels, not with our 8–9 draw calls). What the same page DOES show: with the orbit stopped the renderer sleeps and the page returns a clean 60 fps rAF cadence (91 frames / 1.5 s). The ≥ 50 / ≥ 30 fps targets need the owner's own machine.

## 12. Out of scope, with the seam left

| Later | Seam |
|---|---|
| Real component models (offline GLB per curated board) | `MeshGroup.material = 'body'` is the slot; a loader would replace courtyard groups per footprint ref |
| Silkscreen lettering | `ShapeModel` already carries text-free shapes; text lands as more shapes once a font is chosen |
| Same quality everywhere | `setQualityOverride('full')` |
| Layer toggles / cross-section | groups are per layer already |
