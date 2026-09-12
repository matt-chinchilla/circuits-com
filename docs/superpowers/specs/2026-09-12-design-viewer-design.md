# Design Viewer — KiCad in the browser, stage 1 — Design Spec

**Date:** 2026-09-12 · **Branch:** `updates` · **Migrations:** none · **Status:** architecture approved in conversation (sections 1–3 of the draft); this revision folds a four-lens adversarial review (facts, implementability, owner intent, security) — 12 blockers and 45 shoulds, all resolved below — and awaits owner review of the file

---

## 1. What this is

The site gets a **Design Viewer**: drop a KiCad project (KiCad 6 or newer) into the
browser and see the schematic, the board, the physical stackup, and a **bill of
materials read straight out of the schematic files and priced across the catalog**
by the existing BOM matcher. Design files never leave the browser. The `/bom`
tool accepts the same files, so a KiCad project prices without a CSV export.

The owner's end goal, verbatim (2026-09-12): *"This application needs to integrate
the KiCad suite in the browser first, and they eventually will only be able to
build using items we have listed on our website in a manner similar to what
DigiKey does."* The owner chose the **library model** for that end state: the
browser side is a viewer plus BOM pricer; the "build with our parts" half arrives
later as a Circuit Center KiCad symbol/footprint library for desktop KiCad,
distributed through KiCad's plugin manager, the way DigiKey's KiCad library works.
This stage therefore keeps the renderer read-only and keeps every unit the library
stage will reuse (the reader, the BOM units, the pages) independent of the renderer.

**Explicitly out of this stage** (owner, 2026-09-12: "The focus needs to be on
making the working KiCad integration & that is all for this stage"): saving
designs to accounts (a later guideline from the owner), referral-click attribution
from BOM lines, the KiCad plugin, the Gerber viewer, 3D, share links for drawings,
and the symbol/footprint library itself. Section 14 lists them with what this
stage leaves in place for each.

Research behind every decision: `docs/design-briefs/bom-kicad-research-2026-08-19.md`
(licensing, kicad-cli cost, Gerber, 3D) and `docs/design-briefs/viewer-research-2026-09-12.md`
(storage, renderer state, growth, plugin, landscape — 5 researchers, 5 adversarial
verifiers, 1 synthesizer; 21 numbered refutations in its §7). The stackup
reference is `docs/design-briefs/pcb-viewer-stackup-reference.md`.

---

## 2. Decision record

Owner rulings, 2026-09-12. Settled; do not relitigate in review.

| # | Decision | Why |
|---|---|---|
| D1 | First sub-project is the **KiCad-native viewer** (schematic + board from `.kicad_sch`/`.kicad_pcb`); Gerbers and 3D are separate later projects. | One renderer, one reader, fills the BOM seam, ships the stackup panel the owner already specified. |
| D2 | **Code reuse is the product**: the reader, the renderer host, and the BOM units are top-level, page-independent modules; `/viewer` and `/bom` compose them. The BOM library and components therefore **move out of `pages/bom/`** (§3, §6). | Owner: "being able to have these be top-level elements that can work together". A unit that lives inside one page's folder is that page's private code, not a shared unit. |
| D3 | **Anonymous visitors: browser-only, nothing stored.** Saving is a later stage with its own guideline. | Owner ruling; the site has three real customer accounts today. |
| D4 | **Own pure-TypeScript reader** for BOM lines and stackup; KiCanvas renders only. | Measured live: KiCanvas discards `in_bom` and `dnp`, so its model cannot produce a correct BOM even in principle. |
| D5 | **KiCanvas vendored as source at commit `b031159eb74aaa7eef2b026fd85d35bc05ff2095`** (2026-04-28, the frozen tip), two patches, built by a pinned esbuild step. | No releases, no npm package, zero commits since April; the source is the only pinnable thing, and the font injection must be patched out. |
| D6 | KiCanvas licensing: the owner ruled **proceed** in August (BOM spec D8) when the concern was generic. The 2026-09-12 packet then **located** the contradiction — a GPL-2.0-or-later header on `src/kicad/text/newstroke-glyphs.ts`, the 174 KB glyph table that draws every character the renderer produces, versus the project's own MIT `LICENSE.md` — and calls it "the lawyer question, before anything ships publicly" (packet §3 risk 1, §8). **Local phases 0–4 proceed on the August ruling; the Deploy gate in §11 carries an explicit owner decision on the licence before `/viewer` is public.** The notice ships verbatim with a source link either way. | The ruling stands for local work; the new fact is the owner's to rule on before publication, not the spec's to assume. |
| D7 | **Positioning claims the BOM, not the rendering.** The stackup panel ships because the owner specified it, but it is not the headline; the page `<title>` and description lead with the BOM claim. | Four free KiCad viewers exist; PCBWay already shows a layer stack; nobody prices a schematic-side BOM on their own catalog. |
| D8 | **Every phase is built locally, playtested, and waits for the owner's explicit approval** before the next phase or any deploy. | Owner, 2026-09-12: "It is very important to playtest these features before pushing them all to production." |
| D9 | The end state is the **library model**, not a browser editor. | Owner choice after the packet priced both; keeps the $0 budget and the read-only renderer. |

---

## 3. Architecture

Nine units, one scope. Everything in this stage lives in `@public`; nothing
touches `@admin` or `@shared`, and the ESLint boundary rules are untouched.

| Unit | Lives in | Does | Depends on |
|---|---|---|---|
| **Vendored renderer** | `frontend/vendor/kicanvas/` | KiCanvas `src/`, `tsconfig.json`, `LICENSE.md` at the pinned commit; `UPSTREAM`; `patches/*.patch`; `MANIFEST.sha256`. Built by `scripts/build-kicanvas.mjs` into `frontend/vendor/build/kicanvas.js` (generated, gitignored). | esbuild (explicit pinned devDependency) |
| **KiCad reader** | `@public/services/kicad/` | Pure TypeScript, no DOM: `types.ts`, `sexpr.ts`, `project.ts`, `schematicBom.ts`, `boardStackup.ts`, `zip.ts`. | `fflate` (new dependency, MIT); `@public/services/bom/{types,headerAliases}` for the `ParseResult` shape and the role-alias table |
| **BOM library** (moved) | `@public/services/bom/` | Today's `pages/bom/lib/*` verbatim (`parseBom`, `headerAliases` (generated), `types`, `priceBreaks`, `priceSource`, `availability`, `format`, `mapMemory`, `share`, `xlsx`, `bomApi`, `fixtures`, tests) plus the new `useBomWorkbench.ts`. | existing `/api/bom/*` |
| **BOM components** (moved) | `@public/components/bom/` | Today's `pages/bom/components/*` (`BomTable`, `CoverageStrip`, `ShareBar`, `MatchBadge`, `AlternatesDropdown`, `SimilarDropdown`, `ColumnMapper`) with their `.module.scss`. `BomIntake` stays page-local on `/bom`. | BOM library |
| **BOM material** (moved) | `@public/styles/_bomMaterial.scss` | The three recipes both tool pages use (`bom-card`, `bom-glass-control`, `bom-primary-control`). | `@shared/styles` |
| **Design canvas** | `@public/components/kicad/` | `DesignCanvas.tsx` (host), `kicanvasAdapter.ts` (the only file that touches KiCanvas internals), `StackupPanel.tsx`. | vendored renderer, reader types |
| **Design session** | `@public/services/designSession.ts` | Module-memory holder for `{ project: KicadProject, parsed: ParseResult }` (the category memo pattern). Dies on reload. | reader types, BOM types |
| **Viewer page** | `@public/pages/viewer/` | `index.tsx`, `components/ViewerIntake.tsx` (its drop zone), `ViewerPage.module.scss`. | everything above |
| **BOM page** | `@public/pages/bom/` | `index.tsx` and `components/BomIntake.tsx` remain; the page becomes a consumer of the moved library and components like `/viewer`. | everything above |

**The move is mechanical** (`git mv` + import rewrites + the header-alias
generator's output path + CLAUDE.md path mentions) and lands in Phase 3 with the
workbench lift, verified by the existing test suite. It is what D2 asks for by
name, and it is why the reader's dependency column is honest: it needs the BOM
`ParseResult` type and the alias table, which after the move are service code,
not a page's private folder.

**Data flow.** Drop → `zip.ts`/files → `KicadProject` → parsed **once** into a
`ParseResult` and held with the project in the design session → three consumers:
the workbench (which calls `/api/bom/match` exactly as today, identity fields
only), the canvas (file texts), and the stackup reader (the board).

**Backend change in this stage: one line** — `/viewer` in the sitemap's static
list. No new endpoint, no migration. Design files never reach the server.

---

## 4. The KiCad reader (`@public/services/kicad/`)

Verified this session against KiCad's own demo projects (`complex_hierarchy`,
`stickhub`, `openair-max`; schematic version `20250114`, board versions
`20241229` and `20250907`) and KiCanvas's example corpus (schematics at
`20211123`, `20221206`, `20230121` plus four headerless clipboard fragments, none
hierarchical; the KiCad 6 root-level `symbol_instances` form was read from
`symbols.kicad_sch` and `example1.kicad_sch`; boards `20211014`–`20221018`
including `tomu-fpga.kicad_pcb` with blind and micro vias). Where a rule rests on
inference it says so.

`types.ts` holds the shared interfaces (`KicadProject`, `BoardStackup`,
`ViaGroup`, `SExpr`); the other modules import from it.

### 4.1 `sexpr.ts`

Tokenizes KiCad s-expressions into nested arrays of strings. Atoms stay strings
(callers convert numbers). Quoted strings unescape `\\`, `\"`, `\n`, `\r`, `\t`;
`{…}` sequences (KiCad's own escapes inside library identifiers) pass through.
**Iterative, not recursive**, so a board at the per-file cap cannot overflow the
stack. Two entry points:

- `parse(text): SExpr` — the whole document.
- `topLevelBlocks(text): Iterable<{ head: string; start: number; end: number }>` —
  yields depth-1 blocks by head token with byte offsets, without building the
  tree, so the board reader parses only `layers`, `general` and `setup` and
  counts `via` heads on a 10 MB board without materializing its tracks.

The cap is set by the **renderer**, not the reader: KiCanvas does not stream, so
whatever the reader could skim, the canvas still holds in full.

### 4.2 `project.ts` — `KicadProject`

```ts
interface KicadProject {
  name: string;                        // .kicad_pro stem, else root schematic stem, else "design"
  files: Map<string, string>;          // normalized relative path → text (never basename-only)
  pro: { sheets: [uuid: string, name: string][] } | null;
  root: string | null;                 // path key of the root schematic
  sheets: { path: string; uuid: string; text: string }[];   // root first
  board: string | null;                // path key of the .kicad_pcb
  warnings: string[];                  // human-readable, informative
  missingSheets: string[];             // Sheetfile references that resolved to nothing
  formatVersions: Record<string, number>;   // path key → (version N)
}
```

`buildProject(files: File[]): Promise<KicadProject>` accepts dropped files
(with their `webkitRelativePath` when a folder was dropped) or one `.zip`.

Rules:
- **Path-keyed, not basename-keyed.** Two sheets named `regulator.kicad_sch` in
  `power/` and `analog/` are different files. A `Sheetfile` value is resolved
  **relative to the directory of the sheet that references it**; only if that
  misses is a basename match tried, and a basename match that is ambiguous
  (two candidates) is reported as a `warnings` entry naming both and counts as
  missing. Directory traversal (`..`) never resolves.
- Root detection, in order: the schematic whose stem equals the `.kicad_pro`
  stem in the same directory; else the schematic no `Sheetfile` names; else the
  first schematic in the set.
- Every `Sheetfile` reference that resolves to nothing goes in `missingSheets`,
  by the name the file used.
- **Accepted for parsing**: `.kicad_pro`, `.kicad_sch`, `.kicad_pcb`.
  **Accepted for detection only**: `.sch` and `.pro` (KiCad 5's names) — never
  parsed, they exist so a KiCad 5 project produces `error: "KiCad 6 or newer"`
  with the one-line re-save hint instead of a "wrong extension" rejection. A
  `.kicad_pcb` whose `(version …)` is below `20211014` (KiCad 6.0's board format)
  produces the same error. Everything else (`-backups/`, `fp-info-cache`,
  `.kicad_prl`, `.kicad_sym`, `.pretty/`, `.step`, `.wrl`, gerbers, …) is ignored
  silently and never inflated.
- **Intake caps, applied after the ignore filter**: 40 parsed files, 10 MB per
  file, 25 MB total (the largest real KiCad file the research measured is
  4.7 MB; the 85 MB `jetson-agx-thor-baseboard` demo exists and is deliberately
  over the cap). Over-cap is a hard error naming the cap. These numbers are
  **provisional until Phase 0 measures peak heap on a phone** (§9).

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
   `dnp`; the token is inferred rather than documented — absence is "not DNP",
   never an error).
6. **Fields**: `Value`, `Footprint`, `Description` by name; every other property
   name is run through `HEADER_ALIASES`, so an `MPN`, `Manufacturer`,
   `Mfr Part #`, or `Digi-Key_PN` field the designer added lands in its role.
   `Datasheet` is read into the role map for parity with the CSV path and is
   deliberately not surfaced (`ParsedBomLine` has no datasheet field). Empty
   strings and `~` are `null`.
7. **Grouping**: lines group on (mpn, manufacturer, value, footprint, dnp).
   **`qty` is the true instance count** — the reader always knows it exactly.
   `refs[]` is sorted naturally (`R2` before `R10`) and **capped at
   `MAX_REFS_PER_LINE` (200) for display and sharing with a `"+N more"` marker**;
   the cap never touches `qty`. (The CSV path truncates refs with a warning and
   then, lacking a quantity column, would under-count; the KiCad path must not.)
8. `MAX_LINES` (2000) is the same hard error the CSV path raises.
9. **The mapper is skipped because of `roleByColumn`, not `unmappedColumns`**:
   `needsMapping()` is `!canPrice(roleByColumn)` and `canPrice` needs a `'value'`
   or `'mpn'` role. The reader therefore returns `roleByColumn` containing
   `'value'` always and `'mpn'` whenever an MPN field was found, with `headers`
   the matching role-name list of the same length, `headerSignature` the literal
   `kicad-sch`, and `unmappedColumns` empty.

`warnings` carries duplicate references, missing or ambiguous sheets, and
"N symbols skipped: not in BOM / power".

### 4.4 `boardStackup.ts` — `readStackup(boardText): BoardStackup`

```ts
interface ViaGroup { type: 'through' | 'blind' | 'micro' | 'unknown'; start: string; end: string; count: number }
interface BoardStackup {
  copperLayers: { ordinal: number; name: string; kind: 'Signal' | 'Plane' | 'Mixed' | 'Jumper' | string }[];
  stackup: { name: string; type: string; thicknessMm: number | null; material: string | null;
             epsilonR: number | null; lossTangent: number | null }[] | null;   // null = no block in file
  copperFinish: string | null;
  listedThicknessMm: number | null;    // sum of thicknesses present in the stackup block
  designThicknessMm: number | null;    // (general (thickness X)) if present
  vias: ViaGroup[];                    // grouped by (type, start, end)
  layerCount: number;                  // copperLayers.length
}
```

- **A `(layers …)` row is copper iff its name ends in `.Cu`**; non-copper rows
  (`F.SilkS`, `F.Mask`, `Dwgs.User`, … — the majority of the table) are excluded
  from `copperLayers` entirely. Copper rows come in **file order** (KiCad writes
  top → bottom in both id schemes; the ordinal is the position, not the id,
  because KiCad ≤8 numbers `F.Cu 0 … B.Cu 31` and KiCad 9/10 `F.Cu 0, B.Cu 2,
  In1.Cu 4 …`). Type tokens: `signal` → Signal, `power` → Plane, `mixed` → Mixed,
  `jumper` → Jumper, anything else shown as-is.
- `stackup` is `null` when `(setup (stackup …))` is absent — KiCad writes the
  block only after Board Setup → Physical Stackup has been opened. **Never
  defaulted.**
- `listedThicknessMm` sums every `(thickness X)` in the block and is labelled as
  that sum; `designThicknessMm` is shown separately when present. They are
  different facts and the panel says which is which.
- **Vias are read with their real extent**: each depth-1 `(via …)` block yields
  its type from the head (`(via` → through, `(via blind` → blind, `(via micro` →
  micro, any other second token → `unknown`) and its `(layers A B)` pair; groups
  are counted by (type, start, end). Verified against `tomu-fpga.kicad_pcb`
  (KiCanvas `debug/examples`, `(version 20221018)`): 53 `(via blind` and 196
  `(via micro` blocks; the three scratchpad demo boards carry through vias only.
  KiCad uses the single token `blind` for blind **and** buried vias, so the panel
  labels that row "Blind/Buried" as the owner's reference does.
- **Not cross-checked against KiCanvas's stackup model** — the live test showed
  it warns from inside the stackup block on a KiCad 10 board (packet §7.7).

### 4.5 `zip.ts`

`unzipToFiles(file: File): Promise<File[]>` using fflate's `unzip(bytes, { filter })`,
where `filter(info: UnzipFileInfo)` runs **before** any entry is inflated and
sees `name`, `size` (compressed) and `originalSize` (declared uncompressed).
Two guards, deliberately separate:

- **Archive guard** (bomb protection, independent of what the tool reads):
  refuse when the archive itself exceeds 60 MB, when the sum of declared
  `originalSize` exceeds 250 MB, or when any entry's `originalSize / size`
  exceeds 100:1. Declared sizes are attacker-controlled; the ratio cap and the
  archive-size cap are what actually bound the inflate. Phase 1 verifies fflate's
  behaviour when an entry inflates past its declared size and records it.
- **Intake caps** (§4.2) apply only to entries that survive the ignore filter;
  nothing else is inflated.

Entry names are normalized (`\` → `/`, leading `/` stripped); entries containing
`..` or that are directories are dropped; the normalized relative path is the
`files` key.

---

## 5. The renderer host

### 5.1 Vendoring (`frontend/vendor/kicanvas/`)

`frontend/scripts/vendor-kicanvas.mjs` (run once by hand, re-run only on a
deliberate upstream bump):
1. clones `https://github.com/theacodes/kicanvas` at `b031159eb74aaa7eef2b026fd85d35bc05ff2095`;
2. copies `src/`, `tsconfig.json`, `LICENSE.md` into `frontend/vendor/kicanvas/`;
3. applies `patches/0001-no-web-fonts.patch` and `patches/0002-icon-codepoints.patch`;
4. writes `UPSTREAM` (URL, sha, date) and `MANIFEST.sha256` (one line per file).

**Patch 1** (`src/kicanvas/elements/kicanvas-embed.ts`): removes the
module-evaluation block at the bottom that appends a `<link>` to
`fonts.googleapis.com` (and thereby the `fonts.gstatic.com` fetches — two hosts),
and drops `Nunito` from the `:host` font-family stack at line 48 so the fallback
stack is what renders. The site's rule is no web-font requests to third parties.

**Patch 2** (`src/kc-ui/icon.ts`): the Material Symbols glyph is selected by an
18-entry name → codepoint map instead of a ligature, including
`toggle-menu.ts:115`'s fallback name `question-mark`. The subset font is built
once by `fontTools` (`varLib.instancer` at wght 400 / opsz 48 / FILL 0 / GRAD 0,
then `pyftsubset --unicodes` for those codepoints, no layout features; measured
2,480 B) and committed at
`frontend/public/fonts/kicanvas/material-symbols-subset-v1.woff2` with its
Apache-2.0 notice; a regenerated subset gets `-v2` and a matching `@font-face`
update, because `public/` files are served immutable for a year. The
`@font-face` is declared by our host, not by the vendored code.

**Build**: `frontend/scripts/build-kicanvas.mjs` mirrors upstream's
`scripts/bundle.js` options plus `build.js`'s `minify: true` — entry
`vendor/kicanvas/src/index.ts`, `format: esm`, `target: es2022`, `keepNames`,
loaders `.js` → ts and `.css`/`.svg`/`.glsl`/`.kicad_wks` → **text** (this is why
Vite cannot compile the tree directly: it would inject the CSS globally instead of
handing the string to the shadow root), `define DEBUG=false` — into
`frontend/vendor/build/kicanvas.js` (gitignored). **The script is also the
integrity gate**: after bundling it recomputes SHA-256 over `vendor/kicanvas/src/**`
against `MANIFEST.sha256` and fails the build (non-zero) on any mismatch or if the
output contains `fonts.googleapis.com` or `fonts.gstatic.com`. `package.json`
gains `"prebuild"` and `"predev"` running it and `esbuild` as an explicit pinned
devDependency. The frontend Docker image runs `npm run build`, so **this build
runs on the t3.small at deploy time**; the Deploy gate (§11) records that the
image builds without OOM and its wall time. Vite alias `@vendor-build` →
`vendor/build` (in **both** `vite.config.ts` and `vitest.config.ts`, which
declares its own aliases); `manualChunks` maps `/vendor/build/kicanvas` to a
`kicanvas` chunk. The host imports it with `import('@vendor-build/kicanvas')`,
typed by a one-line `declare module`. Vite hashes and minifies; nginx serves it
gzip-compressed (no brotli in this stack) and immutable like every other hashed
chunk. The packet measured the upstream bundle at 112 KB gzip; the Phase 0 spike
records the real chunk size and §10's gate is that number +10%.

`vendorIntegrity.test.ts` runs the same two checks under `npm test` as the fast
local echo. The `.eslintrc.json` `vendor/` ignore is belt-and-braces: lint runs
on `src/` only today.

**Notice**: `frontend/public/vendor/kicanvas/NOTICE.txt` — the aggregated notice
(`LICENSE.md` verbatim, which itself requires reproduction in any distribution,
plus the upstream URL and commit). The vendored `LICENSE.md` stays in the repo
tree; `.dockerignore`'s root-anchored `LICENSE*`/`*.md` patterns do not reach
nested paths, so it is in the image too. The viewer page's footer line reads
"Rendering by KiCanvas — licences" (no SPDX claim, per D6) and links the notice.
Phase 2's checklist confirms the notice is served from the built container.

**Monitoring, $0**: a quarterly hand check recorded in CLAUDE.md — the three
curls with today's expected answers (`pushed_at == 2026-04-28T17:37:55Z`,
`tags == 0`, format-token issue search `== 0`) and `npm view @huaqiu/ecad-renderer`.

### 5.2 `DesignCanvas` (`@public/components/kicad/DesignCanvas.tsx`)

```ts
interface DesignCanvasProps {
  project: KicadProject;
  view: 'schematic' | 'board';
  activeSheet?: string;                // path key of the schematic to show; default root
  onState?: (s: CanvasState) => void;  // 'loading' | 'ready' | 'no-webgl' | 'timeout' | 'error'
}
interface DesignCanvasHandle { focusRef(ref: string, sheet?: string): FocusResult }
type FocusResult = 'focused' | 'not-found' | 'unsupported';
```

**One embed per project, not per view.** The review established against the
pinned source that `kc-schematic-app` / `kc-board-app` expose `project` as a
public field (`src/kicanvas/elements/common/app.ts:47`) holding the same
`Project` the embed provides, that `Project.set_active_page(pageOrPath)`,
`pages()` and `page_by_path()` are public (`src/kicanvas/project.ts:313–367`),
and that both apps already listen for the project's `change` event and load or
hide themselves accordingly (`app.ts:84–93`). So a single `<kicanvas-embed>`
holding every file can be told to show any sheet or the board, and the Schematic
and Board tabs are just `set_active_page` calls. This retires the two-embed
structure and the sheet-switching spike of the draft.

Behaviour:
- **WebGL2 probe, once per document**: a module-scoped memo creates one canvas,
  calls `getContext('webgl2')`, records the boolean, and immediately releases the
  context via `WEBGL_lose_context` so probes never accumulate against the
  browser's live-context cap. `false` → the `no-webgl` state with our own copy;
  KiCanvas has no fallback and no error UI.
- Lazily imports the built module once (the module registers the custom elements).
- Renders `<kicanvas-embed controls="basic" controlslist="nodownload nooverlay" theme="kicad">`
  with one `<kicanvas-source name={pathKey} type={'project'|'schematic'|'board'}>`
  child per project file (the `.kicad_pro` first for sheet names). **Inline
  multi-source mounting is documented but was not exercised in the packet's live
  test** (only URL and directory forms were); it is the first item on the
  Phase 0 spike. If it fails, the fallback is object-URL `src` attributes via the
  embed's `custom_resolver`, and this section is amended before Phase 2.
- `view` / `activeSheet` changes call the adapter's `activate(...)`; a `project`
  change remounts by `key` (the embed reads inline sources once).
- Success = the inner app element exists in the shadow root within
  `CANVAS_READY_MS`; the `loaded` attribute is a false positive (packet). The
  constant is **sized in Phase 0** against the largest permitted file on the
  slowest device in the playtest matrix, not guessed. **On timeout the embed is
  unmounted** (so nothing keeps parsing behind an error card) and a "Try again"
  remounts it; a late arrival after teardown is discarded by construction.
- Container: 60vh on desktop, 50vh at ≤768px, `min-height: 320px`; KiCanvas's
  own `size-observer` handles resize.
- Missing sheets are the page's notice (from `project.missingSheets`), rendered
  before the canvas mounts; the canvas still mounts with what it has (KiCanvas
  skips a missing sheet with a warning).

### 5.3 `kicanvasAdapter.ts`

The only file that reaches into KiCanvas. Every function feature-detects and
returns a result rather than throwing; every branch is unit-tested against a fake
element tree.

- `apps(embed)` → `{ schematic?: HTMLElement & { project?, viewer? }, board?: … }`
  from the shadow root.
- `activate(embed, view, sheetPath?)`: find the app's public `project`; pick the
  page via `pages()` by type (`pcb` for board) and, for schematics, by filename
  match on `sheetPath` (default `root_schematic_page`); call
  `set_active_page(page)`; return `true` only if a page was found.
- `focusRef(embed, ref, sheetPath?)`: `activate` the sheet if given (the reader
  knows each reference's sheet, so cross-sheet focus is "activate, then select");
  then on the schematic app: return `'unsupported'` unless `viewer?.document` is
  truthy and `select` and `zoom_to_selection` are functions; `viewer.select(ref)`
  in try/catch; if `viewer.selected` is falsy → `'not-found'` (verified live: a
  missing reference leaves `selected` false and does not throw when a document is
  loaded); `viewer.zoom_to_selection()` → `'focused'`.

Board focus is implemented by the same code path and unit-tested, but no page
calls it in this stage. When the internals move, the page degrades to "open the
viewer, no auto-focus" — a nice-to-have, never a spec commitment (packet §2).

---

## 6. The BOM workbench lift (`@public/services/bom/useBomWorkbench.ts`)

`useBomWorkbench(parsed: ParseResult | null)` returns:

```ts
{
  rows: TableRow[]; matching: boolean; matchError: string | null;
  resolveNote: string | null; resolveError: string | null;
  buildQty: number; setBuildQty; includeDnp: boolean; setIncludeDnp;
  pickSimilar(rowIndex, sku): void;
}
```

Moved verbatim from `pages/bom/index.tsx`: the phase-1 match effect (keyed on
the **identity** of `parsed`, exactly as the page keys it today — which is why
callers hold `parsed` in state or in the design session and never compute it in
render), the resolve stream and its `AbortController`, `applyResolveEvent`,
`settleStragglers`, `startResolve`, `pickSimilar` with its per-row sequence
guard, and the `includeDnp` ref shadow. Share creation already lives in
`ShareBar` (it builds the payload from `rows`, `buildQty`, `includeDnp`) and
stays there; both pages render the same `ShareBar`. The page keeps intake, the
column mapper, share hydration for `/bom/s/:slug`, and layout. **No behavioural
change is intended.** The pure pieces (`applyResolveEvent`, `settleStragglers`,
the similar-pick sequence guard, `pickMisses`) are exported and unit-tested
directly; no React hook renderer is introduced (the vitest harness is node-env,
`*.test.ts` only, and adds no testing-library dependency).

`TableRow.viewerHref` stays `string | null` but its meaning changes from "the
chip's destination" to **"the viewer route; the chip appends the reference"**:
`BomTable`'s chip render changes from `to={row.viewerHref}` to
``to={`${row.viewerHref}#${encodeURIComponent(ref)}`}`` and the doc comment on
`viewerHref` in `types.ts` says so. When the design session holds a schematic,
every row gets `'/viewer'`. `BomTable` also gains `onRefClick?: (ref: string) => void`;
when present, chips are `<button>`s that call it instead (in-page focus). The two
never coexist on one table.

---

## 7. The pages

### 7.1 `/viewer` (`@public/pages/viewer/index.tsx`, lazy route)

Header band: `page="viewer"`, title "Design Viewer" (the page's only `<h1>`),
subtitle "Open a KiCad project. See the schematic and board, and price the BOM
read straight from your schematic." The opening paragraph under the band carries
the packet's positioning sentence in full. Two phases.

**Intake.** `ViewerIntake` (page-local; react-dropzone, `multiple`, folder drop
where the browser supports it, accept `.zip`, `.kicad_pro`, `.kicad_sch`,
`.kicad_pcb`, `.sch`, `.pro`) styled with the BOM tool's crop-mark drop frame
via the shared material recipes. Rejections name the extension, as the BOM
intake does. A KiCad 5 project gets the "KiCad 6 or newer" message with the
one-line note that KiCad 6+ can open and re-save it.

**"Try the example project"** is rendered only once the owner has answered a
separate question at Phase 2: whether his own project may be committed as the
public sample at `public/samples/circuitcenter-example-project.zip`, or whether
he supplies a throwaway design for it. The site never ships an invented design,
and a real design is confidential IP until its owner says otherwise (BOM spec D3).

**Loaded.** A strip: project name, `N sheets · M parts · board: yes/no`, and
"Open another" (which clears the design session). Then tabs, each shown only
when the project has the data:

| Tab | Shown when | Renders |
|---|---|---|
| Schematic | `root != null` | sheet chips (from `project.sheets`, named via `.kicad_pro` when present) driving `activeSheet`; the missing-sheets notice when any; `DesignCanvas view="schematic"`; the KiCanvas notice line |
| Board | `board != null` | `DesignCanvas view="board"` (the same embed, switched) |
| Stackup | `board != null` | `StackupPanel` (7.3) |
| BOM | `root != null` | `BomTable` (which renders `CoverageStrip` itself) fed by `useBomWorkbench(session.parsed)`; build qty, DNP toggle, `ShareBar` exactly as on `/bom` |

Default tab: Schematic when `root != null`, otherwise Board. **The BOM tab stays
mounted (hidden) once first shown**, so switching tabs never re-runs the match;
the design session holds the `ParseResult`, so `/viewer` → `/bom` → `/viewer`
for one project costs one match, not three. A chip click on the BOM tab switches
to Schematic and calls `focusRef(ref, sheetOfRef)`; the result drives a small
toast ("Focused R12" / "R12 not found on its sheet" / nothing when unsupported).
Arriving with a `#ref` hash (from `/bom`) does the same on mount, once, after
`ready`. A route arrival with no session and no files shows the intake; `#ref`
with no session is ignored.

**No account surface in this stage**: no save control, no sign-in nudge.

### 7.2 `/bom` changes

- **The existing drop zone accepts the KiCad extensions** (`.zip`, `.kicad_pro`,
  `.kicad_sch`, `.kicad_pcb`, `.sch`, `.pro`) beside CSV/XLSX, `multiple` for
  those, and the format line under it names them. No new intake component: a
  KiCad drop runs `buildProject` → `readBomLines` → `handleParsed(result,
  project.name, '')`; the mapper never appears (§4.3 rule 9); the project and
  result go into the design session.
- When a session exists on arrival (from `/viewer`), the intake shows one extra
  control: **"Continue with *<project name>* from the viewer"**, which prices the
  session's `ParseResult` on an explicit click. `/bom` never auto-loads from the
  session.
- In `phase === 'table'` only, when the session holds a schematic, a
  **"Show schematic"** toggle above the table mounts `DesignCanvas view="schematic"`
  at 45vh (collapsible); while open, chips use `onRefClick`; while closed, chips
  link to `/viewer#ref`.
- `ShareBar`'s "Change file" clears the design session, as "Open another" does.
- The existing example workbook button stays. No `?from=kicad` parameter: the
  later plugin emits a CSV and lands on the CSV path that already exists.

### 7.3 `StackupPanel` (`@public/components/kicad/StackupPanel.tsx`)

The owner's Altium 365 Viewer reference, three zones left → right, reflowing to
a single column at ≤768px:

1. **Cross-section** — an inline `<svg>` drawn to scale from
   `stackup[].thicknessMm` (rows without a thickness get a fixed hairline):
   solder mask green, copper thin bright bands, dielectrics thick olive bands,
   labelled by leader lines to the table rows. **Via barrels are drawn from
   each `ViaGroup`'s real `(start, end)` span** — a through via spans the stack,
   a blind group from its actual outer layer to its actual inner one, a buried
   group between its two inner layers — never a guessed "from the top". Colours
   are SCSS tokens in `StackupPanel.module.scss`, theme-aware via the existing
   custom properties.
2. **Layer table** — `# | Layer | Type | Thk (mm)`: rows are `stackup[]` in
   file order (the physical stack, including mask, silk and paste rows), joined
   to the copper ordinal from `copperLayers` by name; every non-copper row shows
   `-`; thickness to four decimals as the reference shows; `—` when null.
3. **Summary** — Total layers (`layerCount`), Signal, Plane (from
   `copperLayers`), Dielectric (stackup rows of type `core` or `prepreg`),
   "Listed thickness" (the sum, labelled), "Design thickness" (only when
   present), via counts as **Thru / Blind-Buried / Micro** with a one-line
   footnote that KiCad's file does not distinguish blind from buried, and
   "Unknown via type: N" only when N > 0.

**Honesty states**: `stackup == null` → zones 1 and 2 are replaced by "This
board has no physical stackup saved (Board Setup → Physical Stackup in KiCad);
showing the copper layers and via counts the file does carry" plus a
copper-only table; zone 3 still renders what it can. A field a file does not
carry is `—`, never a default (stackup reference brief, "Honesty constraint").

### 7.4 Navigation and SEO

- Home hero quick-links gain **"Design Viewer"** after "BOM Tool"; the browse
  drawer gains an item "Design Viewer" with meta `KiCad`, icon `blueprint`
  (present in the self-hosted Phosphor Light font; `circuitry` is already the
  Parts item's icon).
- `StaticPageKey` gains `'viewer'`; `STATIC_PAGE_SEO.viewer`: title
  **"Price a KiCad BOM from Your Schematic — Design Viewer | Circuit Center"**
  (the BOM claim leads, per D7); description (140 characters) "Open a KiCad
  project in your browser: schematic, board, stackup, and a BOM read from your
  schematic and priced across our distributor catalog."; canonical
  `${SITE_ORIGIN}/viewer` (absolute, like every other entry); `index, follow`.
- `scripts/seoPrerender.ts` adds `{ urlPath: '/viewer', file: 'viewer/index.html', seo: STATIC_PAGE_SEO.viewer }`.
- `api/app/routes/sitemap.py` `STATIC_PAGES` adds `("/viewer", "weekly", "0.6")`;
  `test_sitemap.py` asserts the loc.
- Copy targets the `kicad bom` query cluster (packet §4 L5): "KiCad", "BOM",
  "schematic" and "price" appear in the title and the opening paragraph. No
  "Gerber viewer" copy anywhere — that cluster is owned by fabs. The public
  privacy wording everywhere is **"your design files never leave your
  browser"**, never "no upload" (see §9).

---

## 8. Error handling

| Where | Condition | Behaviour |
|---|---|---|
| Intake | wrong extension | rejection copy naming the extension; nothing else changes |
| Intake | archive guard tripped | "That archive is too large to open here" naming the limit hit |
| Intake | over an intake cap | hard error naming the cap (files / per-file / total / BOM lines) |
| Intake | zip with no KiCad files | "No KiCad files in that archive" |
| Reader | KiCad 5 (`.sch`/`.pro`, or a board version below `20211014`) | "KiCad 6 or newer" + the re-save hint, before any mount |
| Reader | missing or ambiguous `Sheetfile`s | project loads; the notice names the files (and both candidates when ambiguous); their BOM lines are absent and the warning says so |
| Reader | schematic with zero BOM symbols | BOM tab shows the existing empty state with "0 parts in BOM (N skipped as power / not-in-BOM)" |
| Reader | parser exception | caught per file; the file is dropped with a warning naming it; a project with no readable file is a hard error |
| Canvas | no WebGL2 | own state; the BOM and Stackup tabs still work |
| Canvas | `CANVAS_READY_MS` elapsed / thrown | embed unmounted; "Couldn't render this file" + the KiCad 6+ note + "Try again"; other tabs unaffected |
| Focus | ref not found / unsupported | toast / silent |
| Workbench | `/api/bom/match` 429 or failure | unchanged from today (`MATCH_THROTTLED` / `MATCH_FAILED`) |

Every state is a component-owned string; none is a bare exception surfacing.

---

## 9. Limits, security, privacy, performance

- **Nothing new touches the server, and no new kind of request.** The viewer's
  network calls are the existing `/api/bom/match` and `/resolve`, whose bodies
  are identity fields only (`BomLineIn`, `extra="forbid"`), plus `/share` on an
  explicit action. **`/share` is the one deliberate exception and already
  discloses it**: creating a link publishes parts, quantities and designators for
  180 days, behind `ShareBar`'s disclosure string and a second confirming click —
  unchanged from `/bom` today. A designator set read from a schematic is exactly
  the same disclosure as one typed into a CSV, and the same string covers it.
  **No design-file byte ever leaves the browser on any path.** The existing
  per-IP limits (`/match` 20/min, `/resolve` 4/min) bound the new entry path;
  the session-held `ParseResult` and the mounted BOM tab keep one project at one
  match.
- **Guards**: the archive guard and intake caps of §4.2/§4.5; `MAX_LINES` 2000
  and `MAX_REFS_PER_LINE` 200 (display) unchanged.
- **Zip entry names**: normalized relative paths; `..` dropped; no path is ever
  used to write anything.
- **Rendering of file-derived strings** (project name, layer names, materials,
  sheet names, references): React text nodes only — never `dangerouslySetInnerHTML`,
  never an attribute that could become a URL. KiCanvas draws to canvas, not DOM.
- **Third-party requests**: none. The build script fails the image build if the
  font hosts survive in the bundle; Phase 2's playtest checks the network panel.
- **Memory is the visitor's, and it is unmeasured on the risk surface.** The
  25 MB total holds the zip bytes, the inflated files, UTF-16 strings in both
  `files` and `sheets[].text`, the s-expression arrays, **and KiCanvas's own
  parsed model and vertex buffers**, which for a board is usually the largest
  item. The draft's "well under 200 MB" was an inference from demo boards on a
  laptop; iOS Safari kills tabs in the low hundreds of MB. **Phase 0 measures
  peak JS heap on desktop and on the owner's phone at the largest permitted
  file**, and the caps in §4.2 are set from that measurement before Phase 2
  ships. Until then they are provisional and this section says so.
- **WebGL contexts**: one probe per document, released; one embed per project.

---

## 10. Testing

Frontend (`vitest`, node environment, `*.test.ts` only; DOM tests get happy-dom
per file):
- `sexpr.test.ts` — escapes, nesting, `topLevelBlocks` offsets, a 20 000-deep
  synthetic nest (iterative guarantee).
- `project.test.ts` — root detection in each order; `Sheetfile` resolved
  relative to the referencing sheet; **two same-named sheets in different
  directories** (both kept, both resolved); an ambiguous basename fallback
  reported; missing sheets; ignored files never inflated; KiCad 5 via `.sch`,
  `.pro`, and an old board version; the archive guard and each intake cap
  (synthetic zips built with fflate in the test, including a declared-size lie
  and a 100:1 ratio entry).
- `schematicBom.test.ts` — one synthetic fixture per rule in §4.3 (KiCad 6
  `symbol_instances` shape, root-level and sub-sheet; KiCad 7+ `instances`; a
  sheet placed twice; `in_bom no`; `#PWR`; `(power)` lib symbol; multi-unit;
  `dnp yes`; user field `MPN`; grouping and natural ref sort; **240 references
  → `qty === 240 && refs.length === 200` with the "+40 more" marker**;
  `canPrice(result.roleByColumn) === true` for a schematic with only `Value`
  fields; the 2000-line cap), plus the owner's project as an integration fixture
  with pinned counts. Synthetic fixtures are hand-written minimal documents in
  `fixtures.ts`, like the BOM parser's; no GPL demo file is ever committed.
- `boardStackup.test.ts` — stackup present / absent; the `.Cu` selector against
  a 30-row layer table; thickness sum vs design thickness; via groups incl.
  blind, micro, an unknown token, and `(layers A B)` spans; KiCad ≤8 and 9/10
  layer ids both ordering by position; a `topLevelBlocks`-only parse of a
  synthetic board **at the 10 MB cap** with a stated time bound.
- `kicanvasAdapter.test.ts` — every branch of `activate` and `focusRef` against
  fake elements, including a missing `project`, a missing page, and a `select`
  that throws.
- `bomWorkbench.test.ts` — the exported reducers: `applyResolveEvent` for each
  event kind, `settleStragglers`, the similar-pick sequence guard dropping a
  superseded response, `pickMisses` with and without DNP.
- `bomTable` chip href — the `#ref` construction with encoding, in the existing
  component test location or a new pure helper test.
- `vendorIntegrity.test.ts` — §5.1.
- `designSession.test.ts` — set/get/clear and that `clear` drops both fields.

Backend: `test_sitemap.py` gains `/viewer`.

Playtests (each phase's gate; the owner runs them from the checklist the plan
writes): chrome-devtools in a GPU-capable browser against the local stack,
covering the owner's project and the KiCad demo projects fetched to the
scratchpad (never committed): render both views, switch sheets, chip → focus
across sheets, the **set of references** on the BOM tab equal to the reference
column of a bare `kicad-cli sch export bom` (one row per symbol, no grouping) on
the same project where the owner can run it — grouping differs by design, the
reference set must not — stackup numbers against Board Setup, mobile at 390px
via `mobile-layout-guard`, network panel = zero third-party requests, the
NOTICE file served, and the `kicanvas` chunk within the Phase 0 measurement +10%.

---

## 11. Build order and gates (D8)

**Prerequisite, before Phase 0:** the owner supplies one real KiCad project
(`.kicad_pro`, every `.kicad_sch`, the `.kicad_pcb`). It is used privately for
Phases 0–1 and as the integration fixture; whether it becomes the public sample
is a separate question at Phase 2 (§7.1).

Each phase ends with the local stack rebuilt, a written playtest checklist, and a
**STOP for the owner's explicit approval**. **No phase begins without the previous
phase's explicit approval, and approval of one phase authorises only that next
phase — never the deploy, which is a separate explicit ask.**

| Phase | Builds | Playtest gate |
|---|---|---|
| **0 — Spike** (throwaway, in the scratchpad) | Vendoring script + esbuild build with the integrity check; a bare page that mounts the built module from **inline `<kicanvas-source>` children** and renders the owner's project and `stickhub` in Chrome with a GPU; `activate` via `app.project.set_active_page` between sheets and to the board; the icon subset renders; measures: chunk size, peak JS heap on desktop and on the owner's phone at the largest permitted file, time-to-app-element for `CANVAS_READY_MS`. | Owner sees both views render and sheets switch; the four measurements are written into §5.1, §5.2, §9 and §10, and the caps are confirmed or lowered. Findings amend this spec before Phase 1. |
| **1 — Reader** | `@public/services/kicad/*` + tests + fflate dependency; the fflate over-run behaviour recorded. | `npm test` green; a dev-only console harness prints BOM lines and stackup for a dropped project; owner compares the reference set against KiCad's own export. |
| **2 — Canvas + `/viewer` (Schematic, Board)** | Vendored tree, patches, build step, `DesignCanvas`, adapter, `ViewerIntake`, the page with two tabs and sheet chips, nav links, SEO/prerender/sitemap, the notice. | Owner opens `/viewer` locally, drops a project, switches sheets and views, sees zero third-party requests and the served notice, tries a phone width; **answers the public-sample question**. |
| **3 — BOM bridge** | The `pages/bom/lib` and `components` move (D2), `useBomWorkbench` lift (no behaviour change), BOM tab on `/viewer`, KiCad extensions on the `/bom` drop zone, "Continue from the viewer", schematic toggle, design session, chip focus both directions. | Owner prices their project from `/viewer` and from `/bom`, clicks chips both ways, confirms `/bom` CSV and paste paths still behave, confirms one project = one match across the round trip. |
| **4 — Stackup** | `boardStackup` panel with the three zones, real via spans, honesty states. | Owner compares the panel to Board Setup for their board; a board without a stackup block shows the honest state. |
| **Deploy** | On the owner's explicit ask only, **after his decision on the KiCanvas licence question (D6)**: deploy-preflight → `./deploy.sh` (the sitemap line makes it a full deploy). | Live: the frontend image built on the box without OOM (wall time recorded); `/viewer` prerendered HTML served; sitemap carries it; chunk sizes; the notice served; one real project end-to-end on prod. |

---

## 12. File plan

```
frontend/vendor/kicanvas/{src/**, tsconfig.json, LICENSE.md, UPSTREAM, MANIFEST.sha256, patches/0001-no-web-fonts.patch, patches/0002-icon-codepoints.patch}
frontend/vendor/build/kicanvas.js                     (generated, gitignored)
frontend/scripts/vendor-kicanvas.mjs
frontend/scripts/build-kicanvas.mjs                   (bundle + integrity gate)
frontend/public/vendor/kicanvas/NOTICE.txt
frontend/public/fonts/kicanvas/material-symbols-subset-v1.woff2 (+ LICENSE-Apache-2.0.txt)
frontend/public/samples/circuitcenter-example-project.zip     (only after the Phase 2 answer)
frontend/src/public/services/kicad/{types.ts, sexpr.ts, project.ts, schematicBom.ts, boardStackup.ts, zip.ts, fixtures.ts, *.test.ts}
frontend/src/public/services/bom/**                   (moved from pages/bom/lib; + useBomWorkbench.ts, bomWorkbench.test.ts)
frontend/src/public/components/bom/**                 (moved from pages/bom/components, minus BomIntake)
frontend/src/public/styles/_bomMaterial.scss          (moved from pages/bom/_bomMaterial.scss)
frontend/src/public/services/designSession.ts (+ test)
frontend/src/public/components/kicad/{DesignCanvas.tsx, DesignCanvas.module.scss, kicanvasAdapter.ts (+ test), StackupPanel.tsx, StackupPanel.module.scss, vendorBuild.d.ts, vendorIntegrity.test.ts}
frontend/src/public/pages/viewer/{index.tsx, components/ViewerIntake.tsx, ViewerPage.module.scss}
frontend/src/public/pages/bom/{index.tsx, components/BomIntake.tsx, BomPage.module.scss}   (consumer of the moved units; KiCad extensions; toggle; continue control)
frontend/src/public/services/seoRoutes.ts             (StaticPageKey + viewer entry)
frontend/scripts/seoPrerender.ts                      (viewer route)
frontend/scripts/gen-header-aliases.mjs               (output path → services/bom)
frontend/src/public/pages/home/components/HeroSection.tsx, components/layout/BrowseDrawer/BrowseDrawerBody.tsx  (links)
frontend/src/App.tsx                                  (route)
frontend/vite.config.ts, frontend/vitest.config.ts (alias), .eslintrc.json (vendor ignore), package.json (scripts, esbuild, fflate), .gitignore (vendor/build)
api/app/routes/sitemap.py, api/tests/test_sitemap.py
CLAUDE.md                                             (gotchas: vendored renderer + patches + build-time integrity gate; reader rules; no server contact; the BOM units' new homes; quarterly check)
```

---

## 13. Design tokens and copy

Both tool pages use the shared material recipes so they read as one family; tab
strip and strip chips are `bom-glass-control`; the canvas frame is `bom-card`
with an inset 1px hairline so the KiCad grey does not float on the page. Copy is
sentence case, active voice, and names the file format only as "KiCad" (no
product name containing it — no brand policy exists to check).

---

## 14. Out of scope, with the seam this stage leaves

| Later | What this stage leaves in place |
|---|---|
| Saving designs to accounts (owner's guideline later) | `designSession` holds `{ project, parsed }`; the strip has room for a save control; the packet's storage decision (Postgres `bytea`, one zip per design, behind a `storage_uri` seam, later S3) is recorded and not built |
| Referral-click attribution from BOM lines (packet §4 L1/L2 — the sponsor evidence). Measured 2026-09-12 by `psql` on prod: **12 rows total** in `outbound_clicks`, all between 2026-08-29 and 2026-09-01, 10 suppliers, 7 parts — below the console's 30-click drawing floor. | none needed; first follow-up after this stage |
| KiCad plugin (Python BOM generator that writes a CSV and opens `/bom`) | nothing to reserve — the CSV path it lands on already exists |
| Circuit Center KiCad symbol/footprint library (the library model's second half) | the reader's role mapping already reads any user field, so a library-stamped `CircuitCenter_PN` field will match exactly the day it exists |
| Gerber viewer, 3D | none; separate projects per the August packet |
| Drawing share links | the BOM share link continues to carry the derived BOM only |
