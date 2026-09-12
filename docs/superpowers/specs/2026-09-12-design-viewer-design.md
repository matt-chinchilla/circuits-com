# Design Viewer — KiCad in the browser, stage 1 — Design Spec

**Date:** 2026-09-12 · **Branch:** `updates` · **Migrations:** none · **Status:** approved architecture (sections 1–3 approved in conversation), remainder self-reviewed, awaiting owner review of this file

---

## 1. What this is

The site gets a **Design Viewer**: drop a KiCad project (KiCad 6 or newer) into the
browser and see the schematic, the board, the physical stackup, and a **bill of
materials read straight out of the schematic files and priced across the catalog**
by the existing BOM matcher. Nothing is uploaded. The `/bom` tool gains the same
intake, so a KiCad project prices without a CSV export.

The owner's end goal, verbatim (2026-09-12): *"This application needs to integrate
the KiCad suite in the browser first, and they eventually will only be able to
build using items we have listed on our website in a manner similar to what
DigiKey does."* The owner chose the **library model** for that end state: the
browser side is a viewer plus BOM pricer; the "build with our parts" half arrives
later as a Circuit Center KiCad symbol/footprint library for desktop KiCad,
distributed through KiCad's plugin manager, the way DigiKey's KiCad library works.
This stage therefore keeps the renderer read-only and keeps every unit that the
library stage will reuse (the reader, the BOM bridge, the pages) independent of
the renderer.

**Explicitly out of this stage** (owner, 2026-09-12: "The focus needs to be on
making the working KiCad integration & that is all for this stage"): saving
designs to accounts (a later guideline from the owner), referral-click attribution
from BOM lines, the KiCad plugin, the Gerber viewer, 3D, share links for drawings,
and the symbol/footprint library itself. Section 14 lists them with what this
stage leaves in place for each.

Research behind every decision here: `docs/design-briefs/bom-kicad-research-2026-08-19.md`
(licensing, kicad-cli cost, Gerber, 3D) and `docs/design-briefs/viewer-research-2026-09-12.md`
(storage, renderer state, growth, plugin, landscape — 11 agents, 32 refuted claims).
The stackup reference is `docs/design-briefs/pcb-viewer-stackup-reference.md`.

---

## 2. Decision record

Owner rulings, 2026-09-12. Settled; do not relitigate in review.

| # | Decision | Why |
|---|---|---|
| D1 | First sub-project is the **KiCad-native viewer** (schematic + board from `.kicad_sch`/`.kicad_pcb`); Gerbers and 3D are separate later projects. | One renderer, one reader, fills the BOM seam, ships the stackup panel the owner already specified. |
| D2 | **Code reuse is the product**: the reader, the renderer host, and the BOM workbench are top-level units; `/viewer` and `/bom` compose them. | Owner: "being able to have these be top-level elements that can work together". |
| D3 | **Anonymous visitors: browser-only, nothing stored.** Saving is a later stage with its own guideline. | Owner ruling; the site has three real customer accounts today. |
| D4 | **Own pure-TypeScript reader** for BOM lines and stackup; KiCanvas renders only. | Measured live: KiCanvas discards `in_bom` and `dnp`, so its model cannot produce a correct BOM even in principle. |
| D5 | **KiCanvas vendored as source at commit `b031159eb74aaa7eef2b026fd85d35bc05ff2095`** (2026-04-28, the frozen tip), two patches, built by a pinned esbuild step. | No releases, no npm package, zero commits since April; the source is the only pinnable thing, and the font injection must be patched out. |
| D6 | KiCanvas licensing (a GPL-2.0 header on `src/kicad/text/newstroke-glyphs.ts` vs its own MIT `LICENSE.md`) is the **owner's accepted risk** (BOM spec D8, reaffirmed by the 2026-09-12 packet). Ship the notice verbatim with a source link. | The lawyer question is located; the ruling stands. |
| D7 | **Positioning claims the BOM, not the rendering.** The stackup panel ships because the owner specified it, but it is not the headline. | Four free KiCad viewers exist; PCBWay already shows a layer stack; nobody prices a schematic-side BOM on their own catalog. |
| D8 | **Every phase is built locally, playtested, and waits for the owner's explicit approval** before the next phase or any deploy. | Owner, 2026-09-12: "It is very important to playtest these features before pushing them all to production." |
| D9 | The end state is the **library model**, not a browser editor. | Owner choice after the packet priced both; keeps the $0 budget and the read-only renderer. |

---

## 3. Architecture (approved)

Seven units, three scopes, two pages. Each unit answers "what it does, how you use
it, what it depends on" without reading the others. ESLint boundary rules hold:
public ↛ admin, admin ↛ public, shared ↛ either; nothing in this stage touches
`@admin` or `@shared`.

| Unit | Lives in | Does | Depends on |
|---|---|---|---|
| **Vendored renderer** | `frontend/vendor/kicanvas/` | KiCanvas `src/`, `tsconfig.json`, `LICENSE.md` at the pinned commit; `UPSTREAM` (sha + URL); `patches/*.patch`; `MANIFEST.sha256`. Built by `scripts/build-kicanvas.mjs` into `frontend/vendor/build/kicanvas.js` (gitignored, generated). | esbuild (explicit devDependency, pinned) |
| **KiCad reader** | `@public/services/kicad/` | Pure TypeScript, no DOM. `sexpr.ts`, `project.ts`, `schematicBom.ts`, `boardStackup.ts`, `zip.ts`. | `fflate` (new dependency, MIT, ~8 KB gzip) |
| **Design canvas** | `@public/components/kicad/` | `DesignCanvas.tsx` (host), `kicanvasAdapter.ts` (the only file that touches KiCanvas internals), `KicadDropzone.tsx` (shared intake), `StackupPanel.tsx`. | vendored renderer, reader types |
| **BOM workbench** | `@public/pages/bom/lib/useBomWorkbench.ts` | Today's page-local match / resolve / quantity / DNP / similar-pick / share logic as one hook. | existing `bomApi`, existing `/api/bom/*` |
| **Design session** | `@public/services/designSession.ts` | Module-memory holder for the current `KicadProject` (same pattern as the category memo). Dies on reload. | reader types |
| **Viewer page** | `@public/pages/viewer/` | Intake → tabs Schematic · Board · Stackup · BOM. | canvas, reader, workbench, session |
| **BOM page** | `@public/pages/bom/` | Third intake tile "KiCad project"; optional schematic panel above the table. | canvas, reader, workbench, session |

**Data flow.** Drop → `zip.ts`/files → `KicadProject` → three consumers: BOM
lines to the workbench (which calls `/api/bom/match` exactly as today, identity
fields only), file texts to the canvas, the board to the stackup reader.

**Backend change in this stage: one line** — `/viewer` in the sitemap's static
list. No new endpoint, no migration. Design files never reach the server; the
privacy claim stays structural (BOM spec D7).

---

## 4. The KiCad reader (`@public/services/kicad/`)

Verified this session against KiCad's own demo projects (`complex_hierarchy`,
`stickhub`, `openair-max`; schematic version `20250114`, board versions
`20241229` and `20250907`) and KiCanvas's example corpus (KiCad 6 schematics,
version `20211123`). Where a rule rests on inference it says so.

### 4.1 `sexpr.ts`

Tokenizes KiCad s-expressions into nested arrays of strings. Atoms stay strings
(callers convert numbers). Quoted strings unescape `\\`, `\"`, `\n`, `\r`, `\t`;
`{…}` sequences (KiCad's own escapes for library identifiers) pass through
unchanged. **Iterative, not recursive**, so a 5 MB board cannot overflow the
stack. Two entry points:

- `parse(text): SExpr` — the whole document.
- `topLevelBlocks(text): Iterable<{ head: string; start: number; end: number }>` —
  yields depth-1 blocks by head token with byte offsets, without building the
  tree, so the board reader can parse only `layers`, `general`, `setup` and count
  `via` heads on an 85 MB board without materializing its tracks.

### 4.2 `project.ts` — `KicadProject`

```ts
interface KicadProject {
  name: string;                       // .kicad_pro stem, else root schematic stem, else "design"
  files: Map<string, string>;         // basename → text
  pro: { sheets: [uuid: string, name: string][] } | null;
  root: string | null;                // basename of the root schematic
  sheets: { file: string; uuid: string; text: string }[];   // root first
  board: string | null;               // basename of the .kicad_pcb
  warnings: string[];                 // human-readable, informative
  missingSheets: string[];            // Sheetfile names referenced but absent
  formatVersions: Record<string, number>;   // basename → (version N)
}
```

`buildProject(files: File[]): Promise<KicadProject>` accepts dropped files or one
`.zip` (unzipped with fflate; the central directory's uncompressed sizes are
checked against the caps **before** inflating anything).

Rules:
- Root detection, in order: the schematic whose stem equals the `.kicad_pro`
  stem; else the schematic no `Sheetfile` property names; else the first
  schematic in the set.
- Every `Sheetfile` value referenced by any sheet but absent from the set goes in
  `missingSheets`, by name.
- Ignored on the way in: `-backups/`, `fp-info-cache`, `.kicad_prl`, `.kicad_sym`,
  `.pretty/`, anything else not `.kicad_pro` / `.kicad_sch` / `.kicad_pcb`.
  Directory components are dropped; matching is by basename.
- KiCad 5 refusal **before anything mounts**: a schematic whose first bytes are
  `EESchema Schematic File Version`, or a board whose `(version …)` is below
  `20211014`, produces `error: "KiCad 6 or newer"` and no project.
- Caps: 40 files, 10 MB per file, 25 MB total (the largest real KiCad file the
  research measured is 4.7 MB). Over-cap is a hard error naming the cap.

### 4.3 `schematicBom.ts` — `readBomLines(project): ParseResult`

Walks root → sheets, carrying the instance path (`/root-uuid/sheet-uuid/…`, the
sheet uuids taken from each `(sheet … (uuid …))` block as it is entered).
For each depth-1 `(symbol …)` with a `lib_id`:

1. **One line per instance path, not per symbol.** A sheet placed twice yields
   two references from one drawn symbol (verified: 46 symbols → 92 references).
2. **Reference resolution**, first match wins: the symbol's own
   `(instances (project … (path P (reference R) (unit U))))` entry whose `P`
   equals the current path (KiCad 7+; `P = "/" + rootUuid [+ "/" + sheetUuid…]`,
   verified on the demo); else the root document's
   `(symbol_instances (path P (reference R) …))` table (KiCad 6), where `P` ends
   in the **symbol's** uuid and carries no root uuid — verified for root-level
   symbols (`/<symbol-uuid>`); the sub-sheet form (`/<sheet-uuid>/<symbol-uuid>`)
   is inferred and Phase 1 pins it against a KiCad 6 hierarchical file fetched to
   the scratchpad; else the `Reference` property.
3. **Skip** when `in_bom no`; when the reference starts with `#`; when the
   library symbol (in `lib_symbols`) carries `(power)`.
4. **Multi-unit symbols** dedupe on (path, reference); properties are shared
   across units, so the first unit seen wins.
5. `(dnp yes)` → the line's `dnp` flag. Absent token → `false` (KiCad 6 has no
   `dnp`; the packet marks this token as inferred rather than documented — the
   reader treats its absence as "not DNP", never as an error).
6. **Fields**: `Value`, `Footprint`, `Datasheet`, `Description` by name; every
   other property name is run through the existing `HEADER_ALIASES` table, so an
   `MPN`, `Manufacturer`, `Mfr Part #`, or `Digi-Key_PN` field the designer added
   lands in its role. Empty strings and `~` are `null`.
7. **Grouping**: lines group on (mpn, manufacturer, value, footprint, dnp) →
   `refs[]` sorted naturally (`R2` before `R10`), `qty = refs.length`. This is the
   shape the CSV path produces for a grouped export and what `BomTable` expects.
8. Existing caps apply: `MAX_LINES` (2000) and `MAX_REFS_PER_LINE` (200) from
   `parseBom.ts`; over-cap is the same hard error the CSV path raises.

The returned `ParseResult` is **ready-mapped**: `headers` are the role names,
`headerSignature` is the literal `kicad-sch`, `roleByColumn` is fully assigned,
`unmappedColumns` is empty, so `needsMapping()` is false and the column mapper
never appears. `warnings` carries duplicate references, missing sheets, and
"N symbols skipped: not in BOM / power".

### 4.4 `boardStackup.ts` — `readStackup(boardText): BoardStackup`

```ts
interface BoardStackup {
  copperLayers: { ordinal: number; name: string; kind: 'Signal' | 'Plane' | string }[];
  stackup: { name: string; type: string; thicknessMm: number | null; material: string | null;
             epsilonR: number | null; lossTangent: number | null }[] | null;   // null = no block in file
  copperFinish: string | null;
  listedThicknessMm: number | null;    // sum of thicknesses present in the stackup block
  designThicknessMm: number | null;    // (general (thickness X)) if present
  vias: { through: number; blind: number; micro: number; unknown: number };
  layerCount: number;
}
```

- Copper layers come from the `(layers …)` table in **file order** (KiCad
  writes top → bottom; the ordinal is the position, not the id, because KiCad 9
  renumbered ids). `signal` → Signal, `power` → Plane, anything else shown as-is.
- `stackup` is `null` when `(setup (stackup …))` is absent — KiCad writes the
  block only after Board Setup → Physical Stackup has been opened. **Never
  defaulted.**
- `listedThicknessMm` sums every `(thickness X)` in the block and is labelled as
  that sum; `designThicknessMm` is shown separately when present. They are
  different facts and the panel says which is which.
- Vias: depth-1 heads `(via` → through, `(via blind` → blind, `(via micro` →
  micro; any other second token → `unknown`. KiCad's format docs name exactly
  those two type tokens; the demo boards carried only through vias, so blind and
  micro are verified against the documentation, not a file (packet §8).
- **Not cross-checked against KiCanvas's stackup model** — the live test showed
  it warns from inside the stackup block on a KiCad 10 board (packet §7.7).

### 4.5 `zip.ts`

`unzipToFiles(file: File): Promise<File[]>` using fflate's `unzip` with a size
guard from the central directory (total and per-entry) before inflating; entries
whose names contain `..` or are directories are dropped; basenames only.

---

## 5. The renderer host

### 5.1 Vendoring (`frontend/vendor/kicanvas/`)

`frontend/scripts/vendor-kicanvas.mjs` (run once by hand, re-run only on a
deliberate upstream bump):
1. clones `https://github.com/theacodes/kicanvas` at `b031159eb74aaa7eef2b026fd85d35bc05ff2095`;
2. copies `src/`, `tsconfig.json`, `LICENSE.md` into `frontend/vendor/kicanvas/`;
3. applies `patches/0001-no-google-fonts.patch` and `patches/0002-icon-codepoints.patch`;
4. writes `UPSTREAM` (URL, sha, date) and `MANIFEST.sha256` (one line per file).

**Patch 1** removes the module-evaluation block at the bottom of
`src/kicanvas/elements/kicanvas-embed.ts` that appends a `<link>` to
`fonts.googleapis.com` (and thereby the `fonts.gstatic.com` fetches). The site's
rule is no web-font requests to third parties.

**Patch 2** changes `src/kc-ui/icon.ts` so the Material Symbols glyph is selected
by an 18-entry name → codepoint map instead of a ligature, and drops the Nunito
family to the existing fallback stack. The subset font is built once by
`fontTools` (`varLib.instancer` at wght 400 / opsz 48 / FILL 0 / GRAD 0, then
`pyftsubset --unicodes` for those 18 codepoints, no layout features; measured
2,480 B) and committed at `frontend/public/fonts/kicanvas/material-symbols-subset.woff2`
with its Apache-2.0 notice. The `@font-face` is declared by our host, not by the
vendored code. Watch `src/kc-ui/toggle-menu.ts:115`, whose fallback name
`question-mark` is not a valid ligature today; the map must carry it.

**Build**: `frontend/scripts/build-kicanvas.mjs` mirrors upstream's `scripts/bundle.js`
exactly — entry `vendor/kicanvas/src/index.ts`, `format: esm`, `target: es2022`,
`keepNames`, loaders `.css`/`.svg`/`.glsl`/`.kicad_wks` → **text** (this is why
Vite cannot compile the tree directly: it would inject the CSS globally instead
of handing the string to the shadow root), `define DEBUG=false`, minified — into
`frontend/vendor/build/kicanvas.js` (gitignored). `package.json` gains
`"prebuild"` and `"predev"` running it, and `esbuild` as an explicit pinned
devDependency. Vite alias `@vendor-build` → `vendor/build`; `manualChunks` maps
`/vendor/build/kicanvas` to a `kicanvas` chunk. The host imports it with
`import('@vendor-build/kicanvas')`, typed by a one-line `declare module`. Vite
hashes, minifies, and nginx serves it gzip/brotli-compressed and immutable like
every other chunk.

**Integrity guard** (`frontend/src/public/components/kicad/vendorIntegrity.test.ts`):
recomputes SHA-256 over `vendor/kicanvas/src/**` and compares to the manifest;
asserts no `fonts.googleapis.com` or `fonts.gstatic.com` substring survives in
the tree; asserts `UPSTREAM` names the sha this spec pins. No network.

**Notice**: `frontend/public/vendor/kicanvas/NOTICE.txt` (not `LICENSE*` — the
frontend `.dockerignore` excludes that glob) carries `LICENSE.md` verbatim plus
the upstream URL and commit; the viewer page's footer line reads "Rendering by
KiCanvas (MIT) — source" and links to it.

**Monitoring, $0**: a quarterly hand check recorded in CLAUDE.md — the three
curls with today's expected answers (`pushed_at == 2026-04-28T17:37:55Z`,
`tags == 0`, format-token issue search `== 0`) and `npm view @huaqiu/ecad-renderer`.

### 5.2 `DesignCanvas` (`@public/components/kicad/DesignCanvas.tsx`)

```ts
interface DesignCanvasProps {
  project: KicadProject;
  view: 'schematic' | 'board';
  controls?: 'basic' | 'full';         // default 'full' (see 5.4)
  onState?: (s: CanvasState) => void;  // 'loading' | 'ready' | 'no-webgl' | 'timeout' | 'error'
}
interface DesignCanvasHandle { focusRef(ref: string): FocusResult }   // via useImperativeHandle
type FocusResult = 'focused' | 'not-on-active-sheet' | 'unsupported';
```

Behaviour:
- Probes `document.createElement('canvas').getContext('webgl2')` **before**
  importing anything; `null` → the `no-webgl` state with our own copy ("This
  browser has WebGL disabled…"). KiCanvas has no fallback and no error UI.
- Lazily imports the built module once (module registers the custom elements).
- Renders `<kicanvas-embed controls=… controlslist="nodownload nooverlay" theme="kicad">`
  with one `<kicanvas-source name={basename} type={'schematic'|'board'|'project'}>`
  child per file in the project — for the schematic view: `.kicad_pro` (sheet
  names), root, every sub-sheet; for the board view: the board only. **One embed
  per view**, mounted lazily on first visit and kept mounted; the basic control
  set has no file switcher, and a single embed cannot be told which document to
  show.
- A project change remounts by `key`; the embed reads inline sources once.
- Success = the inner `kc-schematic-app` / `kc-board-app` element exists in the
  shadow root within 8 s; the `loaded` attribute is a false positive (packet).
  Otherwise `timeout`.
- Container: 60vh on desktop, 50vh at ≤768px, `min-height: 320px`; KiCanvas's
  own `size-observer` handles resize.
- Missing sheets: not the canvas's job — `project.missingSheets` is rendered by
  the page before the canvas mounts, naming the files to add. The canvas still
  mounts with what it has (KiCanvas skips a missing sheet with a warning).

### 5.3 `kicanvasAdapter.ts`

The only file that reaches into KiCanvas. `focusRef(embed, view, ref)`:
1. `app = embed.shadowRoot?.querySelector(view === 'board' ? 'kc-board-app' : 'kc-schematic-app')`;
2. `viewer = app?.viewer`; return `'unsupported'` unless `viewer?.document` is
   truthy and `typeof viewer.select === 'function'` and
   `typeof viewer.zoom_to_selection === 'function'`;
3. `viewer.select(ref)` inside try/catch; if `viewer.selected` is falsy →
   `'not-on-active-sheet'` (verified live: a missing reference leaves `selected`
   false and does not throw when a document is loaded);
4. `viewer.zoom_to_selection()` → `'focused'`.

Every branch is unit-tested with a fake element tree. When the internals move,
the page degrades to "open the viewer, no auto-focus" — the feature is a
nice-to-have, never a spec commitment (packet §2).

### 5.4 Sheet switching (hierarchical projects)

Baseline: `controls="full"` on the schematic embed, `controlslist="nodownload nooverlay"`,
because the full set carries KiCanvas's project panel, which is the only
documented way to move between sheets. Phase 0's spike checks whether the app
element exposes the project (`app.project?.set_active_page`); if it does, the
page's own sheet chips drive it, the embed drops to `controls="basic"`, and
`focusRef` becomes cross-sheet (set page, then select). If it does not, the
baseline stands and a chip click for a reference on another sheet shows
"R12 is on sheet *ampli_ht_vertical* — open it in the panel". The reader knows
each reference's sheet, so the message is always exact.

---

## 6. The BOM workbench lift (`useBomWorkbench`)

`useBomWorkbench(parsed: ParseResult | null, options?: { session?: 'viewer' | 'bom' })`
returns:

```ts
{
  rows: TableRow[]; matching: boolean; matchError: string | null;
  resolveNote: string | null; resolveError: string | null;
  buildQty: number; setBuildQty; includeDnp: boolean; setIncludeDnp;
  pickSimilar(rowIndex, sku);
}
```

Moved verbatim from `pages/bom/index.tsx`: the phase-1 match effect, the
resolve stream and its `AbortController`, `applyResolveEvent`,
`settleStragglers`, `startResolve`, `pickSimilar` with its per-row sequence
guard, and the `includeDnp` ref shadow. Share creation already lives in
`ShareBar` (it builds the payload from `rows`, `buildQty`, `includeDnp`) and
stays there; both pages render the same `ShareBar`. The page keeps intake, the
column mapper, share hydration for `/bom/s/:slug`, and layout. **No
behavioural change is intended**; the lift is verified by the existing lib tests
plus a new hook test with a mocked `bomApi` covering: phase-1 → phase-2 handoff,
a superseded similar-pick response being dropped, and an abort on re-parse.

`TableRow.viewerHref` keeps its type (`string | null`) and meaning: a route. When
the design session holds a schematic, every row gets `'/viewer'` and the chip
renders `<Link to={`/viewer#${encodeURIComponent(ref)}`}>`. `BomTable` gains
`onRefClick?: (ref: string) => void`; when present, chips are `<button>`s that
call it instead (in-page focus). The two never coexist on one table.

---

## 7. The pages

### 7.1 `/viewer` (`@public/pages/viewer/index.tsx`, lazy route)

Header band: `page="viewer"`, title "Design Viewer", subtitle "Open a KiCad
project. See the schematic and board, and price the BOM read straight from your
schematic." Two phases.

**Intake.** `KicadDropzone` (react-dropzone, `multiple`, accept `.zip`,
`.kicad_pro`, `.kicad_sch`, `.kicad_pcb`; folder drop accepted where the browser
supports it) with the BOM page's crop-mark drop styling ported into
`ViewerPage.module.scss` via the shared `_bomMaterial.scss` recipes. Beside it,
"Try the example project", which fetches
`/samples/circuitcenter-example-project.zip` (the owner's real KiCad project,
committed on purpose like the example workbook) and hands it to the same
`buildProject` a drop uses. The sample is the owner's own project, supplied as
an input to Phase 2; until it exists the button is not rendered — the site never
ships an invented design. Rejections name the extension, as the BOM intake
does. A KiCad 5 file gets the "KiCad 6 or newer" message with a one-line note
that KiCad 6+ can open and re-save it.

**Loaded.** A strip: project name, `N sheets · M parts · board: yes/no`,
"Open another". Then tabs, each shown only when the project has the data:

| Tab | Shown when | Renders |
|---|---|---|
| Schematic | `root != null` | `DesignCanvas view="schematic"`; above it the missing-sheets notice when any; below it the KiCanvas notice line |
| Board | `board != null` | `DesignCanvas view="board"` |
| Stackup | `board != null` | `StackupPanel` (7.3) |
| BOM | `root != null` | `CoverageStrip` + `BomTable` fed by `useBomWorkbench(readBomLines(project))`; build qty, DNP toggle, `ShareBar` exactly as on `/bom` |

Default tab: Schematic, else Board, else BOM. A chip click on the BOM tab
switches to Schematic and calls `focusRef`; the result drives a small toast
("Focused R12" / "R12 is on sheet X" / nothing when unsupported). Arriving with a
`#ref` hash (from `/bom`) does the same on mount, once, after `ready`.

Loading the project puts it in the design session so `/bom` can pick it up.

**No account surface in this stage**: no save control, no sign-in nudge. The
strip has room for one later.

**Route arrival without a session and without files** (a bookmark to `/viewer`)
shows the intake; `#ref` with no session is ignored.

### 7.2 `/bom` changes

- A third intake tile, **"KiCad project"**, beside "Upload CSV/XLSX" and
  "Paste part numbers", using `KicadDropzone`. A KiCad drop runs `buildProject`
  → `readBomLines` → `handleParsed(result, project.name, '')`; the mapper never
  appears because the result is ready-mapped; the project goes into the design
  session.
- When the session holds a schematic, a **"Show schematic"** toggle above the
  table mounts `DesignCanvas view="schematic"` at 45vh (collapsible); while it is
  open, chips use `onRefClick` (in-place focus); while closed, chips link to
  `/viewer#ref`.
- `?from=kicad` preselects the KiCad tile and shows one line, "Opened from
  KiCad". That is the whole landing seam the later plugin uses; nothing else
  reads it.
- The existing example workbook button stays.

### 7.3 `StackupPanel` (`@public/components/kicad/StackupPanel.tsx`)

The owner's Altium 365 Viewer reference, three zones left → right, reflowing to
a single column at ≤768px:

1. **Cross-section** — an inline `<svg>` drawn to scale from
   `stackup[].thicknessMm` (rows without a thickness get a fixed hairline):
   solder mask green, copper thin bright bands, dielectrics thick olive bands,
   labelled by leader lines to the table rows; via barrels drawn for each via
   type with a nonzero count (through spans the stack; blind and micro drawn as
   partial barrels from the top). Colours are SCSS tokens in
   `StackupPanel.module.scss`, theme-aware via the existing custom properties.
2. **Layer table** — `# | Layer | Type | Thk (mm)`: copper rows carry their
   ordinal, dielectric rows `-`; thickness to four decimals as the reference
   shows; `—` when null.
3. **Summary** — Total layers, Signal, Plane, Dielectric, "Listed thickness"
   (sum, labelled), "Design thickness" (only when present), Thru / Blind /
   Micro via counts, and "Unknown via type: N" only when N > 0.

**Honesty states**: `stackup == null` → the cross-section and table rows for
dielectrics are replaced by "This board has no physical stackup saved (Board
Setup → Physical Stackup in KiCad); showing the copper layers and via counts the
file does carry." The copper rows and via counts still render. A field a file
does not carry is `—`, never a default (stackup reference brief, "Honesty
constraint").

### 7.4 Navigation and SEO

- Home hero quick-links gain **"Design Viewer"** after "BOM Tool"; the browse
  drawer gains an item "Design Viewer" with meta `KiCad`, icon `blueprint`
  (present in the self-hosted Phosphor Light font; `circuitry` is already the
  Parts item's icon).
- `STATIC_PAGE_SEO.viewer`: title "KiCad Design Viewer — View Schematics & Price
  the BOM | Circuit Center"; meta description (≤160 characters) "Open a KiCad
  project in your browser: schematic, board, stackup, and a BOM read from the
  schematic and priced across our distributor catalog. No upload, no account.";
  canonical `/viewer`; `index, follow`. The page's H1 lede carries the full
  positioning sentence from the packet ("…nobody trying to win your board
  order").
- `scripts/seoPrerender.ts` adds `{ urlPath: '/viewer', file: 'viewer/index.html', seo: STATIC_PAGE_SEO.viewer }`.
- `api/app/routes/sitemap.py` `STATIC_PAGES` adds `("/viewer", "weekly", "0.6")`;
  `test_sitemap.py` asserts the loc.
- The page's H1 and first paragraph target the `kicad bom` query cluster (packet
  §4 L5): the words "KiCad", "BOM", "schematic", and "price" appear in the first
  200 characters of copy. No "Gerber viewer" copy anywhere — that cluster is
  owned by fabs and the site is not chasing it.

---

## 8. Error handling

| Where | Condition | Behaviour |
|---|---|---|
| Intake | wrong extension | rejection copy naming the extension; nothing else changes |
| Intake | over a cap | hard error naming the cap (files / per-file / total / BOM lines) |
| Intake | zip with no KiCad files | "No KiCad files in that archive" |
| Reader | KiCad 5 | "KiCad 6 or newer" + the re-save hint, before any mount |
| Reader | missing `Sheetfile`s | project loads; notice names the files; BOM lines from the absent sheets are simply absent and the warning says so |
| Reader | schematic with zero BOM symbols | BOM tab shows the existing empty state with "0 parts in BOM (N skipped as power / not-in-BOM)" |
| Reader | parser exception | caught per file; the file is dropped with a warning naming it; a project with no readable file is a hard error |
| Canvas | no WebGL2 | own state; the BOM and Stackup tabs still work |
| Canvas | 8 s timeout / thrown | own state with "Couldn't render this file" and the KiCad 6+ note; other tabs unaffected |
| Focus | ref not on active sheet / unsupported | toast naming the sheet / silent |
| Workbench | `/api/bom/match` 429 or failure | unchanged from today (`MATCH_THROTTLED` / `MATCH_FAILED`) |

Every state is a component-owned string; none is a bare exception surfacing.

---

## 9. Limits, security, privacy

- **Nothing new touches the server.** The only network call the viewer makes is
  the existing `/api/bom/match` (+ `/resolve`, `/share` on explicit action), with
  the same identity-only body. Quantities, designators, and every byte of the
  design files stay in the browser. Share links carry the derived BOM only, as
  today.
- **Caps**: 40 files, 10 MB per file, 25 MB total, checked from the zip central
  directory before inflating (zip-bomb guard); `MAX_LINES` 2000 and
  `MAX_REFS_PER_LINE` 200 unchanged.
- **Zip entry names**: basenames only; entries containing `..` dropped; no path
  is ever used to write anything.
- **Rendering of file-derived strings** (project name, layer names, materials,
  sheet names, references): React text nodes only — never `dangerouslySetInnerHTML`,
  never an attribute that could become a URL. KiCanvas draws to canvas, not DOM.
- **Third-party requests**: none. Patch 1 is guarded by the integrity test;
  a Phase 2 playtest step checks the network panel for zero requests to any host
  but ours.
- **Memory**: a 25 MB project parses into well under 200 MB of JS heap on a
  laptop (inferred from the demo boards); phones get the same caps and the
  50vh canvas. If Phase 0 measures worse, the total cap drops before the page
  ships.

---

## 10. Testing

Frontend (`vitest`, unit-logic only; DOM tests get happy-dom per file):
- `sexpr.test.ts` — escapes, nesting, `topLevelBlocks` offsets, a 20 000-deep
  synthetic nest (iterative guarantee).
- `project.test.ts` — root detection in each order, missing sheets, ignored
  files, KiCad 5 refusal, caps (synthetic zips built with fflate in the test).
- `schematicBom.test.ts` — one synthetic fixture per rule in §4.3 (KiCad 6
  `symbol_instances` shape, root-level and sub-sheet; KiCad 7+ `instances`; a
  sheet placed twice; `in_bom no`; `#PWR`; `(power)` lib symbol; multi-unit;
  `dnp yes`; user field `MPN`; grouping and natural ref sort; the 2000-line
  cap), plus the owner's project as an integration fixture with pinned counts
  once it is supplied. Synthetic fixtures are hand-written minimal documents in
  `fixtures.ts`, like the BOM parser's; no GPL demo file is ever committed.
- `boardStackup.test.ts` — stackup present / absent, thickness sum vs design
  thickness, via head tokens incl. an unknown one, KiCad 9 layer ids out of
  order, a `topLevelBlocks`-only parse of a synthetic 20 MB board (timing bound).
- `kicanvasAdapter.test.ts` — every branch of `focusRef` against fake elements.
- `useBomWorkbench.test.ts` — the three behaviours in §6 with a mocked `bomApi`.
- `vendorIntegrity.test.ts` — §5.1.
- `designSession.test.ts` — set/get/clear, and that `/viewer#ref` construction
  encodes.

Backend: `test_sitemap.py` gains `/viewer`.

Playtests (each phase's gate; the owner runs them from the checklist the plan
writes): chrome-devtools in a GPU-capable browser against the local stack,
covering the owner's project and the KiCad demo projects fetched to the
scratchpad (never committed): render both views, switch sheets, chip → focus,
the **set of references** on the BOM tab equal to the reference column of a bare
`kicad-cli sch export bom` (one row per symbol, no grouping) on the same project
where the owner can run it — grouping differs by design, the reference set must
not — stackup numbers against Board Setup,
mobile at 390px via `mobile-layout-guard`, network panel = zero third-party
requests, and `npm run build` bundle sizes (the `kicanvas` chunk ≤ 130 KB gzip).

---

## 11. Build order and gates (D8)

Each phase ends with the local stack rebuilt, a written playtest checklist, and a
**STOP for the owner's explicit approval**. No phase begins on the previous
phase's approval; `./deploy.sh` runs only on a separate, explicit ask.

| Phase | Builds | Playtest gate |
|---|---|---|
| **0 — Spike** (throwaway, in the scratchpad) | Vendoring script + esbuild build + a bare page that mounts the built module and renders the owner's project and `stickhub` in Chrome with a GPU; checks `app.project` reachability (5.4); measures heap on the largest file; icon subset renders. | Owner sees both views render; decides sheet-switch route; approves the vendoring approach. Findings amend this spec before Phase 1. |
| **1 — Reader** | `@public/services/kicad/*` + tests + fflate dependency. | `npm test` green; a dev-only console harness prints BOM lines and stackup for a dropped project; owner compares against KiCad's own BOM export. |
| **2 — Canvas + `/viewer` (Schematic, Board)** | Vendored tree, patches, build step, integrity test, `DesignCanvas`, adapter, `KicadDropzone`, the page with two tabs, example project, nav links, SEO/prerender/sitemap. | Owner opens `/viewer` locally, drops a project, switches sheets, sees zero third-party requests, tries a phone width. |
| **3 — BOM bridge** | `useBomWorkbench` lift (no behaviour change), BOM tab on `/viewer`, KiCad tile + schematic toggle on `/bom`, design session, chip focus both directions, `?from=kicad`. | Owner prices their project from `/viewer` and from `/bom`, clicks chips both ways, confirms `/bom` CSV and paste paths still behave. |
| **4 — Stackup** | `boardStackup` panel with the three zones and honesty states. | Owner compares the panel to Board Setup for their board; a board without a stackup block shows the honest state. |
| **Deploy** | On the owner's explicit ask only: deploy-preflight → `./deploy.sh` (frontend + the one-line sitemap change means a full deploy). | Live check: `/viewer` prerendered HTML served, sitemap carries it, chunk sizes, one real project end-to-end on prod. |

---

## 12. File plan

```
frontend/vendor/kicanvas/{src/**, tsconfig.json, LICENSE.md, UPSTREAM, MANIFEST.sha256, patches/0001-no-google-fonts.patch, patches/0002-icon-codepoints.patch}
frontend/vendor/build/kicanvas.js                     (generated, gitignored)
frontend/scripts/vendor-kicanvas.mjs
frontend/scripts/build-kicanvas.mjs
frontend/public/vendor/kicanvas/NOTICE.txt
frontend/public/fonts/kicanvas/material-symbols-subset.woff2 (+ LICENSE-Apache-2.0.txt)
frontend/public/samples/circuitcenter-example-project.zip     (owner-supplied)
frontend/src/public/services/kicad/{sexpr.ts, project.ts, schematicBom.ts, boardStackup.ts, zip.ts, types.ts, *.test.ts, fixtures.ts}
frontend/src/public/services/designSession.ts (+ test)
frontend/src/public/components/kicad/{DesignCanvas.tsx, DesignCanvas.module.scss, kicanvasAdapter.ts (+ test), KicadDropzone.tsx, StackupPanel.tsx, StackupPanel.module.scss, vendorBuild.d.ts, vendorIntegrity.test.ts}
frontend/src/public/pages/viewer/{index.tsx, ViewerPage.module.scss}
frontend/src/public/pages/bom/lib/useBomWorkbench.ts (+ test)
frontend/src/public/pages/bom/index.tsx               (lift + KiCad tile + schematic toggle)
frontend/src/public/pages/bom/components/{BomIntake.tsx, BomTable.tsx}   (tile; onRefClick)
frontend/src/public/services/seoRoutes.ts             (viewer entry)
frontend/scripts/seoPrerender.ts                      (viewer route)
frontend/src/public/pages/home/components/HeroSection.tsx, components/layout/BrowseDrawer/BrowseDrawerBody.tsx  (links)
frontend/src/App.tsx                                  (route)
frontend/vite.config.ts, tsconfig.app.json (unchanged include), .eslintrc.json (ignore vendor/), package.json, .gitignore
api/app/routes/sitemap.py, api/tests/test_sitemap.py
CLAUDE.md                                             (gotchas: vendored renderer + patches; reader rules; no server contact; quarterly check)
```

---

## 13. Design tokens and copy

The viewer page uses the BOM tool's material system (`_bomMaterial.scss`:
`bom-card`, `bom-glass-control`, `bom-primary-control`) so the two tools read
as one family; tab strip and strip chips are `bom-glass-control`. Canvas frame:
`bom-card` with an inset 1px hairline so the KiCad grey does not float on the
page. Copy is sentence case, active voice, and names the file format only as
"KiCad" (no product name containing it — no brand policy exists to check).

---

## 14. Out of scope, with the seam this stage leaves

| Later | What this stage leaves in place |
|---|---|
| Saving designs to accounts (owner's guideline later) | `designSession` holds a `KicadProject`; the strip has room for a save control; the research packet's storage decision (Postgres `bytea` one-zip-per-design behind a `storage_uri` seam, later S3) is recorded and not built |
| Referral-click attribution from BOM lines (packet §4 L1/L2 — the sponsor evidence; prod has 12 clicks total) | none needed; first follow-up after this stage |
| KiCad plugin (Python BOM generator that opens `/bom`) | `?from=kicad` |
| Circuit Center KiCad symbol/footprint library (the library model's second half) | the reader's role mapping already reads any user field, so a library-stamped `CircuitCenter_PN` field will match exactly the day it exists |
| Gerber viewer, 3D | none; separate projects per the August packet |
| Cross-sheet focus | 5.4's spike may deliver it; otherwise the exact-sheet message |
| Drawing share links | the BOM share link continues to carry the derived BOM only |
