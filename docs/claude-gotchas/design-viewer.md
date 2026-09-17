# Design Viewer (`/viewer`) — full gotcha histories

Written 2026-09-16 at Phase 5 of the viewer build, the same way the other files
in this directory work: the compressed rule (same bold key) lives in CLAUDE.md's
Gotchas section, and this file holds the full story — evidence, measurements,
dates, rulings and refuted hypotheses.
**Update BOTH files when a rule changes.**

Spec: `docs/superpowers/specs/2026-09-12-design-viewer-design.md` (binding
authority on intent). Plan + 48 execution rulings:
`docs/superpowers/plans/2026-09-12-design-viewer.md`, section
`# Rulings I made (final adjudication, 2026-09-14)`. Phases 0–4 deployed to
production 2026-09-14 (master `134ba73`); the parked mechanical batch landed
2026-09-16 (`40bbfd9..3277053`).

---

## **The renderer is a VENDORED KiCanvas and the build script IS the integrity gate**

`frontend/vendor/kicanvas/` holds `src/`, `third_party/earcut/`, `patches/`,
`entry.ts`, `MANIFEST.sha256`, `UPSTREAM`, `LICENSE.md`, `tsconfig.json`.
`UPSTREAM` line 2 pins commit `b031159eb74aaa7eef2b026fd85d35bc05ff2095`
(2026-04-28) of https://github.com/theacodes/kicanvas.

`frontend/scripts/build-kicanvas.mjs` runs as `prebuild` AND `predev`, so it
executes inside the production image build on the t3.small, and bundles the tree
with esbuild to the **gitignored** `frontend/vendor/build/kicanvas.js`. Vite
cannot compile the tree directly — upstream loads `.css`, `.svg`, `.glsl` and
`.kicad_wks` as **text**, which is what the script's `loader:` map reproduces.

The script fails the build on any of three conditions:

1. **Manifest drift** — every file under `src/` and `third_party/earcut/` is
   SHA-256'd and compared to `MANIFEST.sha256`; a file that is gone also fails.
2. **A surviving web-font host** — `fonts.googleapis.com` or `fonts.gstatic.com`
   anywhere in the output (site rule: no Google Fonts).
3. **A bundle that registers no elements** — it asserts `define("<name>"` for all
   four of `kicanvas-embed`, `kicanvas-source`, `kc-board-app`, `kc-schematic-app`.

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
that would bloat git and the Docker context. Every byte the bundle compiles is
still hashed.

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
commit, matches the manifest file for file, and re-checks the font hosts across
the whole tree (not just the bundle).

### Licence

The programme is **GPL-3.0-or-later** (owner decision, spec D6). Three agreeing
declarations — `LICENSE` at the repo root, `license` in `frontend/package.json`,
`license` in `api/pyproject.toml` — guarded by
`api/tests/test_licence_declared.py`. Third-party notices ship in
`frontend/public/vendor/kicanvas/NOTICE.txt`, served at
`/vendor/kicanvas/NOTICE.txt` and linked from the viewer's footer credit
("Rendering by KiCanvas — licences", no SPDX claim, per D6).

### Fixtures are open hardware, and the KiCad demos are NOT GPL

`frontend/src/public/services/kicad/fixtures/` — each directory carries a
`LICENSE` and a `SOURCE` beside the data:

- `glasgow-revC3/` — Glasgow Interface Explorer revC3, **0BSD**.
- `kicad-demos/` — KiCad's own demo projects, **CC BY-SA 4.0** (`demos/*` are
  carved out of KiCad's GPLv3 code licence by its `LICENSE.README`; attribution
  is the `SOURCE` file).
- `bad-thing-panel/` — panelised board fixture.

An earlier draft of this documentation called the demos "KiCad's GPL demos
riding on the programme's GPL-3.0-or-later licence". **That was wrong and was
corrected during Task 1.4** (ruling 2026-09-12, code `7fd8366`, docs `4716fbc`):
CC BY-SA 4.0 is *one-way compatible* with GPLv3, we do not adapt the files, and
the `shareAlike` gate plus the `SOURCE` string now say the truth in the script,
the test regex, the spec and the plan. Do not re-introduce the GPL claim.

### Quarterly hand check (spec §5.1, $0 monitoring)

Expected answers as of the pin:

- `pushed_at == 2026-04-28T17:37:55Z`
- `tags == 0`
- format-token issue search `== 0`
- `npm view @huaqiu/ecad-renderer` (the watch for a maintained fork)

---

## **The renderer seam: nothing outside `kicanvasController.ts` may touch KiCanvas**

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

**The reader keys files by full relative PATH** (two `power.kicad_sch` in
different folders are different files). **KiCanvas keys its virtual file system
by BASENAME** and physically cannot hold both. Two correct designs that disagree
at the seam, so the seam reports the loss: `sourcesFor(project)` returns
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

### `DesignCanvas.tsx`

Props: `project view activeSheet? onState? onUnrenderableSheets? createController?
height?('default'|'compact') ref`.

- `onState` is held **through a ref** — adding it to the effect deps would
  remount the canvas on every parent render.
- WebGL2 support is probed once in a memo, with the probe wrapped so a throwing
  `getContext` reads as no-WebGL.
- `CANVAS_READY_MS = 15000`, and **the deadline is PAUSED while the tab is
  hidden**: the first GPU mount of Glasgow took **4.3 s** to reach the app
  element, and background tabs throttle rAF. The refund is arithmetic on real
  elapsed time (clock and visibility injected through constructor options for
  tests), never a fixed slice.
- `.frameCompact` is `height: 45vh` and `flex: 0 0 auto` — `/bom`'s schematic
  panel. Its parent MUST be a flex **column**: every child `DesignCanvas` paints
  is absolutely positioned, so in a flex row the frame resolves to zero content
  width and the drawing is invisible with **no error anywhere**. Pinned by a
  source-level SCSS witness in `bomPage.test.ts`.
- The frame takes `touch-action: none` + `overscroll-behavior: contain` so it can
  pan (accepted trade-off: the page cannot scroll by dragging on the drawing).

---

## **The KiCad reader is OURS and is REQUIRED — KiCanvas discards `in_bom` and `dnp`**

`@public/services/kicad/` — `sexpr.ts`, `zip.ts`, `project.ts`,
`schematicBom.ts`, `boardStackup.ts`, `naturalSort.ts`, `fixtures.ts`,
`types.ts`. The renderer cannot be asked for a BOM: it parses schematics for
drawing and throws away exactly the two fields a BOM turns on.

### One BOM line per INSTANCE PATH

A sheet placed twice is two references. The reference resolves from, in order:

1. KiCad 7+ per-symbol `(instances …)`, matched on the instance path;
2. KiCad 6's root `symbol_instances` table, keyed `${pathV6}/${uuid}`;
3. the symbol's own `Reference` property.

Skipped: refs starting `#`, `(power)` symbols, and not-in-BOM symbols. `qty` is
the **true instance count**; `refs` is capped at `MAX_REFS_PER_LINE` (200) for
**display only** and a warning says so, naming the real quantity.

Three review-mandated refinements, all pinned by tests:

- When the reference came from the symbol's own property (no instance-table
  hit), the dedupe key is `${path}|${ref}` and a warning names the sheet — a
  twice-placed sheet must never halve the order.
- A reference ending `?` is keyed by the symbol's **uuid** (path-qualified, so a
  twice-placed sheet still counts twice), never merged, and a warning says N
  symbol instances are not annotated and to run Tools → Annotate Schematic.
- `visit` carries the **ancestor chain** and skips a sheet already on it. KiCad
  itself refuses recursive hierarchies; a visited-set would wrongly collapse a
  sheet legitimately placed twice, which is why it is a chain and not a set.

`RefLocation` is a **single (first) location** — `{ sheet, instancePath }`. A
list for cross-sheet multi-unit parts is a later contract decision, carried
forward deliberately.

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
per-entry ratio ≤ 100:1 — all checked inside fflate's `filter`, **before any
inflate**. The declared total accumulates over the entries the tool would READ
(i.e. after the name filter), which is the tighter bound, and the running check
runs before every `return true` so the transient total never exceeds the cap.
Cap messages round the actual size **up** to a tenth, so an 8 MiB + 1 byte file
never reads "8.0 MB; limit 8.0 MB".

Note: the planning docs (`global-constraints.md`) still carry the *provisional*
pre-Phase-0 figures "10 MB per file, 25 MB total". The code is the authority.

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

### `readStackup` — the two figures it deliberately does not clean up

`boardStackup.ts` returns `null` when the file has no `(setup (stackup …))` —
**never a default**. Two values are kept raw on purpose:

- `copperFinish` keeps KiCad's literal `"None"` (3 of 3 stackup boards carry it).
  The Stackup tab must **label** it, never print it as a finish.
- `listedThicknessMm` is the **raw IEEE sum** of every thickness present (e.g.
  `1.5999999999999999`). Rounding it to 3 dp would coincidentally equal
  `designThicknessMm` and kill the comparison the tab exists to make. The view
  rounds: ONE `formatMm` at **four decimals**, which is KiCad's own Board Setup
  precision, and a null or non-finite figure reads as an em dash — never "0",
  never "NaN".

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

## **Design files never leave the browser — and that is exactly how to say it**

Every KiCad file is parsed **client-side**. The viewer's only network calls are
the ones the BOM tool already made:

- `POST /api/bom/match` — identity fields only (`extra="forbid"`, spec D7).
- `POST /api/bom/resolve` — live lookups for unmatched lines.
- `POST /api/bom/share` — **only on an explicit click**, and it DOES publish
  quantities and designators, behind its own disclosure.

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
- `reset()` is terminal.
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

## **Testing facts specific to this area**

- **`vitest` leaves `css` at its default `false`.** A CSS-module import returns a
  proxy that **echoes the key back**, so `expect(el.className).toContain(styles.foo)`
  passes whether or not the rule exists. A rule's EXISTENCE needs a
  **source-level SCSS witness**: `readFileSync(join(__dirname, 'X.module.scss'))`
  and assert on the rule body. Canonical examples: `bomPage.test.ts` (the flex
  column that makes the compact canvas visible at all) and `StackupPanel.test.ts`.
- **DOM tests are happy-dom + `react-dom/client` + `act`. There is no testing
  library.** `vitest.config.ts` sets `environment: 'node'` and
  `include: ['src/**/*.test.ts']`; a DOM test opts in with a
  `// @vitest-environment happy-dom` directive at the top of the file.
  `DesignCanvas.test.ts` is the canonical harness (fake controller injected
  through the `createController` prop).
- **Test files are excluded from `tsc -b` and eslint** (`tsconfig.app.json` /
  `.eslintrc.json`). A type error in a test is seen only by vitest — that is how
  a wrong `atom()` signature in a brief's own test reached review.
- The frontend suite at the time of writing: **106 files / 1316 tests**
  (2026-09-16).

---

## Known limitations

Documented so a future session does not "fix" them by accident.

- **A sheet placed more than once shows ONE instance's annotations.** KiCanvas
  renders one document per file and cannot re-annotate per instance. Chips
  address paths; `focusRef` addresses instances. The visible artefact: focusing
  `U16` on Glasgow's `io_buffer` may land on a symbol drawn with the OTHER
  instance's reference text (`U10`). Accepted at the Phase 4 ruling.
- **Re-entering `/viewer`, or opening the `/bom` schematic panel, re-parses the
  whole project** — about 9 s for Glasgow. Keeping the embed alive across routes
  is the fix; it is not built.
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

Product decisions for the owner, not code defects. The first four are verbatim
from the plan's "Parked findings — disposition › Product decisions".

- The BOM snapshot restores a table priced up to a session ago with no age
  shown; the honest fix is a "priced N minutes ago" line, tied to the standing
  `price_stale` decision — not re-matching.
- `/bom` chip focus is silent on a genuinely missing designator or a dropped
  sheet (the `/viewer` path toasts); a toast there needs the same `focusSeq` +
  `'superseded'` guards.
- The phone `touch-action` trap of a canvas panel above scrollable rows (both
  pages) — the canvas needs it to pan; a collapse-by-default or a pan handle is
  a design choice.
- CSV vs schematic DNP rules differ (documented in Task 1.6); the
  `SimilarDropdown` hides the currently matched SKU while `foldSimilarPick`
  filters the clicked one.

Two rendered "upload" strings survive the 2026-09-16 sweep and are left
UNCHANGED for the owner to rule on (everything else the sweep found was a
comment or an identifier):

- `frontend/src/public/services/seoRoutes.ts` — the `/bom` SEO description
  "Upload or paste your bill of materials…".
- `frontend/src/public/pages/category/components/CategorySponsor.tsx` — the
  pitch-preview button's `aria-label` "Upload a company logo to preview
  sponsorship".

One unreproduced report:

- **Schematic-view zoom "parallax" (owner report, 2026-09-15) — NOT YET
  REPRODUCED.** No screenshot has been supplied and no test reproduces it. What
  is known and verified is only the upstream behaviour recorded above: plain
  wheel PANS, ctrl+wheel and pinch ZOOM, and the zoom is origin-anchored on both
  the wheel and the buttons. Get the owner's screenshot before changing
  anything.
