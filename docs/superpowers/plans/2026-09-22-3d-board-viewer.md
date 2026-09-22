# 3D Board Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fifth tab on `/viewer`, **3D**, that renders the dropped KiCad board as an orbitable 3D model built entirely in the browser from the file's own geometry and stackup, with estimated translucent component bodies.

**Architecture:** A pure, DOM-free geometry pipeline under `frontend/src/public/services/kicad/board3d/` turns the board text (already in the design session) into a `BoardScene` of merged typed-array mesh groups, running in a Web Worker with a same-thread fallback. A React host under `frontend/src/public/components/kicad/board3d/` lazy-loads three.js, renders the groups as one mesh per (material, layer), and disposes everything on tab exit. The viewer page mounts the host only while the 3D tab is selected.

**Tech Stack:** TypeScript strict, React 19, Vite (worker via `new URL(…, import.meta.url)`), vitest (node for pure modules, happy-dom for the host), three `0.186.0` (+ `@types/three`), earcut `3.2.3`.

**Spec:** `docs/superpowers/specs/2026-09-21-3d-board-viewer-design.md` (read it first; §4 geometry rules and §5 scene rules are binding). Context map with citations: `.superpowers/sdd/2026-09-21-3d-board-viewer/context-map.md`.

## Global Constraints

- **No import of `frontend/vendor/kicanvas/**`, `@vendor-build/*`, or `kicanvasController` anywhere under `board3d/`.** The board text comes from `session.project.files.get(session.project.board)`. (Spec D4, §3.2.)
- **No fabricated measurements.** Never default board thickness to 1.6; a board without a `(setup (stackup …))` block yields `thicknessMm: null` and the `no-stackup` warning. Component heights are estimates and are captioned as such. (Spec D7.)
- **No network request derived from the design.** `(model …)` paths are never fetched or logged. `board3d/**` contains no `fetch(`. (Spec §2, §10.)
- **`three` is imported ONLY under `frontend/src/public/components/kicad/board3d/`**, always via dynamic `import()` from the host so it lands in the `board3d-three` chunk. `earcut` is imported only under `services/kicad/board3d/`.
- **Bundle gate:** after `npm run build`, `dist/assets/kicanvas-*.js` stays ≤ 119 KB gzip and `dist/assets/index-*.js` contains neither `WebGLRenderer` nor `earcut`.
- **Tab lifecycle:** the 3D host is mounted only while `tab === '3d'` and disposes its renderer, geometries, materials and WebGL context on unmount. The 2D `<kicanvas-embed>` and its `hidden` handling are untouched. (Spec D5, §7.)
- **Quality:** exactly one setting, `'full' | 'reduced'`, decided once at mount (`webgl2 && innerWidth >= 900 && devicePixelRatio <= 2 ? 'full' : 'reduced'`), overridable by `setQualityOverride`. Nothing else branches on device. (Spec D3, §6.)
- **Copy (verbatim):** caption "Component bodies are estimates from courtyards, not part shapes." · "Layer thicknesses are not in this file" · "Board outline did not close; showing its bounding box" · "N copper pour(s) were saved unfilled" · "N features simplified". Privacy sentence on the page stays "your design files never leave your browser".
- **Coordinates:** KiCad mm, y-down in the model; `buildScene` flips y once and centres on the origin.
- **Process (owner, 2026-09-22):** NO per-task code review. Each task: tests first, gates (`cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npx vitest run <the task's test files>`), commit on `updates` with NO attribution trailers, push. One general review after the whole plan is done.
- **Style:** TS strict (no unused vars, no `_` prefixes), SCSS modules with camelCase classes, non-ASCII glyphs in JSX via entities or `{'…'}`. `package-lock.json` is edit-blocked by a hook — install with `npm i`, never hand-edit.

## File map

```
frontend/src/public/services/kicad/board3d/
  types.ts            BoardModel, BoardScene, MeshGroup, warnings, Vec2/Ring/PolygonWithHoles      (T1)
  geom.ts             vec helpers: add/sub/scale/len/dist/cross, transform (rotate/translate/mirror)  (T1)
  arcs.ts             threePointArc → {c, r, a0, sweep}; flattenArc(tolMm)                          (T1)
  outline.ts          chainLoops(segments) → { loops, unchained }; boardOutline(items, bbox)        (T2)
  strokes.ts          strokePolygon(polyline, width, capSegments) → Ring                            (T3)
  readBoardModel.ts   text → BoardModel (KiCad 6/8/9 dialects)                                     (T4)
  courtyards.ts       footprint → placed courtyard Ring + estimateHeightMm(areaMm2)                 (T5)
  layers.ts           (layers) × BoardStackup → ZLadder (z per layer, thicknessMm | null, warning)  (T6)
  tessellate.ts       triangulate(PolygonWithHoles), extrudeRings, MeshBuilder (positions/normals/indices)  (T7)
  buildScene.ts       BoardModel + BoardStackup|null + quality → BoardScene                         (T8)
  worker.ts           onmessage → buildScene → postMessage(scene, transfer)                         (T8)
  board3dBoundary.test.ts  import-boundary scan                                                     (T0)
frontend/src/public/components/kicad/board3d/
  board3dTheme.ts     material colours + light settings                                              (T9)
  quality.ts          decideQuality(), setQualityOverride()                                          (T9)
  useBoardScene.ts    worker plumbing, per-project cache, status                                     (T8)
  sceneRenderer.ts    BoardScene → three meshes/controls/loop; dispose()                             (T9)
  Board3DView.tsx     host: states, toolbar, caption; createRenderer seam                            (T9)
  Board3DView.module.scss                                                                            (T9)
  notice.test.ts      NOTICE.txt names three + earcut                                                (T0)
frontend/src/public/pages/viewer/index.tsx   fifth tab                                               (T10)
frontend/vite.config.ts                       manualChunks: board3d-three, board3d                   (T0)
frontend/public/vendor/kicanvas/NOTICE.txt    two new blocks                                         (T0)
docs/claude-gotchas/design-viewer.md, CLAUDE.md, spec §11                                            (T11)
```

Fixtures (read with `fixtureText`): `glasgow-revC3/glasgow.kicad_pcb` (KiCad 6, 4 Cu, stackup, 272 fp / 1,149 pads / 416 vias / 4,715 segments / 32 zones filled / 8 Edge.Cuts), `kicad-demos/stickhub/StickHub.kicad_pcb` (KiCad 9, 2 Cu, stackup, 180 top-level `(arc)` tracks, `(property "Reference" …)`, `(hide yes)`, `(uuid …)`, one `connect custom` pad), `kicad-demos/complex_hierarchy/complex_hierarchy.kicad_pcb` (KiCad 8/9, 165 THT pads), `bad-thing-panel/panel.kicad_pcb` (KiCad 9, NO stackup, 10 zones / 3 filled, 85 Edge.Cuts items).

---

### Task 0: Dependencies, chunking, notice, boundary test

**Files:**
- Modify: `frontend/package.json` (via `npm i`), `frontend/vite.config.ts:158-181` (manualChunks), `frontend/public/vendor/kicanvas/NOTICE.txt`
- Create: `frontend/src/public/components/kicad/board3d/notice.test.ts`, `frontend/src/public/services/kicad/board3d/board3dBoundary.test.ts`, `frontend/src/public/services/kicad/board3d/types.ts` (empty export placeholder is NOT allowed — Task 1 creates it; this task creates only the two tests and they must pass against an empty folder)

**Interfaces:** Produces the chunk names `board3d-three` and `board3d` that Task 9/11 verify.

- [ ] **Step 1: Install**

```bash
cd frontend && npm i three@0.186.0 earcut@3.2.3 && npm i -D @types/three@0.186.0
node -e "const p=require('./node_modules/earcut/package.json');console.log(p.version, p.types||p.typings||'NO TYPES')"
```
If the last line prints `NO TYPES`, also `npm i -D @types/earcut@3.0.0`.

- [ ] **Step 2: Chunking** — in `frontend/vite.config.ts` `manualChunks(id)`, add BEFORE the `return undefined`:

```ts
          // three.js + its examples (OrbitControls) — only the lazy 3D tab on
          // /viewer imports it (spec 2026-09-21 §8). Must never join `kicanvas`
          // (6 KB of headroom against its 119 KB gzip gate) nor the entry.
          if (id.includes('node_modules/three/')) {
            return 'board3d-three'
          }
          if (id.includes('node_modules/earcut/') || id.includes('/services/kicad/board3d/')) {
            return 'board3d'
          }
```

- [ ] **Step 3: NOTICE** — append to `frontend/public/vendor/kicanvas/NOTICE.txt`, matching the existing `=== name — url — licence ===` block style:

```
=== three.js (3D board tab on /viewer) — https://github.com/mrdoob/three.js — MIT License ===

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

=== earcut (3D board tab, imported from npm — a second copy of the library the KiCanvas build already bundles) — https://github.com/mapbox/earcut — ISC License ===

Copyright (c) 2016, Mapbox. Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```
Copy the exact licence text from `node_modules/three/LICENSE` and `node_modules/earcut/LICENSE` rather than the paraphrase above if they differ.

- [ ] **Step 4: notice test** — `frontend/src/public/components/kicad/board3d/notice.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Nothing else tests NOTICE.txt (context map §2). Every runtime dependency the
// viewer ships must be named in it, in the existing `=== name — url — licence ===` form.
const NOTICE = readFileSync(join(__dirname, '../../../../../public/vendor/kicanvas/NOTICE.txt'), 'utf8');

describe('the viewer notice file', () => {
  it.each([
    ['three.js', 'https://github.com/mrdoob/three.js', 'MIT'],
    ['earcut', 'https://github.com/mapbox/earcut', 'ISC'],
    ['KiCanvas', 'https://github.com/theacodes/kicanvas', 'MIT'],
  ])('names %s with its url and licence', (name, url, licence) => {
    const block = NOTICE.split('\n').find((l) => l.startsWith('=== ') && l.includes(name));
    expect(block, `${name} block`).toBeDefined();
    expect(block).toContain(url);
    expect(NOTICE.slice(NOTICE.indexOf(block!))).toContain(licence);
  });
});
```

- [ ] **Step 5: boundary test** — `frontend/src/public/services/kicad/board3d/board3dBoundary.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Spec 2026-09-21 §3.2 / §8: the convention "only kicanvasController touches
// KiCanvas" is a GATE for this subsystem, and three.js may only be imported
// under components/kicad/board3d. This scan is the enforcement.
const SERVICE = __dirname;
const HOST = join(__dirname, '../../../components/kicad/board3d');
const PUBLIC = join(__dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('board3d import boundary', () => {
  it('the pure pipeline never touches KiCanvas, three, the DOM or the network', () => {
    for (const file of walk(SERVICE)) {
      const src = readFileSync(file, 'utf8');
      for (const bad of ['vendor/kicanvas', '@vendor-build', 'kicanvasController', "from 'three", 'document.', 'window.', 'fetch(']) {
        expect(src, `${file} contains ${bad}`).not.toContain(bad);
      }
    }
  });
  it('the host never touches KiCanvas or the network', () => {
    for (const file of walk(HOST)) {
      const src = readFileSync(file, 'utf8');
      for (const bad of ['vendor/kicanvas', '@vendor-build', 'kicanvasController', 'fetch(']) {
        expect(src, `${file} contains ${bad}`).not.toContain(bad);
      }
    }
  });
  it('three is imported nowhere else under src/public', () => {
    for (const file of walk(PUBLIC)) {
      if (file.startsWith(HOST)) continue;
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/from ['"]three/);
    }
  });
});
```
(`walk` on a missing directory throws — create `HOST` and `SERVICE` folders with the two test files in them, so both exist from this task on.)

- [ ] **Step 6: Gates + commit**

```bash
cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npx vitest run src/public/components/kicad/board3d src/public/services/kicad/board3d
cd .. && git add frontend/package.json frontend/package-lock.json frontend/vite.config.ts frontend/public/vendor/kicanvas/NOTICE.txt frontend/src/public/components/kicad/board3d frontend/src/public/services/kicad/board3d
git commit -m "build(viewer): three + earcut in their own chunks, noticed, with the board3d import boundary as a test" && git push origin updates
```

---

### Task 1: Types, vector helpers, arcs

**Files:**
- Create: `frontend/src/public/services/kicad/board3d/types.ts`, `geom.ts`, `arcs.ts`
- Test: `frontend/src/public/services/kicad/board3d/arcs.test.ts`, `geom.test.ts`

**Interfaces (produces):**

```ts
// types.ts — copy verbatim; later tasks import these names.
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
```

```ts
// geom.ts
export const v = (x: number, y: number): Vec2 => ({ x, y });
export function add(a: Vec2, b: Vec2): Vec2; export function sub(a: Vec2, b: Vec2): Vec2; export function scale(a: Vec2, k: number): Vec2;
export function len(a: Vec2): number; export function dist(a: Vec2, b: Vec2): number; export function cross(a: Vec2, b: Vec2): number;
export function rotate(p: Vec2, deg: number): Vec2;            // KiCad: positive = counter-clockwise on screen (y-down) → x' = x cos − y sin? NO — see below
export function place(p: Vec2, pl: Placement): Vec2;           // footprint-local → board: mirror y for side 'B', rotate by rotDeg, translate by at
export function signedArea(pts: Vec2[]): number;               // shoelace; y-down means CW loops have POSITIVE area — callers use |area| and orient explicitly
export function bbox(pts: Vec2[]): { min: Vec2; max: Vec2 };
```
KiCad rotation convention (verified against the vendored painter's `Matrix3.rotate_self(deg_to_rad(rot))` recipe and pcbnew): with y pointing DOWN, a positive footprint angle rotates the part COUNTER-clockwise as seen on screen, which in y-down maths is `x' = x·cos θ + y·sin θ`, `y' = −x·sin θ + y·cos θ` with θ = rotDeg in radians. `place` = (side B ? mirror `y → −y` : id) → rotate → add `at`. The test below pins the sign with a known Glasgow pad; if it fails, flip the sign in ONE place (`rotate`) and never elsewhere.

```ts
// arcs.ts
export interface ArcParams { c: Vec2; r: number; a0: number; sweep: number }   // radians; sweep signed
/** null when the three points are (near) collinear: |cross(mid−a, b−a)| < 1e-6 · |b−a|² */
export function threePointArc(a: Vec2, mid: Vec2, b: Vec2): ArcParams | null;
/** polyline from a to b (inclusive) with angular step clamp(acos(1 − tol/r), 2°, 15°). For r ≤ tol returns [a, b]. */
export function flattenArc(arc: ArcParams, tolMm: number): Vec2[];
export function flattenThreePoint(a: Vec2, mid: Vec2, b: Vec2, tolMm: number): { pts: Vec2[]; degenerate: boolean };
```

- [ ] **Step 1: tests** — `arcs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { flattenArc, flattenThreePoint, threePointArc } from './arcs';

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

describe('threePointArc', () => {
  it('solves a quarter circle (the Glasgow silk arc at 51.5,111 → 51,110.5)', () => {
    const arc = threePointArc({ x: 51.5, y: 111 }, { x: 51.146447, y: 110.853553 }, { x: 51, y: 110.5 })!;
    expect(close(arc.c.x, 51.5, 1e-4)).toBe(true);
    expect(close(arc.c.y, 110.5, 1e-4)).toBe(true);
    expect(close(arc.r, 0.5, 1e-4)).toBe(true);
    expect(close(Math.abs(arc.sweep), Math.PI / 2, 1e-3)).toBe(true);
  });
  it('returns null for collinear points', () => {
    expect(threePointArc({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 })).toBeNull();
    expect(threePointArc({ x: 0, y: 0 }, { x: 1, y: 1e-9 }, { x: 2, y: 0 })).toBeNull();
  });
  it('picks the sweep that passes THROUGH mid, not the complementary arc', () => {
    // 270° arc: a=(1,0), mid=(-1,0) via the bottom, b=(0,1)
    const arc = threePointArc({ x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 })!;
    expect(close(Math.abs(arc.sweep), (3 * Math.PI) / 2, 1e-6)).toBe(true);
  });
});

describe('flattenArc', () => {
  it('starts at a, ends at b, and every point is on the circle', () => {
    const a = { x: 1, y: 0 }, mid = { x: 0, y: 1 }, b = { x: -1, y: 0 };
    const { pts, degenerate } = flattenThreePoint(a, mid, b, 0.01);
    expect(degenerate).toBe(false);
    expect(pts[0]).toEqual(a);
    expect(pts[pts.length - 1]).toEqual(b);
    for (const p of pts) expect(close(Math.hypot(p.x, p.y), 1, 1e-9)).toBe(true);
    // step = clamp(acos(1 − 0.01/1), 2°, 15°) = 8.1° → 180/8.1 ≈ 22 segments (+1 point)
    expect(pts.length).toBeGreaterThan(20);
    expect(pts.length).toBeLessThan(26);
  });
  it('coarser tolerance means fewer points, never fewer than the 15° floor implies', () => {
    const arc = threePointArc({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 })!;
    expect(flattenArc(arc, 0.05).length).toBeLessThan(flattenArc(arc, 0.01).length);
    expect(flattenArc(arc, 10).length).toBe(13); // 180° / 15° = 12 segments
  });
  it('a degenerate arc flattens to its chord and says so', () => {
    const r = flattenThreePoint({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, 0.01);
    expect(r.degenerate).toBe(true);
    expect(r.pts).toEqual([{ x: 0, y: 0 }, { x: 2, y: 0 }]);
  });
});
```

`geom.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { bbox, place, rotate, signedArea } from './geom';

describe('geom', () => {
  it('rotate follows KiCad: +90° turns +x into −y on the y-down page', () => {
    const p = rotate({ x: 1, y: 0 }, 90);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(-1, 9);
  });
  it('place: Glasgow C(0402) at (127, 107.6, 90) puts pad 1 at (−0.485, 0) → (127, 108.085)', () => {
    // pad "1" (at -0.485 0 90) inside footprint (at 127 107.6 90): the pad's own
    // rotation is absolute in KiCad 6 files; only the OFFSET is rotated by the footprint.
    const p = place({ x: -0.485, y: 0 }, { at: { x: 127, y: 107.6 }, rotDeg: 90, side: 'F' });
    expect(p.x).toBeCloseTo(127, 6);
    expect(p.y).toBeCloseTo(108.085, 6);
  });
  it('place on the back mirrors y before rotating', () => {
    const p = place({ x: 1, y: 2 }, { at: { x: 0, y: 0 }, rotDeg: 0, side: 'B' });
    expect(p).toEqual({ x: 1, y: -2 });
  });
  it('signedArea and bbox', () => {
    expect(Math.abs(signedArea([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 }]))).toBeCloseTo(2);
    expect(bbox([{ x: 3, y: -1 }, { x: -2, y: 5 }])).toEqual({ min: { x: -2, y: -1 }, max: { x: 3, y: 5 } });
  });
});
```
Verify the pad-1 expectation against the file before trusting it: in `glasgow.kicad_pcb` the fifth `(footprint` block is `Capacitor_SMD:C_0402_1005Metric (at 127 107.6 90)` and its `(pad "1" … (at -0.485 0 90)`; KiCanvas draws that pad centred at (127, 108.085) — confirm by rendering the board on /viewer and hovering, or by the vendored recipe `Matrix3.translation(x, y).rotate_self(deg_to_rad(rot))` applied to (−0.485, 0) with rot = 90 in y-down space. If the file's placement disagrees, correct the expected NUMBERS in the test to the file's truth, not the sign convention in `rotate`.

- [ ] **Step 2: run, expect failures (modules missing)**: `npx vitest run src/public/services/kicad/board3d/arcs.test.ts src/public/services/kicad/board3d/geom.test.ts`

- [ ] **Step 3: implement** `types.ts` (verbatim above), `geom.ts`:

```ts
import type { Placement, Vec2 } from './types';
export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
/** KiCad rotation on the y-down page: positive angles turn counter-clockwise as seen on screen. */
export function rotate(p: Vec2, deg: number): Vec2 {
  if (deg === 0) return { x: p.x, y: p.y };
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return { x: p.x * c + p.y * s, y: -p.x * s + p.y * c };
}
export function place(p: Vec2, pl: Placement): Vec2 {
  const m = pl.side === 'B' ? { x: p.x, y: -p.y } : p;
  return add(rotate(m, pl.rotDeg), pl.at);
}
export function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}
export function bbox(pts: Vec2[]): { min: Vec2; max: Vec2 } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}
```

`arcs.ts`:

```ts
import { cross, sub } from './geom';
import type { Vec2 } from './types';
export interface ArcParams { c: Vec2; r: number; a0: number; sweep: number }
const DEG = Math.PI / 180;

export function threePointArc(a: Vec2, mid: Vec2, b: Vec2): ArcParams | null {
  const ab = sub(b, a), am = sub(mid, a);
  const chord2 = ab.x * ab.x + ab.y * ab.y;
  const cr = cross(am, ab);
  if (chord2 === 0 || Math.abs(cr) < 1e-6 * chord2) return null;
  // circumcentre via perpendicular bisectors
  const bx = b.x - a.x, by = b.y - a.y, mx = mid.x - a.x, my = mid.y - a.y;
  const d = 2 * (mx * by - my * bx);
  if (Math.abs(d) < 1e-12) return null;
  const m2 = mx * mx + my * my, b2 = bx * bx + by * by;
  const ux = (by * m2 - my * b2) / d, uy = (mx * b2 - bx * m2) / d;
  const c = { x: a.x + ux, y: a.y + uy };
  const r = Math.hypot(ux, uy);
  const a0 = Math.atan2(a.y - c.y, a.x - c.x);
  const aM = Math.atan2(mid.y - c.y, mid.x - c.x);
  const a1 = Math.atan2(b.y - c.y, b.x - c.x);
  // choose the sweep direction that passes through mid
  const ccw = (from: number, to: number) => { let s = to - from; while (s < 0) s += 2 * Math.PI; return s; };
  const sCcw = ccw(a0, a1), mCcw = ccw(a0, aM);
  const sweep = mCcw <= sCcw ? sCcw : -(2 * Math.PI - sCcw);
  return { c, r, a0, sweep };
}

export function flattenArc(arc: ArcParams, tolMm: number): Vec2[] {
  const { c, r, a0, sweep } = arc;
  if (r <= tolMm) return [{ x: c.x + r * Math.cos(a0), y: c.y + r * Math.sin(a0) }, { x: c.x + r * Math.cos(a0 + sweep), y: c.y + r * Math.sin(a0 + sweep) }];
  const step = Math.min(15 * DEG, Math.max(2 * DEG, Math.acos(Math.max(-1, 1 - tolMm / r))));
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / step));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) { const t = a0 + (sweep * i) / n; pts.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) }); }
  return pts;
}

export function flattenThreePoint(a: Vec2, mid: Vec2, b: Vec2, tolMm: number): { pts: Vec2[]; degenerate: boolean } {
  const arc = threePointArc(a, mid, b);
  if (arc == null) return { pts: [a, b], degenerate: true };
  const pts = flattenArc(arc, tolMm);
  pts[0] = a; pts[pts.length - 1] = b;   // exact endpoints, so chaining snaps
  return { pts, degenerate: false };
}
```
(Import only `cross` and `sub` from `./geom` — TS strict forbids unused imports.)

- [ ] **Step 4: run tests → PASS**; then gates; commit `feat(board3d): types, vector helpers and three-point arcs` and push.

---

### Task 2: Outline chaining

**Files:** Create `outline.ts`, `outline.test.ts`.

**Interfaces:**

```ts
// outline.ts
import type { Ring, Shape, Vec2 } from './types';
export interface Chained { loops: Ring[]; unchained: number }
/** Chain open polylines end-to-end (1 µm snap) into closed loops. Closed inputs (first==last within snap) become loops directly. */
export function chainLoops(polylines: Vec2[][], snapMm?: number): Chained;      // snap default 0.001
/** Edge.Cuts → outer + cutouts. Circles/rects/closed polys are loops already; lines/arcs (flattened at tolMm) are chained. */
export function boardOutline(edgeItems: Shape[], tolMm: number): { outer: Ring; cutouts: Ring[]; open: boolean; unchained: number; degenerateArcs: number };
```
Rules: orient `outer` counter-clockwise in y-DOWN coordinates (i.e. `signedArea < 0` … pick ONE and document: **outer has `signedArea(pts) < 0`, holes `> 0`** — the tessellator (Task 7) will consume this convention). Largest |area| loop = outer. If `unchained > 0` or no loop → `open: true`, `outer` = axis-aligned bbox of all edge points (4 corners), `cutouts: []`.

- [ ] **Step 1: tests** — `outline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { boardOutline, chainLoops } from './outline';
import { signedArea } from './geom';
import type { Shape } from './types';

const L = (x1: number, y1: number, x2: number, y2: number): Shape => ({ kind: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, width: 0.1 });

describe('chainLoops', () => {
  it('chains four unordered, mixed-direction segments into one square', () => {
    const r = chainLoops([
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [{ x: 10, y: 10 }, { x: 0, y: 10 }],
      [{ x: 10, y: 0 }, { x: 10, y: 10 }],
      [{ x: 0, y: 0 }, { x: 0, y: 10 }],   // reversed relative to the loop
    ]);
    expect(r.unchained).toBe(0);
    expect(r.loops).toHaveLength(1);
    expect(r.loops[0].pts).toHaveLength(4);
  });
  it('snaps endpoints within 1 µm and reports an unchained segment', () => {
    const r = chainLoops([
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [{ x: 10.0000004, y: 0 }, { x: 10, y: 10 }],
      [{ x: 10, y: 10 }, { x: 0, y: 10 }],
      [{ x: 0, y: 10 }, { x: 0, y: 0 }],
      [{ x: 50, y: 50 }, { x: 60, y: 60 }],
    ]);
    expect(r.loops).toHaveLength(1);
    expect(r.unchained).toBe(1);
  });
});

describe('boardOutline', () => {
  it('largest loop is the board, the rest are cutouts, orientations fixed', () => {
    const items: Shape[] = [
      L(0, 0, 100, 0), L(100, 0, 100, 50), L(100, 50, 0, 50), L(0, 50, 0, 0),
      { kind: 'circle', c: { x: 20, y: 20 }, r: 3, width: 0.1, filled: false },
      { kind: 'rect', a: { x: 60, y: 10 }, b: { x: 70, y: 20 }, width: 0.1, filled: false },
    ];
    const o = boardOutline(items, 0.01);
    expect(o.open).toBe(false);
    expect(Math.abs(signedArea(o.outer.pts))).toBeCloseTo(5000, 6);
    expect(o.cutouts).toHaveLength(2);
    expect(signedArea(o.outer.pts)).toBeLessThan(0);
    for (const c of o.cutouts) expect(signedArea(c.pts)).toBeGreaterThan(0);
  });
  it('an arc corner is flattened and still closes', () => {
    const items: Shape[] = [
      L(5, 0, 100, 0), L(100, 0, 100, 50), L(100, 50, 0, 50), L(0, 50, 0, 5),
      { kind: 'arc', a: { x: 0, y: 5 }, mid: { x: 5 - 5 * Math.SQRT1_2, y: 5 - 5 * Math.SQRT1_2 }, b: { x: 5, y: 0 }, width: 0.1 },
    ];
    const o = boardOutline(items, 0.01);
    expect(o.open).toBe(false);
    expect(o.outer.pts.length).toBeGreaterThan(8);
  });
  it('an open outline falls back to the bounding box and says so', () => {
    const o = boardOutline([L(0, 0, 100, 0), L(100, 0, 100, 50), L(100, 50, 0, 50)], 0.01);
    expect(o.open).toBe(true);
    expect(o.unchained).toBe(3);
    expect(o.outer.pts).toHaveLength(4);
    expect(Math.abs(signedArea(o.outer.pts))).toBeCloseTo(5000, 6);
  });
});
```

- [ ] **Step 2: run → fail.**  **Step 3: implement** `outline.ts`:

```ts
import { flattenThreePoint } from './arcs';
import { bbox, signedArea } from './geom';
import type { Ring, Shape, Vec2 } from './types';

export interface Chained { loops: Ring[]; unchained: number }

const key = (p: Vec2, snap: number) => `${Math.round(p.x / snap)}|${Math.round(p.y / snap)}`;

export function chainLoops(polylines: Vec2[][], snapMm = 0.001): Chained {
  const loops: Ring[] = [];
  const open: Vec2[][] = [];
  for (const pl of polylines) {
    if (pl.length < 2) continue;
    const first = pl[0], last = pl[pl.length - 1];
    if (pl.length >= 3 && key(first, snapMm) === key(last, snapMm)) loops.push({ pts: pl.slice(0, -1) });
    else open.push(pl);
  }
  // endpoint index: key → list of [polylineIndex, end(0|1)]
  const used = new Array<boolean>(open.length).fill(false);
  const index = new Map<string, [number, 0 | 1][]>();
  open.forEach((pl, i) => {
    for (const e of [0, 1] as const) {
      const k = key(e === 0 ? pl[0] : pl[pl.length - 1], snapMm);
      const arr = index.get(k) ?? []; arr.push([i, e]); index.set(k, arr);
    }
  });
  let unchained = 0;
  for (let s = 0; s < open.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    let consumed = 1;
    const chain: Vec2[] = [...open[s]];
    const startKey = key(chain[0], snapMm);
    let closed = false;
    for (let guard = 0; guard < open.length; guard++) {
      const tail = chain[chain.length - 1];
      if (key(tail, snapMm) === startKey && chain.length > 2) { closed = true; break; }
      const cands = (index.get(key(tail, snapMm)) ?? []).filter(([i]) => !used[i]);
      if (cands.length === 0) break;
      const [i, e] = cands[0];
      used[i] = true; consumed++;
      const next = e === 0 ? open[i] : [...open[i]].reverse();
      chain.push(...next.slice(1));
    }
    if (closed) loops.push({ pts: chain.slice(0, -1) });
    else unchained += consumed;
  }
  return { loops, unchained };
}
```

```ts
export function boardOutline(edgeItems: Shape[], tolMm: number) {
  const polylines: Vec2[][] = [];
  let degenerateArcs = 0;
  for (const s of edgeItems) {
    if (s.kind === 'line') polylines.push([s.a, s.b]);
    else if (s.kind === 'arc') { const r = flattenThreePoint(s.a, s.mid, s.b, tolMm); if (r.degenerate) degenerateArcs++; polylines.push(r.pts); }
    else if (s.kind === 'circle') { const n = Math.max(16, Math.ceil((2 * Math.PI) / Math.max(2 * Math.PI / 180, Math.acos(Math.max(-1, 1 - tolMm / s.r))))); const pts: Vec2[] = []; for (let i = 0; i < n; i++) { const t = (2 * Math.PI * i) / n; pts.push({ x: s.c.x + s.r * Math.cos(t), y: s.c.y + s.r * Math.sin(t) }); } pts.push(pts[0]); polylines.push(pts); }
    else if (s.kind === 'rect') polylines.push([s.a, { x: s.b.x, y: s.a.y }, s.b, { x: s.a.x, y: s.b.y }, s.a]);
    else if (s.kind === 'poly' && s.pts.length >= 3) polylines.push([...s.pts, s.pts[0]]);
  }
  const chained = chainLoops(polylines);
  const all = polylines.flat();
  if (chained.loops.length === 0 || chained.unchained > 0) {
    const b = bbox(all.length ? all : [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    const outer: Ring = { pts: orient([{ x: b.min.x, y: b.min.y }, { x: b.max.x, y: b.min.y }, { x: b.max.x, y: b.max.y }, { x: b.min.x, y: b.max.y }], 'outer') };
    return { outer, cutouts: [], open: true, unchained: chained.unchained || polylines.length, degenerateArcs };
  }
  const sorted = [...chained.loops].sort((p, q) => Math.abs(signedArea(q.pts)) - Math.abs(signedArea(p.pts)));
  const outer: Ring = { pts: orient(sorted[0].pts, 'outer') };
  const cutouts = sorted.slice(1).map((l) => ({ pts: orient(l.pts, 'hole') }));
  return { outer, cutouts, open: false, unchained: 0, degenerateArcs };
}
/** Outer loops carry signedArea < 0, holes > 0 (y-down convention used by tessellate.ts). */
export function orient(pts: Vec2[], as: 'outer' | 'hole'): Vec2[] {
  const a = signedArea(pts);
  const want = as === 'outer' ? a < 0 : a > 0;
  return want ? pts : [...pts].reverse();
}
```
Note for the open-outline case: the test expects `unchained` = 3 for three loose segments; make `chainLoops` report each input polyline that ended up in a non-closing chain (the counter version), and `boardOutline` returns `chained.unchained` when it is > 0, else `polylines.length` (no loop at all).

- [ ] **Step 4: run → PASS; gates; commit `feat(board3d): chain Edge.Cuts into a board outline with cutouts` ; push.**

---

### Task 3: Stroke outlines and pad shapes

**Files:** Create `strokes.ts`, `pads.ts`; tests `strokes.test.ts`, `pads.test.ts`.

**Interfaces:**

```ts
// strokes.ts
/** Polyline (≥2 distinct points) with width → one closed ring: round joins & caps, `capSegments` per half-cap (8 full / 4 reduced). Zero-length input → []. */
export function strokePolygon(pts: Vec2[], width: number, capSegments: number): Ring;
/** Circle → ring, n = max(8, ceil(2π / step(tol, r))) */
export function circleRing(c: Vec2, r: number, tolMm: number): Ring;
// pads.ts
/** Pad shape → ring in PAD-LOCAL coords (centre origin), unrotated. roundrect radius = rratio × min(w,h). oval = stadium. trapezoid → rect. custom → rect of `size` (anchor). */
export function padRing(shape: PadShape, size: Vec2, rratio: number | null, tolMm: number): Ring;
/** The pad's absolute ring: padRing → rotate(pad.rotDeg, absolute per KiCad 6+) → translate(place(pad.at, fp.place)) */
export function placedPadRing(pad: PadModel, fp: Placement, tolMm: number): Ring;
/** Drill → ring(s) at the pad centre: round → circleRing(d/2); slot → stadium (slotW × slotH) rotated with the pad. */
export function drillRing(pad: PadModel, fp: Placement, tolMm: number): Ring | null;
```
`strokePolygon` algorithm (simple, watertight, no boolean): build the left offset polyline and the right offset polyline of `pts` by `w/2`; at each interior vertex insert a round join fan (arc from the previous segment's normal to the next segment's normal on the OUTER side only; on the inner side just take the intersection of the two offset lines, clamped to the vertex when the intersection lies behind it); add a semicircle cap of `capSegments` at each end. Return `left ⧺ endCap ⧺ reverse(right) ⧺ startCap`. Self-intersections on very tight polylines are tolerated (they are painted, not analysed).

- [ ] **Step 1: tests** — `strokes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { circleRing, strokePolygon } from './strokes';
import { signedArea } from './geom';

describe('strokePolygon', () => {
  it('a straight 10 mm × 0.15 mm track has area ≈ 10·0.15 + π·0.075²', () => {
    const ring = strokePolygon([{ x: 0, y: 0 }, { x: 10, y: 0 }], 0.15, 8);
    expect(Math.abs(signedArea(ring.pts))).toBeCloseTo(10 * 0.15 + Math.PI * 0.075 * 0.075, 3);
    expect(ring.pts.length).toBeGreaterThan(16); // caps add points
  });
  it('an L-shaped track keeps its outer corner round and its inner corner sharp', () => {
    const ring = strokePolygon([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 1, 8);
    const area = Math.abs(signedArea(ring.pts));
    // two 10 mm legs of width 1 overlap in a 1×1 corner: 20 − 1 + caps (π·0.25) + round outer join (π·0.25/… ) ≈ 19.8–20.3
    expect(area).toBeGreaterThan(19.5);
    expect(area).toBeLessThan(20.5);
  });
  it('returns an empty ring for a zero-length polyline', () => {
    expect(strokePolygon([{ x: 1, y: 1 }, { x: 1, y: 1 }], 1, 8).pts).toHaveLength(0);
  });
});

describe('circleRing', () => {
  it('has at least 8 points and area within tolerance of πr²', () => {
    const r = circleRing({ x: 0, y: 0 }, 0.3, 0.01);
    expect(r.pts.length).toBeGreaterThanOrEqual(8);
    expect(Math.abs(signedArea(r.pts))).toBeCloseTo(Math.PI * 0.09, 2);
  });
});
```
`pads.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { drillRing, padRing, placedPadRing } from './pads';
import { signedArea, bbox } from './geom';
import type { PadModel } from './types';

const base: PadModel = { ref: 'C1', number: '1', kind: 'smd', shape: 'rect', at: { x: 0, y: 0 }, rotDeg: 0, size: { x: 2, y: 1 }, rratio: null, layers: ['F.Cu'], drill: null };

describe('padRing', () => {
  it('rect', () => { expect(Math.abs(signedArea(padRing('rect', { x: 2, y: 1 }, null, 0.01).pts))).toBeCloseTo(2, 6); });
  it('roundrect with rratio .25 loses the four corner squares minus quarter circles', () => {
    const a = Math.abs(signedArea(padRing('roundrect', { x: 2, y: 1 }, 0.25, 0.005).pts));
    const r = 0.25; // .25 × min(2,1)
    expect(a).toBeCloseTo(2 - (4 - Math.PI) * r * r, 2);
  });
  it('oval is a stadium', () => {
    const a = Math.abs(signedArea(padRing('oval', { x: 2, y: 1 }, null, 0.005).pts));
    expect(a).toBeCloseTo(1 * 1 + Math.PI * 0.25, 2);
  });
  it('circle uses the first size component as diameter', () => {
    expect(Math.abs(signedArea(padRing('circle', { x: 1, y: 1 }, null, 0.005).pts))).toBeCloseTo(Math.PI / 4, 2);
  });
  it('custom and trapezoid fall back to the anchor rect', () => {
    expect(Math.abs(signedArea(padRing('custom', { x: 2, y: 1 }, null, 0.01).pts))).toBeCloseTo(2, 6);
  });
});

describe('placement', () => {
  it('pad rotation is absolute (KiCad 6+): a 90° pad in a 90° footprint is rotated once', () => {
    const ring = placedPadRing({ ...base, at: { x: -0.485, y: 0 }, rotDeg: 90, size: { x: 0.59, y: 0.64 } }, { at: { x: 127, y: 107.6 }, rotDeg: 90, side: 'F' }, 0.01);
    const b = bbox(ring.pts);
    expect(b.max.x - b.min.x).toBeCloseTo(0.64, 6);  // rotated 90°: width becomes the y size
    expect(b.max.y - b.min.y).toBeCloseTo(0.59, 6);
    expect((b.min.x + b.max.x) / 2).toBeCloseTo(127, 6);
    expect((b.min.y + b.max.y) / 2).toBeCloseTo(108.085, 6);
  });
  it('drill rings: round and slot', () => {
    const round = drillRing({ ...base, kind: 'thru_hole', drill: { d: 0.8 } }, { at: { x: 10, y: 10 }, rotDeg: 0, side: 'F' }, 0.01)!;
    expect(Math.abs(signedArea(round.pts))).toBeCloseTo(Math.PI * 0.16, 2);
    const slot = drillRing({ ...base, kind: 'thru_hole', rotDeg: 270, drill: { d: 0.6, slotW: 0.6, slotH: 1.7 } }, { at: { x: 0, y: 0 }, rotDeg: 0, side: 'F' }, 0.005)!;
    const b = bbox(slot.pts);
    expect(b.max.y - b.min.y).toBeCloseTo(0.6, 3);   // 270° turns the 1.7 mm long axis onto x
    expect(b.max.x - b.min.x).toBeCloseTo(1.7, 3);
    expect(drillRing(base, { at: { x: 0, y: 0 }, rotDeg: 0, side: 'F' }, 0.01)).toBeNull();
  });
});
```
Note the Glasgow footprint→pad convention in the first placement test: KiCad 6+ stores the pad's `(at x y rot)` rotation ABSOLUTE (already including the footprint's), so `placedPadRing` rotates the pad ring by `pad.rotDeg` (not `pad.rotDeg + fp.rotDeg`) and places its centre with `place(pad.at, fp)`. On the back side the ring is mirrored in y before rotation (`place` handles the centre; apply the same mirror to the ring).

- [ ] **Step 2: run → fail. Step 3: implement.** Sketch for `strokePolygon`:

```ts
export function strokePolygon(pts: Vec2[], width: number, capSegments: number): Ring {
  const p = dedupe(pts); if (p.length < 2) return { pts: [] };
  const hw = width / 2;
  const left: Vec2[] = [], right: Vec2[] = [];
  const n = p.length;
  const dir = (i: number) => { const d = sub(p[i + 1], p[i]); const l = len(d); return { x: d.x / l, y: d.y / l }; };
  const nrm = (d: Vec2) => ({ x: -d.y, y: d.x });
  for (let i = 0; i < n; i++) {
    const dPrev = i > 0 ? dir(i - 1) : dir(0), dNext = i < n - 1 ? dir(i) : dir(n - 2);
    const nPrev = nrm(dPrev), nNext = nrm(dNext);
    if (i === 0 || i === n - 1) { const nn = i === 0 ? nNext : nPrev; left.push(add(p[i], scale(nn, hw))); right.push(sub(p[i], scale(nn, hw))); continue; }
    const turn = cross(dPrev, dNext);       // >0: left turn (y-down: visually right) — outer side is the RIGHT offset
    const fan = (from: Vec2, to: Vec2): Vec2[] => { const a0 = Math.atan2(from.y, from.x); let da = Math.atan2(to.y, to.x) - a0; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI; const k = Math.max(1, Math.ceil(Math.abs(da) / (Math.PI / capSegments))); const out: Vec2[] = []; for (let j = 0; j <= k; j++) { const t = a0 + (da * j) / k; out.push(add(p[i], { x: hw * Math.cos(t), y: hw * Math.sin(t) })); } return out; };
    const miter = (sign: number): Vec2 => { const a = add(p[i], scale(nPrev, sign * hw)), b = add(p[i], scale(nNext, sign * hw)); const m = add(scale(add(nPrev, nNext), 0.5), { x: 0, y: 0 }); const ml = len(m); if (ml < 1e-9) return a; const k = hw / ml; const mp = add(p[i], scale(m, sign * k / ml * ml)); return len(sub(mp, p[i])) > 4 * hw ? scale(add(a, b), 0.5) : mp; };
    if (turn > 0) { left.push(...fan(scale(nPrev, 1), scale(nNext, 1))); right.push(miter(-1)); }
    else { left.push(miter(1)); right.push(...fan(scale(nPrev, -1), scale(nNext, -1))); }
  }
  const capEnd = capArc(p[n - 1], nrm(dir(n - 2)), hw, capSegments, +1);
  const capStart = capArc(p[0], nrm(dir(0)), hw, capSegments, -1);
  return { pts: [...left, ...capEnd, ...right.reverse(), ...capStart] };
}
```
Write `dedupe` (drop consecutive points within 1e-9), `capArc(centre, normal, r, segments, sign)` (a half circle from `+normal` around through `sign·direction` to `−normal`, `segments` steps, endpoints excluded so they do not duplicate the offset points), and a correct `miter` (intersection of the two inner offset lines; fall back to the average of the two offset points when the lines are nearly parallel or the intersection is farther than `4·hw` from the vertex). The sketch's `miter` body is deliberately rough — write it from the geometry, not from the sketch.

- [ ] **Step 4: run → PASS; gates; commit `feat(board3d): stroke outlines and pad shape rings`; push.**

---

### Task 4: The board model reader

**Files:** Create `readBoardModel.ts`, `readBoardModel.test.ts`.

**Interfaces:** `export function readBoardModel(text: string, tolMm: number): BoardModel` — throws `KicadReadError(…, 'unreadable')` exactly as `readStackup` does (same header regex and the same truncated-file catch). Consumes `topLevelBlocks`, `parse`, `child`, `children`, `atom`, `head` from `../sexpr`, `flattenThreePoint` from `./arcs`.

Dialect table (both forms must parse to the same model):

| Thing | KiCad 6 (Glasgow) | KiCad 8/9 (StickHub, panel, complex_hierarchy) |
|---|---|---|
| id | `(tstamp …)` | `(uuid …)` — ignored either way |
| reference | `(fp_text reference "C1" (at …) (layer …) hide …)` | `(property "Reference" "C1" (at …) (layer …) (hide yes) …)` |
| footprint layer | `(footprint "lib:name" (layer "F.Cu") … (at x y [rot]))` | same, multi-line |
| pad | `(pad "1" smd roundrect (at x y [rot]) (size w h) (layers …) (roundrect_rratio r) [(drill d)] [(drill oval w h)])` — a `locked` atom may appear after the shape | same; `(pad "1" connect custom …)` exists once |
| graphics | `(fp_line (start) (end) (stroke (width w) …) (layer "F.CrtYd"))`, `fp_arc (start)(mid)(end)`, `fp_circle (center)(end)`, `fp_rect (start)(end)`, `fp_poly (pts (xy …)…)` ; fill: `(fill none|solid)` or `(fill yes|no)` | same |
| tracks | `(segment (start)(end)(width)(layer))` | plus `(arc (start)(mid)(end)(width)(layer))` |
| via | `(via (at)(size)(drill)(layers "F.Cu" "B.Cu"))` | same; `blind`/`micro` atoms may precede `(at` |
| zone | `(zone … (layer "F.Cu") … (filled_polygon (layer "F.Cu") (pts (xy …)…)) …)`; multi-layer zones use `(layers …)` and one `filled_polygon` per layer | same |
| board graphics | `(gr_line …)`, `(gr_arc …)`, `(gr_rect …)`, `(gr_circle …)`, `(gr_poly …)` with `(layer "Edge.Cuts")` or `"F.SilkS"` | same |
| layers | `(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (36 "B.SilkS" user "B.Silkscreen") (44 "Edge.Cuts" user) (47 "F.CrtYd" user "F.Courtyard") …)` | same |

Layer kind mapping: name ends with `.Cu` → `copper` (side `F` for `F.Cu`, `B` for `B.Cu`, else `In`); `F.Mask`/`B.Mask` → `mask`; `F.SilkS`/`B.SilkS` → `silk`; `F.CrtYd`/`B.CrtYd` → `courtyard`; `Edge.Cuts` → `edge`; else `other`.

Rules: pad `size` for `circle` uses `(size d d)`; `rratio` from `(roundrect_rratio r)` else null; pad `kind` from the second atom; pad `layers` may contain wildcards `*.Cu`, `*.Mask` — expand `*.Cu` to every copper layer name of the board, `*.Mask` to `F.Mask`,`B.Mask`. Footprint side: `(layer "B.Cu")` → `'B'`. Reference: `fp_text reference` value or `property "Reference"` value; a footprint without either gets `ref: ''`. Shapes: `(width w)` may be direct (KiCad 5/6 `(width 0.12)`) or inside `(stroke (width w))`; `fill` truthy for `solid` or `yes`. Zone: emit one `ZoneFill` per `filled_polygon` using ITS OWN `(layer …)`; a zone with `(fill yes …)` (or absent fill block) but NO `filled_polygon` children counts toward `zonesUnfilled`. Tracks: `(arc)` flattened at `tolMm`, degenerate arcs counted. Only `Shape`s on `Edge.Cuts` go to `edgeItems`; `gr_*` on `F.SilkS`/`B.SilkS` go to `silk`; footprint `fp_*` on `<side>.SilkS`/`<side>.CrtYd` go to the footprint's `silk`/`courtyard` (footprint-local, unplaced). Everything else is ignored. Never read `(model …)`.

- [ ] **Step 1: tests** — `readBoardModel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fixtureText } from '../fixtures';
import { readBoardModel } from './readBoardModel';
import { KicadReadError } from '../types';

const glasgow = () => readBoardModel(fixtureText('glasgow-revC3/glasgow.kicad_pcb'), 0.01);
const stickhub = () => readBoardModel(fixtureText('kicad-demos/stickhub/StickHub.kicad_pcb'), 0.01);
const panel = () => readBoardModel(fixtureText('bad-thing-panel/panel.kicad_pcb'), 0.01);
const hier = () => readBoardModel(fixtureText('kicad-demos/complex_hierarchy/complex_hierarchy.kicad_pcb'), 0.01);

describe('readBoardModel — Glasgow revC3 (KiCad 6)', () => {
  const m = glasgow();
  it('counts', () => {
    expect(m.version).toBe(20221018);
    expect(m.footprints).toHaveLength(272);
    expect(m.footprints.reduce((n, f) => n + f.pads.length, 0)).toBe(1149);
    expect(m.vias).toHaveLength(416);
    expect(m.tracks).toHaveLength(4715);
    expect(m.zones).toHaveLength(32);
    expect(m.zonesUnfilled).toBe(0);
    expect(m.edgeItems).toHaveLength(8);
  });
  it('layers carry kinds and sides', () => {
    expect(m.layers.filter((l) => l.kind === 'copper').map((l) => l.name)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    expect(m.layers.find((l) => l.name === 'Edge.Cuts')?.kind).toBe('edge');
    expect(m.layers.find((l) => l.name === 'F.CrtYd')?.kind).toBe('courtyard');
  });
  it('sides: 178 front, 94 back', () => {
    expect(m.footprints.filter((f) => f.place.side === 'F')).toHaveLength(178);
    expect(m.footprints.filter((f) => f.place.side === 'B')).toHaveLength(94);
  });
  it('a known footprint: C at (127, 107.6, 90) with two roundrect pads and a courtyard', () => {
    const f = m.footprints.find((x) => x.place.at.x === 127 && x.place.at.y === 107.6)!;
    expect(f.lib).toBe('Capacitor_SMD:C_0402_1005Metric');
    expect(f.place.rotDeg).toBe(90);
    expect(f.pads[0]).toMatchObject({ number: '1', kind: 'smd', shape: 'roundrect', rratio: 0.25, size: { x: 0.59, y: 0.64 } });
    expect(f.courtyard.length).toBeGreaterThanOrEqual(4);
  });
  it('pad wildcards expand to the board layers', () => {
    const tht = m.footprints.flatMap((f) => f.pads).find((p) => p.kind === 'thru_hole')!;
    expect(tht.layers).toEqual(expect.arrayContaining(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu', 'F.Mask', 'B.Mask']));
    expect(tht.drill).not.toBeNull();
  });
  it('drill slots are read', () => {
    const slot = m.footprints.flatMap((f) => f.pads).find((p) => p.drill?.slotW != null)!;
    expect(slot.drill).toEqual({ d: 0.6, slotW: 0.6, slotH: 1.7 });
  });
  it('a via: (at 77.4 106.700098) (size 0.6) (drill 0.3) F.Cu→B.Cu', () => {
    expect(m.vias.find((v) => v.at.x === 77.4)).toMatchObject({ size: 0.6, drill: 0.3, layers: ['F.Cu', 'B.Cu'] });
  });
  it('references come from fp_text', () => {
    expect(m.footprints.some((f) => f.ref === 'TP5')).toBe(true);
    expect(m.footprints.filter((f) => f.ref === '')).toHaveLength(0);
  });
});

describe('readBoardModel — StickHub (KiCad 9 dialect)', () => {
  const m = stickhub();
  it('references come from (property "Reference")', () => {
    expect(m.footprints.some((f) => f.ref === 'D4')).toBe(true);
    expect(m.footprints.some((f) => f.ref === 'J7')).toBe(true);
  });
  it('180 arc tracks are flattened, none degenerate', () => {
    expect(m.tracks.filter((t) => t.pts.length > 2)).toHaveLength(180);
    expect(m.warnings.find((w) => w.kind === 'arc-degenerate')).toBeUndefined();
  });
  it('the custom pad falls back to its anchor size', () => {
    const c = m.footprints.flatMap((f) => f.pads).find((p) => p.shape === 'custom')!;
    expect(c.kind).toBe('connect');
    expect(c.size.x).toBeGreaterThan(0);
  });
  it('counts', () => {
    expect(m.footprints).toHaveLength(94);
    expect(m.footprints.reduce((n, f) => n + f.pads.length, 0)).toBe(278);
    expect(m.edgeItems).toHaveLength(21);
  });
});

describe('readBoardModel — the panel (no stackup) and complex_hierarchy', () => {
  it('panel: 10 zones, 3 filled → 7 unfilled; 85 edge items', () => {
    const m = panel();
    expect(m.zones).toHaveLength(3);
    expect(m.zonesUnfilled).toBe(7);
    expect(m.edgeItems).toHaveLength(85);
  });
  it('complex_hierarchy: 165 THT pads, all drilled', () => {
    const m = hier();
    const pads = m.footprints.flatMap((f) => f.pads);
    expect(pads).toHaveLength(165);
    expect(pads.every((p) => p.kind === 'thru_hole' && p.drill != null)).toBe(true);
  });
});

describe('readBoardModel — errors', () => {
  it('refuses a non-board and a truncated board with KicadReadError', () => {
    expect(() => readBoardModel('(kicad_sch (version 1))', 0.01)).toThrow(KicadReadError);
    const t = fixtureText('glasgow-revC3/glasgow.kicad_pcb');
    expect(() => readBoardModel(t.slice(0, 200000), 0.01)).toThrow(KicadReadError);
  });
});
```
Counts marked here come from the context map's grep census; if a count is off by a few, verify with `grep -c` on the fixture BEFORE changing the test, and record the corrected number in the commit message.

- [ ] **Step 2: run → fail. Step 3: implement** — structure:

```ts
export function readBoardModel(text: string, tolMm: number): BoardModel {
  if (!/^\s*\(kicad_pcb\b/.test(text)) throw new KicadReadError('That file does not open with (kicad_pcb …) — it is not a KiCad board.', 'unreadable');
  let blocks: TopLevelBlock[];
  try { blocks = [...topLevelBlocks(text)]; } catch { throw new KicadReadError('That board file is truncated or malformed and could not be read.', 'unreadable'); }
  const model: BoardModel = { version: 0, layers: [], edgeItems: [], footprints: [], vias: [], tracks: [], zones: [], zonesUnfilled: 0, silk: [], warnings: [] };
  let degenerate = 0;
  const copperNames: string[] = [];
  for (const b of blocks) {
    const node = b.head === 'version' || b.head === 'layers' || b.head === 'footprint' || b.head === 'via' || b.head === 'segment' || b.head === 'arc' || b.head === 'zone' || b.head.startsWith('gr_') ? parseBlock(text, b.start, b.end) : null;
    if (!node) continue;
    switch (b.head) { /* one small function per head: readVersion, readLayers (fills copperNames), readFootprint, readVia, readSegment, readArcTrack, readZone, readGr */ }
  }
  if (degenerate) model.warnings.push({ kind: 'arc-degenerate', count: degenerate });
  if (model.zonesUnfilled) model.warnings.push({ kind: 'zones-unfilled', count: model.zonesUnfilled });
  return model;
}
```
Helper `num(node, i)` → `Number(atom(node,i))` with NaN → 0; `xy(child(node,'at'))` → Vec2 + optional rot; `shapeOf(node)` for `fp_*`/`gr_*` returning `Shape | null` with the width/fill rules above. `(layers …)` on the board is parsed ONCE and must precede footprints in every KiCad file (it does); expand wildcards against `copperNames`. Keep every function under ~40 lines; this file will be ~300 lines.

- [ ] **Step 4: run → PASS.** Also time it: add to the test file
```ts
it('reads Glasgow in under 400 ms', () => { const t0 = performance.now(); glasgow(); expect(performance.now() - t0).toBeLessThan(400); });
```
- [ ] **Step 5: gates; commit `feat(board3d): read footprints, pads, vias, tracks, zones and edges from a board (KiCad 6–9)`; push.**

---

### Task 5: Courtyards and height estimate

**Files:** Create `courtyards.ts`, `courtyards.test.ts`.

**Interfaces:**

```ts
export interface Courtyard { ring: Ring; heightMm: number; side: Side; areaMm2: number }
/** Chain the footprint's courtyard graphics (local coords), place them, return null when absent or open. */
export function courtyardOf(fp: FootprintModel, tolMm: number): Courtyard | null;
/** h = clamp(0.35 · sqrt(area), 0.6, 12) — an ESTIMATE, captioned as such (spec §4). */
export function estimateHeightMm(areaMm2: number): number;
export function courtyards(model: BoardModel, tolMm: number): { bodies: Courtyard[]; missing: number };
```

- [ ] **Step 1: tests**

```ts
import { describe, expect, it } from 'vitest';
import { fixtureText } from '../fixtures';
import { readBoardModel } from './readBoardModel';
import { courtyardOf, courtyards, estimateHeightMm } from './courtyards';
import { bbox, signedArea } from './geom';

describe('estimateHeightMm', () => {
  it('is monotone in area and clamped to [0.6, 12]', () => {
    expect(estimateHeightMm(0)).toBe(0.6);
    expect(estimateHeightMm(1.5)).toBeCloseTo(0.6, 6);           // 0402: 0.35·√1.5 = 0.43 → floor
    expect(estimateHeightMm(100)).toBeCloseTo(3.5, 6);
    expect(estimateHeightMm(10_000)).toBe(12);
  });
});

describe('courtyards on Glasgow', () => {
  const m = readBoardModel(fixtureText('glasgow-revC3/glasgow.kicad_pcb'), 0.01);
  it('264 closed courtyards, 8 footprints without one', () => {
    const r = courtyards(m, 0.01);
    expect(r.bodies).toHaveLength(264);
    expect(r.missing).toBe(8);
  });
  it('the C at (127, 107.6, 90) has a closed courtyard placed around its centre', () => {
    const f = m.footprints.find((x) => x.place.at.x === 127 && x.place.at.y === 107.6)!;
    const c = courtyardOf(f, 0.01)!;
    const b = bbox(c.ring.pts);
    expect((b.min.x + b.max.x) / 2).toBeCloseTo(127, 2);
    expect((b.min.y + b.max.y) / 2).toBeCloseTo(107.6, 2);
    // a 0402 courtyard is ~1.86 × 0.94 mm; rotated 90° the long side runs along y
    expect(b.max.y - b.min.y).toBeGreaterThan(b.max.x - b.min.x);
    expect(signedArea(c.ring.pts)).toBeLessThan(0);   // outer orientation
    expect(c.heightMm).toBeGreaterThanOrEqual(0.6);
  });
  it('back-side courtyards are mirrored', () => {
    const f = m.footprints.find((x) => x.place.side === 'B' && x.courtyard.length >= 4)!;
    const c = courtyardOf(f, 0.01)!;
    expect(c.side).toBe('B');
    expect(Math.abs(signedArea(c.ring.pts))).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2 → 3:** implement with `chainLoops` from `outline.ts` on the placed shapes (map each courtyard `Shape` through `place(·, fp.place)` for its points; arcs flattened first), take the largest loop, `orient(…, 'outer')`, `areaMm2 = |signedArea|`, `heightMm = estimateHeightMm(area)`. `courtyards()` iterates footprints, counts `null` as missing (whether absent or open).

- [ ] **Step 4: PASS; gates; commit `feat(board3d): courtyard bodies with an estimated height`; push.**

---

### Task 6: Layer z-ladder

**Files:** Create `layers.ts`, `layers.test.ts`.

**Interfaces:**

```ts
export interface LayerZ { name: string; kind: LayerKind; side: Side | 'In'; z0: number; z1: number }   // mm, z up, board bottom at 0
export interface ZLadder { layers: LayerZ[]; thicknessMm: number | null; substrateTop: number; substrateBottom: number; warning: BoardWarning | null }
/** From the board's copper LayerDefs (file order = top→bottom) and the stackup reader's rows. */
export function zLadder(layers: LayerDef[], stackup: BoardStackup | null): ZLadder;
```
Rules (spec §4 Layers):
- With `stackup.stackup` rows: walk rows in file order from the TOP: mask/silk/paste rows have their thickness (mask 0.01 typical; missing → 0.01 for mask, 0 for silk/paste); copper rows use their `thicknessMm` (missing → 0.035); dielectric rows their `thicknessMm` (missing → contributes 0 and the warning below). `thicknessMm = listedThicknessMm` (never designThicknessMm, never 1.6). Copper layer `z0/z1` = its band; `substrateTop` = z of the top copper's underside; `substrateBottom` = 0. Copper faces are drawn at their band top (F) / band bottom (B) / both (inner, hidden inside the substrate anyway — skip inner copper meshes in v1 but keep their z in the ladder).
- Without a stackup: `thicknessMm: null`, warning `{ kind: 'no-stackup' }`, copper at nominal 0.035 mm bands separated by `designThicknessMm / (n−1)` dielectric when `designThicknessMm != null`, else a nominal 1.0 mm total — used ONLY to draw, never reported (the scene's `thicknessMm` stays null).

- [ ] **Step 1: tests**

```ts
import { describe, expect, it } from 'vitest';
import { fixtureText } from '../fixtures';
import { readStackup } from '../boardStackup';
import { readBoardModel } from './readBoardModel';
import { zLadder } from './layers';

describe('zLadder', () => {
  it('Glasgow: four copper bands inside a 1.6 mm sandwich, thickness = the reader\'s listed sum', () => {
    const text = fixtureText('glasgow-revC3/glasgow.kicad_pcb');
    const s = readStackup(text), m = readBoardModel(text, 0.05);
    const z = zLadder(m.layers, s);
    expect(z.warning).toBeNull();
    expect(z.thicknessMm).toBe(s.listedThicknessMm);
    const cu = z.layers.filter((l) => l.kind === 'copper');
    expect(cu.map((l) => l.name)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    expect(cu[3].z0).toBeCloseTo(0.01, 6);                  // above B.Mask (0.01)
    expect(cu[0].z1).toBeCloseTo(s.listedThicknessMm! - 0.01, 6);
    for (let i = 1; i < cu.length; i++) expect(cu[i].z1).toBeLessThan(cu[i - 1].z0);
  });
  it('the panel has no stackup: null thickness, a warning, and still a drawable ladder', () => {
    const text = fixtureText('bad-thing-panel/panel.kicad_pcb');
    const z = zLadder(readBoardModel(text, 0.05).layers, readStackup(text));
    expect(z.thicknessMm).toBeNull();
    expect(z.warning).toEqual({ kind: 'no-stackup' });
    expect(z.substrateTop).toBeGreaterThan(z.substrateBottom);
    expect(z.layers.filter((l) => l.kind === 'copper')).toHaveLength(2);
  });
});
```
(If the panel's `(general (thickness …))` is present, `substrateTop − substrateBottom` equals it minus copper; either way the assertion above holds.)

- [ ] **Steps 2–4:** implement, PASS, gates, commit `feat(board3d): the z ladder from the stackup, never a fabricated thickness`, push.

---

### Task 7: Tessellation and extrusion

**Files:** Create `tessellate.ts`, `tessellate.test.ts`.

**Interfaces:**

```ts
export class MeshBuilder {
  constructor(flipY: boolean, centre: Vec2 = { x: 0, y: 0 });   // writes (x − centre.x, flipY ? −(y − centre.y) : y − centre.y, z)
  positions: number[] = []; normals: number[] = []; indices: number[] = [];
  /** Flat polygon (with holes) at height z, facing +z (up=true) or −z. Uses earcut with holeIndices. Returns triangle count. */
  addFace(poly: PolygonWithHoles, z: number, up: boolean): number;
  /** Vertical walls around a ring from z0 to z1; `outward` flips the normal (holes face inward). */
  addWalls(ring: Ring, z0: number, z1: number, outward: boolean): number;
  /** Solid = top face + bottom face + walls for outer and every hole. */
  addPrism(poly: PolygonWithHoles, z0: number, z1: number): number;
  build(material: Material, layerName: string | null): MeshGroup;   // Float32Array / Uint32Array
}
export function triangulate(poly: PolygonWithHoles): { verts: Float64Array; tris: Uint32Array };   // earcut wrapper; verts are the concatenated xy of outer then holes
```
earcut call: `earcut(flatXY, holeIndices, 2)` where `holeIndices[i]` = index of the first vertex of hole i in the concatenated array. Normals: faces `(0,0,±1)`; walls: per-quad flat normal from the edge direction × z, outward for the outer ring (outer rings have `signedArea < 0` in y-down; after the scene's y-flip they become CCW in y-up — compute the normal from the actual edge and flip if `!outward`). y-flip is NOT done here; `buildScene` flips by scaling y by −1 and reversing winding (`indices` triple order) — simpler: `MeshBuilder` takes a `flipY: boolean` in its constructor and writes `−y` while reversing each triangle's winding.

- [ ] **Step 1: tests**

```ts
import { describe, expect, it } from 'vitest';
import { MeshBuilder, triangulate } from './tessellate';

const sq = (s: number, cx = 0, cy = 0) => ({ pts: [{ x: cx - s, y: cy - s }, { x: cx + s, y: cy - s }, { x: cx + s, y: cy + s }, { x: cx - s, y: cy + s }] });

describe('triangulate', () => {
  it('a square with a square hole yields 8 triangles', () => {
    const t = triangulate({ outer: sq(5), holes: [{ pts: [...sq(1).pts].reverse() }] });
    expect(t.tris.length / 3).toBe(8);
  });
  it('a plain square yields 2', () => { expect(triangulate({ outer: sq(5), holes: [] }).tris.length / 3).toBe(2); });
});

describe('MeshBuilder', () => {
  it('a prism has 2 faces + 4 walls·2 = 12 triangles, outward normals, in-range indices', () => {
    const b = new MeshBuilder(false);
    const n = b.addPrism({ outer: sq(1), holes: [] }, 0, 2);
    expect(n).toBe(12);
    const g = b.build('substrate', null);
    expect(g.indices.length).toBe(36);
    for (const i of g.indices) expect(i).toBeLessThan(g.positions.length / 3);
    // top face normal up, bottom down
    expect(g.normals[2]).toBe(1);
    // a wall on the +x side has normal +x: find a vertex at x=1, z between 0..2 with nz==0
    let found = false;
    for (let i = 0; i < g.positions.length / 3; i++) if (g.positions[3 * i] === 1 && g.normals[3 * i + 2] === 0 && g.normals[3 * i] > 0.99) found = true;
    expect(found).toBe(true);
  });
  it('flipY negates y and keeps faces up', () => {
    const b = new MeshBuilder(true);
    b.addFace({ outer: { pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }, holes: [] }, 0, true);
    const g = b.build('copper', 'F.Cu');
    expect(Math.min(...Array.from(g.positions).filter((_, i) => i % 3 === 1))).toBe(-1);
    // winding still counter-clockwise seen from +z after the flip: cross product of the first triangle's edges has positive z
    const [a, b2, c] = [g.indices[0], g.indices[1], g.indices[2]].map((i) => [g.positions[3 * i], g.positions[3 * i + 1]]);
    const cz = (b2[0] - a[0]) * (c[1] - a[1]) - (b2[1] - a[1]) * (c[0] - a[0]);
    expect(cz).toBeGreaterThan(0);
  });
});
```
(Hole orientation for earcut does not matter — earcut handles either winding — but `addWalls` uses the ring's stored orientation to pick the outward normal; write `addPrism` to orient holes explicitly by area sign before extruding.)

- [ ] **Steps 2–4:** implement with `import earcut from 'earcut'`, PASS, gates, commit `feat(board3d): earcut triangulation and prism extrusion into transferable mesh groups`, push.

---

### Task 8: buildScene, the worker, and useBoardScene

**Files:**
- Create: `services/kicad/board3d/buildScene.ts`, `buildScene.test.ts`, `services/kicad/board3d/worker.ts`
- Create: `components/kicad/board3d/useBoardScene.ts`, `useBoardScene.test.ts`

**Interfaces:**

```ts
// buildScene.ts
export interface BuildInput { text: string; stackup: BoardStackup | null; quality: Quality }
export function buildScene(input: BuildInput): BoardScene;           // throws KicadReadError('unreadable') from the reader
export function buildSceneFromModel(model: BoardModel, stackup: BoardStackup | null, quality: Quality): BoardScene;
export function transferList(scene: BoardScene): ArrayBuffer[];       // every typed array's buffer, for postMessage

// worker.ts (module worker)
//   self.onmessage = (e: MessageEvent<BuildInput>) => { try { const s = buildScene(e.data); self.postMessage({ ok: true, scene: s }, transferList(s)); } catch (err) { self.postMessage({ ok: false, message: (err as Error).message, kind: err instanceof KicadReadError ? err.kind : 'error' }); } };

// useBoardScene.ts
export type SceneStatus = 'idle' | 'building' | 'ready' | 'error';
export interface SceneState { status: SceneStatus; scene: BoardScene | null; error: string | null }
/** Per-project cache (WeakMap<KicadProject, Promise<BoardScene>>) keyed by project identity AND quality. `retry()` bypasses the cache. */
export function useBoardScene(project: KicadProject | null, stackup: BoardStackup | null, quality: Quality, deps?: { spawn?: () => Worker | null }): SceneState & { retry: () => void };
```
`buildSceneFromModel` composition (spec §4, in this order):
1. `tol = TOL_MM[quality]`; `outline = boardOutline(model.edgeItems, tol)`; warnings: `outline-open` (with `unchained`), `arc-degenerate` merged with the reader's count.
2. `ladder = zLadder(model.layers, stackup)`; warning appended if any.
3. Holes: for each via → `circleRing(at, drill/2, tol)`; for each pad with a drill → `drillRing`; plus `outline.cutouts`. Overlap pass: sort holes by |area| descending; for each hole, if its bbox intersects an already-accepted hole's bbox AND the two rings' bboxes overlap by more than 25 % of the smaller → skip it, `holesMerged++`. (bbox-only in v1 — cheap, and a via touching a pad drill is the realistic case.) Warning `holes-merged` when > 0.
4. Substrate: `MeshBuilder(true).addPrism({ outer: outline.outer, holes }, ladder.substrateBottom, ladder.substrateTop)` → group `substrate` (top+bottom faces) — put the walls of every hole ring into a SEPARATE builder so they become the `hole-wall` group (call `addWalls` for holes with `outward=false`, and for the outer ring with `outward=true`, in the substrate group).
5. Copper (outer layers only in v1: `F.Cu` and `B.Cu`): per layer, one builder; add a face-only slab (top face at `z1` for F, bottom face at `z0` for B) for every pad ring on that layer, every track (`strokePolygon` at `capSegments = quality === 'full' ? 8 : 4`, skipping width < 0.2 mm in reduced), and every `ZoneFill` ring on that layer (as a face with no holes). Group `copper`/layerName.
6. Mask per outer side: `addFace({ outer: outline.outer, holes: [...holes, ...padRingsOnThisSide] }, zMask, up)` where `zMask = ladder top (F) / bottom (B)` ± 0.001 mm; pad rings that overlap each other are dropped with the same bbox rule (count into `holes-merged`). Group `mask`/`F.Mask`|`B.Mask`.
7. Silk per side: board `gr_*` on `<side>.SilkS` + footprint `fp_*` placed with `place(·, fp.place)`; lines/arcs → `strokePolygon`, filled shapes → face, unfilled circle/rect/poly → stroked outline; z = mask z ± 0.01. Group `silk`/`F.SilkS`|`B.SilkS`.
8. Bodies (full only): `courtyards(model, tol)` → for each, `addPrism({outer: ring, holes: []}, zBase, zBase ± heightMm)` where zBase = the side's mask z; group `body`/null. Warning `no-courtyard` from `missing`.
9. `bounds` from the outline; `stats` counts; `buildMs = performance.now() − t0`. Every builder writes y as `−y` (flipY) and positions are also shifted so the bbox centre is (0,0): pass a `centre` to `MeshBuilder` and subtract it in `push` (add `MeshBuilder(flipY, centre)`; update Task 7's constructor accordingly — Task 7's tests pass `false` and `{x:0,y:0}`).

- [ ] **Step 1: tests** — `buildScene.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fixtureText } from '../fixtures';
import { readStackup } from '../boardStackup';
import { buildScene, transferList } from './buildScene';

const load = (rel: string, quality: 'full' | 'reduced' = 'full') => {
  const text = fixtureText(rel);
  let stackup = null; try { stackup = readStackup(text); } catch { stackup = null; }
  return buildScene({ text, stackup, quality });
};

describe('buildScene — Glasgow', () => {
  const s = load('glasgow-revC3/glasgow.kicad_pcb');
  it('reports honest thickness, bounds and stats', () => {
    expect(s.thicknessMm).toBeCloseTo(1.6, 6);
    expect(s.bounds.max.x - s.bounds.min.x).toBeCloseTo(80, 0);
    expect(s.bounds.max.y - s.bounds.min.y).toBeCloseTo(49, 0);
    expect(s.stats).toMatchObject({ footprints: 272, pads: 1149, vias: 416, tracks: 4715 });
    expect(s.stats.triangles).toBeGreaterThan(20_000);
    expect(s.stats.buildMs).toBeLessThan(3000);
  });
  it('has one group per material/layer, at most a dozen', () => {
    const keys = s.groups.map((g) => `${g.material}/${g.layerName}`);
    expect(keys).toEqual(expect.arrayContaining(['substrate/null', 'hole-wall/null', 'copper/F.Cu', 'copper/B.Cu', 'mask/F.Mask', 'mask/B.Mask', 'silk/F.SilkS', 'body/null']));
    expect(s.groups.length).toBeLessThanOrEqual(12);
    for (const g of s.groups) { expect(g.positions.length % 3).toBe(0); expect(g.normals.length).toBe(g.positions.length); for (const i of g.indices) expect(i).toBeLessThan(g.positions.length / 3); }
  });
  it('is centred on the origin with y flipped', () => {
    const sub = s.groups.find((g) => g.material === 'substrate')!;
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < sub.positions.length; i += 3) { minX = Math.min(minX, sub.positions[i]); maxX = Math.max(maxX, sub.positions[i]); }
    expect(minX + maxX).toBeCloseTo(0, 3);
  });
  it('warnings: none except possibly merged holes', () => {
    expect(s.warnings.filter((w) => w.kind !== 'holes-merged' && w.kind !== 'no-courtyard')).toEqual([]);
    expect(s.warnings.find((w) => w.kind === 'no-courtyard')).toEqual({ kind: 'no-courtyard', count: 8 });
  });
  it('reduced quality has no bodies and fewer triangles', () => {
    const r = load('glasgow-revC3/glasgow.kicad_pcb', 'reduced');
    expect(r.groups.find((g) => g.material === 'body')).toBeUndefined();
    expect(r.stats.triangles).toBeLessThan(s.stats.triangles);
  });
  it('transferList lists every buffer once', () => {
    expect(transferList(s)).toHaveLength(s.groups.length * 3);
  });
});

describe('buildScene — the panel', () => {
  it('no stackup → null thickness + warning; unfilled zones reported', () => {
    const s = load('bad-thing-panel/panel.kicad_pcb');
    expect(s.thicknessMm).toBeNull();
    expect(s.warnings).toEqual(expect.arrayContaining([{ kind: 'no-stackup' }, { kind: 'zones-unfilled', count: 7 }]));
  });
});
```

`useBoardScene.test.ts` (happy-dom, fake worker injected through `deps.spawn`):

```ts
// @vitest-environment happy-dom
import { act, createElement, type FC } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useBoardScene } from './useBoardScene';
import type { KicadProject } from '@public/services/kicad/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const project = (text: string) => ({ name: 'p', files: new Map([['b.kicad_pcb', text]]), board: 'b.kicad_pcb', sheets: [], root: null } as unknown as KicadProject);

class FakeWorker { onmessage: ((e: MessageEvent) => void) | null = null; posted: unknown[] = []; terminated = 0;
  postMessage(m: unknown) { this.posted.push(m); }
  terminate() { this.terminated++; }
  reply(msg: unknown) { this.onmessage?.({ data: msg } as MessageEvent); } }

function mount(p: KicadProject, spawn: () => Worker | null) {
  const seen: unknown[] = [];
  const Probe: FC = () => { const s = useBoardScene(p, null, 'full', { spawn }); seen.push({ status: s.status, error: s.error }); return null; };
  const el = document.createElement('div'); const root = createRoot(el);
  act(() => root.render(createElement(Probe)));
  return { seen, root };
}

describe('useBoardScene', () => {
  it('goes idle → building → ready through the worker and transfers the text once', async () => {
    const w = new FakeWorker();
    const { seen } = mount(project('(kicad_pcb (version 20221018))'), () => w as unknown as Worker);
    expect(seen.at(-1)).toMatchObject({ status: 'building' });
    expect(w.posted).toHaveLength(1);
    await act(async () => { w.reply({ ok: true, scene: { bounds: { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } }, thicknessMm: null, groups: [], warnings: [], stats: { footprints: 0, pads: 0, vias: 0, tracks: 0, triangles: 0, buildMs: 1 } } }); });
    expect(seen.at(-1)).toMatchObject({ status: 'ready' });
  });
  it('surfaces a worker failure as error, and retry posts again', async () => {
    const w = new FakeWorker();
    const { seen } = mount(project('(kicad_pcb)'), () => w as unknown as Worker);
    await act(async () => { w.reply({ ok: false, message: 'nope', kind: 'unreadable' }); });
    expect(seen.at(-1)).toMatchObject({ status: 'error', error: 'nope' });
  });
  it('falls back to the main thread when there is no worker', async () => {
    const { seen } = mount(project('(kicad_pcb (version 20221018) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)))'), () => null);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(['ready', 'error']).toContain((seen.at(-1) as { status: string }).status);
  });
  it('terminates the worker on unmount', () => {
    const w = new FakeWorker();
    const { root } = mount(project('(kicad_pcb)'), () => w as unknown as Worker);
    act(() => root.unmount());
    expect(w.terminated).toBe(1);
  });
});
```
The default `spawn` is `() => { try { return new Worker(new URL('../../../services/kicad/board3d/worker.ts', import.meta.url), { type: 'module' }); } catch { return null; } }`. The cache key is `${quality}` inside a `WeakMap<KicadProject, Map<Quality, Promise<BoardScene>>>`.

- [ ] **Steps 2–4:** implement, PASS both test files, gates, commit `feat(board3d): buildScene composes the board, a worker runs it, useBoardScene caches it per project`, push.

---

### Task 9: Renderer and host

**Files:**
- Create: `components/kicad/board3d/board3dTheme.ts`, `quality.ts`, `sceneRenderer.ts`, `Board3DView.tsx`, `Board3DView.module.scss`
- Test: `components/kicad/board3d/quality.test.ts`, `Board3DView.test.ts`

**Interfaces:**

```ts
// quality.ts
export function decideQuality(env: { webgl2: boolean; innerWidth: number; devicePixelRatio: number }): Quality;  // full iff webgl2 && innerWidth >= 900 && dpr <= 2
export function setQualityOverride(q: Quality | null): void;      // wins over decideQuality
export function currentQuality(env: …): Quality;

// sceneRenderer.ts
export interface SceneRenderer {
  mount(host: HTMLElement, scene: BoardScene, quality: Quality): Promise<void>;   // dynamic import('three') + OrbitControls inside
  setView(v: 'top' | 'bottom' | 'reset'): void;
  flip(): void;                                                                   // 0.5 s animated 180° about the board's long axis
  pause(): void; resume(): void;                                                  // tab hidden / visible
  dispose(): void;                                                                // renderer.dispose(), geometries, materials, WEBGL_lose_context, cancel rAF
  info(): { calls: number; triangles: number };                                   // renderer.info for the measurement step
}
export function createSceneRenderer(): SceneRenderer;

// Board3DView.tsx
export interface Board3DViewProps { project: KicadProject; stackup: BoardStackup | null; createRenderer?: () => SceneRenderer; quality?: Quality }
export default function Board3DView(props: Board3DViewProps): JSX.Element;
```
Renderer rules (spec §5): materials from `board3dTheme.ts` (`MeshStandardMaterial`; `body` transparent .55, `depthWrite: false`); one `Mesh` per `MeshGroup` with `BufferGeometry` from the typed arrays (`setAttribute('position', new BufferAttribute(positions, 3))`, normals, `setIndex(new BufferAttribute(indices, 1))`); `DirectionalLight(0xffffff, 2.2)` attached to the camera's parent so it follows the view + `HemisphereLight(0xffffff, 0x444444, .6)`; `PerspectiveCamera(35)` framed to `bounds` at elevation 35°, azimuth 30°, `OrbitControls` with `enableDamping`, `minDistance = 0.4·diag`, `maxDistance = 6·diag`; auto-orbit 6°/s until the first `start` event from the controls; render loop only while `needsFrame` (auto-orbit | damping | flip animating), woken by the controls' `change` event; `setPixelRatio(quality === 'full' ? Math.min(devicePixelRatio, 2) : 1)`; `ResizeObserver` on the host. `dispose()` must also `controls.dispose()` and remove the canvas.

Host rules (spec §5, §7): after the renderer's first frame the host writes `data-calls`, `data-triangles` (from `renderer.info()`) and `data-build-ms` (from `scene.stats`) onto `.canvasHost` — the measurement hook Task 11 reads. Renders `.toolbar` (Top · Bottom · Flip · Reset, `<button>`s), the `.canvasHost` div (`tabIndex=0`, arrow keys orbit ±10°, Home = reset), `.caption` (`role="note"`), and the three states: `building` → `<p role="status">Building the board…</p>`; `error` → `.problem` with the message and `Try again`; no WebGL2 → the same title/body as `DesignCanvas`'s `no-webgl` COPY (import nothing from it; copy the two strings verbatim). Caption text order per Global Constraints; `"N features simplified"` = sum of `holes-merged` + `no-courtyard` + `arc-degenerate` counts. Stats line under the caption: `${footprints} footprints · ${pads} pads · ${vias} vias · built in ${Math.round(buildMs)} ms`.

- [ ] **Step 1: tests** — `quality.test.ts` (trivial truth table incl. override) and `Board3DView.test.ts` (happy-dom, mirror `DesignCanvas.test.ts`: fake renderer records `mount/dispose/setView/flip`; a fake `spawn` is NOT reachable from here, so pass a `project` whose board text is the tiny valid board from Task 8 and let the main-thread fallback build it, OR inject the scene via a `useBoardScene` mock with `vi.mock('./useBoardScene', …)` returning a ready scene — do the mock, it is what `viewerPage.test.ts` does for the canvas):

```ts
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardScene } from '@public/services/kicad/board3d/types';
import type { KicadProject } from '@public/services/kicad/types';
import { resetWebgl2ProbeForTests } from '../webgl';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scene = (warnings: BoardScene['warnings'], withBody = true): BoardScene => ({
  bounds: { min: { x: -1, y: -1 }, max: { x: 1, y: 1 } }, thicknessMm: 1.6,
  groups: withBody ? [{ material: 'body', layerName: null, positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) }] : [],
  warnings, stats: { footprints: 2, pads: 4, vias: 1, tracks: 3, triangles: 1, buildMs: 12 },
});
const state = { status: 'ready', scene: scene([]), error: null as string | null, retry: vi.fn() };
vi.mock('./useBoardScene', () => ({ useBoardScene: () => state }));

import Board3DView from './Board3DView';

const project = { name: 'p', files: new Map(), board: 'b.kicad_pcb', sheets: [], root: null } as unknown as KicadProject;
function fakeRenderer() {
  const r = { mounted: 0, disposed: 0, views: [] as string[], flips: 0, mount: async () => { r.mounted++; }, setView: (v: string) => { r.views.push(v); }, flip: () => { r.flips++; }, pause: () => {}, resume: () => {}, dispose: () => { r.disposed++; }, info: () => ({ calls: 0, triangles: 0 }) };
  return r;
}
function setWebgl(ok: boolean) { resetWebgl2ProbeForTests(); HTMLCanvasElement.prototype.getContext = (() => (ok ? { getExtension: () => null } : null)) as never; }

let root: Root, el: HTMLDivElement;
beforeEach(() => { el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); setWebgl(true); });
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('Board3DView', () => {
  it('mounts the renderer once ready and captions the estimate', async () => {
    const r = fakeRenderer();
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => r as never, quality: 'full' })); });
    expect(r.mounted).toBe(1);
    expect(el.querySelector('[role="note"]')?.textContent).toContain('Component bodies are estimates from courtyards, not part shapes.');
    expect(el.textContent).toContain('2 footprints');
  });
  it('lists warnings in the fixed order', async () => {
    state.scene = scene([{ kind: 'zones-unfilled', count: 2 }, { kind: 'no-stackup' }, { kind: 'holes-merged', count: 3 }, { kind: 'no-courtyard', count: 1 }], false);
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => fakeRenderer() as never, quality: 'full' })); });
    const note = el.querySelector('[role="note"]')!.textContent!;
    expect(note.indexOf('Layer thicknesses are not in this file')).toBeLessThan(note.indexOf('2 copper pours were saved unfilled'));
    expect(note).toContain('4 features simplified');
    expect(note).not.toContain('Component bodies');
    state.scene = scene([]);
  });
  it('toolbar drives the renderer and unmount disposes it', async () => {
    const r = fakeRenderer();
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => r as never, quality: 'full' })); });
    const byLabel = (t: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === t)!;
    act(() => { byLabel('Bottom').click(); byLabel('Flip').click(); byLabel('Reset').click(); });
    expect(r.views).toEqual(['bottom', 'reset']);
    expect(r.flips).toBe(1);
    act(() => root.unmount());
    expect(r.disposed).toBe(1);
    root = createRoot(el); // afterEach unmounts again harmlessly
  });
  it('shows the no-WebGL copy and never mounts', async () => {
    setWebgl(false);
    const r = fakeRenderer();
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => r as never })); });
    expect(el.textContent).toContain('This browser has WebGL disabled');
    expect(r.mounted).toBe(0);
  });
  it('error state offers Try again which calls retry', async () => {
    state.status = 'error'; state.error = 'That board file is truncated'; state.scene = null;
    await act(async () => { root.render(createElement(Board3DView, { project, stackup: null, createRenderer: () => fakeRenderer() as never, quality: 'full' })); });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('truncated');
    act(() => { [...el.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!.click(); });
    expect(state.retry).toHaveBeenCalled();
    state.status = 'ready'; state.scene = scene([]); state.error = null;
  });
});
```
SCSS: `.wrap` (flex column, `min-height: 420px` desktop / `300px` ≤ 768), `.toolbar` (flex, gap 6px, buttons styled like `DesignCanvas`'s `.ctl`), `.canvasHost` (`position: relative; flex: 1 1 auto; min-height: 0; border-radius: 8px; overflow: hidden; background: #0f1512`, `&:focus-visible { outline: 2px solid var(--theme-accent) }`), `.caption` (0.8rem, secondary text), `.stats` (mono, 0.72rem), `.status`/`.problem`/`.retry` mirroring `DesignCanvas.module.scss`. Assert one rule from SCSS source in the test if any styling is load-bearing (the `min-height` is: add a source assertion like `StackupPanel.test.ts:364` does).

- [ ] **Steps 2–4:** implement, PASS, gates, commit `feat(board3d): three.js renderer and the 3D host with toolbar, caption and lifecycle`, push.

---

### Task 10: The fifth tab

**Files:** Modify `frontend/src/public/pages/viewer/index.tsx` (`type Tab` :25, `TAB_ID`/`PANEL_ID`/`PANEL_OF` :90-103, `tabs` memo :308-319, the panels near :596-620), `ViewerPage.module.scss` (`.board3dPanel { margin-top: 4px; }` next to `.stackupPanel`); test `viewerPage.test.ts`.

- [ ] **Step 1: tests** — add to `viewerPage.test.ts` (follow its existing `vi.mock` of the canvas; also `vi.mock('@public/components/kicad/board3d/Board3DView', () => ({ default: () => createElement('div', { 'data-testid': 'board3d' }) }))`):

```ts
it('offers a 3D tab for a project with a board, mounts the view only while selected, and unmounts on leaving', async () => {
  // open the Glasgow fixture the way the existing tests do, then:
  const tab3d = [...el.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '3D')!;
  expect(tab3d).toBeDefined();
  expect(el.querySelector('[data-testid="board3d"]')).toBeNull();
  act(() => { tab3d.click(); });
  expect(el.querySelector('[data-testid="board3d"]')).not.toBeNull();
  expect(tab3d.getAttribute('aria-selected')).toBe('true');
  const stackupTab = [...el.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Stackup')!;
  act(() => { stackupTab.click(); });
  expect(el.querySelector('[data-testid="board3d"]')).toBeNull();
});
it('a schematic-only project has no 3D tab', () => {
  // open the fixture the existing 'schematic-only' test in this file uses, then:
  expect([...el.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).not.toContain('3D');
});
```

- [ ] **Step 2: implement** — `type Tab = 'schematic' | 'board' | 'stackup' | 'board3d' | 'bom'`; `TAB_ID.board3d = 'viewer-tab-3d'`; `PANEL_ID.board3d = 'viewer-panel-3d'`; `PANEL_OF.board3d = 'board3d'`; in `tabs`: after the Stackup push, `if (session.project.board != null) out.push({ id: 'board3d', label: '3D' });`; `aria-controls` for the 3D tab only while `tab === 'board3d'` (the panel exists only then — mirror the BOM comment). Panel, placed after the stackup section:

```tsx
{tab === 'board3d' && session.project.board != null && (
  // Mounted ONLY while selected (spec 2026-09-21 D5): the 3D view holds its own
  // WebGL context and releases it on the way out so the 2D embed keeps the
  // browser's one it already has.
  <section id={PANEL_ID.board3d} role="tabpanel" aria-labelledby={TAB_ID.board3d} className={styles.board3dPanel}>
    <Suspense fallback={<p className={styles.notice} role="status">Loading the 3D view&#8230;</p>}>
      <Board3DView project={session.project} stackup={stackup} />
    </Suspense>
  </section>
)}
```
with `const Board3DView = lazy(() => import('@public/components/kicad/board3d/Board3DView'));` at module top (React `lazy` + `Suspense`), and `stackup` computed with `stackupWanted = stackupSeen || tab === 'stackup' || tab === 'board3d'` so the ladder has the reader's rows. The privacy sentence and the KiCanvas credit line are untouched.

- [ ] **Step 3: run the page tests + gates; commit `feat(viewer): the 3D tab`; push.**

---

### Task 11: Build gates, browser measurement, docs

- [ ] **Step 1: bundle gates**

```bash
cd frontend && npm run build 2>&1 | tail -30
K=$(ls dist/assets/kicanvas-*.js | head -1); gzip -9 -c "$K" | wc -c        # must be ≤ 121856 (119 KB)
ls -la dist/assets/board3d-three-*.js dist/assets/board3d-*.js; for f in dist/assets/board3d*.js; do echo "$f $(gzip -9 -c $f | wc -c) gz"; done
grep -c "WebGLRenderer" dist/assets/index-*.js; grep -c "earcut" dist/assets/index-*.js     # both 0
```
Record the numbers in spec §11.

- [ ] **Step 2: local build + browser measurement** — `docker compose up -d --build frontend`, then with chrome-devtools-mcp on `http://localhost/viewer`: click "Try the example project", open the 3D tab, and via `evaluate_script` read the `data-calls`, `data-triangles` and `data-build-ms` attributes the host writes on `.canvasHost` once after the first frame (Task 9 adds them; they are the measurement hook and cost nothing). Read them, sample rAF fps for 3 s while `OrbitControls` auto-orbits, then switch to the Stackup tab and count live WebGL contexts (`performance.memory` before/after; `document.querySelectorAll('canvas').length` should drop by one). Repeat with `emulate` viewport `390x844x3,mobile,touch` for the reduced tier. Targets (spec §9): calls ≤ 20, fps ≥ 50 desktop / ≥ 30 phone, heap returns within 5 MB, contexts back to one. Write the results into spec §11 and `.superpowers/sdd/2026-09-21-3d-board-viewer/progress.md`.

- [ ] **Step 3: docs** — `docs/claude-gotchas/design-viewer.md`: a "3D tab (2026-09-22)" section (the boundary test, D5 teardown, D7 honesty rules, the quality switch, where measurements live); `CLAUDE.md`: one bullet under the Design Viewer gotchas pointing at it (keep the one-liner style: what the tab is, `board3d/` is DOM-free and KiCanvas-free by TEST, three.js only under `components/kicad/board3d/`, bodies are estimates, tear-down on exit, `→ docs/claude-gotchas/design-viewer.md`); memory file `project_3d_board_viewer_2026_09_22.md` + MEMORY.md line. Commit `docs: the 3D board tab`, push.

- [ ] **Step 4: hand-off** — report to the owner for playtest; then the single general review per the 2026-09-22 rule.
