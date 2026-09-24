# Design Viewer (`/viewer`) — full gotcha histories

Written 2026-09-16 at Phase 5 of the viewer build, the same way the other files
in this directory work: the compressed rule (same bold key) lives in CLAUDE.md's
Gotchas section, and this file holds the full story — evidence, measurements,
dates, rulings and refuted hypotheses.
**Update BOTH files when a rule changes.**

One house-style difference, deliberate: its siblings are flat `- **key (date)**`
bullets, and this file is SECTIONED, because 600 lines of flat bullets are
unreadable. Every `##` heading's bold key still contains its CLAUDE.md bullet
key **verbatim**, so a grep on the CLAUDE.md key lands on the section that owns
it.

Spec: `docs/superpowers/specs/2026-09-12-design-viewer-design.md` (binding
authority on intent). Plan + 48 execution rulings:
`docs/superpowers/plans/2026-09-12-design-viewer.md`, section
`# Rulings I made (final adjudication, 2026-09-14)`.

**What is deployed, and what this file describes.** Phases 0–4 were deployed to
production 2026-09-14 and **production is still `134ba73`**. The parked
mechanical batch (`40bbfd9..3277053` + `547f8f2`, 2026-09-16) and Phase 5's docs
(`5041b94`, `a640967`, `ef2273b`, the fix round `853fce1` + `51c54a7`, the sync
`4798a72` and later) are on `updates` and are **NOT deployed**. This
file and its CLAUDE.md bullets describe the `updates` tree; anything observed on
the live site — including the 2026-09-15 zoom report under **Open** — is
pre-Phase-5 code.

---

## **The Design Viewer renders with a VENDORED KiCanvas, and `scripts/build-kicanvas.mjs` IS the integrity gate (2026-09-12)**

`frontend/vendor/kicanvas/` holds `src/`, `third_party/earcut/`, `patches/`,
`entry.ts`, `MANIFEST.sha256`, `UPSTREAM`, `LICENSE.md`, `tsconfig.json`.
`UPSTREAM` line 2 pins commit `b031159eb74aaa7eef2b026fd85d35bc05ff2095`
(2026-04-28) of https://github.com/theacodes/kicanvas.

`frontend/scripts/build-kicanvas.mjs` runs as `prebuild` AND `predev`, so it
executes inside the production image build on the t3.small, and bundles the tree
with esbuild to the **gitignored** `frontend/vendor/build/kicanvas.js`. Vite
cannot compile the tree directly — upstream loads `.css`, `.svg`, `.glsl` and
`.kicad_wks` as **text**, which is what the script's `loader:` map reproduces.
The host imports the bundle as **`@vendor-build/kicanvas`**. That specifier has
THREE declaration sites and all three must agree: the alias in
`vite.config.ts:123`, the same alias in `vitest.config.ts:21`, and the one-line
`declare module` that types it in
`frontend/src/public/components/kicad/vendorBuild.d.ts`.

The script fails the build on any of three conditions:

1. **Manifest drift** — every file under `src/` and `third_party/earcut/` is
   SHA-256'd and compared to `MANIFEST.sha256`; a file that is gone also fails.
2. **A surviving web-font host** — `fonts.googleapis.com` or `fonts.gstatic.com`
   **in the built output** (site rule: no Google Fonts).
3. **A bundle that registers no elements** — it asserts `define("<name>"` for all
   four of `kicanvas-embed`, `kicanvas-source`, `kc-board-app`, `kc-schematic-app`,
   again **in the built output**.

Condition 3 exists because of a measured near-miss during Task 0.3: a
hash-clean, font-clean **142 KB** bundle that rendered nothing passed every other
check. The embed only *type*-imports the two app classes, so `entry.ts` must
import them for side effect or they and everything they pull vanish. The check
looks for the **registration call**, not the bare element name — `kc-board-app`
and `kc-schematic-app` each occur three times in the broken bundle (the embed's
CSS selector and its HTML template), so a bare-name check would have passed the
defect. Ruling recorded 2026-09-12.

`third_party/` is vendored as `earcut/` ONLY. Ruling: it is the single thing
`src/` compiles from upstream's `third_party/` (the WebGL renderer,
`src/graphics/webgl/vector.ts`); the rest is ~16 MB of font-authoring sources
that would bloat git and the Docker context. Every byte of upstream's own source
that the bundle compiles is hashed.

### Where the manifest boundary actually is

`VENDORED_DIRS = ['src', 'third_party/earcut']` (`build-kicanvas.mjs:20`) is the
hashed set — **151 entries** in `MANIFEST.sha256` — and
`vendorIntegrity.test.ts:17` walks the same two directories. Three things inside
`frontend/vendor/kicanvas/` are therefore **NOT hashed**:

- **`entry.ts`**, the esbuild entry point (`build-kicanvas.mjs:73`) — ours, not
  upstream's;
- **`tsconfig.json`**, which esbuild is pointed at (`:83`);
- **`patches/`**, excluded on purpose — `0001-no-web-fonts.patch` necessarily
  *contains* the font host it removes, so hashing it and scanning it for hosts
  are mutually exclusive.

An edit to `entry.ts` is caught only **indirectly**: by the four-element
`define(` assertion and the font-host check, both of which read the BUILT OUTPUT
rather than the tree — which is exactly the near-miss above, so the coverage is
real but narrow. Widening the manifest to `entry.ts` and `tsconfig.json` is under
**Open**.

**Re-vendor only through `frontend/scripts/vendor-kicanvas.mjs`** — it is what
re-applies the patches and regenerates the manifest. Two patches, no more:

- `0001-no-web-fonts.patch` — strips every web font including Nunito.
- `0002-icon-codepoints.patch` — the site serves a **16-glyph subset** of
  Material Symbols Outlined at `frontend/public/fonts/kicanvas/` with **no
  ligature table**, so the icon NAME in the element's text is mapped to its
  codepoint in a `CODEPOINTS` record. Unmapped names render as their literal
  text on purpose: visibly wrong beats silently blank. This is the trap a
  subset font sets — Material Symbols addresses glyphs by ligature, and dropping
  the ligature table to save bytes breaks every icon at once.

Guard: `frontend/src/public/components/kicad/vendorIntegrity.test.ts` — pins the
commit (`UPSTREAM` line 2), matches the manifest file for file, and scans the
**hashed set** (the same two directories) for `fonts.googleapis.com`,
`fonts.gstatic.com` **and `Nunito`**, i.e. the source side of the check the build
script performs on the output. Neither the script nor the test reads `entry.ts`,
`tsconfig.json` or `patches/`.

### Licence

The programme is **GPL-3.0-or-later** (owner decision, spec D6). Three agreeing
declarations — `LICENSE` at the repo root, `license` in `frontend/package.json`,
`license` in `api/pyproject.toml` — guarded by
`api/tests/test_licence_declared.py`. Third-party notices ship in
`frontend/public/vendor/kicanvas/NOTICE.txt`, served at
`/vendor/kicanvas/NOTICE.txt` and linked from the credit line **under the
drawing** ("Rendering by KiCanvas — licences", no SPDX claim, per D6):
`pages/viewer/index.tsx:529-534`, inside the drawing tabpanel — so it **hides
with that panel** on the BOM and Stackup tabs. It is not a page footer.

### Fixtures are open hardware, and the KiCad demos are NOT GPL

`frontend/src/public/services/kicad/fixtures/` — each directory carries a
`LICENSE` and a `SOURCE` beside the data:

- `glasgow-revC3/` — Glasgow Interface Explorer revC3, **0BSD**.
- `kicad-demos/` — KiCad's own demo projects, **CC BY-SA 4.0** (`demos/*` are
  carved out of KiCad's GPLv3 code licence by its `LICENSE.README`; attribution
  is the `SOURCE` file).
- `bad-thing-panel/` — the Bad Thing of the Edge keyboard panel board, **MIT**
  (© 2023 Rodrigo Feliciano; `github.com/Pakequis/Bad-Thing-of-the-Edge-keyboard`
  @ `f7e73685d0bc05957b2d3bedc635b2414c79a013`). The panelised-board fixture.

An earlier draft of this documentation called the demos "KiCad's GPL demos
riding on the programme's GPL-3.0-or-later licence". **That was wrong and was
corrected during Task 1.4** (ruling 2026-09-12, code `7fd8366`, docs `4716fbc`):
CC BY-SA 4.0 is *one-way compatible* with GPLv3, we do not adapt the files, and
the `shareAlike` gate plus the `SOURCE` string now say the truth in the script,
the test regex, the spec and the plan. Do not re-introduce the GPL claim.

**What the corpus costs, accepted at Task 1.4:** **~6.6 MB** in git and therefore
in the Docker build context (`glasgow.kicad_pcb` alone is 3,470,158 B ≈ 3.47 MB;
`glasgow-revC3/` 4.3 MB, `kicad-demos/` 2.1 MB, `bad-thing-panel/` 252 KB).
Nothing pulls it into the bundle — `fixtures.ts` imports `node:fs` and is
imported only by tests, so Vite never sees it.

### Quarterly hand check (spec §5.1, $0 monitoring) — first due 2026-12-15

Upstream was frozen at the pin, so the whole monitoring budget is four commands
run by hand. Expected answers are as of the pin (research brief
`docs/design-briefs/viewer-research-2026-09-12.md`, 2026-09-12):

```bash
# 1. Has upstream moved at all?   expect: 2026-04-28T17:37:55Z
curl -s https://api.github.com/repos/theacodes/kicanvas | jq -r .pushed_at
# 2. Has it cut a release?        expect: 0   (also 0 releases; `npm view kicanvas` → E404)
curl -s https://api.github.com/repos/theacodes/kicanvas/tags | jq 'length'
# 3. Is anyone reporting a KiCad format token KiCanvas cannot read?   expect: 0
curl -s -G https://api.github.com/search/issues \
  --data-urlencode 'q=repo:theacodes/kicanvas is:issue is:open <format-token terms>' | jq .total_count
# 4. The alternative renderer watch
npm view @huaqiu/ecad-renderer version dist.unpackedSize
```

Two things to know before you run them:

- **The spec fixes the expected answer for (3) but never fixes a query string.**
  §5.1 says only "format-token issue search `== 0`". Phrase it for the thing that
  matters — an open issue saying KiCanvas refuses or mis-draws a newer KiCad
  file-format version token — and **record the string you used** next to the
  result, or the next check is not comparing like with like.
- **(4) is not a 404 watch.** `@huaqiu/ecad-renderer` already exists; at the pin
  its single entry point was ~985 KB gzip (42,380,919 B unpacked) against
  KiCanvas's 112 KB. The decision reopens only if that entry point **shrinks
  materially** — i.e. Huaqiu splits its CJK glyph table out — or if upstream
  KiCanvas unfreezes.

---

## **Nothing outside `@public/components/kicad/kicanvasController.ts` may touch KiCanvas — pages see only `CanvasController` (2026-09-13)**

`@public/components/kicad/canvasController.ts` declares the interface; pages,
the design session and the BOM units see only that. `kicanvasController.ts` is
the single implementation. The later editor stage implements the SAME interface
over KiCad-as-WebAssembly and starts emitting `documentChanged` and `selection`
— that is why the seam exists and why a page must never import a renderer.

```
mount(host, project): Promise<void>        // resolves on ready; never rejects — failures arrive as `state` events
activate(view, sheet?): Promise<boolean>
focusRef(ref, sheet?): Promise<FocusResult>
zoom('fit' | 'in' | 'out'): Promise<boolean>
unrenderableSheets?(project): string[]
dispose(): void
on(type, handler): () => void
```

### The seam is a CONVENTION — nothing enforces it

No ESLint zone and no test police it. `.eslintrc.json`'s
`import/no-restricted-paths` zones are the bounded-context rules only
(admin ↛ public, public ↛ admin, shared ↛ either), and `vendor/` is merely in
`ignorePatterns`. The invariant today is a fact about the tree, not a gate:

```bash
grep -rn "kicanvasController" frontend/src --include=*.tsx --include=*.ts | grep -v test
# → DesignCanvas.tsx:7 (the import) and vendorBuild.d.ts:4 (a comment). Nothing else.
```

**It has been breached once.** Task 3.3's first cut had `pages/viewer/index.tsx`
importing `sourcesFor` straight from the renderer module to mark the dropped
sheet chips. Review caught it before it landed, and the fix was to widen the
interface rather than to allow the import: `unrenderableSheets?(project)` was
added to `CanvasController`, and `DesignCanvas` surfaces it through
`onUnrenderableSheets`. A guard test that scans the import sites is under
**Open** — it is the cheap thing that would have caught that in CI instead.

### `FocusResult = 'focused' | 'not-found' | 'unsupported' | 'superseded'`

**`'superseded'` is not a failure and the host must say NOTHING.** A newer
gesture — the reader picking a different sheet while this focus was still
loading — took the view, and the focus stood down rather than dragging the
drawing back. Narrating a click the reader has already abandoned is worse than
silence. `/viewer` honours this with a `focusSeq` guard so an abandoned click
never toasts; `/bom`'s chip focus is silent on *every* miss today (see **Open**).

### One embed per project, never unmounted across tabs

ONE `<kicanvas-embed>` per project, keyed on project identity. The
Stackup and BOM tabs hide the drawing panel; the same embed survives (verified
in the owner's Chrome, 2026-09-14). Sheets and the board switch through
`project.set_active_page` — the **page object**, never the path string, because
on a path that does not resolve upstream falls back to `first_page`
(`kicanvas/project.ts:353-355`), which shows the WRONG sheet and still looks
like success. `findPage` decides, so a miss is an honest `false`.

`DesignCanvas`'s `project` prop is **referentially stable by contract**: the host
keys its mount on object identity, so a new identity disposes the renderer and
reloads the whole project. Never pass a `buildProject(...)` call from a render
body or a `useMemo` with an unstable dep. The design session holds one object
for exactly this reason.

### The `hidden` re-assert — the "screen duplicates itself" class

Upstream's `app.load()` assigns `hidden = false` **after** an await. A naive
switch therefore races: the app you just hid un-hides itself a microtask later
and both drawings paint at once. The controller re-asserts BOTH apps' `hidden`
after every settled activation, and `mount()` ends with an `activate()` (the
embed's own initial page is `first_page`, which is the **board** on any
board-bearing project — Glasgow included). Caught in Phase 2; ruled 2026-09-12.

Related upstream trap, recorded as a comment citation: `findPage('schematic')`
trusts upstream's `root_schematic_page` **only when its type is `'schematic'`**,
because `project.ts:274` reassigns that field to the FIRST page — the PCB on a
board-bearing project. A test drives a fake whose root page is the pcb.

### Settling: `kicanvas:load`, in-flight watches, `seq` and `mountEpoch`

`activate` settles on the viewer's own `kicanvas:load` event
(`viewers/base/events.ts`), after checking `active_page` identity. Three rounds
of review shaped this:

- Upstream returns EARLY when the target viewer already holds the page's
  document, so **no event will come** — `holdsDocument()` short-circuits.
- But `holdsDocument()` turns true when a load *begins*, not when it ends. So an
  activate that would short-circuit must instead await the controller's own
  armed, unfired watch for that view, bounded by `settleMs` (1500 ms).
  Listeners are one-shot (`{ once: true }`), so nothing leaks; `dispose()`
  cancels the in-flight watches.
- An activation `seq` makes a superseded activate return without touching
  `hidden`; a `mountEpoch` drops every emit and teardown from a stale mount.

`focusRef` waits for the **newest** in-flight activation of the same document.
On a *different* document it yields `'superseded'` and answers quietly — no
re-activate. Ruling (round 2 on Task 3.3): with the host's activate always
naming the focus's own sheet, a different document can only be the reader's own
deliberate choice, and taking the view back would snap the drawing off the sheet
they just picked and leave the chip bar naming a sheet that is not on screen.

`dispose()` walks the embed's shadow roots and calls
`WEBGL_lose_context.loseContext()` on every canvas before removing the element:
browsers cap live GL contexts and the spike's repeated loads degraded visibly.

### The basename collision — `unrenderableSheets` is the seam admitting a real loss

**The reader keys files by full relative PATH when it gets one** (two
`power.kicad_sch` in different folders are different files — see the reader
section: only a ZIP reliably supplies the path). **KiCanvas keys its virtual file
system by BASENAME** and physically cannot hold both. Two correct designs that
disagree at the seam, so the seam reports the loss: `sourcesFor(project)` returns
`{ sources, dropped }`, `unrenderableSheets(project)` answers from the project
alone — before the renderer bundle is even fetched — so a host can mark the
dropped chips on the first paint instead of a frame later.

`unrenderableSheets` is **optional on the interface on purpose**: it is a
statement about one renderer's limits, not about the project. A path-keyed
renderer drops nothing and simply does not implement it. A host MUST treat an
absent implementation as "none", never as "unknown". `DesignCanvas` always calls
`onUnrenderableSheets`, with `[]` when there is no renderer at all (no WebGL2),
so a host is never left holding a set from a previous project.

`activate()` of a dropped path returns false, and `focusRef` maps that to
`'not-found'`.

### Zoom, and what upstream actually does with the wheel

`zoom()` writes `viewer.viewport.camera.zoom` directly, clamped to named
constants `ZOOM_MIN = 0.5` / `ZOOM_MAX = 190`. Those mirror upstream's own
interactive limits: `Viewer.setup()` is the only call site and passes them as
literals — `this.viewport.enable_pan_and_zoom(0.5, 190)`
(`viewers/base/viewer.ts:80`), overriding `PanAndZoom`'s `0.5`/`10` field
defaults (`base/dom/pan-and-zoom.ts:36-37`). They sit on an ECMAScript-private
field (`Viewport.#pan_and_zoom`), so nothing exports them to read at runtime and
the file:line citation is what keeps the literals honest. A zoom BUTTON that
ignored the clamp walks the camera where the wheel can never reach (24 steps in
from 1.0 passes 190; the same out reaches ~0.005 — a board drawn as a dot until
the next wheel event silently re-clamps it).

Two upstream facts, both measured in the vendored source, that surprise everyone
who reports a zoom bug:

1. **Plain wheel PANS; ctrl+wheel and pinch ZOOM.** The gate is
   `prefs.alignControlsWithKiCad` (`base/dom/pan-and-zoom.ts:139,162`). The class
   field declares `= true` (`kicanvas/preferences.ts:20`) — but
   `Preferences.INSTANCE.load()` runs at module scope and reads
   `storage.get("alignControlsWithKiCad", false)`, so on a fresh browser the
   **effective value is `false`**. Reading only the field declaration gives you
   the opposite answer.
2. **Upstream's zoom is origin-anchored too.** `#handle_zoom` looks
   mouse-anchored, but `mouse_world` and `new_world` are BOTH computed *after*
   the zoom mutation (`pan-and-zoom.ts:217-223`), so `center_delta` is always
   `(0, 0)`. The controller's origin-anchored `zoom()` is not a divergence from
   upstream — it matches it.

### The ready deadline lives in the CONTROLLER, not in `DesignCanvas.tsx`

All three of these are easy to go looking for in the React component and not
find.

- **`CANVAS_READY_MS = 15000`** is declared at `kicanvasController.ts:61` and
  consumed at `:183` (as the default for the `readyMs` constructor option).
  `DesignCanvas.tsx` never names it.
- **The deadline is refunded while the tab is hidden**, in the controller's mount
  poll loop (`kicanvasController.ts:272-296`): `deadline += now() - t0` whenever
  `visibility() === 'hidden'`. The refund is arithmetic on **real elapsed time**,
  never a fixed slice — a hidden tab throttles chained timers to about a second,
  so refunding a flat `POLL_MS` (50) gives back ~1/20th of what the wait actually
  spent and fires a FALSE timeout on a mount that was fine. The clock and the
  visibility reader are constructor options so a test can drive them. Why 15 s at
  all: the first GPU mount of Glasgow took **4.3 s** to reach the app element.
- **WebGL2 is probed once per document by a module-level cache in
  `components/kicad/webgl.ts`** (`let probed: boolean | null`), NOT by a React
  memo — `DesignCanvas.tsx:74` calls `webgl2Supported()` straight from the render
  body. The probe is wrapped in try/catch because fingerprint-blocking browsers
  have been seen to THROW from `getContext`, and an escaping throw from a render
  body would reach the ErrorBoundary instead of showing the no-WebGL card the
  probe exists for (and, with `probed` still null, would throw again next render).
  The probe context is released immediately via `WEBGL_lose_context`.

### `DesignCanvas.tsx`

Props: `project view activeSheet? onState? onUnrenderableSheets? createController?
height?('default'|'compact') ref`.

- `onState` is held **through a ref** — adding it to the effect deps would
  remount the canvas on every parent render.
- `.frameCompact` is `height: 45vh` and `flex: 0 0 auto` — `/bom`'s schematic
  panel. Its parent MUST be a flex **column**: every child `DesignCanvas` paints
  is absolutely positioned, so in a flex row the frame resolves to zero content
  width and the drawing is invisible with **no error anywhere**. Pinned by a
  source-level SCSS witness in `bomPage.test.ts`.
- The frame takes `touch-action: none` + `overscroll-behavior: contain` so it can
  pan (accepted trade-off: the page cannot scroll by dragging on the drawing).

---

## **The KiCad reader is OURS and is REQUIRED — KiCanvas discards `in_bom` and `dnp` (2026-09-12)**

`@public/services/kicad/` — `sexpr.ts`, `zip.ts`, `project.ts`,
`schematicBom.ts`, `boardStackup.ts`, `naturalSort.ts`, `fixtures.ts`,
`types.ts`. The renderer cannot be asked for a BOM: it parses schematics for
drawing and throws away exactly the two fields a BOM turns on.

### The dedupe key is the DESIGNATOR, not the instance path

The commit that introduced this is titled "one BOM line per instance path"
(`1c2cdee`, 2026-09-12) and its own code says otherwise — the phrase has
propagated from that subject line into briefs and drafts ever since. Read
`schematicBom.ts:169-175`:

```ts
const isUnannotated = ref.endsWith('?');
const key = isUnannotated
  ? `${pathV7}|${uuid === '' ? `#${instances.length}` : uuid}`
  : tabled == null
    ? `${pathV7}|${ref}`
    : ref;              // ← the default: designator ONLY
```

**The default branch is designator-only, and that is the rule.** A reference
designator names ONE physical part for the whole hierarchy, and a **multi-unit
symbol may draw its units on DIFFERENT sheets** — Glasgow revC3's `U30` is a
5-unit FPGA with units 3+5 on the root sheet and units 1, 2+4 on `io_banks` — so
a path-scoped key buys that chip twice. A sheet placed twice still yields two
lines, because KiCad re-annotates each placement and the two arrive here as two
distinct designators. Pinned by `schematicBom.test.ts` ("dedupes a multi-unit
symbol whose units are drawn on DIFFERENT sheets").

Two inputs cannot support that reasoning, and both fall back to an
instance-path-scoped key:

- **The `Reference`-property fallback** (`tabled == null`, no instance-table hit)
  keys `${path}|${ref}`, because both placements of a sheet read the same cached
  string; a warning names the sheet. Without this a twice-placed sheet would
  halve the order.
- **An unannotated `?` reference** keys `${path}|${uuid}` (the symbol's own uuid,
  path-qualified so a twice-placed sheet still counts twice; a symbol with no
  uuid at all falls back to its ordinal). Never merged — every part would answer
  "R?" — and a warning says N symbol instances are not annotated and to run
  Tools → Annotate Schematic.

The reference itself resolves from, in order:

1. KiCad 7+ per-symbol `(instances …)`, matched on the instance path;
2. KiCad 6's root `symbol_instances` table, keyed `${pathV6}/${uuid}`;
3. the symbol's own `Reference` property.

Skipped: refs starting `#`, `(power)` symbols, and not-in-BOM symbols. `qty` is
the **true instance count**; `refs` is capped at `MAX_REFS_PER_LINE` (200,
declared in `services/bom/parseBom.ts:39` and imported here) for **display only**
and a warning says so, naming the real quantity.

`visit` carries the **ancestor chain** and skips a sheet already on it. KiCad
itself refuses recursive hierarchies; a visited-set would wrongly collapse a
sheet legitimately placed twice, which is why it is a chain and not a set.

`RefLocation` is a **single (first) location** — `{ sheet, instancePath }`. A
list for cross-sheet multi-unit parts is a later contract decision, carried
forward deliberately.

### Path keying is a ZIP property — a dragged FOLDER keys by basename

`project.ts:89` builds each candidate's key from
`(file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name`.
Two of the three ways files arrive satisfy that; the third does not.

- **A ZIP** — `unzipToFiles` normalises each entry's own name and returns
  `new File([data], name)` (`zip.ts:84`), so every `File.name` IS the full
  relative path. Two `power.kicad_sch` in different folders stay two files (and a
  pair that normalises to ONE path is refused outright, `'archive'`). This is the
  case the `unrenderableSheets` contrast above is about.
- **`<input webkitdirectory>`** would populate `webkitRelativePath`, which is the
  other half of line 89. **The viewer does not use one**: both intakes are
  react-dropzone with `useFsAccessApi: false` and no `webkitdirectory` attribute
  (`ViewerIntake.tsx:79-85`, `BomIntake.tsx:208-218`).
- **A dragged folder, or a multi-file pick** — file-selector traverses the
  `FileSystemEntry` tree and stamps the nested path on its **non-standard `.path`
  and `.relativePath`** (`file-selector/dist/file.js`, `toFileWithPath`), leaving
  `webkitRelativePath` empty. `project.ts` reads neither, so those files key by
  **BASENAME** — and two same-named sheets then collapse into the
  "`<path>` was dropped twice; the last copy is the one shown" warning
  (`project.ts:110-111`) instead of staying distinct.

Reading `.path`/`.relativePath` in `project.ts` is small and is under **Open**
(Task 2.4 observation).

### DNP: the schematic path is STRICTER than the CSV path, on purpose

- CSV (`parseBom.ts`): `dnp: at('dnp') !== ''` — any non-empty value.
- Schematic (`schematicBom.ts`): `(dnp yes)` **OR** a property whose header maps
  to the `dnp` role with a value **not** matching `NOT_DNP = /^(no|false|0|n)$/i`.

The difference is deliberate and commented in the code: KiCad field templates
default DNP fields to "No", and Glasgow writes `(dnp no)` on all 347 symbols
while marking its 8 DNP parts by a "DNP" property only. The two intakes
disagreeing is a **product decision left open** (see **Open**), not a bug to
quietly unify.

### Caps — read them from the code, not from the planning docs

`INTAKE_CAPS` in `types.ts`, applied AFTER the ignore filter, to the files the
tool will actually read (owner-approved at the Phase 0 gate):

| | value |
|---|---|
| `files` | 40 |
| `perFileBytes` | 8 MB |
| `totalBytes` | 12 MB |

`ARCHIVE_GUARD`: archive ≤ 60 MB, declared uncompressed total ≤ 250 MB,
per-entry ratio ≤ 100:1 — all checked inside fflate's `filter`, **before THAT
entry inflates**. Be precise about what that buys, because an earlier draft here
said "before any inflate" and that is not what happens: `unzipSync` walks the
central directory and, for every entry the filter accepts, inflates it **inside
the same loop** (`fflate/esm/browser.js`, `unzipSync`). So a throw from a later
entry's filter happens *after* the earlier entries have already inflated, and the
bound is **the running declared total** (≤ 250 MB of accepted entries), not zero
bytes. The declared total accumulates over the entries the tool would READ (i.e.
after the name filter), which is the tighter bound, and the running check runs
before every `return true` so the transient total never exceeds the cap. Declared
sizes are attacker-controlled, which is why the archive-size and ratio caps —
not the declared total — are what actually hold. Cap messages round the actual
size **up** to a tenth, so an 8 MiB + 1 byte file never reads
"8.0 MB; limit 8.0 MB".

**Where the superseded figures still live.** `types.ts:69-75` is the authority.
The spec states the final caps in §4.2 (`:166-167`, "40 parsed files, **8 MB per
file, 12 MB total**"), but the *reasoning* around them still quotes the
pre-Phase-0 provisional 10 MB / 25 MB — §4.2 `:173-175` (the heap extrapolation
that argued them down), §9 `:743`, `:755`, `:759` (the memory bullet, which ends
by recording the lowering); the one line that had gone stale, §10 `:809`
describing `boardStackup.test.ts`'s synthetic board as "at the 10 MB cap" when
the test says 8 MB (`boardStackup.test.ts:54`), was corrected on 2026-09-17
(`4798a72`). Read a figure from `types.ts`, never from a planning document.

Two entries that normalize to the same path make `unzipToFiles` **throw**
`KicadReadError(kind 'archive')` naming the path — a silent keep-last lets a
second copy shadow a real sheet where the path-keyed Map could never see it.
Entries are sorted by path so the output order is a contract rather than
"whatever order the archiver wrote".

### Refusals — `KicadReadErrorKind = 'kicad5' | 'cap' | 'archive' | 'empty' | 'unreadable'`

- **KiCad 5 is refused by name**: a drop of only `.sch`/`.pro`, or any
  `.kicad_pcb` whose `(version …)` is below `MIN_BOARD_VERSION = 20211014`, gets
  `KICAD5_MESSAGE` — "Open it in KiCad 6 or newer and save it — that rewrites it
  in the format this viewer reads."
- **`'empty'` fires twice**: nothing KiCad-shaped in the drop, and — added by
  ruling — a project where neither a schematic nor a board survives the filter
  (a `.kicad_pro` alone shows nothing). The predicate is `root == null &&
  board == null`, so the board-only fixture keeps working.
- **The tokenizer refuses an unbalanced `)` or `(`** rather than reading a
  truncated board as a valid smaller one — `'unbalanced ) at N'` /
  `'unbalanced ( at end of input'`. Without this, `'unreadable'` was unreachable
  on that path. KiCad never writes a stray `)`.

### `readStackup` never returns null — it THROWS, and a FIELD is what goes null

The signature is `readStackup(boardText: string): BoardStackup`
(`boardStackup.ts:77`; it was `:90` until 2026-09-22). There is no nullable
return anywhere in it:

- **It throws `KicadReadError(…, 'unreadable')`** for a file that does not open
  with `(kicad_pcb …)` or whose s-expressions do not balance (the tokenizer's
  plain `Error` is re-labelled to the same `'unreadable'` kind). **Both refusals
  now live in `services/kicad/boardFile.ts` `boardBlocks` (`:20-30`)**, shared by
  all three `.kicad_pcb` readers (4bfc546, 2026-09-22) — the `boardStackup.ts`
  `:91-93` / `:104-108` references this bullet used to give are SUPERSEDED.
- **Otherwise it always returns an object**, whose `stackup` field — with
  `copperFinish` and `listedThicknessMm` alongside it — is `null` when the board
  carries no `(setup (stackup …))` block. **Never a default.** The type says so:
  `types.ts:58`, "null = the board has no (setup (stackup …)) block. Never
  defaulted."

**Every caller must try/catch**, because `project.ts` picks the board by
EXTENSION alone, so a mis-saved or half-copied `.kicad_pcb` really does reach it.
The viewer's memo does (`pages/viewer/index.tsx:574-583` as of 2026-09-22, was `:342-349`; `catch { return null }`)
and that is load-bearing: the call sits in a `useMemo`, so an uncaught throw is
thrown **from a render** and takes the whole page to the `ErrorBoundary` — the
reader loses the schematic and the BOM over a file they may not have come for.
Caught, they lose only the stackup and the panel says so.

Two values are then kept raw on purpose:

- `copperFinish` keeps KiCad's literal `"None"` (3 of 3 stackup boards carry it).
  The Stackup tab must **label** it, never print it as a finish.
- `listedThicknessMm` is the **raw IEEE sum** of every thickness present (e.g.
  `1.5999999999999999`). Rounding it to 3 dp would coincidentally equal
  `designThicknessMm` and kill the comparison the tab exists to make. The VIEW
  rounds, never the reader: ONE `formatMm` at **four decimals**
  (`components/kicad/stackupLayout.ts:67`, shared by the Thk column and by both
  totals), which is KiCad's own Board Setup precision, and a null or non-finite
  figure reads as an em dash — never "0", never "NaN".

### `naturalSort.ts` — a regex-totality trap worth one line

`SPLIT = /^([^\d]*)(\d*)(.*)$/` looks total because every group is
`*`-quantified. It is not: `.` does not match a line terminator and there is no
`m` flag, so once `(\d*)` has taken a digit the trailing `(.*)$` cannot get past
a `\n`, and backtracking cannot either. `exec` returns **null** for `"R1\n"`,
`"R1\nX"`, `"R1\r\nX"` and a designator containing a raw U+2028 line separator (measured). A designator reaches this
from a `.kicad_sch` property and the tokenizer reads a quoted string up to its
closing quote, newlines and all. The `?? [a, a, '', '']` fallback is REACHABLE
and stays — a null-deref here throws from inside a `sort()` and takes the BOM
table down. A reviewer's "exec cannot return null" was refuted and the fallback
is now pinned by a test (2026-09-16, `f7dfec3`).

### Glasgow revC3 — the measured corpus numbers

- 4 copper layers, 13 stackup rows (9 measured), **416** through vias
  (409 plain + 7 `locked`). An earlier `grep -c '(via'` said 410 — it also
  matched `(vias` and `(viasonmask`; the delimiter-aware recount is 416.
- `io_buffer.kicad_sch` is placed twice and contributes **136** of the 257
  reference locations.
- 8 DNP parts by property; 12 DNP *instances* once the twice-placed sheet counts.
- A via head may carry `blind` / `micro` (a **type**) and `locked` (a **flag**) —
  an unknown via token must not become sticky.

---

## **Design files never leave the browser — say exactly that, never "no upload" (2026-09-13)**

Every KiCad file is parsed **client-side**. Two lists, because they are two
different claims and conflating them is how the sentence gets weakened.

**Calls that SEND something derived from the design** — every one of them a
request the BOM tool already made, all in `@public/services/bom/bomApi.ts`:

- `POST /api/bom/match` (`:17`) — identity fields only (`extra="forbid"`, spec D7).
- `POST /api/bom/resolve` (`:33`, a `fetch` because it streams NDJSON) — live
  lookups for unmatched lines, identity fields only.
- `POST /api/bom/share` (`:20`) — **only on an explicit click**, and it DOES
  publish quantities and designators, behind its own disclosure.
- `GET /api/bom/share/{slug}` (`:23`) — the read-back when someone opens a shared
  link. It sends nothing itself, but it is the other half of the share, so the
  list is not complete without it.

**Requests the page makes that carry nothing of the design** — both are
DOWNLOADS, and naming them is what keeps the first list honest:

- The renderer chunk: `import('@vendor-build/kicanvas')` (the default
  `loadModule`, `kicanvasController.ts:181`, awaited in `mount()` at `:250`), so
  it is fetched lazily on the first canvas mount and never on a page that has no
  drawing.
- The example project: `GET /samples/glasgow-revC3.zip` on "Try the example
  project" — `EXAMPLE_URL` at `pages/viewer/components/ViewerIntake.tsx:15`,
  fetched at `:69`. That is the committed
  `frontend/public/samples/glasgow-revC3.zip`, **840,355 bytes (~820 KiB)**,
  committed on purpose exactly like the BOM tool's example `.xlsx`, and handed to
  the **same `buildProject`** a drop uses (the intake's own header comment says
  so) — never a second code path.

**Public copy is "your design files never leave your browser" — never "no
upload."** The Share button is a real publication and the phrase has to survive
it. Rendered today at `pages/viewer/index.tsx` ("Your design files never leave
your browser.") and `pages/bom/components/BomIntake.tsx` ("Your design files
never leave your browser. Only part numbers are sent to us."). In *documentation*
like this file, "no upload" is fine when describing what the code does not do.

### The design session — one global slot, one identity gate

`@public/services/designSession.ts`:
`readDesign / publishDesign / openDesign / getDesignSession / clearDesignSession /
unpriceableReason / NO_BOM_LINES`. It holds `{ project, parsed, refs }`, so
`/viewer` ↔ `/bom` costs one match per project.

`/bom` admits the session **only** through the identity gate
`parsed === session.parsed`, and only when it is usable (`error == null &&
lines.length > 0`). A board-only or over-cap project opens NO session on `/bom`,
and the Continue gate uses the same predicate. Ruling: the session is one global
slot and only the parse that produced it may borrow it.

Two rulings about its lifecycle, both easy to get wrong:

- **`openDesign` is NOT idempotent.** It is `publishDesign(readDesign(project))`
  (`designSession.ts:34-36`) and `readDesign` re-parses the schematic. Call it
  from the **drop handler only, never from an effect** — React 19's StrictMode
  double-invokes effects and you would pay the parse twice. `pages/viewer/index.tsx:185-195`
  carries that comment on `handleProject` for exactly this reason.
- **The slot is released by an explicit choice, never by navigation.** `/viewer`'s
  "Open another" calls `clearDesignSession()` (`index.tsx:444`, and the unmount
  path deliberately does NOT — surviving the `/viewer` ↔ `/bom` trip is the whole
  point). `/bom`'s "Change file" calls it too, but **only when that table came
  from the design** (`pages/bom/index.tsx:286`, `if (design != null)`): a CSV
  priced while a project happened to be open must not close the project, or the
  reader loses it from `/viewer` without ever being asked. A new project replaces
  the slot through `openDesign` / `publishDesign`. Changing TABS never touches it.

### `useBomWorkbench` — shared by `/bom` and the viewer's BOM tab

`@public/services/bom/useBomWorkbench.ts`:

- **One match per `parsed` identity.** `hasLinesToPrice` is the single home for
  "will this parse be priced", and `decidedRef` marks the parse the effect has
  already spoken for — so the hook reports `matching: true` from the FIRST
  render for anything it will price (2026-09-16, `edb6594`; this is what killed
  the `/bom` "Change file" one-commit flash).
- **Zero lines → no match at all**, `matching = false`, and `/bom` keeps its
  table chrome (ShareBar, "Change file") reachable.
- `viewerHref` is held in a ref and **re-stamped, never re-matched** — the guard
  lives in the HOOK, not in the callers, because the viewer's BOM tab is a
  second mounting page and `/bom` is the late-href case by construction.
- A generation ref plus a per-row `pickSeqRef` (last click wins) — two guards
  because they answer different questions; both clicks on one row share a
  generation.
- **`reset()` is TERMINAL for the current `parsed`, and the consumer owes it a
  new one.** Pricing does not resume on its own, by design — re-issuing a match
  the reader just cancelled would spend the resolve budget they declined — and
  the hook prices again only when `parsed` changes IDENTITY, so hand in a fresh
  parse, or `null` and then the same one back. It also drops that parse's
  `WeakMap` snapshot, or handing the same `parsed` back would restore the very
  table they just cleared, out of a cache they cannot see. **Distinct from
  handing the hook `null`**, which means "nothing to price right now": that
  clears the priced result but KEEPS the build quantity and the DNP choice, so a
  consumer re-deriving a BOM (closing and reopening a project) does not silently
  reset a number somebody typed. Null-arming is "close the project"; `reset()` is
  **"Change file"** (`useBomWorkbench.ts:253-269` states the contract, `:615` is
  the implementation).
- `RESOLVE_CAP = 50` lines of the visitor's 100-a-day resolve budget.
- **A module-level `WeakMap<ParseResult, PricedSnapshot>`** restores rows on SPA
  re-entry with **zero requests**. Keyed on parse identity, so the entry's
  lifetime IS the `ParseResult`'s. `remember` refuses empty rows and carries
  `RESOLVE_STOPPED` for rows still resolving; `reset()` drops it.

The `+20%` `SPONSOR_BAND` rule keeps its two mirrored homes unchanged (see the
existing BOM tool bullet).

### The viewer page

`pages/viewer/index.tsx`:

- Full tablist contract: `role="tablist"` labelled "Views", `tab`/`tabpanel` ids
  pointing both ways, roving `tabIndex`, Left/Right/Home/End. The strip is ONE
  tab stop. `aria-controls` is omitted for a panel that has not mounted yet
  rather than naming a missing id.
- `bomSeen` and `stackupSeen` are **one-way latches**. The BOM tab is mounted
  once and kept alive; the stackup is read on the FIRST visit to its tab, and
  the memo gate is `stackupSeen || tab === 'stackup'` so the "could not be read"
  alert can never announce about a board nobody has asked to read
  (2026-09-16, `40bbfd9` — `readStackup` had been running eagerly on project
  open, 323 ms on an 8 MB board).
- **`activeSheet` is a FILE PATH** (what the sheet chips express) while
  `focusRef(ref, instancePath)` is **instance-exact**. No per-instance chips:
  KiCanvas renders one document per sheet file and cannot re-annotate it per
  instance, so an instance chip would change nothing on screen. Ruling owed to
  Phase 4 from the 2.5 review.
- `pendingFocus` + `focusSeq`: a chip clicked during the "Rendering…" window
  lands when the canvas reports ready, and an abandoned click never toasts.
  `/bom` mirrors `pendingFocus` for its schematic panel — a click during that
  ~9 s window is the likeliest click on `/bom`.
- The example credit line is `EXAMPLE_CREDIT` in
  `pages/viewer/components/ViewerIntake.tsx`: "Example: Glasgow Interface
  Explorer revC3, 0BSD".

### Stackup tab

`stackupLayout.ts` is pure and `StackupPanel.tsx` draws it.

- `summarize` buckets `signal / plane / mixed / jumper / other`, and they **SUM
  to the copper count**. KiCad's Board Setup offers Mixed and Jumper beside
  Signal and Plane, and a summary that loses layers is wrong data, not a copy
  choice. The panel renders only the non-zero buckets.
- `bands` is **floors-first, exact fit** — the reviewer's test is the contract;
  the brief's algorithm was wrong and was replaced.
- `minHeightPx` is exported and the drawing box is clamped to it, so the box can
  never go below the floors' sum.
- `viaSpans` lanes are numbered by **DRAWN order**, not source index, and a
  group the stack cannot anchor leaves no empty lane behind it.
- Labels are placed copper-first with colliders **dropped**: Glasgow's three
  ~67-unit dielectrics sit beside eight rows of 1–7 units, so labelling all 13
  renders a smear. Seven are drawn and the copy points at the table, which is
  the complete record.
- The zones step to **two columns** between `$bp-mobile` and `$bp-tablet`: three
  floors of 220 + 260 + 180 plus two 20px gaps = 700px never fit the 695px
  available at 769px (`W - 40 .page - 32 .panel - 2 border`). Labels at 769px are
  now ~11.8px, measured 8.46px before (2026-09-16, `11dea36`). Pinned by an SCSS
  witness; **not** browser-measured (Docker was down) — playtest at 769px and
  1024px.

---

## **`vitest` runs with `css` at its default FALSE, so a CSS-module class assertion proves NOTHING (2026-09-13)**

Two genuinely new facts, surfaced by this build but true of every frontend test
in the repo. (The third thing people reach for here — that test files are
excluded from `tsc -b` and eslint — is already stated in CLAUDE.md's **Static
analysis** paragraph and is not repeated a third time. The consequence worth
remembering is that a type error in a test is seen only by vitest, which is how a
wrong `atom()` signature in a brief's own test reached review.)

- **`css` is at vitest's default `false`** — note it is a default, not a line in
  `vitest.config.ts`; `grep css vitest.config.ts` returns nothing, and the
  behaviour would change silently if anyone ever set `css: true` for an unrelated
  reason. A CSS-module import therefore returns a proxy that **echoes the key
  back**, so `expect(el.className).toContain(styles.foo)` passes whether or not
  the rule exists. A rule's EXISTENCE needs a **source-level SCSS witness**:
  `readFileSync(join(__dirname, 'X.module.scss'))` and assert on the rule body.
  Canonical examples: `bomPage.test.ts` (the flex column that makes the compact
  canvas visible at all) and `StackupPanel.test.ts`; both comment the reason.
- **DOM tests are happy-dom + `react-dom/client` + `act`. There is no testing
  library.** `vitest.config.ts` sets `environment: 'node'` and
  `include: ['src/**/*.test.ts']`; a DOM test opts in with a
  `// @vitest-environment happy-dom` directive at the top of the file.
  `DesignCanvas.test.ts` is the canonical harness — a fake controller injected
  through the `createController` prop, which is also why that prop exists.

The frontend suite at the time of writing: **106 files / 1316 tests**
(2026-09-16).

---

## **The 3D tab — `board3d/` is DOM-free and KiCanvas-free BY TEST, and the panel is torn down on the way out (2026-09-22)**

A fifth tab on `/viewer`, **3D**, orbits the dropped board. Spec:
`docs/superpowers/specs/2026-09-21-3d-board-viewer-design.md`; plan:
`docs/superpowers/plans/2026-09-22-3d-board-viewer.md`. Two halves:

- **`@public/services/kicad/board3d/`** — the PURE pipeline. Board text →
  `BoardModel` → a `BoardScene` of merged typed-array mesh groups. No DOM, no
  three.js, no KiCanvas, no `fetch(`. Unlike the `kicanvasController` seam (a
  convention nothing enforces — see above), **this one is a GATE**:
  `board3dBoundary.test.ts` walks the directory and fails on any of
  `vendor/kicanvas`, `@vendor-build`, `kicanvasController`, three,
  `document.`, `window.`, `fetch(`, and separately asserts that **no file under
  `src/public` outside `components/kicad/board3d/` imports three at all**.
  **Widened 2026-09-22 (308935b)** because the gate had holes: it matched only
  `from 'three`, while the renderer loads three with `import('three')`, so a
  stray dynamic import anywhere passed — it now matches both forms and pins that
  the one sanctioned importer IS seen; the network deny-list is `fetch(`,
  `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`, `importScripts`,
  `new Image`; and the scan follows the pipeline's `../` imports (`sexpr.ts`,
  `types.ts`), which live outside the folder. (One comment in `sexpr.ts` said
  `document.` and was reworded.) The
  board text comes from `session.project.files.get(session.project.board)` — the
  design session, never the renderer.
- **`@public/components/kicad/board3d/`** — the host. `Board3DView.tsx` (default
  export, props `{ project, stackup, createRenderer?, quality? }`) over the
  `SceneRenderer` seam in `sceneRenderer.ts`, which is the ONLY file that imports
  three, and does it with a dynamic `import()` so three lands in its own chunk.

**Chunks (453ed5d, 2026-09-22).** `manualChunks` names exactly two 3D chunks:
`board3d-three` (three + OrbitControls) and `board3d` = **earcut ALONE** (7,403
B raw / 3,161 B gz, was 31,192 / 12,237). It used to send the whole
`services/kicad/board3d` folder to `board3d`, and Rollup then pulled the
pipeline's shared deps (`services/kicad/types.ts`, `sexpr.ts`) in with it —
which `useBomWorkbench` and the `/bom` + `/viewer` route chunks import — so
every visit to either page loaded earcut and the pipeline statically, 3D or
not. The pipeline needs no name: it is reachable only through the lazy
`Board3DView` (which carries the no-worker fallback copy) and its worker, and
splits there by itself. A config witness in `board3dBoundary.test.ts` reads
`vite.config.ts` and fails on any `id.includes('…services/kicad/board3d…')`.

### The page wiring

`type Tab` gained `'board3d'` (label **3D**, ids `viewer-tab-3d` /
`viewer-panel-3d`), offered for **any project with a board** — the same rule as
Stackup, because the panel is where an unreadable board gets its explanation.
`Board3DView` is a React `lazy()` behind a `<Suspense>`, so the renderer's chunk
is fetched on the first visit and never by a reader who came for the BOM.

**The panel is MOUNTED ONLY WHILE ITS TAB IS SELECTED** (spec D5) — every other
panel on this page is mounted for the session and shown with `hidden`, and
copying that pattern here would leave a second live WebGL context beside
KiCanvas's for the rest of the visit. Two consequences:

- `aria-controls` for the 3D tab is emitted only while `tab === 'board3d'`
  (`panelIdFor()` in `pages/viewer/index.tsx`), exactly as the BOM tab's is
  emitted only once its panel exists. The tablist-contract test skips both.
- **Measured teardown**: leaving the tab takes the page from 3 canvases to 2 (the
  2D embed's two survive) and the JS heap back to within 0.2 MB. A return trip
  re-mounts from `useBoardScene`'s per-project cache — 483 ms to first frame
  against 1,629 ms cold, with no rebuild.
- `.board3dPanel` must be `display: flex; flex-direction: column; flex: 1 1 auto;
  min-height: 0` like `.drawing`. Without it the panel is a content-height flex
  item and the board renders **317px tall in a 900px viewport** (measured), because
  the host's own `min-height: 420px` is then the only thing giving it a size.
- `stackupWanted` ORs in `tab === 'board3d'`: the 3D view wants the same z ladder
  the Stackup tab reads, and the board is re-tokenised once per session, not once
  per tab. **That last claim was FALSE until 2026-09-22 (57fa887):** the OR alone
  dropped the memo the moment the reader left 3D, so every return re-tokenised
  the whole board inside the tab click. The 3D tab now also SETS the
  `stackupSeen` latch (`tab === 'stackup' || tab === 'board3d'`).

### Honesty (spec D7) — what the caption may and may not say

Nothing is measured that the board did not state. `thicknessMm` is the stackup
reader's listed sum **or null** — never 1.6. Component bodies are estimated from
**courtyards**, and the caption says so in those words. Every simplification is
COUNTED, in the fixed order `captionOf()` pins: bodies-are-estimates, then
`no-stackup`, `outline-open`, unfilled pours, then one total for
`holes-merged + holes-marked + no-courtyard + arc-degenerate` as "N features
simplified" (`holes-marked` joined 2026-09-22 with the per-face hole budget,
below). `outline-open` with ZERO segments reads "This board has no outline yet;
showing the box around its copper." — anything else "Board outline did not
close; showing its bounding box." Unfilled pours count COPPER zones only (a
`B.Mask` zone saved unfilled is not a pour — the panel fixture's four were, and
the caption told the reader about four copper pours the board does not have).

**The count is only as honest as the overlap test.** `buildScene.prune` keeps the
larger of two overlapping hole/opening rings (v1 has no polygon-clipping library)
and counts the drop. Until 2026-09-22 "overlapping" was a **bounding-box** rule
(>25% of the smaller box), and the drop was counted unconditionally — so Glasgow,
the owner's own board, was captioned **"134 features simplified"**. Both halves
were wrong in the same direction:

- `overlap.ts` now answers on the RINGS: a proper edge crossing, or one ring
  inside the other, with boundaries EXCLUSIVE (two pads that share an edge do not
  overlap) and a bbox reject first. `ringContains` is the second export.
- A ring **wholly contained** in the one it lost to is dropped **silently** —
  the union of the two is exactly the ring that was kept, so nothing was
  approximated and nothing is reported. Same reasoning `withoutOverlaps` already
  applied to a pad's own drill.
- Measured on Glasgow: all **126** merged pad openings are that case (a fine-pitch
  pad inside a footprint's large one, or two coincident pads), and 0 hole rings
  merge at all. The caption now reads **"8 features simplified"** — the 8 missing
  courtyards, which is the only thing that really was. `buildScene.test.ts` pins
  the absence of a `holes-merged` warning; a partial overlap still counts, pinned
  in `overlap.test.ts`.

### The quality switch

Exactly one setting, `'full' | 'reduced'`, decided ONCE at mount by
`currentQuality({ webgl2, innerWidth, devicePixelRatio })` —
`webgl2 ? 'full' : 'reduced'` — **the width gate `innerWidth >= 900` was REMOVED 2026-09-23** (the owner on a phone: "there arent even the renderings of the 3D objects like the mosfets"; every phone got a 1× backing store, no MSAA and no bodies, on a guess about phone GPUs nobody measured — and the phone canvas is the SMALL one: 370×414 CSS px → 740×828 at the 2× cap, ~0.6 MP; Glasgow at 390×844×3 now draws 308,634 triangles / 12 calls, built in 786 ms, in Playwright's software WebGL — chrome-devtools-mcp's browser has NO WebGL at all here, use Playwright for 3D checks); so `reduced` is reachable only through the override or without WebGL2 (which renders nothing). History: (the `devicePixelRatio <= 2` gate was REMOVED 2026-09-22 — the owner's 2.24×/2.52× desktop monitors, on an RTX 4070 Ti, landed on the reduced tier and he saw a blurred board with no component bodies; the pixel cost is capped by `setPixelRatio(min(dpr, 2))` in the renderer, not by the tier), overridable with
`setQualityOverride`. Nothing else in the subsystem branches on device. `reduced`
drops tracks under 0.2 mm, halves the arc caps, coarsens the tolerance
(`TOL_MM`), pins `setPixelRatio(1)`, turns MSAA off and **skips component bodies
entirely** — which also skips their warning, because nothing was attempted. That
is why a phone shows **no caption at all** on a clean board: there is nothing to
admit. *(Superseded by the refinement, 32d624e: `reduced` now says "Component
bodies are not drawn on this display. Select a pad to identify a part.", because
a reader looking at a bare board needs to know the bodies are missing by design
and that the pads still answer. Device-neutral since 3e8d23a — no "tap", no "at
this size" — because the reduced tier is a narrow window OR a dense display.)* Measured Glasgow: 294,094 triangles / 9 draw calls full, 182,392 / 8
reduced.

### Where the numbers live

Spec §11 carries the measured table (build ms, triangles, draw calls, bundle
sizes, teardown) and `.superpowers/sdd/2026-09-22-3d-board-viewer/` carries the
proof screenshots and the task report. **fps is the one target that could not be
measured here**: this WSL2 instance has no `/dev/dri`, so the chrome-devtools MCP
browser has WebGL disabled outright and Playwright's Chromium falls back to
SwiftShader — a software rasteriser whose frame cost (1.9 s/frame at 1376×616) is
a property of the CPU, not of the scene. The scene-side numbers that DO transfer
are the draw calls and the triangle count; when the loop is asleep the page sits
at a clean 60 fps rAF cadence (measured 91 frames / 1.5 s), which is the other
half of the design: `sceneRenderer` only runs frames while auto-orbiting,
flipping or settling, and the first touch of the controls ends the auto-orbit for
the tab's lifetime.

### The general review round (2026-09-22) — what it changed

17 fix commits and 8 refactors, `d446e9d..9693964`. The owner's rule was ONE
review after the build; these are its findings, each with a test.

- **Back-side parts were mirrored TWICE** (5856579, b5821be). KiCad saves a
  flipped footprint's children in coordinates that are ALREADY mirrored (the file
  un-rotates them but never un-flips them), and the vendored 2D renderer places
  them with translate + rotate alone. `geom.place` and the pad-ring tail mirrored
  y again, so every asymmetric B-side part had its pads, drills, body and silk
  reflected across its own x axis. **`place` is rotate-then-translate, no mirror,
  and `geom.ts` says so beside it.** Witness: `pads.stickhub.test.ts` — StickHub's
  U2 (TDFN-8 on B.Cu) put **0 of 6** off-axis pads on the end of their track or
  via; now **6 of 6** land within 0.05 mm. The old geom test had pinned the wrong
  behaviour and the courtyard test could not fail.
- **A dense board's build is bounded per FACE, not by via count** (67ba1b9).
  earcut bridges every hole of a face into one outer ring, so a face costs
  O(holes × vertices): 1,000 vias 0.96 s, 2,000 4.0 s, 4,000 17.6 s, **8,000
  94.8 s**. `FACE_HOLE_BUDGET = { holes: 1500, vertices: 40_000 }` per flat face,
  largest first (`withinBudget`: board cutouts and connector drills are always
  real holes, and it is the 0.3 mm vias that give way); past it a
  drill is drawn as a dark mark on the mask and a pad opening as its pad raised
  just above the mask (`overMaskZ`, halfway to the silk), both counted as
  `holes-marked`. `prune` and the mask's overlap filter use a grid index instead
  of a linear scan. Measured: **8,000 vias 2.6 s, 50,000 vias 4.3 s**; Glasgow's
  busiest face (F.Mask, 1,317 openings / 35.6k vertices) is inside both limits
  and builds the same 294,094 triangles.
- **A build past 45 s is stopped with an honest "too large"** (1deab2c).
  `useBoardScene`'s watchdog (`BUILD_TIMEOUT_MS = 45_000`) terminates the worker
  and reports `TOO_LARGE` ("This board is too large to build in 3D in the
  browser. The Board tab still draws it.") instead of an endless spinner. The
  hook tests were also made to check what they claimed (retry really spawns a
  fresh worker; the no-worker fallback builds a real board to `ready`).
- **Hostile inputs** — `chainLoops` stays linear when endpoints pile into one
  cell (660cb58: 40k coincident zero-length Edge.Cuts lines, 2.4 MB, 46.8 s →
  0.14 s; an 8 MB file of them 0.39 s). A layer table with more than 32 copper
  layers (KiCad's hard limit) or 128 rows is refused `unreadable` (5e91ac7): every
  `*.Cu` pad expands against the copper table, so an unbounded one multiplied by
  the pad count (measured ~480 MB from a 1 MB file).
- **The outline** (817b18f). A footprint's own Edge.Cuts graphics (connector
  notches, slots, outline footprints) are placed with the footprint and join the
  board edge, as KiCad counts them; a turned rect is placed as its four-corner
  poly. A board with NO edge items is the box around its copper + 1 mm — it was a
  1 mm square at the page origin, ~100 mm from the parts — and the caption says
  "no outline yet" rather than "did not close".
- **The render loop** (e464b41). OrbitControls fires `change` from INSIDE a tick
  (auto-orbit, damping), and the `wake()` it triggered queued a second frame
  beside the tick's own, so queued ticks grew every frame of the orbit and
  doubled during a drag. The tick now decides the next frame alone — exactly one
  in flight. `prefers-reduced-motion` turns off the load-time orbit and makes
  Flip a cut. The four tolerance rays around a miss are for TOUCH only; a mouse
  click on bare board is one raycast, not five.
- **Pause, failure, contrast** (3e8d23a). An IntersectionObserver pauses the loop
  while the canvas is scrolled out of view (the browser does not throttle that),
  beside the existing `visibilitychange` pause. A renderer mount that rejects (no
  context, chunk failed) shows the problem block with **Try again**, which mounts
  a fresh renderer (`attempt`), instead of live-looking buttons over an empty
  box. Caption, stats and strip notes use `#676c71` (AA on the bench); the canvas
  focus ring draws inside the dark canvas and the tab/toolbar rings are ink-dark,
  all over 3:1.
- **Refactors, one home each** (4bfc546 … 9693964): the three `.kicad_pcb`
  readers — `boardStackup`, `boardPlacements`, `board3d/readBoardModel` — share
  `services/kicad/boardFile.ts` (`boardBlocks`: the header test + both
  `unreadable` sentences; `parseBlock`; `footprintField` for Reference/Value in
  both KiCad 6 and 7+ spellings), so they refuse the same files with the same
  sentence by construction. ONE curve-flattening rule: `arcStep` / `arcPoints` /
  `flattenArc` in `arcs.ts` (strokes and pads import them; `circleRing` is
  `arcPoints` round a full turn). ONE placement path: pads place through
  `geom.place` with their own frame, and every rectangle's corners come from
  `geom.rectCorners`. `ringsOverlap(a, b, boxA?, boxB?)` takes the boxes the
  pruner already holds (the bbox reject is `geom.boxesOverlap`, one `Box` type),
  and `ringContains` shares its edge-crossing loop. One `overMaskZ`; material
  specs spread whole into three; single-file symbols unexported.

---

## **One selection for the whole `/viewer` page, and the part panel is a rendering of `partFacts` — never a second KiCanvas properties panel (2026-09-22)**

The refinement stage of 2026-09-22 (ledger `.superpowers/sdd/2026-09-22-viewer-refinement/`,
report `report.md`, probe `probe.md`) added the identification panel the owner
asked for ("like Altium 365") and the cross-view selection behind it.

### Where the selection comes from, and what the seam gained

`pages/viewer/index.tsx` holds ONE `selectedRef`. Five doors set it: a click on
the schematic or board (the canvas reports it), a pick in the 3D view, a BOM
designator chip, the panel's search, and the `#ref` hash (through `focus()`).

KiCanvas **does** emit a selection event — `KiCanvasSelectEvent`, type
`"kicanvas:select"`, `viewers/base/events.ts:26-33`, dispatched by
`Viewer._set_selected` (`viewers/base/viewer.ts:200-214`) for every change of
`selected`, on the board (`BoardViewer.on_pick` → a `Footprint`,
`viewers/board/viewer.ts:57-84`) and the schematic (the base `on_pick` → the
first bbox's context, a `SchematicSymbol` or anything else painted). Two traps
the controller absorbs, both pinned in `kicanvasController.test.ts`:

- **The target is the `Viewer` object, not a DOM node** (`Viewer extends
  EventTarget`), so `bubbles: true` reaches nothing; the controller attaches to
  `app.viewer` itself, lazily (the getter throws before the app's first render)
  and idempotently (a `WeakSet`), on mount-ready and after every activate.
- **Every document load ends with a deselect** — `DocumentViewer.load`'s
  `later()` tail dispatches `kicanvas:load` and then, synchronously in the same
  task, `this.selected = null` (`document-viewer.ts:62-86`). Passed through, a
  sheet switch would clear the reader's selection. The controller marks a viewer
  "in its load tail" on the load event and clears the mark in a `queueMicrotask`
  (exact, because `later` is `setTimeout(…, 0)`); a null selection inside the
  mark is swallowed. The controller's own `select()` calls are muted the same
  way and it emits its own event with the outcome it knows.

The seam kept the `selection` event name spec §5.5 already declared (payload
widened to `{ ref, sheet?, view? }`) and gained **`selectRef(ref | null, sheet?,
view?)`** — the same sheet/view switch and select as `focusRef`, WITHOUT the
zoom. Both take a `view`: `'board'` shows the board first so "Show on Board"
can select a footprint; a `sheet` implies the schematic. `focusRef` stays the
travel gesture (BOM chips, the hash, the panel's Show on row); arriving at a
drawing tab with a selection uses `selectRef` so the tab is not yanked to a
zoomed-in part. `DesignCanvas` surfaces it as `onSelection` (held through a
ref, like `onState`) and `selectRef` on the handle. A `canvasHas` ref on the
page records what the canvas itself reported, so an echo is never sent back.
*(Superseded by d446e9d: the record is now PER DRAWING —
`shown: Record<CanvasView, string | null>` — because the schematic and the board
are two viewers with two selections, and one view-blind record skipped the board
whenever the schematic had reported the same designator. And since 57fa887
(2026-09-22) a `selectRef`/`focusRef` that answers `'not-found'` nulls that
drawing's entry — the viewer has cleared its outline — or a later selection of
the previous part was skipped as "already shown" and never drawn.)*

### The panel's facts, and where each number comes from

`pages/viewer/partFacts.ts` (pure, node-tested) assembles the record the panel
renders from three sources the page already holds: the BOM lines (identity,
quantity, siblings; `sheet` from the `refs` map), the board's placements, and
the workbench's priced rows. The price is the SAME number the BOM table shows:
`recommend()` at the table's line quantity, then `priceAt()` — so the panel and
the table cannot disagree. An absent fact is a dash, never a default.
**Corrected 2026-09-22 (c3a50f8):** they COULD disagree — the table lets the
reader pin another supplier, and the panel ignored the pin. `BomTable`'s pins
can now be held by the host (optional `pins` + `onPinsChange`; `/bom` still
lets the table keep its own); the viewer holds them, drops them with the project,
and `partFacts` applies the table's own rule: the pin if it still resolves, else
`recommend()`, then `priceAt()`.

**`services/kicad/boardPlacements.ts`** reads `(footprint … (at x y rot) (layer …)
(fp_text reference|property "Reference"))` through `topLevelBlocks` — ~40 ms on
Glasgow (measured), run on the main thread ONCE per project (`placementsSeen`,
the same one-way latch as `stackupSeen`). Until 2026-09-22 it was armed by the
first selection or the first focus of the search — i.e. INSIDE that click; since
57fa887 it is armed at the first idle moment after a project with a board opens
(`requestIdleCallback`, `PLACEMENTS_IDLE_TIMEOUT_MS` = 2 s at the latest), and a
selection or search focus that comes first still arms it. Seven of Glasgow's 272 footprints are annotated
`REF**` (logos, kikit tabs) and a reference-keyed map keeps the first: 266
entries, pinned. The reader is REQUIRED because the 3D scene (which knows
positions) is built only when the 3D tab opens, and the panel shows on every
tab.

Desktop: a 296px sticky rail beside the stage (`.stage` is a two-column grid,
`minmax(0, 1fr)` first so the BOM table shrinks rather than pushing the rail
off). Phone: the same markup as a fixed bottom sheet; a new selection PEEKS
(designator, value, price on one row) so the drawing the reader just tapped
stays visible; `.loaded` keeps 60px clear under the stage for the peek.
**Review round, 2026-09-22:**

- **The sheet reaches up to `$bp-tablet` (1024px), not just `$bp-mobile`**
  (7c4a4a2): the 296px rail left an 820px tablet a 455px stage, where the BOM
  table showed two of its columns. Rail above 1024; sheet + full-width stage at
  or below it (`ViewerPage.module.scss` and `PartPanel.module.scss`, both
  `@include responsive($bp-tablet)`; the page's block must stay AFTER `.loaded`
  — same specificity, source order decides).
- **The sheet chips row moved INSIDE the drawing column**, so switching to and
  from Schematic changes only the drawing's height; the rail used to move 35px
  with it.
- **The sheet is OPAQUE** (f4b2fe1): `bom-card`'s 85–93% white glass is laid over
  a solid `#f7f8fb`. Floating over the footer and the 3D canvas, the translucent
  card went grey and put its secondary ink under AA — the navbar lesson again.
- **A selection made from the sheet's OWN search keeps it open**; one made on a
  drawing still collapses it to the peek row. The fact list has no column gap,
  so each row's hairline (a border on both `dt` and `dd`) is one line. `/`
focuses the search and Esc clears, except while typing in a field (`typingIn`).
`BomTable` marks the selected chip with `aria-current`.

### The 3D side: ranges, picking, highlight, framing, teardown

`buildScene` records `MeshGroup.parts: PartRange[]` — the slice of a group's
`indices` each footprint owns — for bodies (`full` only) and for pads on every
copper layer, which are drawn FIRST and per footprint so the slice is
contiguous. `partRanges.ts` maps a hit `faceIndex` back to a designator (binary
search) and a designator to draw slices. The renderer highlights through
`geometry.addGroup` ranges and a two-material array (`HIGHLIGHT_MATERIALS`,
cyan `#4fc3f7`, emissive so it reads at any orbit): a range rewrite and at most
two extra draw calls, never a colour attribute over 300k vertices. A pick is a
pointer-up within 6px/500ms of its pointer-down (an orbit drag never picks) and
raycasts EVERY mesh nearest-first, so the substrate occludes a top-side body
seen from below; at `reduced` quality a phone still picks by pads, and the
caption says the bodies are not drawn at that size.

Reset framing (`framing.ts`, pure) projects the model box's eight corners
through the real perspective camera at every 10° of azimuth and solves for the
distance at which all clear BOTH frustum edges: Glasgow on a 1376×616 canvas
stands at **0.73 of the old diagonal rule's distance** (the bound is the near
corner's rise at a 35° elevation, not the width). It re-fits on resize.

**Leaving the 3D tab no longer loses the WebGL context inside the tab click's
React commit** (perf audit 2026-09-22: `forceContextLoss` was a 4.7 s long
task under SwiftShader, and the synchronous-on-click STRUCTURE was the defect).
`dispose()` does the cheap half at once (cancel rAF, listeners, the canvas
leaves the DOM) and `deferTeardown` runs geometry/material disposal and the
context loss in `requestIdleCallback` (1 s timeout; `setTimeout(0)` fallback),
exactly once. The context is still lost — just not before the new tab paints.

### The papaparse split

`services/kicad/schematicBom.ts` imported two caps from `services/bom/parseBom.ts`,
whose top-level `import { parse } from 'papaparse'` shipped 24 KB gz of CSV
parser to `/viewer`. The line shapes and caps now live in `services/bom/bomLines.ts`
(papaparse-free) and `parseBom.ts` re-exports them, so CSV-side callers are
unchanged. Cite `bomLines.ts` for `MAX_REFS_PER_LINE` from now on.

## Known limitations

Documented so a future session does not "fix" them by accident.

- **A sheet placed more than once shows ONE instance's annotations.** KiCanvas
  renders one document per file and cannot re-annotate per instance. Chips
  address paths; `focusRef` addresses instances. The visible artefact: focusing
  `U16` on Glasgow's `io_buffer` may land on a symbol drawn with the OTHER
  instance's reference text (`U10`). Accepted at the Phase 4 ruling.
- **Re-entering `/viewer`, or opening the `/bom` schematic panel, makes the
  RENDERER reload and re-parse every source** — about 9 s for Glasgow. Our
  reader's parse is not repeated: it survives in the design session, which is
  what the `WeakMap` snapshot and the identity gate exist for. What is repaid is
  KiCanvas's own work, because the embed is disposed with the route. Keeping the
  embed alive across routes is the fix; it is not built.
- **Under `StrictMode` (dev only) the match effect double-invokes** and a dev
  network panel shows two `match` calls, the first discarded. Not a production
  behaviour.
- **`zoom()` is origin-anchored.** So is upstream's (see the seam section above)
  — the mouse-anchored centre delta is a genuine upstream no-op.
- **The first `/api/bom/match` for 66 lines took 8.6 s server-side.** A backend
  observation, not a viewer defect.
- **The BOM snapshot restores prices up to a session old with no age shown.**
  Tied to the standing `price_stale` product decision (CLAUDE.md OPEN). Do NOT
  "fix" it by re-matching — that spends the resolve budget again and defeats the
  one-request-per-project promise.
- **Theoretical, no page path produces them:** the three-activation focus case
  (would need a focus-generation counter on the controller); cross-page load
  cross-talk and duplicate-handler collapse in the controller; the `ZOOM`
  literals as a vendor-bump note.

---

## Open

### Product decisions for the owner, not code defects

The first three are verbatim from the plan's "Parked findings — disposition ›
Product decisions".

- The BOM snapshot restores a table priced up to a session ago with no age
  shown; the honest fix is a "priced N minutes ago" line, tied to the standing
  `price_stale` decision — not re-matching.
- `/bom` chip focus is silent on a genuinely missing designator or a dropped
  sheet (the `/viewer` path toasts); a toast there needs the same `focusSeq` +
  `'superseded'` guards.
- The phone `touch-action` trap of a canvas panel above scrollable rows (both
  pages) — the canvas needs it to pan; a collapse-by-default or a pan handle is
  a design choice.
- **CSV vs schematic DNP rules differ** (documented in Task 1.6 and in the DNP
  section above). The two intakes disagreeing is deliberate, and unifying them
  is the owner's call, not a bug to quietly fix.

The plan's list fused a fourth item onto that DNP bullet — "the
`SimilarDropdown` hides the currently matched SKU while `foldSimilarPick` filters
the clicked one". **Re-checked at HEAD 2026-09-17: there is no divergence, and it
is recorded here so it stops being re-parked.** `SimilarDropdown` does not hide
anything — it renders `options` verbatim and *names* the current match in a
footer ("Currently matched: …", `SimilarDropdown.tsx:162-164`), and the options
it is handed are `row.server.similar` (`BomTable.tsx:486`). `foldSimilarPick`
(`useBomWorkbench.ts:204-240`) is the only thing that edits that list, and it
agrees with the footer: it drops the SKU just picked (now the match) and puts the
**displaced** part back, so the pick stays reversible.

### Engineering follow-ups (small, uncontroversial)

- **Widen the integrity manifest to `entry.ts` and `tsconfig.json`.** Today they
  are outside `VENDORED_DIRS`, so an edit to either is caught only indirectly by
  the built-output checks (see the manifest-boundary section). `patches/` stays
  out by necessity.
- **A guard test for the renderer seam.** It is a convention today; a test that
  greps the import sites and fails on anything but `DesignCanvas.tsx` importing
  `kicanvasController` would have caught the Task 3.3 breach in CI instead of in
  review.
- **Read file-selector's `.path` / `.relativePath` in `project.ts`.** Small, and
  it is what would make a dragged FOLDER key by path like a ZIP already does
  (Task 2.4 observation).

### Public copy: two "upload" strings

Two rendered "upload" strings survive the 2026-09-16 sweep and are left
UNCHANGED for the owner to rule on (everything else the sweep found was a
comment or an identifier):

- `frontend/src/public/services/seoRoutes.ts:60` — the `/bom` SEO description
  "Upload or paste your bill of materials…".
- `frontend/src/public/pages/category/components/CategorySponsor.tsx:764` — the
  pitch-preview button's `aria-label` "Upload a company logo to preview
  sponsorship".

**Both line numbers and the list itself are a SNAPSHOT** (re-verified
2026-09-17). Re-run the grep before any public copy change rather than trusting
this list:

```bash
grep -rni "upload" frontend/src/public --include=*.ts --include=*.tsx | grep -v '\.test\.'
```

### Two observations from production, neither diagnosed

Production is `134ba73`, i.e. **pre-Phase-5** — see the note at the top of this
file. Both of these were seen against that build.

- **The intake's first click did nothing (prod, 2026-09-16) — OBSERVED, NOT
  DIAGNOSED.** The first "Try the example project" click showed the busy state
  (both buttons dimmed) for roughly 30 s and ended back at the idle intake with
  no project and no visible error; the second click opened Glasgow normally. It
  has not been reproduced and there is no explanation. One fact that is verified
  in the code and is worth knowing while chasing it: **both intake buttons are
  `disabled={busy}` with no queue** (`ViewerIntake.tsx:103` and `:106`), so a
  click during the busy window is simply swallowed — unlike `/bom`'s chip focus,
  which defers through `pendingFocus`. That is a plausible *contributor*, not a
  cause; do not write it up as one.
- **Schematic-view zoom "parallax" (owner report, 2026-09-15) — NOT YET
  REPRODUCED.** No screenshot has been supplied and no test reproduces it. What
  is known and verified is only the upstream behaviour recorded above: plain
  wheel PANS, ctrl+wheel and pinch ZOOM, and the zoom is origin-anchored on both
  the wheel and the buttons. Get the owner's screenshot before changing anything.

  *How to reproduce it when the screenshot arrives.* A fix plus
  `./deploy.sh --frontend` are **pre-authorised by the owner (2026-09-15) for
  this bug only**. The chrome-devtools MCP Chrome **has no WebGL2** and therefore
  cannot render KiCanvas at all (recorded repeatedly through Phases 0–3: Task
  0.4's report, the 2.5 review, the 3.3 report) — so reproduction needs the
  owner's own Chrome through the claude-in-chrome extension. In that extension
  the `scroll` action scrolls the PAGE over the canvas rather than driving the
  viewer, so drive the zoom with **JS-dispatched `WheelEvent`s carrying
  `ctrlKey: true`**, targeted at the canvas **inside the two shadow roots**; six
  such events moved the camera 2.41 → 4.96 on 2026-09-16. The owner's window
  shrank mid-probe, so the visual check is still owed.
