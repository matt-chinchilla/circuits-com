# BOM tool + KiCad viewers — verified research packet (2026-08-19)

Produced by a 13-agent workflow: 6 parallel researchers (KiCad docs via
docs.kicad.org, KiCanvas, Gerber viewers, 3D, competitor BOM UX, licensing),
each followed by an adversarial verifier that independently re-retrieved the
cited sources, then a synthesizer in which **verifier corrections override the
original claims**. 0 agent errors, 0 empty results.

Read section 5 before acting on anything here. It lists what could NOT be
verified and what the verifiers refuted — including several claims that would
have produced wrong code.

---

## 1. BOM tool — what the research changes

### The literal strings your parser must recognize

**`kicad-cli sch export bom` (KiCad 8/9/10) defaults:**

| Setting | Default value |
|---|---|
| `--labels` (→ the CSV header row) | `Refs,Value,Footprint,Qty,DNP` |
| `--fields` | `Reference,Value,Footprint,QUANTITY,DNP` (KiCad 10); `Reference,Value,Footprint,${QUANTITY},${DNP}` (8/9) |
| field delimiter | `,` |
| string delimiter | **none — fields are NOT quoted** |
| reference delimiter | `,` |
| reference *range* delimiter | `-` |
| tabs / line breaks in fields | stripped |

**Correction that changes the design:** `--group-by` has **no default**. A bare `kicad-cli sch export bom` emits **one row per symbol with a single reference** — `R1-R3` range collapsing never fires. Multi-reference cells only appear when the user passes `--group-by`, `--preset`, or uses a grouped GUI preset. Your detector must handle both shapes and must not assume grouping.

**The three bundled legacy Python scripts each write a different header, all with `csv.QUOTE_ALL` (every cell quoted) and all joining references with `", "` (comma + SPACE):**

```
bom_csv_grouped_extra.py            #,Reference,Qty,Value,Footprint,DNP   (+extra fields from argv)
bom_csv_grouped_by_value.py         Item,Qty,Reference(s),Value,LibPart,Footprint,Datasheet,DNP
                                    (+ all remaining symbol fields, alphabetical)
bom_csv_grouped_by_value_with_fp.py Ref,Qnty,Value,Cmp name,Footprint,Description,Vendor,DNP
```

Note `Qnty` (misspelled), `Cmp name`, `Reference(s)`, `#` as a column name. The latter two scripts **prepend a five-line metadata preamble** before the header: `Source:`, `Date:`, `Tool:`, `Generator:`, `Component Count:`.

**Symbol fields:** exactly five undeletable defaults — `Reference`, `Value`, `Footprint`, `Datasheet`, `Description` (Description became a *field* only in KiCad 8). Footprint is always `LIBNAME:FOOTPRINTNAME`.

**Attribute columns are strings-or-empty, not booleans.** `${DNP}` expands to the friendly name `DNP` when set and to an **empty string** when not. Same pattern for `Excluded from board` (`${EXCLUDE_FROM_BOARD}`), `${EXCLUDE_FROM_SIM}`, `${EXCLUDE_FROM_BOM}`. Do not parse for `true`/`false`/`Y`.

`${QUANTITY}` and `${ITEM_NUMBER}` are the two *special* virtual fields; virtual fields are otherwise **open-ended** ("any text variable can be used, including sheet and project text variables"). Do not code against a closed list.

### MPN

KiCad ships **no MPN field and reserves no name for one.** KLC rule S6.2 forbids custom fields in the official libraries, so MPN never arrives from stock symbols — it is always author-supplied. The only *field-name* spelling attested in KiCad's own material is the literal `MPN` (legacy script argv example; database-library JSON template `"column": "MPN", "name": "MPN"`). KiCad 10's Variants docs refer in prose to "a custom Manufacturer Part Number field". `MFR_PN` and `PartNumber` are **unattested** in any KiCad source.

**This is the largest hole in the packet: nobody surveyed real-world BOMs.** See §5. Design the matcher so MPN is *opportunistic*, and so the tool is still useful with only `Value` + `Footprint` + `Description` — which is the normal case for a KiCad export.

### What a CSV auto-detector must actually handle

1. **Skip a metadata preamble.** Scan for the header row; do not assume row 0.
2. **Sniff the delimiter:** `,` (default), tab (TSV preset), `;` (semicolon preset).
3. **Handle both quoting regimes:** unquoted (CLI default) and fully quoted (all three legacy scripts).
4. **The unquoted-multi-ref hazard:** with grouping on and no string delimiter, `R1-R3,R7` is byte-identical to two fields. Detect by **cell count > header count** and re-join the overflow into the reference column. There is no other signal.
5. **Reference cell parsing:** split on `,` *and* `", "`, then expand `-` ranges prefix-aware (`R1-R3` → R1,R2,R3; `C10-C12`).
6. **Header aliases, case-insensitive + whitespace/punctuation-trimmed.** Verified-from-KiCad set:
   - Refs: `Refs` · `Reference` · `Reference(s)` · `Ref`
   - Qty: `Qty` · `QUANTITY` · `Qnty`
   - Value: `Value` · Footprint: `Footprint` · Datasheet: `Datasheet` · Description: `Description`
   - Other real KiCad columns: `DNP` · `Item` · `#` · `LibPart` · `Cmp name` · `Vendor`
   Everything beyond this list (`Designator`, `Manufacturer`, `Comment`, `Part Number`…) is industry folklore until somebody looks at real files.
7. **Split `Footprint` on the first `:`** for a package guess when MPN is absent.
8. **Version awareness:** KiCad ≤7 had no `sch export bom` at all (only `python-bom` XML). `--include-excluded-from-bom` exists **only in 9 and 10** (inert in 10). KiCad 10 always excludes exclude-from-BOM symbols and added `--variant`.

### Competitor UX worth copying (literal strings)

- **Explicit mapping screen, and remember the mapping.** Mouser: per-column dropdowns, **Next disabled until at least Mouser P/N or MPN is mapped**, mapping remembered for future BOMs — the single most-praised detail found. TrustedParts: drag header tags from an "Available Fields" group onto named targets, then "Import the BOM".
- **Keep the user's original input beside the match.** Mouser's row: `Select | Uploaded Data | Matched Part Detail (Part Match Confidence Score) | Design Risk | Min / Mult | Availability | Packaging Options | Qty. | Unit Price | Ext. Price | Delete`.
- **Match-state vocabulary anchored on a number.** Mouser's filter: `All Lines` / `Exact Matches (Part Match Confidence 100%)` / `Not Exact (below 100%)` / `No Matches` / `Not Orderable`.
- **A mismatch must not be silently orderable.** JLCPCB's strongest pattern: a yellow exclamation that **unchecks the line** on MPN-string mismatch, package mismatch, or the same part reused across rows. Copy this.
- **Terse error labels:** JLCPCB uses `Parameter Error`, `The Uploaded File Format Is Incorrect`, `File Processing Failed`, `Shortfall`, `No Part Selected`, `Standard Only`, `Repeated Designator`.
- **Validation rules worth adopting:** JLCPCB caps 200 reference designators per BOM line and requires each designator to appear exactly once across the whole file.
- **Alternates:** per-row expander "See More Options" → "Replace" (Mouser); its *absence* is the signal that none exist. DigiKey calls it "View Substitutes".
- **Ambiguity gets a control, not a guess:** TrustedParts shows a "Select a Manufacturer" dropdown rather than silently picking.
- **Transparent multiplier:** JLCPCB shows a "Recommended Qty" deliberately higher than the BOM qty and explains why inline. DigiKey has an attrition field plus an assembly multiplier. TrustedParts has "BOM Qty" plus a "Total Coverage" percentage.
- **Lifecycle chips:** Octopart — Green = Active, Orange = NRND, Red = EOL, Gray = Unknown.
- **Totals/warnings (PCPartPicker, best in class despite no upload):** a page-level banner "Compatibility: Warning! These parts have potential issues. See details below." with footnote-anchored per-issue notes; a per-row Availability column; **"No Prices Available" instead of a blank cell**; three separate totals rows. User-supplied rows are labelled "Custom Part" with an explicit trust disclaimer — exactly the pattern for an unmatched row the user overrides.
- **A second intake path.** Mouser's paste grammar is documented as one part number and one desired quantity per line, pipe- or space-separated; experienced users prefer it to spreadsheets. Cheap to build, disproportionately liked.
- **Offer a downloadable template and a "Try Sample BOM".** Mouser, JLCPCB both do.
- **Price lock as a trust signal:** Mouser and DigiKey both guarantee quoted pricing for 30 days.

### Worth avoiding

- **Octopart's single saved BOM** — a new upload *replaces* the existing one; the documented workaround is "export first". Destroys prior work.
- **Login walls in front of the tool.** Mouser requires MyMouser before you see anything; `arrow.com/en/bom-tool.html` renders literally "You must login to view this page." The tools people actually recommend put the wall *after* the first result.
- **Undersized caps.** Mouser: 99 lines "for a typical BOM", 5 BOMs/day "for most customers" — the line cap is raisable via a form, **the daily cap has no documented remedy at all**. Octopart 5 MB, JLCPCB 2 MB, TrustedParts 100 parts guest / 1,000 premium. Beat all of these; a real production BOM exceeds 99 lines routinely.
- **No mapping step at all.** JLCPCB matches on standard header names and instructs you to *rename your headers to match* — a documented failure mode. Auto-detect, then always show the mapping and let it be overridden.

Practical fit with this codebase: the public upload endpoint should be rate-limited through the shared `rate_limit.client_ip` (as `POST /api/checkout/silver` is), and matching should reuse the existing `part_feed/registry` + `Part.sku`/`slug` lookup rather than growing a second identity path.

---

## 2. Viewer stack recommendation

### Schematic (.kicad_sch) — **KiCanvas, vendored. Feasible.**

Ship a pinned copy of `kicanvas.js` (477,451 bytes raw; ~112–114 KB gzip; brotli lower once you self-host — GitHub Pages serves gzip only) and use `<kicanvas-embed>`. It renders `.kicad_sch` via Canvas2D, handles hierarchical/multi-sheet projects, and parses `.kicad_pro`/`.kicad_wks`. There is **no npm package and no release tags**; the hosted URL is unversioned, so vendoring the file is the only way to pin. It injects a Google Fonts `<link>` into `document.body` at import time — a CSP problem you must plan for.

**KiCad 6+ only. KiCad 5 files fail entirely.**

For user-supplied local files: read the `File` yourself and inject the text into a `<kicanvas-source>` element. A `blob:` URL in `src` does **not** work — the extension allowlist filters URL-sourced entries but not inline/drag-drop ones. And `embed.loaded === true` is a **false-positive** success signal; detect real success by querying the shadow root for `kc-schematic-app` / `kc-board-app`.

### Can a table row jump to a designator? — **Yes today, but on an unsupported path.**

The **documented** API cannot do it. Deep linking, the `zoom="<refs>"` attribute, and all six `kicanvas:*` events are marked not-implemented, and that is confirmed in source: the embed element's event-setup function is empty and its `zoom` attribute is never read (`this.zoom` as a property exists only in `base/math/camera2.ts`). Do not plan around it.

The **undocumented** path was verified live against the 2026-04-28 bundle:

```js
embed.shadowRoot.querySelector('kc-schematic-app').viewer.select('U6');
embed.shadowRoot.querySelector('kc-schematic-app').viewer.zoom_to_selection();
```

It works on boards too (`select('R403')`). Constraints, all corrected by the verifier:

- **It throws, it does not soft-miss.** With no document loaded: `TypeError: Cannot read properties of undefined (reading 'find_symbol')`. Wrap in try/catch and guard on `viewer.document`.
- **Current sheet only.** Cross-sheet jump needs `project.set_active_page()`, and the `Project` instance lives in a **private `#project` field** on the embed. No public handle was found. **Cross-sheet jump-to-designator is unsolved.**
- **Duplicate refs return the first linear-scan match** (multi-unit symbols: the sample sheet has five `U6` entries).
- `zoom_to_selection()` is idempotent; the zoom numbers in the research are page-state artifacts, not expected values.
- No versioning, no releases, no changelog. `kc-schematic-app` / `.viewer` can change silently.

**Recommendation:** isolate all of this behind one small adapter module with feature detection, and degrade gracefully to "open the viewer, no auto-focus" when the internals move. Treat the deep-link feature as a nice-to-have, not a spec commitment.

**Maintenance reality:** last commit 2026-04-28 — roughly 3.7 months of zero cadence as of today, with 51 open issues. The owner has not *authored* a commit since 2023-12-03 (1,072 commits); a single community contributor (XiangYyang, 30 commits) holds merge rights and self-merges. The owner still merges occasionally (PR #185, 2026-04-13). **Bus factor ≈ 1.**

**Alternative to evaluate:** `Huaqiu-Electronics/ecad-viewer` — MIT KiCanvas fork, last push 2026-07-11, adds ZIP loading, BOM, Altium import, and explicitly "jumping to a specific schematic, focusing, and selecting a specific symbol". 90 stars. Its 3D needs a `kicad-cli` Docker sidecar; whether the 2D half works standalone, and whether its jump-to-symbol is a public JS API or UI-only, is **untested**.

### PCB 2D — **depends entirely on what the user uploads. These are two different products.**

**If the input is `.kicad_pcb`:** KiCanvas again, WebGL2. Footprints, reference designators, values and nets survive as first-class objects; click-to-highlight nets/footprints landed 2026-04-13. Same `select(ref)` path works. This is the only route that supports BOM↔board cross-highlight.

**If the input is Gerbers:** KiCanvas cannot read them at all, and **BOM cross-highlight is structurally impossible** — Gerbers are apertures and drill hits; component identity exists only as silkscreen ink. Gerber X3 carries component data, but essentially no JS library parses it.

Gerber options, ranked honestly:

- **tracespace v4** (`pcb-stackup` 4.2.8 / `gerber-to-svg` 4.2.8, MIT, published 2022-03-30) is what the world actually runs (~24.5k weekly downloads for `pcb-stackup`, the cleanest proxy). Frozen for four years; the repo's default branch is now `v5`, so its front page shows a hiatus notice. The dist is a **webpack global-var bundle, not UMD** — `pcb-stackup.min.js`, 200,096 B raw / ~42 KB gzip, exposes a `pcbStackup` global; no `define.amd`, no `module.exports`, so script-tag consumption is the only mode. The API is a render function returning `{top:{svg}, bottom:{svg}, layers}` — pan/zoom, layer toggles and all UI are yours. No ZIP handling (bring `fflate`). Layer-role detection is a **filename heuristic**, not content inspection, with known unfixed failures on Allegro.
- **tracespace v5 is dead on the record** (hiatus notice 2025-01-20, "likely dead in the water", author refuses new PRs *and* refuses to hand over the project). One alpha wave, 2023-01-16, never updated.
  - **Correction that matters:** the notorious `Maximum call stack size exceeded` bug (#420) is unreleased **upstream only**. `@hpcreery/tracespace-parser@5.0.4` and `@hadimardanian/parser@1.1.0` **do ship the fix**. The earlier claim that all forks carried it was wrong — the forks are a genuine escape hatch.
  - **npm dist-tag trap:** `@tracespace/xml-id`, `/cli`, `/fixtures` still point `latest` at **v4**; the alpha is only under `next`. Install with `@next` or you silently mix v4 into a v5 tree.
  - v5's pipeline is synchronous *including the parse inside `read()`* — every CPU-bound stage must go in a Web Worker.
  - Firefox clipPath (#302), units-vs-format-spec (#234) and outline rendering (#403) are **v4-only defects** (maintainer-labelled `v5-fixed`), not shared limits. Only Gerber X2 (#348) and Allegro drill (#392) are open against both, and both are labelled `feature`.
- **`@sctg/tracespace-view` 5.1.6** (2026-05-04) is the only drop-in React Gerber viewer on npm — ZIP input, worker rendering, React ≥18, MIT, and the only tracespace lineage with a 2026 release. But: 1 GitHub star, 7 downloads/week, and it bundles `mixpanel-browser`, four FontAwesome packages, Formik and Dexie. Nobody has run it.
- **`gerbers-renderer`** (MIT, canvas 2D, ZIP in, layer autodetect, DFM markers, diff, share links) is the most viewer-shaped active option, but npm 1.1.6 (2026-01-04) is **7 months behind** repo 1.2.0 where the documented features live; 3 stars, single author; its README self-contradicts on aperture-macro support.
- **GRX** (hpcreery, WebGL + workers, X1/X2/X3/Excellon/GDSII/DXF, last commit 2026-08-14) is the most capable, and is **not on npm at all** — vendoring a pnpm/turbo monorepo.
- **`gerber-toolkit` is GPL-3.0-or-later. Do not bundle it.**

**No performance data exists for any Gerber renderer.** Nobody publishes a board size at which they fall over. Benchmark on a real board before committing.

### 3D — **not possible client-side from `.kicad_pcb`. Precompute a GLB offline.**

No maintained pure-JS library renders `.kicad_pcb` in 3D. KiCanvas states 3D is a permanent non-goal. The one team that shipped a serious web 3D PCB tab (Huaqiu's ecad-viewer) delegates model generation to `kicad-cli` in Docker. WASM paths are all disqualifying on size: `occt-import-js` 7.6 MB raw WASM / 2.9 MB brotli (LGPL-2.1, last publish 2024-12-03); `opencascade.js` ~9.1 MB brotli and effectively abandoned; PCBJam ships a 150 MB `kicad_editor.wasm` (26.7 MB stored) plus a 60 MB OpenCascade worker, and is GPL-3.0 anyway.

**The workable architecture:** run `kicad-cli pcb export glb` **once, offline, on a real machine**, run `gltfpack -cc`, commit/upload the result, and render with three.js `GLTFLoader`. Two independent boards went 18 MB → 1,145,092 B and 15.9 MB → 1,056,188 B, "visually identical"; a small inverter board is 450,856 B. Both sources are 0-star personal sites and one admits "nothing renders it yet" — treat the ratio as a plausible anecdote, not a benchmark, and note both are hobby-scale.

Details that will bite:
- Useful flags the first pass missed: `--no-dnp`, `--no-unspecified`, `--define-var`, `--grid-origin`, `--drill-origin`.
- Component **colour survives only from STEP models**; footprints still pointing at `.wrl` export as uncoloured white.
- An unoptimized export in three.js measured ~7,000 draw calls / ~24 fps / ~10 s load; merging geometry by material got it to ~1,500 objects and >60 fps. Meshopt/GLB is the fix.
- `gltfpack -cc` requires a **MeshoptDecoder** in the viewer — a real, unmeasured bundle cost.
- The reference implementation people cite (atopile) is **429 lines**, not ~150, and it fetches three.js from jsDelivr and an HDRI from `dl.polyhaven.org`. A self-contained deployment must vendor three.js, the decoder, and the environment map.

---

## 3. Licensing

**Plain statement of the obligations for a closed-source commercial site.**

**Server side — low risk, and this is the well-trodden path.** KiCad, including `kicad-cli`, is **GPL, not AGPL** — that is the single most important fact. The FSF's own FAQ states that running a GPL program (even a modified one) on your web site is not distribution and creates no source obligation; that pipes, sockets and command-line arguments normally indicate separate programs; that fork+exec without intimate communication produces separate programs; and that **the output of a GPL tool is not covered by the tool's licence**. So: `kicad-cli` in its own container, invoked over argv and files, with your closed-source app never linking KiCad code, sits squarely inside the mainstream reading. Pulling and running `kicad/kicad` privately is not distribution. **Pushing your own derived image to a public or customer-facing registry would be conveying a GPLv3 binary** and pulls in the full source obligation. The FSF explicitly forecloses the "permissive wrapper" workaround — do not attempt to be clever.

(Detail: `kicad/cli/kicad_cli.cpp` itself carries a GPL**v2**-or-later header while `command_export_bom.cpp` is v3+. The tree is mixed; `LICENSE.README` says the combined work is GPLv3+. Conclusion unchanged, but do not repeat "kicad-cli is uniformly GPLv3+".)

**Browser side — this is where the exposure is.** The same FSF FAQ treats **serving JavaScript to a browser as distribution.** And KiCanvas's provenance is genuinely unclear:

- `LICENSE.md` declares MIT © 2022 Alethea Katherine Flowers, with an added clause requiring the notice in derivative works.
- 13 files mention "from KiCad"; 15 `src/` files mention "KiCad's"; **at least 4 explicitly say "adapted from" a named KiCad C++ class** (`STROKE_FONT`, `KIFONT::FONT`, `SCH_PAINTER::draw(LIB_PIN)`) — under an MIT header, with **no relicensing notice anywhere**.
- `src/kicad/text/newstroke-glyphs.ts` carries a verbatim **GPLv2-or-later** notice. This is an *upstream* KiCad problem faithfully copied: KiCad's own `common/newstroke_font.cpp` still carries GPLv2+. KiCad's `LICENSE.README` does not mention newstroke at all (zero matches), so its catch-all sweeps it into GPLv3+; `tools/newstroke/README.txt` states no licence. The CC0 story rests entirely on a 2015 mailing-list post, and the current upstream licence could not be retrieved (GitLab 404).

**So: shipping `kicanvas.js` to browsers ships at least one file bearing a live GPLv2+ notice, plus GPL-derived logic relabelled MIT with no explanation. That is a lawyer question and I will not resolve it here.**

**Library redistribution.** KiCad's symbol/footprint libraries are CC-BY-SA 4.0 **with an exception waiving article 3 for designs and generated files** — but the exception explicitly **does not cover redistributing the library collection itself.** For a parts-directory site, hosting symbols/footprints for download is redistribution and pulls in CC-BY-SA attribution + ShareAlike **on the collection**. (Exactly what "article 3" waives is inferred — Section 3 of CC BY-SA 4.0 is "License Conditions", containing 3(a) Attribution and 3(b) ShareAlike — the legal text was not retrieved.)

**JS layer:** tracespace MIT (clean, stale). Material Symbols Apache-2.0; Nunito/Bellota SIL OFL 1.1 — all fine commercially. **Traps:** `gerber-toolkit` is GPL-3.0-or-later; the npm package `kicad-utils` is GPL-2.0 (and abandoned since 2017); `occt-import-js` is LGPL-2.1, which raises its own questions for a WASM blob in a closed bundle.

**Signal of project intent, not a permission:** KiCad's own official IPC bindings (`kicad-python`) are MIT even though the `.proto` files carry GPLv3+ headers. Nobody explains the split. The addons page does say "Closed-source packages may be used with KiCad under a third-party repository" — but that governs the PCM distribution channel, not server-side invocation. **KiCad publishes no position on whether IPC/CLI clients are derived works**, and the page most likely to address it has not been touched since 2024-12-05.

### Where a lawyer is required, ranked

1. **Can we ship `kicanvas.js` (or any fork) to browsers?** GPLv2+ file present; GPL-derived code under an MIT header; no relicensing notice; upstream font licence unverifiable. Highest exposure because serving JS is distribution.
2. **Can we host KiCad symbols/footprints for download?** ShareAlike on the collection would reach whatever we publish alongside it.
3. **Can we use the name "KiCad" in product naming/marketing?** No trademark or brand policy could be found — both `kicad.org/about/brand-guidelines/` and `/help/legal/` return 404.
4. **LGPL-2.1 WASM (`occt-import-js`) inside a closed bundle**, if the 3D path ever needs it.

There is **no case law** on GPL scope for separate processes that anyone retrieved. Every derived-work conclusion above rests on FSF interpretation, which the FSF itself calls a question for judges.

---

## 4. Cost on a t3.small

The box is 2 burstable vCPUs / 2 GB RAM / 20 GB root, already running Postgres, FastAPI, the frontend, nginx, n8n, cost-sync, feed-import and calendar-reminders.

**Does not fit — do not attempt:**

| Item | Number | Why it fails |
|---|---|---|
| `kicad/kicad:10.0.5-full` | **1.44 GB compressed** pull; extracted size larger (unknown) | Disk margin is thin and RAM is the hard stop |
| KiCad 3D model libraries | **3.3 GB installed** (250.7 MB Debian download); independently measured **3,366,805,440 B = 3.37 GB decimal / 3.14 GiB**, 7,238 items | Required for any non-bare 3D export |
| The 3D delta alone | **~636 MB compressed** (`full` minus base; stable across 9.0.9 and 10.0.5) | The real marginal cost of choosing `-full` |
| `kicad-cli` 3D export, in-request | KiCad-8-era timings on an **8-core Xeon**: 4.4 s / 12.6 s / 27.2 s / **130.4 s** | Two burstable vCPUs will be materially slower and will burn CPU credits while starving the API |
| `kicad-cli` 3D export, memory | **Peak RSS is unpublished.** But KiCad GitLab #19058 documents OOM during STEP export "when fusing shapes" with "less than a few GB of RAM free" | A documented failure mode at exactly this box's headroom |

`--include-tracks` costs **~2.9×–4.8×**, not the 10× first reported (the 30× figure conflated two different boards).

**Fits comfortably:**

- **KiCanvas** — 477,451 B raw / ~112 KB gzip, vendored; brotli lower under our own nginx. Zero server cost.
- **tracespace v4 script-tag bundle** — 200,096 B / ~42 KB gzip. Client-side render, zero server CPU.
- **Precomputed GLB** — ~0.45–1.15 MB per board post-`gltfpack` on the hobby-scale samples available; a static asset served with the same `immutable` caching as our hashed bundles. The unmeasured cost is vendoring three.js + MeshoptDecoder (+ an HDRI if you want the atopile look).
- **`kicad-cli sch export bom` only** does *not* need the 3D libraries — the 808 MB base image would do. But if we only parse user-uploaded CSVs, we do not need the container at all.

**Decision:** all 3D generation happens **offline** — a dev machine or a throwaway spot instance — and the GLB ships as a static asset. `kicad-cli` never enters the request path on this box. If server-side KiCad ever becomes genuinely necessary, it belongs on a separate instance or a batch job. Separately: **n8n's 1.57 GB image is the largest reclaim available** and it has not been in the form path for a long time.

---

## 5. What remains UNVERIFIED, and what the verifier REFUTED

### Whole dimensions that failed — no data at all

- **Real-world MPN column-name frequency.** Nobody surveyed real BOMs, KiBoM, InteractiveHtmlBom, kicost, or JLCPCB/Altium templates. Beyond the literal `MPN`, **every alias is guesswork.** This is the primary input to the CSV auto-detector and it is unresearched. Do this before writing the mapper — a bag of ten real customer BOMs beats every doc read in this packet.
- **Performance of every viewer candidate, in all three of SCH / PCB / 3D.** No benchmarks exist publicly for KiCanvas, tracespace, gerbers-renderer, GRX or wasm-gerber. No published board size at which anything degrades. Must be measured on a representative board.
- **Peak RSS for any server-side KiCad export.** The single biggest risk for a 2 GB box, and it has no published figure.
- **Arrow's BOM tool.** Zero data behind a total login wall.

### Refuted or corrected — the correction stands, the original claim does not

1. Range collapsing (`R1-R3`) does **not** occur on a bare `kicad-cli sch export bom` — `--group-by` has no default.
2. Virtual fields are **not** a closed set of eight; they are open-ended (2 special + 4 attribute vars). The "quotes" in the original finding were paraphrase presented as verbatim doc text.
3. "`MPN` is the only spelling anywhere in KiCad's docs" is **false** — KiCad 10's Variants section says "Manufacturer Part Number" in prose. (`MFR_PN` and `PartNumber` remain unattested.)
4. `--include-excluded-from-bom` exists **only in KiCad 9 and 10**, not 8.
5. `csv.QUOTE_ALL` and `", "` ref joins are used by **all three** legacy scripts, not one.
6. tracespace v4's dist is a **webpack global-var** bundle, not UMD — no `define.amd`, no `module.exports`. Script-tag only.
7. The v5 stack-overflow bug **is fixed** in `@hpcreery` and `@hadimardanian` forks. The claim that all forks carried it was wrong and would have wrongly eliminated a viable option.
8. Firefox clipPath / units-detection / outline-render are **v4-only** (`v5-fixed`), not shared v4+v5 limits.
9. `@tracespace/xml-id`, `/cli`, `/fixtures` have `latest` = **v4**; the alpha is under `next`.
10. `--include-tracks` costs ~2.9–4.8×, not 10×.
11. `Huaqiu-Electronics/kicad-cli-docker` is a **third-party fork building a personal KiCad fork** (`gitlab.com/Liangtie/kicad`), not official. Its benchmark was last committed **2024-04-10** — KiCad-8-era, predating 9 and 10 entirely. Infer nothing about the official image from it.
12. Mouser's **5-BOMs-per-day cap has no documented remedy**; only the 99-line cap has a request form. Both figures are hedged in the source ("typical BOM", "most customers").
13. DigiKey's 1,000-line cap, six quantities and guest access come **solely from a June 2021 press release** with no current corroboration. Unconfirmed-current.
14. Octopart's "no manual mapping step" is **unverified** — the source is simply silent, and Octopart historically shipped user-editable column import and currently documents add/delete/hide/pin columns.
15. Octopart price breaks **are** already factored into automatic best-offer selection ("including bulk discounts"). The "prompt, not multiplier" framing was wrong.
16. Mouser's "radio-style" quantity selector is inferred; the docs only say "Select the line with the desired quantity", and there are **two** update paths (pick an uploaded qty, or type into the text field).
17. `viewer.select()` on a viewer with no document **throws** — it does not soft-miss. `embed.loaded === true` is a **false-positive** success signal.
18. `zoom_to_selection()` is idempotent; the zoom numbers in the evidence are page-state artifacts.
19. Duplicate `U6` entries in the KiCanvas sample: **5**, not 3.
20. atopile's GLB viewer is **429 lines** and fetches three.js and an HDRI from remote hosts.
21. The `@sctg/tracespace-view` README quote was **fabricated**; the real prop type is `string | File | Blob | Array<File | Blob>`.
22. The v5 dists are **minified**, not unminified.
23. `kicad_cli.cpp` is GPL**v2**-or-later; the tree is mixed. (Conclusion unchanged.)
24. The kicanvas NOASSERTION explanation ("non-standard wrapper file") is **wrong** — `LICENSE.md` is an accepted filename; the likeliest cause is the appended sentence inside the MIT block defeating exact text matching. Mark it inferred either way.
25. The Torsten Hüter quotation used to support the Newstroke CC0 story **is not on the cited page.**
26. KiCanvas's KiCad-derivation surface is a **range** — 13 files say "from KiCad", 15 `src/` files say "KiCad's", ≥4 say "adapted from" — not a single number.
27. The dev-docs s-expression spec is **materially stale** (last modified 2024-11/12, pre-KiCad-9), omits `dnp` and `exclude_from_sim` entirely, and literally contains "The `pin` token attributes define ???." Treat `(dnp yes|no)` as **inferred**, not documented.

### Never verified, and you will hit these

- The **GUI** BOM export's literal default header row. **Do not assume it matches the CLI's `Refs,Value,Footprint,Qty,DNP`.** Nobody checked.
- Whether the new BOM exporter always writes a header row.
- The literal column set of the "Grouped By Value" and "Grouped By Value and Footprint" presets.
- Whether KiCad 9/10 actually write `(dnp yes|no)` to disk.
- Any format-stability guarantee for the s-expression formats. **None is published** — the only versioning signal is a per-file `(version YYYYMMDD)` token.
- Any published `.kicad_pro` JSON schema.
- Whether cross-sheet jump-to-designator can be driven from outside the KiCanvas embed (`#project` is private).
- Whether `viewer.select()` survives any future KiCanvas bundle. No versioning, no releases, no changelog, unversioned URL.
- KiCanvas rendering fidelity on real KiCad 8/9/10 projects — untested. Its own README compatibility text is stale.
- KiCanvas memory/perf on a large board or deep hierarchy; mobile is unchecked on its own roadmap.
- What programmatic selection actually *looks* like (translucent grown bbox, never visually inspected).
- ecad-viewer without its Docker sidecar: does plain 2D work, is jump-to-symbol a public API, what does it weigh. All unknown.
- Whether tracespace v4's npm module (as opposed to the prebuilt dist) builds in Vite + React 19 without node polyfills. Untested.
- Whether v5's dynamic `import('node:fs/promises')` is harmless under Vite. Untested.
- Whether `@sctg/tracespace-view` mounts and renders at all. Nobody ran it.
- `gerbers-renderer`'s real aperture-macro (`%AM`) and step-and-repeat (`%SR`) support — its README contradicts itself — and whether the documented API belongs to npm 1.1.6 or the unpublished 1.2.0.
- Whether any Gerber library handles the dialects our suppliers emit (Allegro, Zuken, older Altium). Allegro is a known tracespace weak spot; there is no coverage data for any newer library.
- Shipped bundle size of `gerbers-renderer` and `@tscircuit/pcb-viewer`.
- Uncompressed on-disk size of the `kicad/kicad` images.
- Whether PCBJam's in-browser 3D is production-usable (its marketing and its README disagree).
- `occt-wasm`'s real artifact size and maintenance status.
- Whether `gltfpack -cc` output needs a decoder shim in *our* build, and what it costs.
- GLB size for a dense or 500-component board. Every sample was hobby-scale, self-reported, from 0-star personal repos.
- Whether KiCanvas's `.kicad_pcb` parser is separably consumable as a package (a possible route to procedural three.js).
- DigiKey myLists' accepted upload file types, size cap, mapping step, and per-row match labels (Cloudflare 403 blocked the check).
- Octopart's literal per-row match badge strings; whether anonymous upload works.
- Whether PCBWay does live matching or is purely a file handoff to humans.
- JLCPCB's row-count limit (only the 2 MB file cap and the 200-designators-per-line rule are documented).
- Whether Mouser has any global build-quantity multiplier (absence of evidence only).
- The current upstream Newstroke licence (GitLab 404 — genuinely unverifiable by any route tried).
- Whether KiCanvas's author obtained permission or did a clean-room reimplementation. Nobody asked him.
- Whether KiCad, the FSF or the Linux Foundation has ever commented on KiCanvas's MIT relicensing.
- Any official KiCad position on IPC/CLI clients as derived works.
- Why the `.proto` files are GPLv3+ while `kicad-python` is MIT.
- KiCad trademark/brand policy — both candidate URLs 404.
- Exact CC BY-SA 4.0 section numbering, i.e. precisely what "article 3" waives.
- Whether the official `kicad/kicad` image ships the GPLv3 written offer / corresponding-source paperwork.
- Patent exposure in any of the JS libraries. Not researched.

**Method note for whoever re-runs this:** `octopart.com` returns 403 to WebFetch and `www.mouser.com` times out; both yield to firecrawl. GitHub's unauthenticated code-search API returns 401. A future "could not verify" on those sources probably means the wrong tool was tried.