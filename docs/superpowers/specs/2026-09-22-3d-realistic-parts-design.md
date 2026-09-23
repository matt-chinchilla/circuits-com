# 3D parts that look like parts — design

**Date:** 2026-09-22 · **Branch:** `updates` (base 58584d2) · **Backend:** none · **Owner ask (23:04):** "can you add the more realistic textures to the 3d-boxes?" (after 18:03: a beginner clicking J5 "will just be seeing a 3d box and not something that appears like anything at all").

## 1. What changes
1. **Bodies come from the footprint's Fab outline** (`F.Fab`/`B.Fab`: KiCad's library convention draws the physical package body there), falling back to the courtyard when a footprint has no closed Fab loop. The courtyard includes clearance, so today's boxes are too big and cover the pads; the Fab outline is the package.
2. **Pins and terminals, from the real pads** (one new material `lead`, ONE mesh for the whole board):
   - chip passives (family `passive`, 2 pads): metallic **end terminations** = each pad rectangle intersected with the body rectangle, extruded to the body height + 0.005 mm, so the ends of the chip read as metal;
   - SMD pads of ICs and connectors that lie OUTSIDE the body outline: a flat **foot** (pad rectangle, 0.12 mm tall) plus a **shoulder** from the foot's inner edge to the body wall at 40 % of the body height (gull-wing read);
   - through-hole pads (`thru_hole`): a square **post** of side `0.64 × drill` (min 0.3 mm) rising from the mask to the body top + 2.0 mm for connectors, + 0.3 mm otherwise (estimated, like every height);
   - pads under the body (QFN/BGA) draw nothing extra.
3. **Pin-1 mark:** an IC whose pad "1" exists gets a small dimple disc (8 segments, r = 0.12 × min(body w,h), clamped 0.15–0.6 mm) on its top face in the corner nearest pad 1, drawn in the body group with a darker tint.
4. **Surface texture, procedural, no assets:** one 256×256 value-noise canvas generated once per mount → `CanvasTexture` used as `roughnessMap` + `bumpMap` (tiny `bumpScale`) on the opaque body material (moulded epoxy / plastic grain), and a finer brushed variant on `lead`. Needs **UVs** on the body and lead groups (planar: top/bottom faces `uv = xy / 2 mm`; walls `uv = (distance along the ring, z) / 2 mm`).
5. **Tints:** leads per family — connectors gold `#d4a93b`, everything else tin `#c9cdd1` — as vertex colours like the bodies (one material). Passive bodies: capacitors tan `#b48a56`, resistors near-black `#1d1d1f` with the terminations giving the read, inductors grey; the classifier stays `partFamily.ts` (add a `passiveKind(lib, ref)` helper: `C|Capacitor → cap`, `R|Resistor → res`, `L|Inductor|Ferrite → ind`).
6. **Honesty:** the caption becomes "Component bodies are drawn from each footprint's outline and pads; their heights are estimates." — and "…from courtyards…" wording when a board has no Fab outlines at all. The callout keeps its "estimated body" tag. No fabricated numbers anywhere in the UI.

## 2. Interfaces (binding for the parallel seats)
```ts
// services/kicad/board3d/types.ts
export type Material = 'substrate' | 'copper' | 'mask' | 'silk' | 'body' | 'hole-wall' | 'lead';
// MeshGroup gains:  uvs?: Float32Array            (body + lead groups only; 2 floats per vertex)
// PartRange.family is set on BOTH the body and the lead group (same PartFamily union)
// PartRange gains:  passive?: 'cap' | 'res' | 'ind'   (body + lead groups, passives only)
// FootprintModel gains:  fab: Shape[]           (footprint-local, like courtyard/silk)
// Courtyard (courtyards.ts) gains:  source: 'fab' | 'courtyard'
// BoardScene.stats gains:  bodiesFromFab: number
```
The `lead` group: `layerName: null`, `parts` ranges per ref (so pick + highlight light a part's pins with its body), `uvs` present. Transferable (typed arrays) like every group. Quality `reduced` draws no bodies and no leads (unchanged rule).

## 3. Rules
No asset files, no network, no fonts; `board3dBoundary.test.ts` greps comments too (no vendored path, `document.`/`window.`/`fetch(` in prose under `services/kicad/board3d/`); three only in `sceneRenderer.ts` via dynamic import; draw calls may rise by at most 2 on Glasgow (was 11); triangles may rise by at most +40 %; build time on Glasgow ≤ 1.5 s in the node test; the on-demand render loop unchanged; dispose() releases the textures; TS strict; small commits; NO attribution trailers.

## 4. Tests
Pipeline: Glasgow `bodiesFromFab` > 200 of 264; J5 (`PinHeader_2x22_P1.27mm_Vertical_SMD`) has 44 lead feet; a C_0402's two terminations lie inside its body rect and on its pad sides; every lead/body index in range; uv length = 2/3 of positions length; pin-1 disc exists on U-refs with a pad "1". Renderer: material/texture creation and disposal through a pure helper + the fake-renderer host tests; legend lists "Pins and terminals".
