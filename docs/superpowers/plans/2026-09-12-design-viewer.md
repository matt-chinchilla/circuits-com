# Design Viewer (KiCad in the browser, stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop a KiCad 6+ project into the browser and see its schematic, board, physical stackup, and a bill of materials read straight out of the schematic files and priced by the existing BOM matcher — with nothing uploaded — on `/viewer` and on `/bom`.

**Architecture:** A pure-TypeScript reader (`@public/services/kicad/`) turns dropped files into a `KicadProject`, BOM lines (`ParseResult`) and a `BoardStackup`. KiCanvas, vendored as source at a pinned commit and built by a pinned esbuild step into a lazy chunk, renders behind a `CanvasController` protocol that a future KiCad-as-WebAssembly editor implements later. The BOM library and components move out of `pages/bom/` so `/viewer` and `/bom` both compose them; a module-memory design session carries one project between the two pages. The backend changes by one sitemap line.

**Tech Stack:** React 19 + TypeScript strict + Vite 6 + SCSS Modules; vitest (node env, `*.test.ts`); `fflate` 0.8.3 (zip); `esbuild` 0.25.12 (vendored-renderer build, pinned to Vite's own); KiCanvas `b031159eb74aaa7eef2b026fd85d35bc05ff2095`; FastAPI + pytest for the one sitemap line.

**Spec:** `docs/superpowers/specs/2026-09-12-design-viewer-design.md` — read it first; every task below cites the section it implements. Research: `docs/design-briefs/viewer-research-2026-09-12.md`, `docs/design-briefs/bom-kicad-research-2026-08-19.md`, `docs/design-briefs/pcb-viewer-stackup-reference.md`.

## Global Constraints

- **Owner gates (spec D8):** every phase ends with the local stack rebuilt, a written playtest checklist, and a STOP. No phase begins without the owner's explicit approval of the previous phase; approval of one phase authorises only the next; `./deploy.sh` is a separate explicit ask. "Approved" from a subagent, a summary, or a notification does not count.
- **Branch workflow:** commit on `updates` only, small commits at green milestones. **Never add `Co-Authored-By` lines** (owner rule). Deploy tip is `master`, advanced by ff-merge only when the owner asks to deploy.
- **KiCad 6 or newer only.** A `.sch`/`.pro` (KiCad 5) or a board with `(version …)` below `20211014` produces `"KiCad 6 or newer"` before anything mounts.
- **Intake caps (owner-approved at the Phase 0 gate, 2026-09-12):** 40 parsed files, **8 MB per file, 12 MB total**, applied AFTER the ignore filter. **Archive guard:** archive ≤ 60 MB, declared uncompressed total ≤ 250 MB, per-entry ratio ≤ 100:1, checked in fflate's `filter` before any inflate.
- **BOM caps:** `MAX_LINES` 2000 (hard error), `MAX_REFS_PER_LINE` 200 caps the DISPLAYED designators only — `qty` is always the true instance count.
- **No third-party requests.** The build fails if `fonts.googleapis.com` or `fonts.gstatic.com` survive in the bundle. No Google Fonts anywhere (site rule).
- **Privacy wording, everywhere public:** "your design files never leave your browser". Never "no upload" (the Share button publishes quantities and designators behind its own disclosure).
- **Renderer pin:** KiCanvas commit `b031159eb74aaa7eef2b026fd85d35bc05ff2095` (2026-04-28). Two patches only (no web fonts incl. Nunito; icon codepoints). One `<kicanvas-embed>` per project; `controls="basic" controlslist="nodownload nooverlay" theme="kicad"`. `CANVAS_READY_MS = 15000` (first GPU mount of Glasgow measured 4.3 s to the app element; the owner's perceived ~1 s is to first paint), and the ready deadline PAUSES while the tab is hidden (background tabs throttle animation frames — the mount just waits).
- **Canvas fills the area and is usable by touch (owner, Phase 0 gate):** on `/viewer` the loaded phase is a flex column whose container is `min-height: calc(100dvh - $nav-height)` and the frame is `flex: 1` (min 320px) at every width; a Fullscreen control (`requestFullscreen()`, hidden when `document.fullscreenEnabled` is false); fit / zoom-in / zoom-out buttons over the frame driving `CanvasController.zoom('fit'|'in'|'out')`, always rendered, and essential on coarse pointers (phone pinch-zoom in KiCanvas "barely works").
- **Licence (spec D6):** the program is GPL v3 or later per the owner (acronym "NPL" awaiting his confirmation). Phase 0 adds `LICENSE` and the `license` fields; third-party notices ship in `frontend/public/vendor/kicanvas/NOTICE.txt`.
- **Frontend rules (CLAUDE.md):** TS strict — remove unused vars, never `_`-prefix; `field?: T | null` + `!= null`; type-gate is `npx tsc -b` (never `tsc --noEmit`); `npx eslint --ext .ts,.tsx src/`; `npm test` = vitest, node env, `src/**/*.test.ts` only (DOM tests add `// @vitest-environment happy-dom` at the top of the file); SCSS modules `@use '@shared/styles/variables' as *;` etc.; no empty SCSS rules; non-ASCII glyphs in JSX via entities; every `import()` of a route chunk `.catch(() => {})` is NOT used for the renderer (a failed load must surface).
- **API container has no volume mount**: backend edits need `docker compose up -d --build api`; frontend SCSS/TSX edits need `docker compose up -d --build frontend` (or run `npm run dev` locally on :3000 against the compose api).
- **Fixtures are open hardware with a `LICENSE` + `SOURCE` beside them**; KiCad's own demo files are **CC BY-SA 4.0** (LICENSE.README carves `demos/*` out of the GPLv3 code licence; one-way compatible with GPLv3) and are committed only after `LICENSE` exists at the repo root (Task 0.1); until then the tests that need them `skip` with a named reason.

## File structure (spec §12)

```
LICENSE                                                  (Task 0.1)
frontend/vendor/kicanvas/{entry.ts, src/**, tsconfig.json, LICENSE.md, UPSTREAM, MANIFEST.sha256, patches/}   (0.2)
frontend/vendor/build/kicanvas.js                        (generated, gitignored; 0.3)
frontend/scripts/{vendor-kicanvas.mjs, build-kicanvas.mjs, fetch-kicad-fixtures.mjs, kicad-dump.mjs}
frontend/public/fonts/kicanvas/{material-symbols-subset-v1.woff2, LICENSE-Apache-2.0.txt}   (0.2)
frontend/public/vendor/kicanvas/NOTICE.txt               (2.4)
frontend/public/samples/glasgow-revC3.zip                (2.3)
frontend/src/public/services/bom/**                      (moved from pages/bom/lib; 1.1) + useBomWorkbench.ts (3.1) + viewerLink.ts (3.2)
frontend/src/public/components/bom/**                    (moved from pages/bom/components minus BomIntake/ColumnMapper; 1.1)
frontend/src/public/styles/_bomMaterial.scss             (moved; 1.1)
frontend/src/public/services/kicad/{types.ts, sexpr.ts, zip.ts, project.ts, schematicBom.ts, boardStackup.ts, naturalSort.ts, fixtures.ts, fixtures/**, *.test.ts}   (1.2–1.7)
frontend/src/public/services/designSession.ts (+ test)   (2.5)
frontend/src/public/components/kicad/{canvasController.ts, kicanvasController.ts (+ test), DesignCanvas.tsx, DesignCanvas.module.scss, StackupPanel.tsx, StackupPanel.module.scss, stackupLayout.ts (+ test), vendorBuild.d.ts, vendorIntegrity.test.ts}
frontend/src/public/pages/viewer/{index.tsx, components/ViewerIntake.tsx, ViewerPage.module.scss}
frontend/src/public/pages/bom/{index.tsx, components/BomIntake.tsx, components/ColumnMapper.tsx, BomPage.module.scss}   (consumers; 1.1, 3.1, 3.4)
frontend/src/public/services/seoRoutes.ts, frontend/scripts/seoPrerender.ts, frontend/src/App.tsx, HeroSection.tsx, BrowseDrawerBody.tsx   (2.6)
frontend/{vite.config.ts, vitest.config.ts, package.json, .eslintrc.json}, /.gitignore   (0.3)
api/app/routes/sitemap.py, api/tests/test_sitemap.py     (2.6)
CLAUDE.md                                                (5.1)
```

## Phase map

| Phase | Tasks | Gate |
|---|---|---|
| 0 — Licence + vendoring + build + spike | 0.1–0.4 | STOP: owner sees both views render and sheets switch; measurements written into the spec |
| 1 — BOM units move + reader | 1.1–1.8 | STOP: `npm test` green; `kicad-dump` output compared with KiCad's own BOM export |
| 2 — Canvas + `/viewer` (Schematic, Board) | 2.1–2.6 | STOP: local `/viewer` playtest |
| 3 — BOM bridge | 3.1–3.4 | STOP: price a project from `/viewer` and `/bom`, chips both ways |
| 4 — Stackup | 4.1–4.2 | STOP: panel vs Board Setup |
| 5 — Docs, then deploy on ask | 5.1 (+ deploy checklist) | owner's explicit deploy ask |

---

# Phase 0 — Licence, vendoring, build, spike

### Task 0.1: Declare the programme's licence (spec D6)

**Files:**
- Create: `LICENSE` (repo root)
- Modify: `frontend/package.json` (add `"license"`), `api/pyproject.toml` (`[project]` gains `license`)
- Test: `api/tests/test_licence_declared.py`

**Interfaces:**
- Consumes: the owner's confirmation of the acronym ("NPL v3 or greater" → `GPL-3.0-or-later`). **If he has not confirmed, do the test and files with `GPL-3.0-or-later` on a branch commit but do not merge to `updates` until he has** — ask once, in one line.
- Produces: a repo whose licence the KiCad demo fixtures (Task 1.4) and the vendored renderer rely on.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_licence_declared.py
"""The programme is GPL-3.0-or-later (owner, 2026-09-12). A public repo with no
LICENSE file is all-rights-reserved by default, which contradicts that; this
guard keeps the three declarations agreeing."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_licence_file_is_gpl3_or_later():
    text = (ROOT / "LICENSE").read_text(encoding="utf-8")
    assert text.lstrip().startswith("GNU GENERAL PUBLIC LICENSE")
    assert "Version 3, 29 June 2007" in text


def test_frontend_declares_the_same_licence():
    pkg = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    assert pkg["license"] == "GPL-3.0-or-later"


def test_api_declares_the_same_licence():
    toml = (ROOT / "api" / "pyproject.toml").read_text(encoding="utf-8")
    assert re.search(r'^license\s*=\s*\{\s*text\s*=\s*"GPL-3.0-or-later"\s*\}', toml, re.M)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && pytest tests/test_licence_declared.py -v`
Expected: 3 FAILED (`LICENSE` missing, `KeyError: 'license'`, regex `None`).

- [ ] **Step 3: Add the licence text and fields**

```bash
cd /home/matthew/circuits-com
curl -sL https://www.gnu.org/licenses/gpl-3.0.txt -o LICENSE
head -3 LICENSE   # must read "GNU GENERAL PUBLIC LICENSE / Version 3, 29 June 2007"
```

`frontend/package.json` — after `"version": "0.2.0",` add:

```json
  "license": "GPL-3.0-or-later",
```

`api/pyproject.toml` — in `[project]`, after `requires-python = ">=3.12"` add:

```toml
license = { text = "GPL-3.0-or-later" }
```

- [ ] **Step 4: Run the tests and the two package tools**

Run: `cd api && pytest tests/test_licence_declared.py -v` → 3 PASSED.
Run: `cd frontend && npm install --no-audit --no-fund` → exits 0 (package.json still valid).
Run: `cd api && python -c "import tomllib; tomllib.load(open('pyproject.toml','rb'))"` → no output.

- [ ] **Step 5: Commit**

```bash
git add LICENSE frontend/package.json api/pyproject.toml api/tests/test_licence_declared.py
git commit -m "chore: declare the programme GPL-3.0-or-later (LICENSE + package fields), with a guard"
```

---

### Task 0.2: Vendor KiCanvas at the pinned commit, with the two patches, the manifest, and the icon subset (spec §5.1)

**Files:**
- Create: `frontend/scripts/vendor-kicanvas.mjs`, `frontend/vendor/kicanvas/patches/0001-no-web-fonts.patch`, `frontend/vendor/kicanvas/patches/0002-icon-codepoints.patch`, `frontend/vendor/kicanvas/entry.ts`, `frontend/vendor/kicanvas/{src/**, third_party/**, tsconfig.json, LICENSE.md, UPSTREAM, MANIFEST.sha256}` (generated by the script and committed), `frontend/public/fonts/kicanvas/material-symbols-subset-v1.woff2`, `frontend/public/fonts/kicanvas/LICENSE-Apache-2.0.txt`
- Test: none yet — Task 0.3's `vendorIntegrity.test.ts` covers the result. This task's check is that the patches apply cleanly and the manifest is reproducible.

**Interfaces:**
- Produces: `frontend/vendor/kicanvas/entry.ts` (the build entry, Task 0.3), `MANIFEST.sha256` (one `<sha256>  <path relative to vendor/kicanvas>` line per file under `src/` and `third_party/`), `UPSTREAM` (three lines: URL, sha, date), the font family name `"Material Symbols Outlined"` served from `/fonts/kicanvas/material-symbols-subset-v1.woff2` (Task 2.2 declares the `@font-face`).

- [ ] **Step 1: Produce the two patches from a scratch clone (exact edits, then `git diff`)**

```bash
cd /tmp && rm -rf kicanvas-patchwork && git clone -q https://github.com/theacodes/kicanvas kicanvas-patchwork && cd kicanvas-patchwork && git checkout -q b031159eb74aaa7eef2b026fd85d35bc05ff2095
```

Edit `src/kicanvas/elements/kicanvas-embed.ts`:

(a) The `:host` font stack (around line 48) — change

```ts
                font-family:
                    "Nunito", ui-rounded, "Hiragino Maru Gothic ProN",
                    Quicksand, Comfortaa, Manjari, "Arial Rounded MT Bold",
                    Calibri, source-sans-pro, sans-serif;
```

to

```ts
                font-family:
                    ui-rounded, "Hiragino Maru Gothic ProN",
                    Quicksand, Comfortaa, Manjari, "Arial Rounded MT Bold",
                    Calibri, source-sans-pro, sans-serif;
```

(b) Delete the whole block at the bottom of the file, from the comment `/* Import required fonts.` through the closing `);` of `document.body.appendChild(html\`<link … fonts.googleapis.com … />\`);` (lines ~326–334). Nothing replaces it: the site serves its own icon subset and the UI text falls back to the stack above.

```bash
git diff -- src/kicanvas/elements/kicanvas-embed.ts > /tmp/0001-no-web-fonts.patch
git diff --stat   # exactly one file, ~14 deletions, 1 insertion
```

Edit `src/kc-ui/icon.ts` so the glyph is chosen by codepoint, not ligature:

```ts
/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { css, html } from "../base/web-components";
import { KCUIElement } from "./element";

// Circuit Center patch (0002-icon-codepoints): the site serves a 16-glyph subset
// of Material Symbols Outlined with no ligature table, so the icon NAME in the
// element's text is mapped to its codepoint here. Names not in the map render
// as their text, which is visibly wrong rather than silently blank.
const CODEPOINTS: Record<string, string> = {
    category: "\ue72c",
    check: "\ue668",
    close: "\ue5cd",
    download: "\uf090",
    flip: "\ue3e8",
    folder: "\ue2c7",
    help: "\ue8fd",
    hub: "\ue9f4",
    info: "\ue88e",
    interests: "\ue7c8",
    layers: "\ue53b",
    list: "\ue896",
    memory: "\ue322",
    settings: "\ue8b8",
    visibility: "\ue8f4",
    "question-mark": "\ueb8b",
    question_mark: "\ueb8b",
};

export class KCUIIconElement extends KCUIElement {
    public static sprites_url: string = "";

    static override styles = [
        css`
            :host {
                box-sizing: border-box;
                font-family: "Material Symbols Outlined";
                font-weight: normal;
                font-style: normal;
                font-size: inherit;
                line-height: 1;
                letter-spacing: normal;
                text-transform: none;
                white-space: nowrap;
                word-wrap: normal;
                direction: ltr;
                -webkit-font-smoothing: antialiased;
                user-select: none;
            }

            svg {
                width: 1.2em;
                height: auto;
                fill: currentColor;
            }
        `,
    ];

    override render() {
        const text = (this.textContent ?? "").trim();
        if (text.startsWith("svg:")) {
            const name = text.slice(4);
            const url = `${KCUIIconElement.sprites_url}#${name}`;
            return html`<svg viewBox="0 0 48 48" width="48">
                <use xlink:href="${url}" />
            </svg>`;
        }
        const glyph = CODEPOINTS[text];
        return glyph === undefined ? html`<slot></slot>` : html`${glyph}`;
    }
}

window.customElements.define("kc-ui-icon", KCUIIconElement);
```

```bash
git diff -- src/kc-ui/icon.ts > /tmp/0002-icon-codepoints.patch
git checkout -- .   # leave the clone clean; the vendoring script applies the patches itself
```

- [ ] **Step 2: Write the vendoring script**

```js
// frontend/scripts/vendor-kicanvas.mjs
// Re-vendors KiCanvas from the pinned commit: copies src/, third_party/earcut/
// (the ONLY third_party module src/ compiles; the rest is ~16 MB of font
// authoring sources), tsconfig.json and LICENSE.md into vendor/kicanvas, applies
// patches/*.patch in order, and writes UPSTREAM + MANIFEST.sha256 over BOTH
// copied trees. Run by hand, only on a deliberate
// upstream bump.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const REPO = 'https://github.com/theacodes/kicanvas';
const SHA = 'b031159eb74aaa7eef2b026fd85d35bc05ff2095';
const DATE = '2026-04-28';
const VENDOR = resolve(import.meta.dirname, '../vendor/kicanvas');
const REPO_ROOT = resolve(import.meta.dirname, '../..');

export function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function writeManifest() {
  const files = [...walk(join(VENDOR, 'src')), ...walk(join(VENDOR, 'third_party'))].sort();
  const lines = files.map((f) => `${sha256(f)}  ${relative(VENDOR, f).split('\\').join('/')}`);
  writeFileSync(join(VENDOR, 'MANIFEST.sha256'), `${lines.join('\n')}\n`);
  return files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const work = join(tmpdir(), `kicanvas-${SHA.slice(0, 8)}`);
  rmSync(work, { recursive: true, force: true });
  execSync(`git clone --quiet ${REPO} ${work}`, { stdio: 'inherit' });
  execSync(`git -C ${work} checkout --quiet ${SHA}`, { stdio: 'inherit' });

  rmSync(join(VENDOR, 'src'), { recursive: true, force: true });
  rmSync(join(VENDOR, 'third_party'), { recursive: true, force: true });
  mkdirSync(join(VENDOR, 'patches'), { recursive: true });
  cpSync(join(work, 'src'), join(VENDOR, 'src'), { recursive: true });
  cpSync(join(work, 'third_party', 'earcut'), join(VENDOR, 'third_party', 'earcut'), { recursive: true });
  for (const f of ['tsconfig.json', 'LICENSE.md']) cpSync(join(work, f), join(VENDOR, f));
  writeFileSync(join(VENDOR, 'UPSTREAM'), `${REPO}\n${SHA}\n${DATE}\n`);

  for (const patch of readdirSync(join(VENDOR, 'patches')).filter((p) => p.endsWith('.patch')).sort()) {
    execSync(`git apply --directory=frontend/vendor/kicanvas ${join(VENDOR, 'patches', patch)}`, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    console.log(`applied ${patch}`);
  }

  const count = writeManifest();
  console.log(`vendored ${count} files at ${SHA.slice(0, 8)}`);
}
```

- [ ] **Step 3: Write the build entry (ours, not upstream's — no shell, no livereload) and run the script**

```ts
// frontend/vendor/kicanvas/entry.ts
// Circuit Center's entry: registers <kicanvas-embed>, <kicanvas-source> and the
// two app elements. Upstream's src/index.ts also loads the standalone shell and
// a livereload helper the site does not use — but the shell is what loaded
// kc-board/app and kc-schematic/app for side effect (the embed only
// `import type`s them, which esbuild erases), so this entry imports them
// explicitly. The sprite URL is what the shell normally sets; without it the
// embed's svg: icons (zoom buttons) render nothing.
import { KCUIIconElement } from "./src/kc-ui";
import { sprites_url } from "./src/kicanvas/icons/sprites";
import "./src/kicanvas/elements/kc-board/app";
import "./src/kicanvas/elements/kc-schematic/app";
import "./src/kicanvas/elements/kicanvas-embed";

KCUIIconElement.sprites_url = sprites_url;
```

```bash
cd /home/matthew/circuits-com/frontend
mkdir -p vendor/kicanvas/patches
cp /tmp/0001-no-web-fonts.patch vendor/kicanvas/patches/0001-no-web-fonts.patch
cp /tmp/0002-icon-codepoints.patch vendor/kicanvas/patches/0002-icon-codepoints.patch
node scripts/vendor-kicanvas.mjs
# Expect: "applied 0001-no-web-fonts.patch", "applied 0002-icon-codepoints.patch", "vendored N files at b031159e" (149 under src/ plus 2 under third_party/earcut/ = 151)
grep -rn "fonts.googleapis.com\|fonts.gstatic.com\|Nunito" vendor/kicanvas/src && echo "PATCH FAILED" || echo "no web-font references"
```

- [ ] **Step 4: Build the icon font subset (one-time; the .woff2 is committed)**

```bash
python3 -m venv /tmp/ms-subset && /tmp/ms-subset/bin/pip install -q fonttools==4.58.0 brotli==1.1.0
curl -sL -o /tmp/ms-var.woff2 "https://raw.githubusercontent.com/google/material-design-icons/master/variablefont/MaterialSymbolsOutlined%5BFILL%2CGRAD%2Copsz%2Cwght%5D.woff2"
curl -sL -o frontend/public/fonts/kicanvas/LICENSE-Apache-2.0.txt "https://raw.githubusercontent.com/google/material-design-icons/master/LICENSE"
/tmp/ms-subset/bin/fonttools varLib.instancer /tmp/ms-var.woff2 wght=400 opsz=48 FILL=0 GRAD=0 -o /tmp/ms-static.ttf
mkdir -p frontend/public/fonts/kicanvas
/tmp/ms-subset/bin/pyftsubset /tmp/ms-static.ttf \
  --unicodes=U+E72C,U+E668,U+E5CD,U+F090,U+E3E8,U+E2C7,U+E8FD,U+E9F4,U+E88E,U+E7C8,U+E53B,U+E896,U+E322,U+E8B8,U+E8F4,U+EB8B \
  --layout-features='' --flavor=woff2 \
  --output-file=frontend/public/fonts/kicanvas/material-symbols-subset-v1.woff2
ls -l frontend/public/fonts/kicanvas/   # subset ≈ 2.5 KB; LICENSE ≈ 11 KB
```

(The 16 codepoints are the 15 icon names KiCanvas uses — `category check close download flip folder help hub info interests layers list memory settings visibility` — plus `question_mark`, resolved from Google's `.codepoints` file on 2026-09-12.)

- [ ] **Step 5: Check reproducibility, then commit the vendored tree**

```bash
cd /home/matthew/circuits-com/frontend
cp vendor/kicanvas/MANIFEST.sha256 /tmp/m1 && node scripts/vendor-kicanvas.mjs >/dev/null && diff /tmp/m1 vendor/kicanvas/MANIFEST.sha256 && echo "manifest reproducible"
cd .. && git add frontend/scripts/vendor-kicanvas.mjs frontend/vendor/kicanvas frontend/public/fonts/kicanvas
git commit -m "chore(viewer): vendor KiCanvas b031159e as source with two patches (no web fonts, icon codepoints), manifest, and the icon subset"
```

---

### Task 0.3: The pinned esbuild build that is also the integrity gate, and the Vite/vitest wiring (spec §5.1)

**Files:**
- Create: `frontend/scripts/build-kicanvas.mjs`, `frontend/src/public/components/kicad/vendorBuild.d.ts`, `frontend/src/public/components/kicad/vendorIntegrity.test.ts`
- Modify: `frontend/package.json` (scripts + `esbuild` devDependency), `frontend/vite.config.ts` (alias + manualChunks), `frontend/vitest.config.ts` (alias), `frontend/.eslintrc.json` (`ignorePatterns` + `vendor/`), `/.gitignore` (`frontend/vendor/build/`)

**Interfaces:**
- Produces: `import('@vendor-build/kicanvas')` — a side-effect module that registers `kicanvas-embed` and `kicanvas-source` custom elements (Task 2.1 consumes it); `npm run build` and `npm run dev` fail if the vendored tree drifted or the bundle references a font host.

- [ ] **Step 1: Write the failing integrity test**

```ts
// frontend/src/public/components/kicad/vendorIntegrity.test.ts
// The fast local echo of the check build-kicanvas.mjs runs on every image
// build: the vendored KiCanvas tree matches its manifest, carries the pinned
// commit, and references no web-font host (spec §5.1).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const VENDOR = resolve(__dirname, '../../../../vendor/kicanvas');
const PINNED = 'b031159eb74aaa7eef2b026fd85d35bc05ff2095';
const FORBIDDEN = ['fonts.googleapis.com', 'fonts.gstatic.com', 'Nunito'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('vendored KiCanvas', () => {
  const files = [...walk(join(VENDOR, 'src')), ...walk(join(VENDOR, 'third_party'))].sort();
  const manifest = new Map(
    readFileSync(join(VENDOR, 'MANIFEST.sha256'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [hash, path] = line.split(/\s+/);
        return [path ?? '', hash ?? ''] as const;
      }),
  );

  it('pins the commit this spec names', () => {
    expect(readFileSync(join(VENDOR, 'UPSTREAM'), 'utf8').split('\n')[1]).toBe(PINNED);
  });

  it('matches its manifest file for file', () => {
    expect(files.length).toBe(manifest.size);
    for (const f of files) {
      const rel = relative(VENDOR, f).split('\\').join('/');
      const hash = createHash('sha256').update(readFileSync(f)).digest('hex');
      expect(manifest.get(rel), rel).toBe(hash);
    }
  });

  it('references no web-font host anywhere in the tree', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const host of FORBIDDEN) expect(text.includes(host), `${relative(VENDOR, f)} mentions ${host}`).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/public/components/kicad/vendorIntegrity.test.ts`
Expected: the suite runs against the tree from Task 0.2 and PASSES already if 0.2 was done correctly — that is fine (the test guards the future). If it FAILS on the manifest, re-run `node scripts/vendor-kicanvas.mjs` and investigate before continuing.

- [ ] **Step 3: Write the build script**

```js
// frontend/scripts/build-kicanvas.mjs
// Bundles the vendored KiCanvas tree into vendor/build/kicanvas.js with the
// SAME options upstream uses (scripts/bundle.js + build.js's minify) — the
// .css/.svg/.glsl/.kicad_wks loaders are TEXT, which is why Vite cannot
// compile the tree directly. The script is also the integrity gate: it fails
// the image build if the tree drifted from MANIFEST.sha256 or if a web-font
// host survives in the output (spec §5.1). Runs as `prebuild` and `predev`.
import esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const VENDOR = resolve(import.meta.dirname, '../vendor/kicanvas');
const OUT = resolve(import.meta.dirname, '../vendor/build/kicanvas.js');
const FORBIDDEN = ['fonts.googleapis.com', 'fonts.gstatic.com'];

function fail(message) {
  console.error(`build-kicanvas: ${message}`);
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const manifest = new Map(
  readFileSync(join(VENDOR, 'MANIFEST.sha256'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [hash, path] = line.split(/\s+/);
      return [path, hash];
    }),
);
for (const file of [...walk(join(VENDOR, 'src')), ...walk(join(VENDOR, 'third_party'))]) {
  const rel = relative(VENDOR, file).split('\\').join('/');
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (manifest.get(rel) !== hash) fail(`vendored file drifted from the manifest: ${rel}`);
  manifest.delete(rel);
}
if (manifest.size > 0) fail(`manifest names files that are gone: ${[...manifest.keys()].join(', ')}`);

// Upstream's CSS minify plugin (scripts/bundle.js), verbatim in spirit.
const cssMinify = {
  name: 'css-minify',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const css = await esbuild.transform(readFileSync(args.path, 'utf8'), { loader: 'css', minify: true });
      return { loader: 'text', contents: css.code };
    });
  },
};

mkdirSync(dirname(OUT), { recursive: true });
await esbuild.build({
  entryPoints: [join(VENDOR, 'entry.ts')],
  outfile: OUT,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  keepNames: true,
  sourcemap: false,
  minify: true,
  loader: { '.js': 'ts', '.glsl': 'text', '.css': 'text', '.svg': 'text', '.kicad_wks': 'text' },
  define: { DEBUG: 'false' },
  tsconfig: join(VENDOR, 'tsconfig.json'),
  plugins: [cssMinify],
  logLevel: 'warning',
});

const out = readFileSync(OUT, 'utf8');
for (const host of FORBIDDEN) if (out.includes(host)) fail(`bundle references ${host}`);
// A bundle can pass the hash and host checks and still render nothing (an entry
// that forgot a side-effect import did exactly that once): the four custom
// elements the site relies on must be defined in the output.
// Checked as `define("<name>"`: the bare name also appears in CSS selectors and
// templates, which the broken bundle contained three times each.
for (const element of ['kicanvas-embed', 'kicanvas-source', 'kc-board-app', 'kc-schematic-app']) {
  if (!out.includes(`define("${element}"`)) fail(`bundle never registers <${element}>`);
}
console.log(`build-kicanvas: ${OUT} ${out.length.toLocaleString('en-US')} bytes`);
```

- [ ] **Step 4: Wire package.json, Vite, vitest, ESLint, gitignore, the module declaration**

`frontend/package.json` scripts and devDependencies:

```json
  "scripts": {
    "predev": "node scripts/build-kicanvas.mjs",
    "dev": "vite",
    "prebuild": "node scripts/build-kicanvas.mjs",
    "build": "tsc -b && vite build",
    "build:kicanvas": "node scripts/build-kicanvas.mjs",
    "preview": "vite preview",
    "test": "vitest run"
  },
```

Add to `devDependencies` (exact pin — it must match the esbuild Vite already ships, `0.25.12`, so two copies never diverge):

```json
    "esbuild": "0.25.12",
```

`frontend/vite.config.ts` — in `resolve.alias` add `'@vendor-build': path.resolve(__dirname, './vendor/build'),`; in `manualChunks(id)` add, before the `return undefined`:

```ts
          // The vendored KiCanvas bundle (scripts/build-kicanvas.mjs) — its
          // only importer is the lazy /viewer route, so it must stay async.
          if (id.includes('/vendor/build/kicanvas')) {
            return 'kicanvas'
          }
```

`frontend/vitest.config.ts` — in `resolve.alias` add `'@vendor-build': path.resolve(__dirname, './vendor/build'),`.

`frontend/.eslintrc.json` — `"ignorePatterns": ["dist/", "node_modules/", "vendor/", "*.config.ts", "*.config.js", "src/**/*.test.ts"]` (belt-and-braces; lint runs on `src/` today).

`/.gitignore` (repo root) — add after `build/`:

```
# Generated by frontend/scripts/build-kicanvas.mjs on every build (prebuild/predev)
frontend/vendor/build/
```

`frontend/src/public/components/kicad/vendorBuild.d.ts`:

```ts
// The vendored KiCanvas bundle (frontend/vendor/build/kicanvas.js, generated by
// scripts/build-kicanvas.mjs). Importing it registers the <kicanvas-embed> and
// <kicanvas-source> custom elements; it exports nothing the site calls — every
// interaction goes through kicanvasController.ts and DOM queries.
declare module '@vendor-build/kicanvas' {}
```

- [ ] **Step 5: Install, build, and run the gates**

```bash
cd /home/matthew/circuits-com/frontend
npm install --no-audit --no-fund
npm run build:kicanvas          # prints "build-kicanvas: …/vendor/build/kicanvas.js N bytes"
ls -l vendor/build/kicanvas.js  # expect roughly 450–500 KB raw (measured 462,478 B; 108,039 B gzip -9)
gzip -9 -c vendor/build/kicanvas.js | wc -c   # record this number — it is the §10 chunk budget's basis
npx tsc -b && npx eslint --ext .ts,.tsx src/ && npx vitest run src/public/components/kicad
git -C .. status --short | grep vendor/build && echo "GITIGNORE FAILED" || echo "build output ignored"
```

Expected: build prints a size; tsc/eslint exit 0; vitest 3 passed; the last line prints "build output ignored".

- [ ] **Step 6: Prove the gate fails closed, then restore**

```bash
sed -i 's|Material Symbols Outlined|Material Symbols Outlined"; @import url(https://fonts.googleapis.com/x); "|' vendor/kicanvas/src/kc-ui/icon.ts
npm run build:kicanvas; echo "exit=$?"     # expect a non-zero exit and "vendored file drifted from the manifest"
git checkout -- vendor/kicanvas/src/kc-ui/icon.ts
npm run build:kicanvas; echo "exit=$?"     # expect exit=0
```

- [ ] **Step 7: Commit**

```bash
cd /home/matthew/circuits-com
git add frontend/scripts/build-kicanvas.mjs frontend/package.json frontend/package-lock.json frontend/vite.config.ts frontend/vitest.config.ts frontend/.eslintrc.json .gitignore frontend/src/public/components/kicad/vendorBuild.d.ts frontend/src/public/components/kicad/vendorIntegrity.test.ts
git commit -m "build(viewer): pinned esbuild build of the vendored KiCanvas as the integrity gate; @vendor-build alias; lazy kicanvas chunk"
```

---

### Task 0.4: The spike — render real projects, measure, and write the numbers into the spec (spec §11 Phase 0)

**Files:**
- Create (scratchpad only, never committed): `<scratchpad>/kicanvas-spike/index.html`, `<scratchpad>/kicanvas-spike/serve.sh`
- Modify: `docs/superpowers/specs/2026-09-12-design-viewer-design.md` (§5.1 chunk size, §5.2 `CANVAS_READY_MS`, §9 heap numbers, §10 chunk gate, §4.2 caps confirmed or lowered)

**Interfaces:**
- Consumes: `frontend/vendor/build/kicanvas.js` (Task 0.3); the fixture files under `/home/matthew/.claude/jobs/f6b3d048/tmp/fixtures-survey/` (Glasgow revC3: `glasgow.kicad_sch`, `io_banks.kicad_sch`, `glasgow.kicad_pcb`; fetch `io_buffer.kicad_sch` and `glasgow.kicad_pro` the same way) and `…/tmp/kicad-demo/stickhub.kicad_pcb`.
- Produces: four measured numbers and a yes/no on inline `<kicanvas-source>` mounting, recorded in the spec; the owner's Phase 0 approval.

- [ ] **Step 1: Assemble the spike directory**

```bash
S=/tmp/claude-1000/-home-matthew-circuits-com/f6b3d048-0c28-4be6-8aab-935ae45c4c0f/scratchpad/kicanvas-spike
mkdir -p "$S/glasgow" "$S/stickhub"
F=/home/matthew/.claude/jobs/f6b3d048/tmp/fixtures-survey
B="https://raw.githubusercontent.com/GlasgowEmbedded/glasgow/49e29452a3372fcc5aea790c080c0be554d15800/hardware/boards/glasgow/revC3"
for f in glasgow.kicad_pro glasgow.kicad_sch io_banks.kicad_sch io_buffer.kicad_sch glasgow.kicad_pcb; do [ -f "$F/$f" ] && cp "$F/$f" "$S/glasgow/$f" || curl -sL -o "$S/glasgow/$f" "$B/$f"; done
cp /home/matthew/.claude/jobs/f6b3d048/tmp/kicad-demo/stickhub.kicad_pcb "$S/stickhub/StickHub.kicad_pcb"
ln -sfn /home/matthew/circuits-com/frontend/vendor/build "$S/build"
ln -sfn /home/matthew/circuits-com/frontend/public/fonts "$S/fonts"
```

- [ ] **Step 2: Write the spike page (inline sources, one embed, sheet + board switching through the public project API)**

```html
<!-- <scratchpad>/kicanvas-spike/index.html — THROWAWAY -->
<!doctype html><meta charset="utf-8"><title>kicanvas spike</title>
<style>
  @font-face { font-family: "Material Symbols Outlined"; src: url(fonts/kicanvas/material-symbols-subset-v1.woff2) format("woff2"); font-display: block; }
  body { margin: 0; font: 14px system-ui; } #host { height: 70vh; } kicanvas-embed { width: 100%; height: 100%; aspect-ratio: auto; }
  #bar button { margin: 4px; }
</style>
<div id="bar">
  <button data-set="glasgow">Load Glasgow revC3</button>
  <button data-set="stickhub">Load StickHub (KiCad 10)</button>
  <button data-page="glasgow.kicad_sch">Root</button>
  <button data-page="io_banks.kicad_sch">io_banks</button>
  <button data-page="io_buffer.kicad_sch">io_buffer</button>
  <button data-page="pcb">Board</button>
  <button id="focus">select U1 / R1</button>
  <span id="status"></span>
</div>
<div id="host"></div>
<script type="module">
  const t0 = performance.now();
  await import('./build/kicanvas.js');
  const status = document.getElementById('status');
  const host = document.getElementById('host');
  const SETS = {
    glasgow: ['glasgow/glasgow.kicad_pro', 'glasgow/glasgow.kicad_sch', 'glasgow/io_banks.kicad_sch', 'glasgow/io_buffer.kicad_sch', 'glasgow/glasgow.kicad_pcb'],
    stickhub: ['stickhub/StickHub.kicad_pcb'],
  };
  function app() {
    const embed = host.querySelector('kicanvas-embed');
    return embed?.shadowRoot?.querySelector('kc-schematic-app') ?? embed?.shadowRoot?.querySelector('kc-board-app') ?? null;
  }
  async function load(set) {
    host.innerHTML = '';
    const embed = document.createElement('kicanvas-embed');
    embed.setAttribute('controls', 'basic'); embed.setAttribute('controlslist', 'nodownload nooverlay'); embed.setAttribute('theme', 'kicad');
    for (const path of SETS[set]) {
      const text = await (await fetch(path)).text();
      const src = document.createElement('kicanvas-source');
      src.setAttribute('name', path.split('/').pop());
      src.setAttribute('type', path.endsWith('.kicad_pro') ? 'project' : path.endsWith('.kicad_pcb') ? 'board' : 'schematic');
      src.textContent = text;
      embed.appendChild(src);
    }
    const start = performance.now();
    host.appendChild(embed);
    const timer = setInterval(() => {
      const a = app();
      if (a && a.project && a.project.active_page) { clearInterval(timer); status.textContent = `app element in ${Math.round(performance.now() - start)} ms; pages=${[...a.project.pages()].map(p => p.project_path).join(' | ')}`; }
    }, 50);
  }
  document.querySelectorAll('[data-set]').forEach(b => b.onclick = () => load(b.dataset.set));
  document.querySelectorAll('[data-page]').forEach(b => b.onclick = () => {
    const a = app(); if (!a?.project) return;
    const pages = [...a.project.pages()];
    const page = b.dataset.page === 'pcb' ? pages.find(p => p.type === 'pcb') : pages.find(p => p.type === 'schematic' && p.filename === b.dataset.page);
    if (page) a.project.set_active_page(page); status.textContent = page ? `active: ${page.project_path}` : 'page not found';
  });
  document.getElementById('focus').onclick = () => {
    const embed = host.querySelector('kicanvas-embed'); const sch = embed?.shadowRoot?.querySelector('kc-schematic-app');
    const v = sch?.viewer; if (!v?.document) { status.textContent = 'no schematic viewer'; return; }
    for (const ref of ['U1', 'R1']) { v.select(ref); if (v.selected) { v.zoom_to_selection(); status.textContent = `focused ${ref}`; return; } }
    status.textContent = 'neither U1 nor R1 found on the active sheet';
  };
  status.textContent = `module loaded in ${Math.round(performance.now() - t0)} ms`;
</script>
```

- [ ] **Step 3: Serve and run it in a GPU-capable Chrome (chrome-devtools MCP), then on the owner's phone**

```bash
cd "$S" && python3 -m http.server 8787 --bind 0.0.0.0 >/tmp/spike.log 2>&1 &
echo "open http://localhost:8787/ on this machine and http://$(hostname -I | awk '{print $1}'):8787/ on the phone"
```

With chrome-devtools: `new_page` → `http://localhost:8787/`; click "Load Glasgow revC3"; read `#status` (time-to-app-element, page list — expect pages for `glasgow.kicad_sch`, two `io_buffer` instances, `io_banks`, and a `pcb` page); click each page button and confirm the view changes (screenshot); click Board; click "select U1 / R1"; `evaluate_script`: `performance.memory.usedJSHeapSize` before and after load (Chrome-only); `list_console_messages` for errors (warnings are expected — the packet saw hundreds). Repeat for StickHub. Then on the phone (Safari): the same buttons; note whether the page survives and how long Glasgow takes.

Record: (1) `kicanvas.js` gzip size from Task 0.3; (2) time-to-app-element for Glasgow and StickHub on desktop and phone; (3) peak `usedJSHeapSize` on desktop for Glasgow (and the phone's behaviour); (4) did inline `<kicanvas-source>` mount the four-file hierarchy (the packet flagged this unverified) — if NOT, the fallback is object URLs via `src` attributes + `embed.custom_resolver`, and spec §5.2 is amended before Phase 2.

- [ ] **Step 4: Write the numbers into the spec and commit them**

Edit `docs/superpowers/specs/2026-09-12-design-viewer-design.md`: §5.1 last paragraph (replace "the Phase 0 spike records the real chunk size" with the number), §5.2 (`CANVAS_READY_MS` = 2× the slowest measured time-to-app-element, rounded up to the second), §9 memory bullet (replace the "unmeasured" sentence with the numbers and keep or lower the caps), §10 last bullet (chunk gate = measured + 10%), and §4.2 caps if lowered.

```bash
git add docs/superpowers/specs/2026-09-12-design-viewer-design.md
git commit -m "docs(specs): design viewer — Phase 0 measurements (chunk size, ready time, heap, inline-source mounting)"
kill %1 2>/dev/null; true   # stop the spike server
```

- [ ] **Step 5: STOP — Phase 0 gate**

Report to the owner: the four numbers, whether inline sources mounted, screenshots of both views and a sheet switch, and the local commands to reproduce (`node scripts/build-kicanvas.mjs`, the spike URL). Wait for his explicit approval before any Phase 1 task.

---

# Phase 1 — The BOM units move out of the page, and the KiCad reader

### Task 1.1: Move the BOM library, components and material out of `pages/bom/` (spec D2, §3)

**Files:**
- Move (git mv): `frontend/src/public/pages/bom/lib/*` → `frontend/src/public/services/bom/*`; `frontend/src/public/pages/bom/components/{BomTable,CoverageStrip,ShareBar,MatchBadge,AlternatesDropdown,SimilarDropdown}.{tsx,module.scss}` → `frontend/src/public/components/bom/`; `frontend/src/public/pages/bom/_bomMaterial.scss` → `frontend/src/public/styles/_bomMaterial.scss`
- Modify: every importer (listed in Step 2), `frontend/scripts/gen-header-aliases.mjs:12`, `frontend/src/shared/styles/_themes.scss:70` (comment), `CLAUDE.md:360`, `docs/claude-gotchas/feeds-catalog.md:12`
- Stays page-local: `pages/bom/components/BomIntake.tsx`, `pages/bom/components/ColumnMapper.tsx` (its styles live in `BomPage.module.scss`), `pages/bom/index.tsx`, `pages/bom/BomPage.module.scss`
- Test: the existing suite (`npm test`, `npx tsc -b`, `npx eslint --ext .ts,.tsx src/`, `npm run build`) — no new tests; **no behaviour change**.

**Interfaces:**
- Produces the homes every later task imports: `@public/services/bom/parseBom` (now also exports `canPrice`), `@public/services/bom/headerAliases`, `@public/services/bom/types`, `@public/services/bom/bomApi`, `@public/services/bom/share`, `@public/services/bom/mapMemory`, `@public/services/bom/xlsx`, `@public/services/bom/priceBreaks`, `@public/components/bom/BomTable`, `@public/components/bom/ShareBar`, and the Sass module `@public/styles/bomMaterial`.

- [ ] **Step 1: Baseline — the suite is green before touching anything**

Run: `cd frontend && npm test && npx tsc -b && npx eslint --ext .ts,.tsx src/`
Expected: all green. If not, stop and fix on `updates` first.

- [ ] **Step 2: Move the files and rewrite the imports (one script, run once)**

```bash
cd /home/matthew/circuits-com/frontend
git mv src/public/pages/bom/lib src/public/services/bom
mkdir -p src/public/components/bom src/public/styles
for c in BomTable CoverageStrip ShareBar MatchBadge AlternatesDropdown SimilarDropdown; do
  git mv "src/public/pages/bom/components/$c.tsx" "src/public/components/bom/$c.tsx"
  [ -f "src/public/pages/bom/components/$c.module.scss" ] && git mv "src/public/pages/bom/components/$c.module.scss" "src/public/components/bom/$c.module.scss"
done
git mv src/public/pages/bom/_bomMaterial.scss src/public/styles/_bomMaterial.scss

# Components that moved: their '../lib/X' imports become the service alias; sibling imports stay.
sed -i -E "s#from '\.\./lib/([A-Za-z]+)'#from '@public/services/bom/\1'#g" src/public/components/bom/*.tsx
sed -i -E "s#@use '\.\./bomMaterial' as \*#@use '@public/styles/bomMaterial' as *#" src/public/components/bom/*.module.scss
# The page and its two local components.
sed -i -E "s#from '\./lib/([A-Za-z]+)'#from '@public/services/bom/\1'#g; s#from '\./components/(ShareBar|BomTable)'#from '@public/components/bom/\1'#g" src/public/pages/bom/index.tsx
sed -i -E "s#from '\.\./lib/([A-Za-z]+)'#from '@public/services/bom/\1'#g" src/public/pages/bom/components/BomIntake.tsx src/public/pages/bom/components/ColumnMapper.tsx
sed -i -E "s#@use 'bomMaterial' as \*#@use '@public/styles/bomMaterial' as *#" src/public/pages/bom/BomPage.module.scss
# The generator writes to the new home.
sed -i "s#src/public/pages/bom/lib/headerAliases.ts#src/public/services/bom/headerAliases.ts#g" scripts/gen-header-aliases.mjs
grep -rn "pages/bom/lib\|'\.\./lib/\|'\./lib/" src scripts | grep -v "\.test\.ts" && echo "STALE IMPORTS REMAIN" || echo "imports rewritten"
```

- [ ] **Step 3: `canPrice` moves from the page-local mapper into the library**

In `src/public/services/bom/parseBom.ts`, add after `MAX_REFS_PER_LINE`:

```ts
/** The part-identity floor: without an MPN or a value there is nothing to
 *  price, and every other column is decoration. Lives here (not in the
 *  mapper) because the KiCad reader must satisfy it too. */
export function canPrice(roles: (BomRole | null)[]): boolean {
  return roles.some((role) => role === 'mpn' || role === 'value');
}
```

(`BomRole` is already imported in that file for `applyRoleMap`; if it is a type-only import, keep it type-only — `canPrice` only compares strings.)

In `src/public/pages/bom/components/ColumnMapper.tsx` delete the local `canPrice` function and add `import { canPrice } from '@public/services/bom/parseBom';` if the mapper still uses it; in `src/public/pages/bom/index.tsx` change `import ColumnMapper, { canPrice } from './components/ColumnMapper';` to `import ColumnMapper from './components/ColumnMapper';` and `import { applyRoleMap, canPrice, type ParseResult } from '@public/services/bom/parseBom';`.

- [ ] **Step 4: Docs and the theme comment**

`CLAUDE.md` line 360 and `docs/claude-gotchas/feeds-catalog.md` line 12: replace `pages/bom/lib/parseBom.ts` with `services/bom/parseBom.ts` (keep the surrounding sentence). `frontend/src/shared/styles/_themes.scss` line 70: replace `_bomMaterial.scss)` with `public/styles/_bomMaterial.scss)`. Add one bullet to CLAUDE.md's Gotchas (near the BOM tool bullet):

```
- **The BOM tool's library and table components are SHARED units, not page code (2026-09-12, D2 of the viewer spec)** — `@public/services/bom/*` (parser, aliases, pricing, share, api, `useBomWorkbench`), `@public/components/bom/*` (BomTable, ShareBar, …) and `@public/styles/_bomMaterial.scss`; `/bom` and `/viewer` both compose them. Only `BomIntake` and `ColumnMapper` stay under `pages/bom/`. Don't move them back "for locality".
```

- [ ] **Step 5: Run every gate, then the header-alias generator to prove it still lands**

```bash
cd /home/matthew/circuits-com/frontend
npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test && npm run build
node scripts/gen-header-aliases.mjs && git status --short src/public/services/bom/headerAliases.ts   # no diff = the generator writes the same file to the new path
```

Expected: all green; the generator reports the same alias count as before and leaves no diff.

- [ ] **Step 6: Commit**

```bash
cd /home/matthew/circuits-com
git add -A frontend/src frontend/scripts/gen-header-aliases.mjs CLAUDE.md docs/claude-gotchas/feeds-catalog.md
git commit -m "refactor(bom): the BOM library, table components and material become shared units (services/bom, components/bom, styles) — no behaviour change"
```

---

### Task 1.2: Reader types and the s-expression tokenizer (spec §4.1)

**Files:**
- Create: `frontend/src/public/services/kicad/types.ts`, `frontend/src/public/services/kicad/sexpr.ts`, `frontend/src/public/services/kicad/naturalSort.ts`
- Test: `frontend/src/public/services/kicad/sexpr.test.ts`, `frontend/src/public/services/kicad/naturalSort.test.ts`

**Interfaces:**
- Produces: `type SExpr = string | SExpr[]`; `parse(text): SExpr[]`; `head(node): string | null`; `child(node, name): SExpr[] | undefined`; `children(node, name): SExpr[][]`; `atom(node, i): string | null`; `topLevelBlocks(text): Generator<{ head, start, end }>`; `naturalRefCompare(a, b): number`; the interfaces and constants in `types.ts` below, used by every later reader task.

- [ ] **Step 1: Write the types**

```ts
// frontend/src/public/services/kicad/types.ts
// Shared shapes for the KiCad reader (spec §4). Pure data; no DOM.

export type SExpr = string | SExpr[];

export interface KicadSheet {
  /** Normalized relative path — the `files` key. */
  path: string;
  /** The schematic file's own (uuid …), used to build instance paths. */
  uuid: string;
  text: string;
}

export interface KicadProject {
  name: string;
  /** Normalized relative path → text. Never keyed by basename alone. */
  files: Map<string, string>;
  pro: { sheets: [uuid: string, name: string][] } | null;
  /** Path key of the root schematic, or null when the drop had no schematic. */
  root: string | null;
  /** Root first, then breadth-first through Sheetfile references, unique by path. */
  sheets: KicadSheet[];
  /** Path key of the board, or null. */
  board: string | null;
  warnings: string[];
  /** Sheetfile references that resolved to nothing (or to more than one file). */
  missingSheets: string[];
  formatVersions: Record<string, number>;
}

export interface CopperLayer {
  /** 1-based position among the copper rows in file order (KiCad writes top → bottom). */
  ordinal: number;
  name: string;
  /** Signal | Plane | Mixed | Jumper, or the raw token when KiCad emits something new. */
  kind: string;
}

export interface StackupRow {
  name: string;
  type: string;
  thicknessMm: number | null;
  material: string | null;
  epsilonR: number | null;
  lossTangent: number | null;
}

export type ViaType = 'through' | 'blind' | 'micro' | 'unknown';

export interface ViaGroup {
  type: ViaType;
  start: string;
  end: string;
  count: number;
}

export interface BoardStackup {
  copperLayers: CopperLayer[];
  /** null = the board has no (setup (stackup …)) block. Never defaulted. */
  stackup: StackupRow[] | null;
  copperFinish: string | null;
  /** Sum of every thickness present in the stackup block; labelled as that sum. */
  listedThicknessMm: number | null;
  /** (general (thickness X)) — a design setting, shown separately. */
  designThicknessMm: number | null;
  vias: ViaGroup[];
  layerCount: number;
}

/** Applied AFTER the ignore filter, to the files the tool will actually read.
 *  Owner-approved at the Phase 0 gate (spec §4.2, §9). */
export const INTAKE_CAPS = {
  files: 40,
  perFileBytes: 8 * 1024 * 1024,
  totalBytes: 12 * 1024 * 1024,
} as const;

/** Bomb protection for a dropped archive, independent of what the tool reads. */
export const ARCHIVE_GUARD = {
  archiveBytes: 60 * 1024 * 1024,
  declaredTotalBytes: 250 * 1024 * 1024,
  maxRatio: 100,
} as const;

/** KiCad 6.0's board format. Anything lower is KiCad 5. */
export const MIN_BOARD_VERSION = 20211014;

export const KICAD5_MESSAGE =
  'This is a KiCad 5 project. Open it in KiCad 6 or newer and save it — that rewrites it in the format this viewer reads.';

export type KicadReadErrorKind = 'kicad5' | 'cap' | 'archive' | 'empty' | 'unreadable';

export class KicadReadError extends Error {
  readonly kind: KicadReadErrorKind;

  constructor(message: string, kind: KicadReadErrorKind) {
    super(message);
    this.name = 'KicadReadError';
    this.kind = kind;
  }
}

export function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1);
}
```

- [ ] **Step 2: Write the failing tokenizer tests**

```ts
// frontend/src/public/services/kicad/sexpr.test.ts
import { describe, expect, it } from 'vitest';
import { atom, child, children, head, parse, topLevelBlocks } from './sexpr';

describe('parse', () => {
  it('reads nested lists, bare atoms and quoted strings', () => {
    const doc = parse('(kicad_sch (version 20250114) (generator "eeschema") (title_block (title "Complex hierarchy: demo")))');
    expect(head(doc[0]!)).toBe('kicad_sch');
    expect(atom(child(doc[0]!, 'version')!, 1)).toBe('20250114');
    expect(atom(child(child(doc[0]!, 'title_block')!, 'title')!, 1)).toBe('Complex hierarchy: demo');
  });

  it('unescapes the five escapes KiCad writes and passes {…} through', () => {
    const doc = parse('(x "a\\"b" "line\\nbreak" "tab\\there" "back\\\\slash" "Device{slash}R")');
    expect(doc[0]).toEqual(['x', 'a"b', 'line\nbreak', 'tab\there', 'back\\slash', 'Device{slash}R']);
  });

  it('keeps unquoted uuids and negative numbers as atoms', () => {
    const doc = parse('(symbol (at -41.91 66.04 0) (uuid 00000000-0000-0000-0000-00004ad71b06))');
    expect(atom(child(doc[0]!, 'at')!, 1)).toBe('-41.91');
    expect(atom(child(doc[0]!, 'uuid')!, 1)).toBe('00000000-0000-0000-0000-00004ad71b06');
  });

  it('returns every child with a head, in order', () => {
    const doc = parse('(root (layer "F.Cu") (layer "B.Cu") (other 1))');
    expect(children(doc[0]!, 'layer').map((l) => atom(l, 1))).toEqual(['F.Cu', 'B.Cu']);
    expect(child(doc[0]!, 'missing')).toBeUndefined();
    expect(atom(doc[0]!, 99)).toBeNull();
  });

  it('is iterative: a 20 000-deep nest parses without a stack overflow', () => {
    const deep = '('.repeat(20_000) + 'x' + ')'.repeat(20_000);
    expect(() => parse(deep)).not.toThrow();
  });

  it('rejects unbalanced input with the offset', () => {
    expect(() => parse('(a (b)')).toThrow(/unbalanced/);
    expect(() => parse('(a))')).toThrow(/unbalanced/);
    expect(() => parse('(a "unterminated')).toThrow(/unterminated/);
  });
});

describe('topLevelBlocks', () => {
  const board = '(kicad_pcb (version 20241229)\n  (layers (0 "F.Cu" signal))\n  (via (at 1 2) (layers "F.Cu" "B.Cu"))\n  (via blind (at 3 4) (layers "F.Cu" "In1.Cu"))\n  (text "a ) in a string")\n)';

  it('yields depth-1 blocks with heads and string offsets, ignoring parens inside strings', () => {
    const blocks = [...topLevelBlocks(board)];
    expect(blocks.map((b) => b.head)).toEqual(['version', 'layers', 'via', 'via', 'text']);
    const firstVia = blocks[2]!;
    expect(board.slice(firstVia.start, firstVia.end)).toBe('(via (at 1 2) (layers "F.Cu" "B.Cu"))');
  });

  it('never allocates the tree: the slice of a block parses on its own', () => {
    const blind = [...topLevelBlocks(board)][3]!;
    expect(parse(board.slice(blind.start, blind.end))[0]).toEqual(['via', 'blind', ['at', '3', '4'], ['layers', 'F.Cu', 'In1.Cu']]);
  });

  it('throws on a truncated document instead of yielding a smaller one', () => {
    expect(() => [...topLevelBlocks('(kicad_pcb (version 1) (via (at 1 2))')]).toThrow(/unbalanced \( at end of input/);
  });

  it('throws on a stray closing paren', () => {
    expect(() => [...topLevelBlocks(') (kicad_pcb (version 1))')]).toThrow(/unbalanced \)/);
  });
});
```

```ts
// frontend/src/public/services/kicad/naturalSort.test.ts
import { describe, expect, it } from 'vitest';
import { naturalRefCompare } from './naturalSort';

describe('naturalRefCompare', () => {
  it('orders R2 before R10 and letters before their numbers', () => {
    expect(['R10', 'R2', 'C1', 'R1'].sort(naturalRefCompare)).toEqual(['C1', 'R1', 'R2', 'R10']);
  });
  it('keeps suffixes stable and is total', () => {
    expect(['U1B', 'U1A', 'U1'].sort(naturalRefCompare)).toEqual(['U1', 'U1A', 'U1B']);
    expect(naturalRefCompare('R1', 'R1')).toBe(0);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/public/services/kicad`
Expected: FAIL — cannot resolve `./sexpr` / `./naturalSort`.

- [ ] **Step 4: Write the tokenizer and the sort**

```ts
// frontend/src/public/services/kicad/sexpr.ts
// KiCad s-expression tokenizer. Atoms stay strings; callers convert numbers.
// Iterative on purpose: a 10 MB board must not overflow the stack (spec §4.1).
import type { SExpr } from './types';

function isDelimiter(c: string): boolean {
  return c === '(' || c === ')' || c === '"' || c === ' ' || c === '\n' || c === '\t' || c === '\r';
}

function readQuoted(text: string, start: number): { value: string; end: number } {
  let i = start + 1;
  let out = '';
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    if (c === '\\') {
      const e = text[i + 1];
      if (e === 'n') out += '\n';
      else if (e === 't') out += '\t';
      else if (e === 'r') out += '\r';
      else if (e === '"') out += '"';
      else if (e === '\\') out += '\\';
      else out += `\\${e ?? ''}`;
      i += 2;
      continue;
    }
    if (c === '"') return { value: out, end: i + 1 };
    out += c;
    i++;
  }
  throw new Error(`unterminated string starting at ${start}`);
}

function skipQuoted(text: string, start: number): number {
  let i = start + 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i++;
  }
  throw new Error(`unterminated string starting at ${start}`);
}

/** Parse a whole document. Returns the list of top-level nodes (KiCad files have one). */
export function parse(text: string): SExpr[] {
  const root: SExpr[] = [];
  const stack: SExpr[][] = [root];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i] as string;
    if (c === '(') {
      const node: SExpr[] = [];
      (stack[stack.length - 1] as SExpr[]).push(node);
      stack.push(node);
      i++;
    } else if (c === ')') {
      if (stack.length === 1) throw new Error(`unbalanced ) at ${i}`);
      stack.pop();
      i++;
    } else if (c === '"') {
      const { value, end } = readQuoted(text, i);
      (stack[stack.length - 1] as SExpr[]).push(value);
      i = end;
    } else if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
      i++;
    } else {
      let j = i + 1;
      while (j < n && !isDelimiter(text[j] as string)) j++;
      (stack[stack.length - 1] as SExpr[]).push(text.slice(i, j));
      i = j;
    }
  }
  if (stack.length !== 1) throw new Error('unbalanced ( at end of input');
  return root;
}

export function head(node: SExpr): string | null {
  return Array.isArray(node) && typeof node[0] === 'string' ? node[0] : null;
}

/** First child list whose head is `name`. */
export function child(node: SExpr, name: string): SExpr[] | undefined {
  if (!Array.isArray(node)) return undefined;
  for (const item of node) if (Array.isArray(item) && item[0] === name) return item;
  return undefined;
}

/** Every child list whose head is `name`, in order. */
export function children(node: SExpr, name: string): SExpr[][] {
  const out: SExpr[][] = [];
  if (!Array.isArray(node)) return out;
  for (const item of node) if (Array.isArray(item) && item[0] === name) out.push(item);
  return out;
}

/** The string at position `index`, or null when absent, a list, or when
 *  `node` itself is an atom (so it composes with `child(...)` results). */
export function atom(node: SExpr, index: number): string | null {
  if (!Array.isArray(node)) return null;
  const v = node[index];
  return typeof v === 'string' ? v : null;
}

export interface TopLevelBlock {
  head: string;
  start: number;
  end: number;
}

/** Yield the document node's direct LIST children with string offsets
 *  (UTF-16 code units; `start` inclusive, `end` exclusive — only for
 *  `text.slice`), without building a tree — the board reader parses only the
 *  blocks it needs. Throws on unbalanced input exactly as `parse` does, so a
 *  truncated board can never read as a valid smaller one. */
export function* topLevelBlocks(text: string): Generator<TopLevelBlock> {
  const n = text.length;
  let i = 0;
  let depth = 0;
  let blockStart = -1;
  let blockHead = '';
  while (i < n) {
    const c = text[i] as string;
    if (c === '"') {
      i = skipQuoted(text, i);
    } else if (c === '(') {
      depth++;
      if (depth === 2) {
        blockStart = i;
        let j = i + 1;
        while (j < n && !isDelimiter(text[j] as string)) j++;
        blockHead = text.slice(i + 1, j);
      }
      i++;
    } else if (c === ')') {
      if (depth === 0) throw new Error(`unbalanced ) at ${i}`);
      if (depth === 2 && blockStart >= 0) {
        yield { head: blockHead, start: blockStart, end: i + 1 };
        blockStart = -1;
      }
      depth--;
      i++;
    } else {
      i++;
    }
  }
  if (depth !== 0) throw new Error('unbalanced ( at end of input');
}
```

```ts
// frontend/src/public/services/kicad/naturalSort.ts
const SPLIT = /^([^\d]*)(\d*)(.*)$/;

/** R2 before R10: compare the letter prefix, then the number, then the rest. */
export function naturalRefCompare(a: string, b: string): number {
  const ma = SPLIT.exec(a) ?? [a, a, '', ''];
  const mb = SPLIT.exec(b) ?? [b, b, '', ''];
  const prefix = (ma[1] ?? '').localeCompare(mb[1] ?? '', 'en');
  if (prefix !== 0) return prefix;
  const na = ma[2] === '' ? -1 : Number(ma[2]);
  const nb = mb[2] === '' ? -1 : Number(mb[2]);
  if (na !== nb) return na - nb;
  return (ma[3] ?? '').localeCompare(mb[3] ?? '', 'en');
}
```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run src/public/services/kicad && npx tsc -b && npx eslint --ext .ts,.tsx src/`
Expected: 12 passed; gates clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/public/services/kicad
git commit -m "feat(kicad): reader types, iterative s-expression tokenizer with top-level block iterator, natural designator sort"
```

---

### Task 1.3: Zip intake with the archive guard (spec §4.5, §9)

**Files:**
- Create: `frontend/src/public/services/kicad/zip.ts`
- Modify: `frontend/package.json` (`"fflate": "0.8.3"` in dependencies)
- Test: `frontend/src/public/services/kicad/zip.test.ts`

**Interfaces:**
- Consumes: `ARCHIVE_GUARD`, `KicadReadError` (Task 1.2).
- Produces: `unzipToFiles(file: File, guard?: ArchiveGuard): Promise<File[]>` (each `File.name` is the normalized relative path; the guard is injectable for tests only), `normalizeEntryName(name): string | null`, `isKicadName(path): boolean`, `isIgnoredPath(path): boolean`, `KICAD_EXTENSIONS`.

- [ ] **Step 1: Install fflate and write the failing tests**

```bash
cd frontend && npm install --no-audit --no-fund --save-exact fflate@0.8.3
```

```ts
// frontend/src/public/services/kicad/zip.test.ts
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ARCHIVE_GUARD, KicadReadError } from './types';
import { isIgnoredPath, isKicadName, normalizeEntryName, unzipToFiles } from './zip';

function zipFile(entries: Record<string, string | Uint8Array>, name = 'p.zip'): File {
  const data: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) data[k] = typeof v === 'string' ? strToU8(v) : v;
  return new File([zipSync(data, { level: 6 })], name);
}

describe('normalizeEntryName', () => {
  it('normalizes slashes, strips a leading slash, rejects traversal and directories', () => {
    expect(normalizeEntryName('a\\b.kicad_sch')).toBe('a/b.kicad_sch');
    expect(normalizeEntryName('/root/x.kicad_pcb')).toBe('root/x.kicad_pcb');
    expect(normalizeEntryName('../x.kicad_sch')).toBeNull();
    expect(normalizeEntryName('a/../x.kicad_sch')).toBeNull();
    expect(normalizeEntryName('dir/')).toBeNull();
    expect(normalizeEntryName('.')).toBeNull();
    expect(normalizeEntryName('a/.')).toBeNull();
    expect(normalizeEntryName('./x.kicad_sch')).toBe('x.kicad_sch');
  });
});

describe('name filters', () => {
  it('accepts KiCad files including the KiCad 5 names used only for detection', () => {
    for (const n of ['a.kicad_pro', 'a.kicad_sch', 'a.KICAD_PCB', 'old.sch', 'old.pro']) expect(isKicadName(n)).toBe(true);
    for (const n of ['a.kicad_prl', 'a.kicad_sym', 'a.step', 'x.gbr', 'fp-info-cache']) expect(isKicadName(n)).toBe(false);
  });
  it('ignores backups and the footprint cache', () => {
    expect(isIgnoredPath('proj-backups/proj-2024.zip')).toBe(true);
    expect(isIgnoredPath('sub/fp-info-cache')).toBe(true);
    expect(isIgnoredPath('sub/main.kicad_sch')).toBe(false);
  });
});

describe('unzipToFiles', () => {
  it('returns only KiCad files, keyed by their relative path, and never inflates the rest', async () => {
    const files = await unzipToFiles(
      zipFile({ 'board/main.kicad_sch': '(kicad_sch)', 'board/sub/io.kicad_sch': '(kicad_sch)', 'board/main.kicad_pcb': '(kicad_pcb)', 'board/model.step': 'x'.repeat(5000), 'board-backups/old.zip': 'zzz' }),
    );
    expect(files.map((f) => f.name).sort()).toEqual(['board/main.kicad_pcb', 'board/main.kicad_sch', 'board/sub/io.kicad_sch']);
    expect(await files[0]!.text()).toBe('(kicad_pcb)');
  });

  it('refuses an archive over the archive cap without reading it (guard injected small)', async () => {
    const small = zipFile({ 'x.kicad_sch': '(kicad_sch)' });
    await expect(unzipToFiles(small, { ...ARCHIVE_GUARD, archiveBytes: 16 })).rejects.toMatchObject({ kind: 'archive' } satisfies Partial<KicadReadError>);
  });

  it('refuses an entry compressed past the ratio cap before inflating it', async () => {
    // 512 KB of one repeated byte deflates far past 100:1; the production guard applies.
    const bomb = zipFile({ 'x.kicad_sch': new Uint8Array(512 * 1024) });
    await expect(unzipToFiles(bomb)).rejects.toMatchObject({ kind: 'archive' });
  });

  it('refuses an archive whose entries collide after normalization', async () => {
    await expect(unzipToFiles(zipFile({ 'a/b.kicad_sch': '(kicad_sch)', 'a\\b.kicad_sch': '(kicad_sch)' }))).rejects.toMatchObject({ kind: 'archive' });
  });

  it('refuses when the declared uncompressed total is over the guard (guard injected small)', async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 5; i++) entries[`s${i}.kicad_sch`] = `(kicad_sch (version 20250114) (uuid "u${i}") ${'(junk "x")'.repeat(40)})`;
    await expect(unzipToFiles(zipFile(entries), { ...ARCHIVE_GUARD, declaredTotalBytes: 1024 })).rejects.toMatchObject({ kind: 'archive' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/public/services/kicad/zip.test.ts`
Expected: FAIL — cannot resolve `./zip`.

- [ ] **Step 3: Write `zip.ts`**

```ts
// frontend/src/public/services/kicad/zip.ts
// A dropped archive enters through fflate's `filter`, which runs BEFORE any
// entry is inflated and sees each entry's declared sizes (spec §4.5). Two
// guards, deliberately separate: the ARCHIVE guard bounds the inflate (declared
// sizes are attacker-controlled, so the archive-size and ratio caps are what
// actually hold), and the INTAKE caps in project.ts apply only to the KiCad
// files that survive the name filter — nothing else is ever inflated.
import { unzipSync, type UnzipFileInfo } from 'fflate';
import { ARCHIVE_GUARD, KicadReadError, formatMb } from './types';

export const KICAD_EXTENSIONS = ['.kicad_pro', '.kicad_sch', '.kicad_pcb', '.sch', '.pro'] as const;

export function normalizeEntryName(name: string): string | null {
  const slashed = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (slashed === '' || slashed.endsWith('/')) return null;
  const parts = slashed.split('/');
  if (parts.some((seg) => seg === '..' || seg === '')) return null;
  // A trailing `.` names the directory itself ("a/." is "a/"), never a file.
  if (parts[parts.length - 1] === '.') return null;
  return parts.filter((seg) => seg !== '.').join('/');
}

export function isKicadName(path: string): boolean {
  const lower = path.toLowerCase();
  return KICAD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isIgnoredPath(path: string): boolean {
  return path.includes('-backups/') || path.endsWith('fp-info-cache');
}

export type ArchiveGuard = { archiveBytes: number; declaredTotalBytes: number; maxRatio: number };

export async function unzipToFiles(file: File, guard: ArchiveGuard = ARCHIVE_GUARD): Promise<File[]> {
  if (file.size > guard.archiveBytes) {
    throw new KicadReadError(
      `That archive is ${formatMb(file.size)} MB; the limit is ${formatMb(guard.archiveBytes)} MB.`,
      'archive',
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let declared = 0;
  const filter = (info: UnzipFileInfo): boolean => {
    const name = normalizeEntryName(info.name);
    if (name == null || isIgnoredPath(name) || !isKicadName(name)) return false;
    // size 0 → no compressed bytes to expand; the declared-total cap is the bound.
    if (info.size > 0 && info.originalSize / info.size > guard.maxRatio) {
      throw new KicadReadError(
        `That archive has an entry compressed more than ${guard.maxRatio}:1, so it was not opened.`,
        'archive',
      );
    }
    declared += info.originalSize;
    if (declared > guard.declaredTotalBytes) {
      throw new KicadReadError(
        `That archive declares more than ${formatMb(guard.declaredTotalBytes)} MB of files, so it was not opened.`,
        'archive',
      );
    }
    return true;
  };
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter });
  } catch (err) {
    if (err instanceof KicadReadError) throw err;
    throw new KicadReadError('That file is not a zip archive this browser can open.', 'unreadable');
  }
  // fflate hands entries back in zip order; a path-sorted result is a stable
  // contract for the project assembler and for tests that index into it.
  const sorted = Object.entries(entries)
    .map(([name, data]) => [normalizeEntryName(name) ?? name, data] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // Two entries that normalize to one path (a/b vs a\b) would let the later
  // copy shadow a real sheet in the project's path-keyed Map — refuse instead.
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]![0] === sorted[i - 1]![0]) {
      throw new KicadReadError(`That archive names the same file twice: ${sorted[i]![0]}.`, 'archive');
    }
  }
  return sorted.map(([name, data]) => new File([data], name));
}
```

- [ ] **Step 4: Run the tests and gates**

Run: `cd frontend && npx vitest run src/public/services/kicad/zip.test.ts && npx tsc -b && npx eslint --ext .ts,.tsx src/`
Expected: 7 passed; gates clean. Confirm with `console.log` once that the filter runs BEFORE any inflate (add a temporary counter in the ratio test, then remove it). **Record fflate's behaviour for the ratio test in the spec's §4.5** ("fflate throws from `filter` and inflates nothing", or whatever was observed).

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/public/services/kicad/zip.ts frontend/src/public/services/kicad/zip.test.ts
git commit -m "feat(kicad): zip intake behind fflate's pre-inflate filter — archive, ratio and declared-total guards"
```

---

### Task 1.4: The fixture corpus — open hardware, pinned, credited (spec §10)

**Files:**
- Create: `frontend/scripts/fetch-kicad-fixtures.mjs`, `frontend/src/public/services/kicad/fixtures/glasgow-revC3/{glasgow.kicad_pro, glasgow.kicad_sch, io_banks.kicad_sch, io_buffer.kicad_sch, glasgow.kicad_pcb, LICENSE, SOURCE}`, `frontend/src/public/services/kicad/fixtures/bad-thing-panel/{panel.kicad_pro, panel.kicad_sch, panel.kicad_pcb, LICENSE, SOURCE}`, `frontend/src/public/services/kicad/fixtures/kicad5-header.sch`, `frontend/src/public/services/kicad/fixtures/kicad-demos/{complex_hierarchy/…, stickhub/StickHub.kicad_pcb, LICENSE, SOURCE}` (only after Task 0.1 merged — the script refuses otherwise), `frontend/src/public/services/kicad/fixtures.ts` (loader + synthetic documents)
- Test: `frontend/src/public/services/kicad/fixtures.test.ts`

**Interfaces:**
- Produces: `fixtureFiles(name): File[]` (reads a corpus directory into `File`s with relative names, node-only, for tests), `fixtureText(rel): string`, `hasFixture(set): boolean`, and the synthetic-document builders `symbol(...)`, `schematic(...)`, `sheet(...)` with `ROOT_UUID`/`SHEET_A_UUID`/`SHEET_B_UUID`, used by Tasks 1.5–1.7 (there is no `SYNTH` object — the builders ARE the synthetic corpus).

- [ ] **Step 1: Write the fetch script**

```js
// frontend/scripts/fetch-kicad-fixtures.mjs
// Downloads the open-hardware fixture corpus at PINNED commits and writes a
// SOURCE + LICENSE beside each set. Run once; the files are committed.
// KiCad's own demo projects are CC BY-SA 4.0 (LICENSE.README carves demos/* out
// of the GPLv3 code licence). Share-alike files are only written into a repo that
// carries its own compatible licence (ours: GPL-3.0-or-later, spec D6 — CC BY-SA
// 4.0 is one-way compatible with GPLv3) — otherwise they are skipped with a note.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT = resolve(import.meta.dirname, '../src/public/services/kicad/fixtures');
const ROOT = resolve(import.meta.dirname, '../..');

const SETS = [
  {
    dir: 'glasgow-revC3',
    base: 'https://raw.githubusercontent.com/GlasgowEmbedded/glasgow/49e29452a3372fcc5aea790c080c0be554d15800',
    files: ['glasgow.kicad_pro', 'glasgow.kicad_sch', 'io_banks.kicad_sch', 'io_buffer.kicad_sch', 'glasgow.kicad_pcb'].map((f) => [`hardware/boards/glasgow/revC3/${f}`, f]),
    licenseUrl: 'https://raw.githubusercontent.com/GlasgowEmbedded/glasgow/49e29452a3372fcc5aea790c080c0be554d15800/LICENSE-0BSD.txt',
    source: 'Glasgow Interface Explorer, hardware revC3 — https://github.com/GlasgowEmbedded/glasgow @ 49e29452a3372fcc5aea790c080c0be554d15800 (2026-09-11), 0BSD. Retrieved 2026-09-12.',
  },
  {
    dir: 'bad-thing-panel',
    base: 'https://raw.githubusercontent.com/Pakequis/Bad-Thing-of-the-Edge-keyboard/f7e73685d0bc05957b2d3bedc635b2414c79a013',
    files: ['panel.kicad_pro', 'panel.kicad_sch', 'panel.kicad_pcb'].map((f) => [`Hardware/Panel-board/${f}`, f]),
    licenseUrl: 'https://raw.githubusercontent.com/Pakequis/Bad-Thing-of-the-Edge-keyboard/f7e73685d0bc05957b2d3bedc635b2414c79a013/LICENSE',
    source: 'Bad Thing of the Edge keyboard, panel board — https://github.com/Pakequis/Bad-Thing-of-the-Edge-keyboard @ f7e73685d0bc05957b2d3bedc635b2414c79a013 (2026-04-08), MIT. Retrieved 2026-09-12.',
  },
  {
    dir: 'kicad-demos',
    shareAlike: true,
    base: 'https://gitlab.com/kicad/code/kicad/-/raw/a8d6201d6bc1739943ea51b3bc18d8d691503539/demos',
    files: [
      ['complex_hierarchy/complex_hierarchy.kicad_pro', 'complex_hierarchy/complex_hierarchy.kicad_pro'],
      ['complex_hierarchy/complex_hierarchy.kicad_sch', 'complex_hierarchy/complex_hierarchy.kicad_sch'],
      ['complex_hierarchy/ampli_ht.kicad_sch', 'complex_hierarchy/ampli_ht.kicad_sch'],
      ['complex_hierarchy/complex_hierarchy.kicad_pcb', 'complex_hierarchy/complex_hierarchy.kicad_pcb'],
      ['stickhub/StickHub.kicad_pcb', 'stickhub/StickHub.kicad_pcb'],
    ],
    licenseUrl: 'https://gitlab.com/kicad/code/kicad/-/raw/a8d6201d6bc1739943ea51b3bc18d8d691503539/LICENSE.README',
    source: 'KiCad demo projects — https://gitlab.com/kicad/code/kicad @ a8d6201d6bc1739943ea51b3bc18d8d691503539 (2026-09-12), CC BY-SA 4.0 per LICENSE.README (demos/* are carved out of the GPLv3 code licence; attribution is this file). Retrieved 2026-09-12.',
  },
];

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

for (const set of SETS) {
  if (set.shareAlike && !existsSync(join(ROOT, 'LICENSE'))) {
    console.log(`skip ${set.dir}: repo has no LICENSE yet (spec D6) — share-alike fixtures wait for it`);
    continue;
  }
  for (const [remote, local] of set.files) {
    const target = join(OUT, set.dir, local);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, await fetchText(`${set.base}/${remote}`));
    console.log(`wrote ${set.dir}/${local}`);
  }
  writeFileSync(join(OUT, set.dir, 'LICENSE'), await fetchText(set.licenseUrl));
  writeFileSync(join(OUT, set.dir, 'SOURCE'), `${set.source}\n`);
}

writeFileSync(join(OUT, 'kicad5-header.sch'), 'EESchema Schematic File Version 2\nEELAYER 25 0\n');
console.log('done');
```

- [ ] **Step 2: Fetch, and write the loader + synthetic documents**

```bash
cd frontend && node scripts/fetch-kicad-fixtures.mjs
du -sh src/public/services/kicad/fixtures    # expect ≈ 5–6 MB with the KiCad demos, ≈ 4.5 MB without
```

```ts
// frontend/src/public/services/kicad/fixtures.ts
// Fixture access for the reader tests (node only — vitest runs in the node
// environment). Real files live under ./fixtures/<set>/ with a LICENSE and a
// SOURCE beside them; the synthetic documents below are hand-written minimal
// KiCad files, one per reader rule, like the BOM parser's own fixtures.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, 'fixtures');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Every file of a set as `File`s named by their path relative to the set. */
export function fixtureFiles(set: string): File[] {
  const dir = join(ROOT, set);
  return walk(dir)
    .filter((p) => !p.endsWith('/LICENSE') && !p.endsWith('/SOURCE'))
    .map((p) => new File([readFileSync(p)], relative(dir, p).split('\\').join('/')));
}

export function fixtureText(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

export function hasFixture(set: string): boolean {
  return existsSync(join(ROOT, set));
}

/** A symbol block factory for synthetic schematics. */
export function symbol(opts: {
  lib: string; uuid: string; ref: string; value: string; footprint?: string; unit?: number;
  inBom?: boolean; dnp?: boolean; extra?: Record<string, string>; instances?: { path: string; ref: string; unit?: number }[];
}): string {
  const props = [
    `(property "Reference" "${opts.ref}" (at 0 0 0))`,
    `(property "Value" "${opts.value}" (at 0 0 0))`,
    `(property "Footprint" "${opts.footprint ?? ''}" (at 0 0 0))`,
    ...Object.entries(opts.extra ?? {}).map(([k, v]) => `(property "${k}" "${v}" (at 0 0 0))`),
  ].join('\n    ');
  const inst = opts.instances
    ? `(instances (project "synth" ${opts.instances.map((i) => `(path "${i.path}" (reference "${i.ref}") (unit ${i.unit ?? 1}))`).join(' ')}))`
    : '';
  return `(symbol (lib_id "${opts.lib}") (at 10 10 0) (unit ${opts.unit ?? 1}) (in_bom ${opts.inBom === false ? 'no' : 'yes'}) (on_board yes) (dnp ${opts.dnp ? 'yes' : 'no'}) (uuid "${opts.uuid}")
    ${props}
    ${inst})`;
}

export function schematic(opts: { uuid: string; version?: number; libSymbols?: string; body: string; symbolInstances?: string }): string {
  return `(kicad_sch (version ${opts.version ?? 20250114}) (generator "eeschema") (uuid "${opts.uuid}") (paper "A4")
  (lib_symbols ${opts.libSymbols ?? ''})
  ${opts.body}
  ${opts.symbolInstances ?? ''}
)`;
}

export function sheet(opts: { uuid: string; file: string; name?: string }): string {
  return `(sheet (at 50 50) (size 20 10) (uuid "${opts.uuid}") (property "Sheetname" "${opts.name ?? opts.file}" (at 0 0 0)) (property "Sheetfile" "${opts.file}" (at 0 0 0)))`;
}

export const ROOT_UUID = 'aaaaaaaa-0000-4000-8000-000000000001';
export const SHEET_A_UUID = 'bbbbbbbb-0000-4000-8000-000000000002';
export const SHEET_B_UUID = 'bbbbbbbb-0000-4000-8000-000000000003';
```

- [ ] **Step 3: Write the corpus test and run it**

```ts
// frontend/src/public/services/kicad/fixtures.test.ts
import { describe, expect, it } from 'vitest';
import { fixtureFiles, fixtureText, hasFixture } from './fixtures';

describe('fixture corpus', () => {
  it('carries Glasgow revC3 with its licence and source', () => {
    const names = fixtureFiles('glasgow-revC3').map((f) => f.name).sort();
    expect(names).toEqual(['glasgow.kicad_pcb', 'glasgow.kicad_pro', 'glasgow.kicad_sch', 'io_banks.kicad_sch', 'io_buffer.kicad_sch']);
    expect(fixtureText('glasgow-revC3/LICENSE')).toMatch(/Permission to use, copy, modify/);
    expect(fixtureText('glasgow-revC3/SOURCE')).toMatch(/49e29452a3372fcc5aea790c080c0be554d15800/);
  });
  it('carries the keyboard panel and the KiCad 5 header', () => {
    expect(fixtureFiles('bad-thing-panel').map((f) => f.name).sort()).toEqual(['panel.kicad_pcb', 'panel.kicad_pro', 'panel.kicad_sch']);
    expect(fixtureText('kicad5-header.sch').startsWith('EESchema Schematic File Version 2')).toBe(true);
  });
  it.skipIf(!hasFixture('kicad-demos'))('carries the KiCad demos once the licence exists', () => {
    expect(fixtureText('kicad-demos/SOURCE')).toMatch(/CC BY-SA 4\.0/);
  });
});
```

Run: `cd frontend && npx vitest run src/public/services/kicad/fixtures.test.ts` → 3 passed (or 2 passed + 1 skipped without the demos).

- [ ] **Step 4: Commit**

```bash
cd /home/matthew/circuits-com
git add frontend/scripts/fetch-kicad-fixtures.mjs frontend/src/public/services/kicad/fixtures frontend/src/public/services/kicad/fixtures.ts frontend/src/public/services/kicad/fixtures.test.ts
git commit -m "test(kicad): open-hardware fixture corpus — Glasgow revC3 (0BSD), keyboard panel (MIT), KiCad 5 header, KiCad demos behind the licence — pinned and credited"
```

---

### Task 1.5: `buildProject` — files or a zip into a `KicadProject` (spec §4.2)

**Files:**
- Create: `frontend/src/public/services/kicad/project.ts`
- Test: `frontend/src/public/services/kicad/project.test.ts`

**Interfaces:**
- Consumes: `unzipToFiles`, `normalizeEntryName`, `isKicadName`, `isIgnoredPath` (1.3); `INTAKE_CAPS`, `MIN_BOARD_VERSION`, `KICAD5_MESSAGE`, `KicadReadError`, `formatMb`, `KicadProject` (1.2).
- Produces: `buildProject(input: File[]): Promise<KicadProject>`; `resolveSheetRef(fromPath, ref, known: Iterable<string>): SheetResolution`; `dirname(path)`, `basename(path)`, `versionOf(text): number | null`, `schematicUuid(text): string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/public/services/kicad/project.test.ts
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { fixtureFiles, fixtureText, hasFixture, ROOT_UUID, SHEET_A_UUID, schematic, sheet, symbol } from './fixtures';
import { buildProject, resolveSheetRef, versionOf } from './project';
import { INTAKE_CAPS } from './types';

const f = (name: string, content: BlobPart) => new File([content], name);
const ROOT = schematic({ uuid: ROOT_UUID, body: `${symbol({ lib: 'Device:R', uuid: 's1', ref: 'R1', value: '10k' })} ${sheet({ uuid: SHEET_A_UUID, file: 'sub/reg.kicad_sch' })}` });
const SUB = schematic({ uuid: 'cccccccc-0000-4000-8000-000000000004', body: symbol({ lib: 'Device:C', uuid: 's2', ref: 'C1', value: '100n' }) });

describe('versionOf', () => {
  it('reads the version token off a schematic and a board head', () => {
    expect(versionOf('(kicad_sch\n\t(version 20250114)\n\t(generator "eeschema")')).toBe(20250114);
    expect(versionOf('(kicad_pcb (version 20211014) (generator pcbnew)')).toBe(20211014);
    expect(versionOf('EESchema Schematic File Version 2')).toBeNull();
  });
});

describe('resolveSheetRef', () => {
  const known = ['main.kicad_sch', 'power/reg.kicad_sch', 'analog/reg.kicad_sch', 'power/lib/x.kicad_sch'];
  it('resolves relative to the referencing sheet first', () => {
    expect(resolveSheetRef('power/top.kicad_sch', 'reg.kicad_sch', known)).toEqual({ path: 'power/reg.kicad_sch', byName: false });
    expect(resolveSheetRef('power/top.kicad_sch', 'lib/x.kicad_sch', known)).toEqual({ path: 'power/lib/x.kicad_sch', byName: false });
    expect(resolveSheetRef('main.kicad_sch', './power/reg.kicad_sch', known)).toEqual({ path: 'power/reg.kicad_sch', byName: false });
  });
  it('falls back to a unique basename, and reports an ambiguous one as missing', () => {
    expect(resolveSheetRef('main.kicad_sch', 'x.kicad_sch', known)).toEqual({ path: 'power/lib/x.kicad_sch', byName: true });
    expect(resolveSheetRef('main.kicad_sch', 'reg.kicad_sch', known)).toEqual({ missing: true, candidates: ['analog/reg.kicad_sch', 'power/reg.kicad_sch'] });
    expect(resolveSheetRef('main.kicad_sch', 'nope.kicad_sch', known)).toEqual({ missing: true, candidates: [] });
  });
  it('never resolves traversal', () => {
    expect(resolveSheetRef('power/top.kicad_sch', '../main.kicad_sch', known)).toEqual({ missing: true, candidates: [] });
  });
});

describe('buildProject', () => {
  it('builds a hierarchical project from loose files, root first, keyed by path', async () => {
    const p = await buildProject([f('sub/reg.kicad_sch', SUB), f('main.kicad_sch', ROOT), f('main.kicad_pro', '{"sheets":[["' + ROOT_UUID + '","Root"]],"meta":{"filename":"main.kicad_pro"}}')]);
    expect(p.name).toBe('main');
    expect(p.root).toBe('main.kicad_sch');
    expect(p.sheets.map((s) => s.path)).toEqual(['main.kicad_sch', 'sub/reg.kicad_sch']);
    expect(p.sheets[0]!.uuid).toBe(ROOT_UUID);
    expect(p.pro?.sheets).toEqual([[ROOT_UUID, 'Root']]);
    expect(p.board).toBeNull();
    expect(p.missingSheets).toEqual([]);
    expect(p.formatVersions['main.kicad_sch']).toBe(20250114);
  });

  it('keeps two same-named sheets in different directories apart', async () => {
    const root = schematic({ uuid: ROOT_UUID, body: `${sheet({ uuid: SHEET_A_UUID, file: 'power/reg.kicad_sch' })} ${sheet({ uuid: 'bbbbbbbb-0000-4000-8000-000000000003', file: 'analog/reg.kicad_sch' })}` });
    const p = await buildProject([f('main.kicad_sch', root), f('power/reg.kicad_sch', SUB), f('analog/reg.kicad_sch', SUB.replace('C1', 'C2'))]);
    expect(p.sheets.map((s) => s.path)).toEqual(['main.kicad_sch', 'power/reg.kicad_sch', 'analog/reg.kicad_sch']);
    expect(p.files.size).toBe(3);
  });

  it('names missing sheets and warns on an ambiguous one', async () => {
    const root = schematic({ uuid: ROOT_UUID, body: `${sheet({ uuid: SHEET_A_UUID, file: 'reg.kicad_sch' })} ${sheet({ uuid: 'bbbbbbbb-0000-4000-8000-000000000003', file: 'gone.kicad_sch' })}` });
    const p = await buildProject([f('main.kicad_sch', root), f('a/reg.kicad_sch', SUB), f('b/reg.kicad_sch', SUB)]);
    expect(p.missingSheets).toEqual(['reg.kicad_sch', 'gone.kicad_sch']);
    expect(p.warnings.join('\n')).toMatch(/reg\.kicad_sch.*a\/reg\.kicad_sch.*b\/reg\.kicad_sch/s);
  });

  it('picks the root by project stem, else by "not referenced", else first', async () => {
    const byStem = await buildProject([f('other.kicad_sch', SUB), f('x.kicad_sch', ROOT), f('x.kicad_pro', '{}')]);
    expect(byStem.root).toBe('x.kicad_sch');
    const byRef = await buildProject([f('sub/reg.kicad_sch', SUB), f('top.kicad_sch', ROOT)]);
    expect(byRef.root).toBe('top.kicad_sch');
    const first = await buildProject([f('b.kicad_sch', SUB), f('a.kicad_sch', SUB)]);
    expect(first.root).toBe('b.kicad_sch');
  });

  it('accepts a zip and ignores what the tool does not read', async () => {
    const zip = new File([zipSync({ 'proj/main.kicad_sch': strToU8(ROOT), 'proj/sub/reg.kicad_sch': strToU8(SUB), 'proj/main.kicad_pcb': strToU8('(kicad_pcb (version 20241229) (generator "pcbnew"))'), 'proj/main.kicad_prl': strToU8('{}'), 'proj/3d/x.step': strToU8('solid') })], 'proj.zip');
    const p = await buildProject([zip]);
    expect([...p.files.keys()].sort()).toEqual(['proj/main.kicad_pcb', 'proj/main.kicad_sch', 'proj/sub/reg.kicad_sch']);
    expect(p.board).toBe('proj/main.kicad_pcb');
  });

  it('refuses KiCad 5 by name and by board version, before anything else', async () => {
    await expect(buildProject([f('old.sch', fixtureText('kicad5-header.sch')), f('old.pro', 'update=x')])).rejects.toMatchObject({ kind: 'kicad5' });
    await expect(buildProject([f('b.kicad_pcb', '(kicad_pcb (version 20171130) (host pcbnew 5.1))')])).rejects.toMatchObject({ kind: 'kicad5' });
  });

  it('errors on nothing to read, and on each intake cap after the filter', async () => {
    await expect(buildProject([f('notes.txt', 'hi')])).rejects.toMatchObject({ kind: 'empty' });
    const many = Array.from({ length: INTAKE_CAPS.files + 1 }, (_, i) => f(`s${i}.kicad_sch`, SUB));
    await expect(buildProject(many)).rejects.toMatchObject({ kind: 'cap' });
    await expect(buildProject([f('huge.kicad_pcb', new Uint8Array(INTAKE_CAPS.perFileBytes + 1))])).rejects.toMatchObject({ kind: 'cap' });
  });

  it('reads Glasgow revC3: root, two sub-sheets, a board, no missing sheets', async () => {
    const p = await buildProject(fixtureFiles('glasgow-revC3'));
    expect(p.name).toBe('glasgow');
    expect(p.root).toBe('glasgow.kicad_sch');
    expect(p.sheets.map((s) => s.path)).toEqual(['glasgow.kicad_sch', 'io_banks.kicad_sch', 'io_buffer.kicad_sch']);
    expect(p.board).toBe('glasgow.kicad_pcb');
    expect(p.missingSheets).toEqual([]);
    expect(p.pro?.sheets.length).toBe(4);
  });

  it.skipIf(!hasFixture('kicad-demos'))('reads the KiCad demo with a twice-placed sheet', async () => {
    const p = await buildProject(fixtureFiles('kicad-demos').filter((x) => x.name.startsWith('complex_hierarchy/')));
    expect(p.sheets.map((s) => s.path)).toEqual(['complex_hierarchy/complex_hierarchy.kicad_sch', 'complex_hierarchy/ampli_ht.kicad_sch']);
  });

  it('refuses a project file with nothing to show', async () => {
    await expect(buildProject([f('only.kicad_pro', '{}')])).rejects.toMatchObject({ kind: 'empty' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/public/services/kicad/project.test.ts`
Expected: FAIL — cannot resolve `./project`.

- [ ] **Step 3: Write `project.ts`**

```ts
// frontend/src/public/services/kicad/project.ts
// Dropped files (or one zip) → KicadProject (spec §4.2). Files are keyed by
// normalized relative path; Sheetfile references resolve relative to the sheet
// that names them, then by a UNIQUE basename, never by traversal. KiCad 5 is
// refused before anything mounts; the intake caps apply after the ignore
// filter, to the files the tool will actually read.
import { isIgnoredPath, isKicadName, normalizeEntryName, unzipToFiles } from './zip';
import {
  INTAKE_CAPS,
  KICAD5_MESSAGE,
  KicadReadError,
  MIN_BOARD_VERSION,
  formatMb,
  type KicadProject,
  type KicadSheet,
} from './types';

const LEGACY_EXTENSIONS = ['.sch', '.pro'];
const SHEETFILE = /\(property\s+"Sheetfile"\s+"([^"]*)"/g;
const VERSION = /\(kicad_(?:sch|pcb)\s*\(version\s+(\d+)\)/;
const DOC_UUID = /\(kicad_sch[\s\S]{0,400}?\(uuid\s+"?([0-9a-fA-F-]{36})"?\)/;
const MAX_DEPTH = 32;

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function extensionOf(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf('.');
  return i < 0 ? '' : b.slice(i).toLowerCase();
}

function stem(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf('.');
  return i < 0 ? b : b.slice(0, i);
}

export function versionOf(text: string): number | null {
  const m = VERSION.exec(text.slice(0, 400));
  return m ? Number(m[1]) : null;
}

export function schematicUuid(text: string): string | null {
  const m = DOC_UUID.exec(text.slice(0, 2000));
  return m ? (m[1] as string).toLowerCase() : null;
}

export type SheetResolution = { path: string; byName: boolean } | { missing: true; candidates: string[] };

export function resolveSheetRef(fromPath: string, ref: string, known: Iterable<string>): SheetResolution {
  const keys = [...known];
  const dir = dirname(fromPath);
  const joined = normalizeEntryName(dir === '' ? ref : `${dir}/${ref}`);
  if (joined != null && keys.includes(joined)) return { path: joined, byName: false };
  if (ref.replace(/\\/g, '/').split('/').includes('..')) return { missing: true, candidates: [] };
  const name = basename(ref.replace(/\\/g, '/'));
  const candidates = keys.filter((k) => basename(k) === name).sort();
  if (candidates.length === 1) return { path: candidates[0] as string, byName: true };
  return { missing: true, candidates };
}

function capError(message: string): KicadReadError {
  return new KicadReadError(message, 'cap');
}

// The actual size is rounded UP to a tenth: at the exact boundary a plain
// round renders "is 8.0 MB; the limit per file is 8.0 MB", which reads as a
// contradiction. The limits keep formatMb — they are exact by construction.
function formatMbUp(bytes: number): string {
  return (Math.ceil((bytes / (1024 * 1024)) * 10) / 10).toFixed(1);
}

export async function buildProject(input: File[]): Promise<KicadProject> {
  const expanded: File[] = [];
  for (const file of input) {
    if (file.name.toLowerCase().endsWith('.zip')) expanded.push(...(await unzipToFiles(file)));
    else expanded.push(file);
  }

  const candidates: { path: string; file: File }[] = [];
  for (const file of expanded) {
    const raw = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const path = normalizeEntryName(raw);
    if (path == null || isIgnoredPath(path) || !isKicadName(path)) continue;
    candidates.push({ path, file });
  }
  if (candidates.length === 0) {
    throw new KicadReadError('No KiCad files in what was dropped — looking for .kicad_pro, .kicad_sch and .kicad_pcb.', 'empty');
  }

  const modern = candidates.filter((c) => !LEGACY_EXTENSIONS.includes(extensionOf(c.path)));
  if (modern.length === 0) throw new KicadReadError(KICAD5_MESSAGE, 'kicad5');

  if (modern.length > INTAKE_CAPS.files) throw capError(`That is ${modern.length} KiCad files; the limit is ${INTAKE_CAPS.files}.`);
  let total = 0;
  for (const c of modern) {
    if (c.file.size > INTAKE_CAPS.perFileBytes) throw capError(`${basename(c.path)} is ${formatMbUp(c.file.size)} MB; the limit per file is ${formatMb(INTAKE_CAPS.perFileBytes)} MB.`);
    total += c.file.size;
  }
  if (total > INTAKE_CAPS.totalBytes) throw capError(`Those files total ${formatMbUp(total)} MB; the limit is ${formatMb(INTAKE_CAPS.totalBytes)} MB.`);

  const warnings: string[] = [];
  const files = new Map<string, string>();
  for (const c of modern) {
    if (files.has(c.path)) warnings.push(`${c.path} was dropped twice; the last copy is the one shown.`);
    files.set(c.path, await c.file.text());
  }

  const formatVersions: Record<string, number> = {};
  for (const [path, text] of files) {
    const v = versionOf(text);
    if (v != null) formatVersions[path] = v;
    if (extensionOf(path) === '.kicad_pcb' && v != null && v < MIN_BOARD_VERSION) throw new KicadReadError(KICAD5_MESSAGE, 'kicad5');
  }

  const pros = [...files.keys()].filter((p) => extensionOf(p) === '.kicad_pro');
  const proPath = pros[0] ?? null;
  if (pros.length > 1) warnings.push(`${pros.length} project files were dropped; using ${basename(proPath as string)}.`);
  let pro: KicadProject['pro'] = null;
  if (proPath != null) {
    try {
      const json = JSON.parse(files.get(proPath) as string) as { sheets?: unknown };
      const sheets = Array.isArray(json.sheets)
        ? json.sheets.filter((s): s is [string, string] => Array.isArray(s) && typeof s[0] === 'string' && typeof s[1] === 'string')
        : [];
      pro = { sheets };
    } catch {
      warnings.push('The project file could not be read; sheet names come from the schematics instead.');
    }
  }

  const schematicPaths = [...files.keys()].filter((p) => extensionOf(p) === '.kicad_sch');
  const refsOf = (path: string): string[] => {
    const out: string[] = [];
    const text = files.get(path) as string;
    for (const m of text.matchAll(SHEETFILE)) if (m[1]) out.push(m[1]);
    return out;
  };
  const referenced = new Set<string>();
  for (const p of schematicPaths) {
    for (const ref of refsOf(p)) {
      const r = resolveSheetRef(p, ref, schematicPaths);
      if (!('missing' in r)) referenced.add(r.path);
    }
  }
  let root: string | null = null;
  if (proPath != null) root = schematicPaths.find((p) => dirname(p) === dirname(proPath) && stem(p) === stem(proPath)) ?? null;
  if (root == null) root = schematicPaths.find((p) => !referenced.has(p)) ?? null;
  if (root == null) root = schematicPaths[0] ?? null;

  const sheets: KicadSheet[] = [];
  const missingSheets: string[] = [];
  const seen = new Set<string>();
  const queue: { path: string; depth: number }[] = root == null ? [] : [{ path: root, depth: 0 }];
  while (queue.length > 0) {
    const { path, depth } = queue.shift() as { path: string; depth: number };
    if (seen.has(path)) continue;
    seen.add(path);
    const text = files.get(path) as string;
    sheets.push({ path, uuid: schematicUuid(text) ?? '', text });
    if (depth >= MAX_DEPTH) {
      warnings.push(`${basename(path)} is nested more than ${MAX_DEPTH} sheets deep; deeper sheets were not read.`);
      continue;
    }
    for (const ref of refsOf(path)) {
      const r = resolveSheetRef(path, ref, schematicPaths);
      if ('missing' in r) {
        if (!missingSheets.includes(ref)) missingSheets.push(ref);
        if (r.candidates.length > 1) warnings.push(`${basename(path)} references ${ref}, which matches more than one file (${r.candidates.join(', ')}); add the folder so the reference is exact.`);
        continue;
      }
      if (r.byName) warnings.push(`${basename(path)} references ${ref}; matched ${r.path} by name.`);
      queue.push({ path: r.path, depth: depth + 1 });
    }
  }
  const unreachable = schematicPaths.filter((p) => !seen.has(p));
  if (unreachable.length > 0) warnings.push(`${unreachable.length} schematic file(s) are not reachable from the root sheet and are not shown: ${unreachable.map(basename).join(', ')}.`);
  // A drop that yields neither a root schematic nor a board has nothing to
  // render — a lone .kicad_pro is the common case. Board-only projects are
  // legitimate, so the predicate needs BOTH to be absent.
  if (root == null && board == null) {
    throw new KicadReadError('That project has no schematic or board to show — only a .kicad_pro was found.', 'empty');
  }

  const boards = [...files.keys()].filter((p) => extensionOf(p) === '.kicad_pcb');
  const board = boards[0] ?? null;
  if (boards.length > 1) warnings.push(`${boards.length} boards were dropped; showing ${basename(board as string)}.`);

  const name = proPath != null ? stem(proPath) : root != null ? stem(root) : board != null ? stem(board) : 'design';
  return { name, files, pro, root, sheets, board, warnings, missingSheets, formatVersions };
}
```

- [ ] **Step 4: Run the tests and gates**

Run: `cd frontend && npx vitest run src/public/services/kicad && npx tsc -b && npx eslint --ext .ts,.tsx src/`
Expected: all passed (one skipped without the demos); gates clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/public/services/kicad/project.ts frontend/src/public/services/kicad/project.test.ts
git commit -m "feat(kicad): buildProject — path-keyed files, relative Sheetfile resolution, KiCad 5 refusal, intake caps after the filter"
```

---

### Task 1.6: `readSchematic` — BOM lines straight from the schematic (spec §4.3)

**Files:**
- Create: `frontend/src/public/services/kicad/schematicBom.ts`
- Test: `frontend/src/public/services/kicad/schematicBom.test.ts`

**Interfaces:**
- Consumes: `parse`, `child`, `children`, `atom` (1.2); `resolveSheetRef`, `basename` (1.5); `naturalRefCompare` (1.2); `MAX_LINES`, `MAX_REFS_PER_LINE`, `canPrice`, `ParsedBomLine`, `ParseResult` from `@public/services/bom/parseBom`; `matchHeader`, `BomRole` from `@public/services/bom/headerAliases` (1.1).
- Produces: `readSchematic(project): SchematicRead` with `{ result: ParseResult; refs: Map<string, RefLocation>; instances: number }`, `readBomLines(project): ParseResult`, `interface RefLocation { sheet: string; instancePath: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/public/services/kicad/schematicBom.test.ts
import { beforeAll, describe, expect, it } from 'vitest';
import { canPrice, MAX_REFS_PER_LINE } from '@public/services/bom/parseBom';
import { fixtureFiles, hasFixture, ROOT_UUID, SHEET_A_UUID, SHEET_B_UUID, schematic, sheet, symbol } from './fixtures';
import { buildProject } from './project';
import { readBomLines, readSchematic } from './schematicBom';

const f = (name: string, text: string) => new File([text], name);
const SUB_UUID = 'cccccccc-0000-4000-8000-000000000004';

async function lines(files: File[]) {
  return readSchematic(await buildProject(files));
}

describe('readSchematic — rules', () => {
  it('one line per instance path: a sheet placed twice yields two references (KiCad 7+ instances)', async () => {
    const sub = schematic({
      uuid: SUB_UUID,
      body: symbol({ lib: 'Device:R', uuid: 'r', ref: 'R201', value: '10k', footprint: 'R_0603', instances: [
        { path: `/${ROOT_UUID}/${SHEET_A_UUID}`, ref: 'R201' }, { path: `/${ROOT_UUID}/${SHEET_B_UUID}`, ref: 'R301' },
      ] }),
    });
    const root = schematic({ uuid: ROOT_UUID, body: `${sheet({ uuid: SHEET_A_UUID, file: 'amp.kicad_sch', name: 'A' })} ${sheet({ uuid: SHEET_B_UUID, file: 'amp.kicad_sch', name: 'B' })}` });
    const r = await lines([f('main.kicad_sch', root), f('amp.kicad_sch', sub)]);
    expect(r.instances).toBe(2);
    expect(r.result.lines).toHaveLength(1);
    expect(r.result.lines[0]).toMatchObject({ qty: 2, refs: ['R201', 'R301'], value: '10k', footprint: 'R_0603' });
    expect(r.refs.get('R301')).toEqual({ sheet: 'amp.kicad_sch', instancePath: `/${ROOT_UUID}/${SHEET_B_UUID}` });
  });

  it('reads KiCad 6 references from the root symbol_instances table, root-level and sub-sheet', async () => {
    const sub = schematic({ uuid: SUB_UUID, version: 20211123, body: symbol({ lib: 'Device:C', uuid: 'c-uuid', ref: 'C?', value: '100n' }) });
    const root = schematic({
      uuid: ROOT_UUID, version: 20211123,
      body: `${symbol({ lib: 'Device:R', uuid: 'r-uuid', ref: 'R?', value: '1k' })} ${sheet({ uuid: SHEET_A_UUID, file: 'sub.kicad_sch' })}`,
      symbolInstances: `(symbol_instances (path "/r-uuid" (reference "R7") (unit 1) (value "1k") (footprint "")) (path "/${SHEET_A_UUID}/c-uuid" (reference "C9") (unit 1) (value "100n") (footprint "")))`,
    });
    const r = await lines([f('main.kicad_sch', root), f('sub.kicad_sch', sub)]);
    expect(r.result.lines.map((l) => l.refs)).toEqual([['R7'], ['C9']]);
  });

  it('falls back to the Reference property when no instance table names the symbol', async () => {
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body: symbol({ lib: 'Device:R', uuid: 'x', ref: 'R42', value: '4k7' }) }))]);
    expect(r.result.lines[0]!.refs).toEqual(['R42']);
  });

  it('skips in_bom no, #-references and (power) library symbols, and counts them', async () => {
    const body = [
      symbol({ lib: 'Device:R', uuid: 'a', ref: 'R1', value: '1k' }),
      symbol({ lib: 'Device:R', uuid: 'b', ref: 'R2', value: '1k', inBom: false }),
      symbol({ lib: 'power:GND', uuid: 'c', ref: '#PWR01', value: 'GND' }),
      symbol({ lib: 'power:+3V3', uuid: 'd', ref: 'PWR02', value: '+3V3' }),
      symbol({ lib: 'Mechanical:MountingHole', uuid: 'e', ref: 'H1', value: 'Hole' }),
    ].join(' ');
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, libSymbols: '(symbol "power:+3V3" (power) (pin_names (offset 0)))', body }))]);
    expect(r.result.lines.map((l) => l.refs.join())).toEqual(['R1', 'H1']);
    expect(r.result.warnings.join('\n')).toMatch(/3 symbols skipped/);
  });

  it('dedupes multi-unit symbols on the reference designator', async () => {
    const body = `${symbol({ lib: 'Amplifier:LM358', uuid: 'u1a', ref: 'U1', value: 'LM358', unit: 1 })} ${symbol({ lib: 'Amplifier:LM358', uuid: 'u1b', ref: 'U1', value: 'LM358', unit: 2 })}`;
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body }))]);
    expect(r.result.lines).toHaveLength(1);
    expect(r.result.lines[0]).toMatchObject({ qty: 1, refs: ['U1'] });
  });

  // Glasgow revC3's U30 is a 5-unit FPGA drawn across two sheets (units 3+5 on
  // the root, 1, 2+4 on io_banks). It is ONE chip, so the dedupe cannot be
  // scoped to the instance path — that spelling buys the FPGA twice.
  it('dedupes a multi-unit symbol whose units are drawn on DIFFERENT sheets', async () => {
    const sub = schematic({
      uuid: SUB_UUID,
      body: symbol({ lib: 'Amplifier:LM358', uuid: 'u1b', ref: 'U1', value: 'LM358', unit: 2, instances: [{ path: `/${ROOT_UUID}/${SHEET_A_UUID}`, ref: 'U1', unit: 2 }] }),
    });
    const root = schematic({
      uuid: ROOT_UUID,
      body: `${symbol({ lib: 'Amplifier:LM358', uuid: 'u1a', ref: 'U1', value: 'LM358', unit: 1, instances: [{ path: `/${ROOT_UUID}`, ref: 'U1', unit: 1 }] })} ${sheet({ uuid: SHEET_A_UUID, file: 'sub.kicad_sch' })}`,
    });
    const r = await lines([f('main.kicad_sch', root), f('sub.kicad_sch', sub)]);
    expect(r.instances).toBe(1);
    expect(r.result.lines).toHaveLength(1);
    expect(r.result.lines[0]).toMatchObject({ qty: 1, refs: ['U1'] });
  });

  it('carries dnp and routes user fields through the header aliases', async () => {
    const body = `${symbol({ lib: 'Device:C', uuid: 'a', ref: 'C1', value: '10u', dnp: true, extra: { MPN: 'GRM188R61A106KE69D', Manufacturer: 'Murata', Datasheet: 'https://x' } })}`;
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body }))]);
    expect(r.result.lines[0]).toMatchObject({ dnp: true, mpn: 'GRM188R61A106KE69D', manufacturer: 'Murata' });
    expect(r.result.roleByColumn).toContain('mpn');
  });

  it('groups on (mpn, manufacturer, value, footprint, dnp) and sorts refs naturally', async () => {
    const body = ['R10', 'R2', 'R1'].map((ref, i) => symbol({ lib: 'Device:R', uuid: `r${i}`, ref, value: '1k', footprint: 'R_0603' })).join(' ') + symbol({ lib: 'Device:R', uuid: 'rx', ref: 'R3', value: '1k', footprint: 'R_0805' });
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body }))]);
    expect(r.result.lines.map((l) => [l.qty, l.refs.join(',')])).toEqual([[3, 'R1,R2,R10'], [1, 'R3']]);
  });

  it('keeps qty as the true count when the designator list is capped, and says so', async () => {
    const body = Array.from({ length: 240 }, (_, i) => symbol({ lib: 'Device:C', uuid: `c${i}`, ref: `C${i + 1}`, value: '100n', footprint: 'C_0402' })).join(' ');
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body }))]);
    expect(r.result.lines[0]!.qty).toBe(240);
    expect(r.result.lines[0]!.refs).toHaveLength(MAX_REFS_PER_LINE);
    expect(r.result.warnings.join('\n')).toMatch(/240 instances.*first 200/);
  });

  it('is ready-mapped: the mapper never appears', async () => {
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body: symbol({ lib: 'Device:R', uuid: 'x', ref: 'R1', value: '1k' }) }))]);
    expect(canPrice(r.result.roleByColumn)).toBe(true);
    expect(r.result.headerSignature).toBe('kicad-sch');
    expect(r.result.unmappedColumns).toEqual([]);
    expect(r.result.headers).toHaveLength(r.result.roleByColumn.length);
  });

  it('hard-errors past MAX_LINES like the CSV path', async () => {
    const body = Array.from({ length: 2001 }, (_, i) => symbol({ lib: 'Device:R', uuid: `r${i}`, ref: `R${i}`, value: `${i}` })).join(' ');
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body }))]);
    expect(r.result.error).toMatch(/2,000/);
  });

  // KiCad writes the literal "R?" into the instance table for an unannotated
  // symbol, so every part answers the same string. Merging them would report a
  // one-part BOM for a whole board, silently.
  it('never merges unannotated references, and says the schematic needs annotating', async () => {
    const body = `${symbol({ lib: 'Device:R', uuid: 'a', ref: 'R?', value: '1k' })} ${symbol({ lib: 'Device:R', uuid: 'b', ref: 'R?', value: '1k' })}`;
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body }))]);
    expect(r.instances).toBe(2);
    expect(r.result.lines[0]).toMatchObject({ qty: 2 });
    expect(r.result.warnings.filter((w) => /not annotated/.test(w))).toHaveLength(1);
  });

  // buildProject's BFS de-dupes by path, so a self-referencing sheet mounts
  // cleanly and reaches this reader; without an ancestor check it expands
  // 2^MAX_DEPTH times and hangs the tab.
  it('skips a sheet that references itself instead of recursing forever', async () => {
    const body = sheet({ uuid: SHEET_A_UUID, file: 'main.kicad_sch', name: 'self' });
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body }))]);
    expect(r.instances).toBe(0);
    expect(r.result.warnings.filter((w) => /references itself/.test(w))).toHaveLength(1);
  });

  it('returns an error, not lines, for a project with no schematic', async () => {
    const r = readBomLines(await buildProject([f('b.kicad_pcb', '(kicad_pcb (version 20241229))')]));
    expect(r.error).toMatch(/no schematic/i);
    expect(r.lines).toEqual([]);
  });
});

describe('readSchematic — Glasgow revC3', () => {
  let r: Awaited<ReturnType<typeof lines>>;
  beforeAll(async () => {
    r = await lines(fixtureFiles('glasgow-revC3'));
  });

  it('reads every reference once, with the twice-placed io_buffer doubled', () => {
    const refs = r.result.lines.flatMap((l) => l.refs);
    expect(new Set(refs).size).toBe(refs.length);
    expect(r.instances).toBeGreaterThan(100);
    // Pin the exact counts on first run and keep them: they are the regression
    // fingerprint. lines moved 70 -> 71 when the DNP property started being
    // honoured: of the five DNP lines, exactly one (ESD5Z5.0T1G / D12,D13) has
    // a fitted twin it used to merge into. The other four carry footprints
    // ending in _DNP, so they were never grouped with a fitted part.
    expect({ lines: r.result.lines.length, instances: r.instances }).toMatchInlineSnapshot(`
      {
        "instances": 257,
        "lines": 71,
      }
    `);
    // The doubling itself: io_buffer holds 68 non-power designators and is
    // placed twice, so it contributes 136 of the 257 instances.
    expect([...r.refs.values()].filter((l) => l.sheet === 'io_buffer.kicad_sch')).toHaveLength(136);
  });

  // Glasgow writes `(dnp no)` on all 347 symbols and marks its do-not-populate
  // parts with `(property "DNP" "DNP")` alone: R40 on the root, J10/D12/D13 on
  // io_banks, and R51/J8/J9/R8 on io_buffer — which is placed TWICE, so those
  // four are eight instances. 1 + 3 + (4 x 2) = 12 DNP instances from the 8
  // DNP symbols the review counted in the files.
  it('honours the DNP property, not only the dnp attribute', () => {
    const dnpInstances = r.result.lines.filter((l) => l.dnp).reduce((n, l) => n + l.qty, 0);
    expect(dnpInstances).toBe(12);
    expect(r.result.lines.flatMap((l) => (l.dnp ? l.refs : []))).toContain('R40');
  });
});

describe.skipIf(!hasFixture('kicad-demos'))('readSchematic — KiCad demo complex_hierarchy', () => {
  // Measured from the fixture: ampli_ht holds 46 symbols and is placed twice,
  // so it carries 92 instance references. 32 of those are power symbols, which
  // never reach a BOM, leaving 60; the LM358N dual op-amp draws both its units
  // on this sheet, so its two unit-symbols collapse to one part per placement
  // (U201, U301) and 60 becomes 58. 58 is the count of real purchasable parts
  // this sheet contributes, and it is the number the pricing tool must see.
  it('yields 58 BOM parts from the twice-placed 46-symbol sheet', async () => {
    const r = await lines(fixtureFiles('kicad-demos').filter((x) => x.name.startsWith('complex_hierarchy/')));
    const ampRefs = [...r.refs.values()].filter((l) => l.sheet === 'complex_hierarchy/ampli_ht.kicad_sch');
    expect(ampRefs).toHaveLength(58);
  });
});
```

(`toMatchInlineSnapshot()` with no argument writes the counts into the test file on the first run; commit the filled-in snapshot.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/public/services/kicad/schematicBom.test.ts`
Expected: FAIL — cannot resolve `./schematicBom`.

- [ ] **Step 3: Write `schematicBom.ts`**

```ts
// frontend/src/public/services/kicad/schematicBom.ts
// BOM lines read straight out of the schematic set (spec §4.3). One line per
// INSTANCE PATH, references resolved from the KiCad 7+ per-symbol `instances`
// block, else KiCad 6's root `symbol_instances` table, else the Reference
// property; power and not-in-BOM symbols skipped; grouped the way a grouped
// CSV export would be. `qty` is always the true instance count — the
// designator list is capped for display only.
import { MAX_LINES, MAX_REFS_PER_LINE, type ParsedBomLine, type ParseResult } from '@public/services/bom/parseBom';
import { matchHeader, type BomRole } from '@public/services/bom/headerAliases';
import { naturalRefCompare } from './naturalSort';
import { basename, resolveSheetRef } from './project';
import { atom, child, children, parse } from './sexpr';
import type { KicadProject, SExpr } from './types';

export interface RefLocation {
  sheet: string;
  instancePath: string;
}

export interface SchematicRead {
  result: ParseResult;
  refs: Map<string, RefLocation>;
  instances: number;
}

interface Instance {
  ref: string;
  mpn: string | null;
  manufacturer: string | null;
  distributorPn: string | null;
  value: string | null;
  footprint: string | null;
  description: string | null;
  dnp: boolean;
  sheet: string;
  instancePath: string;
}

const BUILTIN_PROPERTIES = new Set(['Reference', 'Value', 'Footprint', 'Datasheet', 'Description']);
const MAX_DEPTH = 32;
/** A DNP field is SET unless it says otherwise — exporters write "DNP", "1",
 *  "yes", "x" or the field's own name, but only a handful of explicit
 *  negatives. Matching the negatives is the only list that stays closed. */
const NOT_DNP = /^(no|false|0|n)$/i;

function clean(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = value.trim();
  return v === '' || v === '~' ? null : v;
}

function properties(sym: SExpr[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of children(sym, 'property')) {
    const name = atom(p, 1);
    const value = atom(p, 2);
    if (name != null && value != null && !out.has(name)) out.set(name, value);
  }
  return out;
}

function powerSymbols(doc: SExpr[]): Set<string> {
  const out = new Set<string>();
  const lib = child(doc, 'lib_symbols');
  if (lib == null) return out;
  for (const s of children(lib, 'symbol')) {
    const name = atom(s, 1);
    if (name != null && child(s, 'power') != null) out.add(name);
  }
  return out;
}

function symbolInstancesTable(doc: SExpr[]): Map<string, string> {
  const out = new Map<string, string>();
  const table = child(doc, 'symbol_instances');
  if (table == null) return out;
  for (const p of children(table, 'path')) {
    const path = atom(p, 1);
    const ref = atom(child(p, 'reference') ?? [], 1);
    if (path != null && ref != null) out.set(path.toLowerCase(), ref);
  }
  return out;
}

function referenceFromInstances(sym: SExpr[], instancePath: string): string | null {
  const inst = child(sym, 'instances');
  if (inst == null) return null;
  for (const project of children(inst, 'project')) {
    for (const p of children(project, 'path')) {
      if ((atom(p, 1) ?? '').toLowerCase() === instancePath.toLowerCase()) return atom(child(p, 'reference') ?? [], 1);
    }
  }
  return null;
}

function emptyResult(error: string | null): ParseResult {
  return { lines: [], headers: [], headerSignature: 'kicad-sch', roleByColumn: [], unmappedColumns: [], warnings: [], error };
}

export function readSchematic(project: KicadProject): SchematicRead {
  const warnings: string[] = [];
  const refs = new Map<string, RefLocation>();
  if (project.root == null || project.sheets.length === 0) {
    return { result: emptyResult('No schematic in this project — drop the .kicad_sch files to read a BOM.'), refs, instances: 0 };
  }

  const docs = new Map<string, SExpr[]>();
  for (const s of project.sheets) {
    try {
      const doc = parse(s.text)[0];
      if (Array.isArray(doc)) docs.set(s.path, doc);
    } catch (err) {
      warnings.push(`${basename(s.path)} could not be read (${err instanceof Error ? err.message : 'parse error'}) and was skipped.`);
    }
  }
  const rootDoc = docs.get(project.root);
  if (rootDoc == null) return { result: emptyResult('The root schematic could not be read.'), refs, instances: 0 };

  const rootUuid = project.sheets[0]?.uuid ?? '';
  const legacy = symbolInstancesTable(rootDoc);
  const instances: Instance[] = [];
  const seen = new Set<string>();
  const propertySheets = new Set<string>();
  const selfReferencing = new Set<string>();
  let skippedNotInBom = 0;
  let skippedUnusable = 0;
  let unannotated = 0;

  const visit = (sheetPath: string, sheetUuids: string[], depth: number, chain: string[]): void => {
    const doc = docs.get(sheetPath);
    if (doc == null) return;
    if (depth > MAX_DEPTH) return;
    const power = powerSymbols(doc);
    const pathV7 = `/${[rootUuid, ...sheetUuids].join('/')}`;
    const pathV6 = sheetUuids.length === 0 ? '' : `/${sheetUuids.join('/')}`;
    for (const sym of children(doc, 'symbol')) {
      const libId = atom(child(sym, 'lib_id') ?? [], 1);
      if (libId == null) continue;
      if (atom(child(sym, 'in_bom') ?? [], 1) === 'no') {
        skippedNotInBom++;
        continue;
      }
      const props = properties(sym);
      const uuid = (atom(child(sym, 'uuid') ?? [], 1) ?? '').toLowerCase();
      // An instance table names this symbol AT THIS PATH; the Reference
      // property is a per-file cache that cannot distinguish two placements.
      const tabled = referenceFromInstances(sym, pathV7) ?? legacy.get(`${pathV6}/${uuid}`.toLowerCase()) ?? null;
      const ref = tabled ?? clean(props.get('Reference'));
      if (ref == null || ref.startsWith('#') || power.has(libId)) {
        skippedUnusable++;
        continue;
      }
      // A reference designator names ONE physical part for the whole
      // hierarchy, so the dedupe is designator-scoped, not path-scoped: a
      // multi-unit symbol may draw its units on DIFFERENT sheets (Glasgow's
      // U30 is a 5-unit FPGA with units 3+5 on the root and 1, 2+4 on
      // io_banks) and a path-scoped key buys that chip twice. A sheet placed
      // twice is re-annotated by KiCad, so its two placements still arrive
      // here as two distinct designators.
      //
      // Two inputs cannot support that reasoning and must never merge:
      //   - an UNANNOTATED symbol, where every part answers "R?" — keyed by
      //     the symbol's own uuid (path-qualified, so a twice-placed sheet
      //     still counts twice);
      //   - a reference that came from the PROPERTY FALLBACK, where both
      //     placements of a sheet read the same cached string — keyed by the
      //     instance path, so the second placement is counted rather than
      //     silently swallowed (an under-count ships too few parts).
      const isUnannotated = ref.endsWith('?');
      if (tabled == null) propertySheets.add(sheetPath);
      const key = isUnannotated
        ? `${pathV7}|${uuid === '' ? `#${instances.length}` : uuid}`
        : tabled == null
          ? `${pathV7}|${ref}`
          : ref;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isUnannotated) unannotated++;
      let mpn: string | null = null;
      let manufacturer: string | null = null;
      let distributorPn: string | null = null;
      let dnpField = false;
      for (const [name, value] of props) {
        if (BUILTIN_PROPERTIES.has(name)) continue;
        const role: BomRole | null = matchHeader(name);
        const v = clean(value);
        if (v == null) continue;
        if (role === 'mpn' && mpn == null) mpn = v;
        else if (role === 'manufacturer' && manufacturer == null) manufacturer = v;
        else if (role === 'distributor_pn' && distributorPn == null) distributorPn = v;
        // A DNP FIELD marks the part, not only the `(dnp yes)` attribute:
        // Glasgow writes `(dnp no)` on all 347 symbols and flags its
        // do-not-populate parts with `(property "DNP" "DNP")` alone. Anything
        // that is not an explicit negative counts as set. Deliberately STRICTER
        // than the CSV path (`parseBom`: any non-empty cell), because KiCad
        // field templates commonly default a DNP field to "No" on every part.
        else if (role === 'dnp' && !NOT_DNP.test(v)) dnpField = true;
      }
      instances.push({
        ref, mpn, manufacturer, distributorPn,
        value: clean(props.get('Value')),
        footprint: clean(props.get('Footprint')),
        description: clean(props.get('Description')),
        dnp: dnpField || atom(child(sym, 'dnp') ?? [], 1) === 'yes',
        sheet: sheetPath,
        instancePath: pathV7,
      });
      // First location wins, for every class of reference (a multi-unit part
      // spread over sheets jumps to the sheet its first unit sits on).
      if (!refs.has(ref)) refs.set(ref, { sheet: sheetPath, instancePath: pathV7 });
    }
    // Re-entering a sheet is CORRECT — that is how a twice-placed sheet gets
    // counted twice — so the guard is the ancestor chain, not a visited set.
    // A sheet that references itself (directly or through a cycle) would
    // otherwise expand 2^MAX_DEPTH times and hang the tab; KiCad refuses
    // recursive hierarchies, so skipping is also what the file means.
    const nextChain = [...chain, sheetPath];
    for (const sh of children(doc, 'sheet')) {
      const uuid = (atom(child(sh, 'uuid') ?? [], 1) ?? '').toLowerCase();
      const file = properties(sh).get('Sheetfile');
      if (uuid === '' || file == null) continue;
      const r = resolveSheetRef(sheetPath, file, docs.keys());
      if ('missing' in r) continue;
      if (nextChain.includes(r.path)) {
        selfReferencing.add(r.path);
        continue;
      }
      visit(r.path, [...sheetUuids, uuid], depth + 1, nextChain);
    }
  };
  visit(project.root, [], 0, []);

  const skipped = skippedNotInBom + skippedUnusable;
  if (skipped > 0) warnings.push(`${skipped} symbols skipped: ${skippedNotInBom} not in BOM, ${skippedUnusable} power, virtual or unreferenced.`);
  for (const path of selfReferencing) warnings.push(`${basename(path)} references itself (directly or through its sub-sheets); that reference was skipped.`);
  for (const path of propertySheets) warnings.push(`${basename(path)}: references were read from symbol properties, not instance tables — a sheet placed more than once may show duplicate designators.`);
  if (unannotated > 0) warnings.push(`${unannotated} symbol instances are not annotated (R?, U? …); run Tools → Annotate Schematic in KiCad for an accurate BOM.`);
  if (project.missingSheets.length > 0) warnings.push(`Parts on the missing sheet(s) ${project.missingSheets.join(', ')} are not in this BOM.`);

  const groups = new Map<string, Instance[]>();
  for (const inst of instances) {
    const key = [inst.mpn, inst.manufacturer, inst.value, inst.footprint, inst.dnp ? 'dnp' : ''].map((v) => v ?? '').join('\u0000');
    const bucket = groups.get(key);
    if (bucket) bucket.push(inst);
    else groups.set(key, [inst]);
  }

  const lines: ParsedBomLine[] = [];
  // 1-based, like the CSV path (`parseBom` assigns `i + 1`) — `BomTable`
  // renders this as the visible line number and `share.ts` round-trips it.
  let index = 1;
  for (const bucket of groups.values()) {
    const first = bucket[0] as Instance;
    const sorted = bucket.map((i) => i.ref).sort(naturalRefCompare);
    if (sorted.length > MAX_REFS_PER_LINE) {
      warnings.push(`${sorted[0]} and ${sorted.length - 1} more: ${sorted.length} instances, showing the first ${MAX_REFS_PER_LINE} designators — the quantity is still ${sorted.length}.`);
    }
    lines.push({
      index: index++,
      mpn: first.mpn,
      value: first.value,
      footprint: first.footprint,
      description: first.description,
      manufacturer: first.manufacturer,
      distributorPn: first.distributorPn,
      qty: bucket.length,
      refs: sorted.slice(0, MAX_REFS_PER_LINE),
      dnp: first.dnp,
    });
  }

  const roles: BomRole[] = ['refs', 'qty', 'value', 'footprint', 'description', 'dnp'];
  const labels: Record<BomRole, string> = {
    refs: 'Reference', qty: 'Qty', value: 'Value', footprint: 'Footprint', description: 'Description', dnp: 'DNP',
    mpn: 'MPN', manufacturer: 'Manufacturer', distributor_pn: 'Distributor P/N', datasheet: 'Datasheet',
  };
  if (lines.some((l) => l.mpn != null)) roles.push('mpn');
  if (lines.some((l) => l.manufacturer != null)) roles.push('manufacturer');
  if (lines.some((l) => l.distributorPn != null)) roles.push('distributor_pn');

  const error = lines.length > MAX_LINES
    ? `That schematic has ${lines.length.toLocaleString('en-US')} BOM lines; the tool reads up to ${MAX_LINES.toLocaleString('en-US')}.`
    : null;

  return {
    result: {
      lines: error == null ? lines : [],
      headers: roles.map((r) => labels[r]),
      headerSignature: 'kicad-sch',
      roleByColumn: roles,
      unmappedColumns: [],
      warnings,
      error,
    },
    refs,
    instances: instances.length,
  };
}

export function readBomLines(project: KicadProject): ParseResult {
  return readSchematic(project).result;
}
```

- [ ] **Step 4: Run the tests (twice: the first run fills the inline snapshot), then the gates**

Run: `cd frontend && npx vitest run src/public/services/kicad/schematicBom.test.ts && npx vitest run src/public/services/kicad/schematicBom.test.ts && npx tsc -b && npx eslint --ext .ts,.tsx src/`
Expected: all passed; the Glasgow snapshot now carries concrete `lines`/`instances` numbers. Read the two numbers and sanity-check them against `grep -c "(lib_id" glasgow.kicad_sch io_banks.kicad_sch io_buffer.kicad_sch` (instances should be roughly root + io_banks + 2×io_buffer symbols minus power symbols).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/public/services/kicad/schematicBom.ts frontend/src/public/services/kicad/schematicBom.test.ts
git commit -m "feat(kicad): readSchematic — one BOM line per instance path, KiCad 6/7+ reference resolution, power/not-in-BOM skipped, ready-mapped ParseResult"
```

---

### Task 1.7: `readStackup` — layers, physical stackup, via groups (spec §4.4)

**Files:**
- Create: `frontend/src/public/services/kicad/boardStackup.ts`
- Test: `frontend/src/public/services/kicad/boardStackup.test.ts`

**Interfaces:**
- Consumes: `topLevelBlocks`, `parse`, `child`, `children`, `atom` (1.2); `BoardStackup`, `CopperLayer`, `StackupRow`, `ViaGroup`, `ViaType` (1.2).
- Produces: `readStackup(boardText: string): BoardStackup`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/public/services/kicad/boardStackup.test.ts
import { describe, expect, it } from 'vitest';
import { readStackup } from './boardStackup';
import { fixtureText, hasFixture } from './fixtures';
import { KicadReadError } from './types';

const LAYERS_9 = '(layers (0 "F.Cu" signal) (4 "In1.Cu" power) (6 "In2.Cu" mixed) (2 "B.Cu" jumper) (9 "F.Adhes" user "F.Adhesive") (11 "F.Paste" user) (13 "F.SilkS" user "F.Silkscreen") (15 "F.Mask" user) (25 "Edge.Cuts" user))';
const LAYERS_8 = '(layers (0 "F.Cu" signal) (1 "In1.Cu" power) (2 "In2.Cu" signal) (31 "B.Cu" signal) (32 "B.Adhes" user "B.Adhesive"))';
const STACKUP = '(setup (stackup (layer "F.SilkS" (type "Top Silk Screen") (color "White")) (layer "F.Mask" (type "Top Solder Mask") (thickness 0.01)) (layer "F.Cu" (type "copper") (thickness 0.035)) (layer "dielectric 1" (type "prepreg") (thickness 0.1) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02)) (layer "In1.Cu" (type "copper") (thickness 0.018)) (layer "dielectric 2" (type "core") (thickness 0.84) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02)) (layer "B.Cu" (type "copper") (thickness 0.035)) (layer "B.Mask" (type "Bottom Solder Mask") (thickness 0.01)) (copper_finish "ENIG") (dielectric_constraints no)) (pad_to_mask_clearance 0))';
const VIAS = '(via (at 1 1) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1)) (via locked (at 2 2) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu")) (via blind (at 3 3) (size 0.4) (drill 0.2) (layers "F.Cu" "In1.Cu")) (via micro (at 4 4) (layers "F.Cu" "In1.Cu")) (via micro locked (at 5 5) (layers "In1.Cu" "In2.Cu")) (via blind (at 6 6) (layers "In1.Cu" "In2.Cu")) (via weird (at 7 7) (layers "F.Cu" "B.Cu"))';
const board = (parts: string) => `(kicad_pcb (version 20241229) (generator "pcbnew") (general (thickness 1.6) (legacy_teardrops no)) ${parts})`;

describe('readStackup', () => {
  it('selects copper rows by name, in file order, with the kind mapped, under both id schemes', () => {
    const nine = readStackup(board(LAYERS_9));
    expect(nine.copperLayers).toEqual([
      { ordinal: 1, name: 'F.Cu', kind: 'Signal' }, { ordinal: 2, name: 'In1.Cu', kind: 'Plane' },
      { ordinal: 3, name: 'In2.Cu', kind: 'Mixed' }, { ordinal: 4, name: 'B.Cu', kind: 'Jumper' },
    ]);
    expect(nine.layerCount).toBe(4);
    const eight = readStackup(board(LAYERS_8));
    expect(eight.copperLayers.map((l) => l.name)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
  });

  it('returns stackup null when the block is absent, and the design thickness separately', () => {
    const s = readStackup(board(LAYERS_9));
    expect(s.stackup).toBeNull();
    expect(s.listedThicknessMm).toBeNull();
    expect(s.designThicknessMm).toBe(1.6);
    expect(s.copperFinish).toBeNull();
  });

  it('reads the physical stackup rows in file order with the listed thickness summed', () => {
    const s = readStackup(board(`${LAYERS_9} ${STACKUP}`));
    expect(s.stackup?.map((r) => r.name)).toEqual(['F.SilkS', 'F.Mask', 'F.Cu', 'dielectric 1', 'In1.Cu', 'dielectric 2', 'B.Cu', 'B.Mask']);
    expect(s.stackup?.[3]).toEqual({ name: 'dielectric 1', type: 'prepreg', thicknessMm: 0.1, material: 'FR4', epsilonR: 4.5, lossTangent: 0.02 });
    expect(s.stackup?.[0]?.thicknessMm).toBeNull();
    expect(s.listedThicknessMm).toBeCloseTo(0.01 + 0.035 + 0.1 + 0.018 + 0.84 + 0.035 + 0.01, 6);
    expect(s.copperFinish).toBe('ENIG');
  });

  it('groups vias by (type, start, end); locked is a flag; unknown tokens are unknown', () => {
    const s = readStackup(board(`${LAYERS_9} ${VIAS}`));
    expect(s.vias).toEqual([
      { type: 'through', start: 'F.Cu', end: 'B.Cu', count: 2 },
      { type: 'blind', start: 'F.Cu', end: 'In1.Cu', count: 1 },
      { type: 'micro', start: 'F.Cu', end: 'In1.Cu', count: 1 },
      { type: 'micro', start: 'In1.Cu', end: 'In2.Cu', count: 1 },
      { type: 'blind', start: 'In1.Cu', end: 'In2.Cu', count: 1 },
      { type: 'unknown', start: 'F.Cu', end: 'B.Cu', count: 1 },
    ]);
  });

  it('never materializes the tracks: a board at the 8 MB cap with 90k segments reads in under two seconds', () => {
    const segments = Array.from({ length: 90_000 }, (_, i) => `(segment (start ${i} 0) (end ${i} 1) (width 0.2) (layer "F.Cu") (net 1) (uuid "s${i}"))`).join('\n');
    const text = board(`${LAYERS_9} ${STACKUP} ${VIAS}\n${segments}`);
    expect(text.length).toBeGreaterThan(7 * 1024 * 1024);
    const t0 = performance.now();
    const s = readStackup(text);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(s.vias.reduce((n, g) => n + g.count, 0)).toBe(7);
  });

  // DEVIATION from the task brief, which expected 410 plain + 7 locked = 417.
  // The committed fixture holds 409 plain + 7 locked = 416 top-level (via …)
  // blocks, every one of them spanning "F.Cu" "B.Cu". Measured over the file
  // with the same depth-2 walk topLevelBlocks uses; the naive
  // `grep -c '(via'` reads 418 because it also counts the `(vias` keepout row
  // and `(viasonmask`, which is where an off-by-one on this number comes from.
  it('reads Glasgow revC3: four copper layers, a stackup, 409 through + 7 locked-through vias', () => {
    const s = readStackup(fixtureText('glasgow-revC3/glasgow.kicad_pcb'));
    expect(s.copperLayers.map((l) => l.name)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    expect(s.stackup).not.toBeNull();
    expect(s.vias.filter((g) => g.type === 'through').reduce((n, g) => n + g.count, 0)).toBe(416);
    expect(s.vias.some((g) => g.type === 'unknown')).toBe(false);
  });

  it.skipIf(!hasFixture('kicad-demos'))('reads the KiCad 10 StickHub board (version 20250907) with no unknown via', () => {
    const s = readStackup(fixtureText('kicad-demos/stickhub/StickHub.kicad_pcb'));
    expect(s.vias.reduce((n, g) => n + g.count, 0)).toBe(87);
    expect(s.stackup?.some((r) => r.type === 'core')).toBe(true);
  });

  // Carry-forward from Task 1.5: buildProject accepts a .kicad_pcb with no
  // (version …), so a mis-typed file can reach this reader. An empty structure
  // would render as "a board with nothing on it"; the typed error is the truth.
  it('throws unreadable rather than returning an empty structure when the text is not a board', () => {
    const thrown = ((): unknown => {
      try {
        readStackup('(kicad_sch (version 20250114) (uuid "abc") (paper "A4"))');
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(thrown).toBeInstanceOf(KicadReadError);
    expect((thrown as KicadReadError).kind).toBe('unreadable');
  });

  it('throws unreadable, not a raw scanner error, when the board is truncated', () => {
    expect(() => readStackup('(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal)) (via (at 1 2)')).toThrow(KicadReadError);
    expect(() => readStackup('(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal)) (via (at 1 2)')).toThrow(/truncated or malformed/);
  });

  it('keeps a via unknown once an unknown token is seen, whatever follows it', () => {
    const s = readStackup(board(`${LAYERS_9} (via micro weird (at 0 0) (layers "F.Cu" "In1.Cu")) (via weird micro (at 0 0) (layers "F.Cu" "In1.Cu"))`));
    expect(s.vias).toEqual([{ type: 'unknown', start: 'F.Cu', end: 'In1.Cu', count: 2 }]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/public/services/kicad/boardStackup.test.ts`
Expected: FAIL — cannot resolve `./boardStackup`.

- [ ] **Step 3: Write `boardStackup.ts`**

```ts
// frontend/src/public/services/kicad/boardStackup.ts
// Layer table, physical stackup and via groups from a .kicad_pcb (spec §4.4),
// parsing only the blocks it needs via topLevelBlocks so a 10 MB board's
// tracks are never materialized. Absent facts stay null — never defaulted.
import { atom, child, children, parse, topLevelBlocks } from './sexpr';
import {
  KicadReadError,
  type BoardStackup,
  type CopperLayer,
  type SExpr,
  type StackupRow,
  type ViaGroup,
  type ViaType,
} from './types';

const KIND: Record<string, string> = { signal: 'Signal', power: 'Plane', mixed: 'Mixed', jumper: 'Jumper' };

/** A board must open with (kicad_pcb …). buildProject accepts a .kicad_pcb that
 *  carries no (version …), so a file that is not a board at all can reach here. */
const BOARD_HEAD = /^\s*\(\s*kicad_pcb[\s()]/;

function num(node: SExpr[] | undefined): number | null {
  const v = node == null ? null : atom(node, 1);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(node: SExpr[] | undefined): string | null {
  return node == null ? null : atom(node, 1);
}

function parseBlock(text: string, start: number, end: number): SExpr[] | null {
  try {
    const node = parse(text.slice(start, end))[0];
    return Array.isArray(node) ? node : null;
  } catch {
    return null;
  }
}

function copperLayers(layers: SExpr[]): CopperLayer[] {
  const out: CopperLayer[] = [];
  for (const row of layers) {
    if (!Array.isArray(row)) continue;
    const name = atom(row, 1);
    if (name == null || !name.endsWith('.Cu')) continue;
    const kindToken = atom(row, 2) ?? '';
    out.push({ ordinal: out.length + 1, name, kind: KIND[kindToken] ?? kindToken });
  }
  return out;
}

function stackupRows(setup: SExpr[]): { rows: StackupRow[]; finish: string | null } | null {
  const block = child(setup, 'stackup');
  if (block == null) return null;
  const rows: StackupRow[] = [];
  for (const layer of children(block, 'layer')) {
    rows.push({
      name: atom(layer, 1) ?? '',
      type: str(child(layer, 'type')) ?? '',
      thicknessMm: num(child(layer, 'thickness')),
      material: str(child(layer, 'material')),
      epsilonR: num(child(layer, 'epsilon_r')),
      lossTangent: num(child(layer, 'loss_tangent')),
    });
  }
  return { rows, finish: str(child(block, 'copper_finish')) };
}

function viaOf(via: SExpr[]): ViaGroup | null {
  let type: ViaType = 'through';
  for (let i = 1; i < via.length; i++) {
    const token = via[i];
    if (typeof token !== 'string') break;
    // A token this reader does not know makes the whole via `unknown`, and
    // stays that way: `(via micro weird …)` is as unknown as `(via weird micro …)`.
    if (type === 'unknown') continue;
    if (token === 'blind') type = 'blind';
    else if (token === 'micro') type = 'micro';
    else if (token !== 'locked') type = 'unknown';
  }
  const layers = child(via, 'layers');
  const start = layers == null ? null : atom(layers, 1);
  const end = layers == null ? null : atom(layers, 2);
  if (start == null || end == null) return null;
  return { type, start, end, count: 1 };
}

export function readStackup(boardText: string): BoardStackup {
  if (!BOARD_HEAD.test(boardText)) {
    throw new KicadReadError('That file does not open with (kicad_pcb …) — it is not a KiCad board.', 'unreadable');
  }
  let copper: CopperLayer[] = [];
  let stackup: StackupRow[] | null = null;
  let copperFinish: string | null = null;
  let designThicknessMm: number | null = null;
  const groups = new Map<string, ViaGroup>();

  // One error contract for the reader: a truncated or unbalanced board makes
  // the scanner throw a plain Error, which the pages never see — it is the
  // same 'unreadable' as a file that is not a board at all.
  let blocks: Iterable<{ head: string; start: number; end: number }>;
  try {
    blocks = [...topLevelBlocks(boardText)];
  } catch (err) {
    if (err instanceof KicadReadError) throw err;
    throw new KicadReadError('That board file is truncated or malformed and could not be read.', 'unreadable');
  }
  for (const block of blocks) {
    if (block.head === 'layers') {
      const node = parseBlock(boardText, block.start, block.end);
      if (node) copper = copperLayers(node);
    } else if (block.head === 'general') {
      const node = parseBlock(boardText, block.start, block.end);
      if (node) designThicknessMm = num(child(node, 'thickness'));
    } else if (block.head === 'setup') {
      const node = parseBlock(boardText, block.start, block.end);
      const read = node ? stackupRows(node) : null;
      if (read) {
        stackup = read.rows;
        copperFinish = read.finish;
      }
    } else if (block.head === 'via') {
      const node = parseBlock(boardText, block.start, block.end);
      const via = node ? viaOf(node) : null;
      if (via == null) continue;
      const key = `${via.type}|${via.start}|${via.end}`;
      const existing = groups.get(key);
      if (existing) existing.count++;
      else groups.set(key, via);
    }
  }

  const listed = stackup == null ? null : stackup.reduce<number | null>((sum, r) => (r.thicknessMm == null ? sum : (sum ?? 0) + r.thicknessMm), null);
  return {
    copperLayers: copper,
    stackup,
    copperFinish,
    listedThicknessMm: listed,
    designThicknessMm,
    vias: [...groups.values()],
    layerCount: copper.length,
  };
}
```

- [ ] **Step 4: Run the tests and gates**

Run: `cd frontend && npx vitest run src/public/services/kicad && npx tsc -b && npx eslint --ext .ts,.tsx src/`
Expected: all passed (skips without the demos); the 200k-segment test under 2 s.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/public/services/kicad/boardStackup.ts frontend/src/public/services/kicad/boardStackup.test.ts
git commit -m "feat(kicad): readStackup — copper rows by name, physical stackup, via groups with real spans (locked is a flag), no track materialization"
```

---

### Task 1.8: `kicad-dump` — the Phase 1 harness, and the gate

**Files:**
- Create: `frontend/scripts/kicad-dump.mjs`, `frontend/scripts/kicad-dump-entry.ts`

**Interfaces:**
- Consumes: `buildProject` (1.5), `readSchematic` (1.6), `readStackup` (1.7).
- Produces: `node scripts/kicad-dump.mjs <dir-or-zip>` printing a JSON summary the owner can compare with KiCad's own BOM export.

- [ ] **Step 1: Write the entry and the runner**

```ts
// frontend/scripts/kicad-dump-entry.ts
// Bundled by kicad-dump.mjs for node: reads a directory or zip through the
// SAME reader the pages use and prints what it found.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildProject } from '@public/services/kicad/project';
import { readSchematic } from '@public/services/kicad/schematicBom';
import { readStackup } from '@public/services/kicad/boardStackup';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export async function dump(target: string): Promise<void> {
  const files = statSync(target).isDirectory()
    ? walk(target).map((p) => new File([readFileSync(p)], relative(target, p).split('\\').join('/')))
    : [new File([readFileSync(target)], target.split('/').pop() ?? 'project.zip')];
  const project = await buildProject(files);
  const sch = readSchematic(project);
  const board = project.board == null ? null : readStackup(project.files.get(project.board) as string);
  const out = {
    name: project.name,
    root: project.root,
    sheets: project.sheets.map((s) => s.path),
    board: project.board,
    missingSheets: project.missingSheets,
    warnings: [...project.warnings, ...sch.result.warnings],
    error: sch.result.error,
    instances: sch.instances,
    lines: sch.result.lines.length,
    references: [...sch.refs.keys()].sort(),
    bom: sch.result.lines.map((l) => ({ qty: l.qty, refs: l.refs.join(' '), value: l.value, footprint: l.footprint, mpn: l.mpn, manufacturer: l.manufacturer, dnp: l.dnp })),
    stackup: board,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
```

```js
// frontend/scripts/kicad-dump.mjs
// Usage: node scripts/kicad-dump.mjs <project-dir-or-zip>
// Bundles kicad-dump-entry.ts for node with the same aliases the app uses,
// then runs it. The reader is browser code with no DOM dependency, so node's
// File/Blob (20+) is enough.
import esbuild from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/kicad-dump.mjs <project-dir-or-zip>');
  process.exit(2);
}
const here = import.meta.dirname;
const out = join(mkdtempSync(join(tmpdir(), 'kicad-dump-')), 'entry.mjs');
await esbuild.build({
  entryPoints: [join(here, 'kicad-dump-entry.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias: { '@public': resolve(here, '../src/public'), '@shared': resolve(here, '../src/shared') },
  logLevel: 'warning',
});
const { dump } = await import(pathToFileURL(out).href);
await dump(resolve(target));
```

- [ ] **Step 2: Run it against the corpus**

```bash
cd frontend
node scripts/kicad-dump.mjs src/public/services/kicad/fixtures/glasgow-revC3 | head -40
node scripts/kicad-dump.mjs src/public/services/kicad/fixtures/bad-thing-panel | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['lines'], 'lines', d['instances'], 'instances', len(d['references']), 'refs; board layers', d['stackup']['layerCount'] if d['stackup'] else None)"
```

Expected: JSON with sheets, references, BOM lines and the stackup; no `error`.

- [ ] **Step 3: Commit, then STOP — Phase 1 gate**

```bash
git add frontend/scripts/kicad-dump.mjs frontend/scripts/kicad-dump-entry.ts
git commit -m "chore(kicad): kicad-dump harness — the reader over a directory or zip, for the Phase 1 playtest"
```

Gate checklist for the owner: `cd frontend && npm test` green; `node scripts/kicad-dump.mjs <any KiCad 6+ project dir>` prints its BOM; where KiCad is installed, compare the `references` list against the reference column of a bare `kicad-cli sch export bom --output /tmp/bom.csv <root>.kicad_sch` (one row per symbol, no grouping): the two sets must be identical. Wait for explicit approval before Phase 2.

---

# Phase 2 — The canvas and `/viewer` (Schematic, Board)

### Task 2.1: The `CanvasController` protocol and its KiCanvas implementation (spec §5.3, §5.5)

**Files:**
- Create: `frontend/src/public/components/kicad/canvasController.ts`, `frontend/src/public/components/kicad/kicanvasController.ts`
- Test: `frontend/src/public/components/kicad/kicanvasController.test.ts` (happy-dom)

**Interfaces:**
- Consumes: `KicadProject` (1.2), `basename` (1.5), `import('@vendor-build/kicanvas')` (0.3).
- Produces: the `CanvasController` interface below (incl. `zoom(action)` and `ZoomAction`); `class KicanvasController implements CanvasController` with constructor options `{ loadModule?, createEmbed?, readyMs?, settleMs?, sleep? }`; `sourcesFor(project): { sources: CanvasSource[]; dropped: string[] }`. **Before writing `zoom`, read `frontend/vendor/kicanvas/src/viewers/base/viewer.ts` and `src/base/math/camera2.ts` and use the real property names the vendored source exposes; the code below assumes `viewer.zoom_to_page()`, `viewer.viewport.camera.zoom` and `viewer.viewport.draw()` — correct the names if the source differs, keep the feature detection, and record what you found in your report.**

- [ ] **Step 1: Write the protocol**

```ts
// frontend/src/public/components/kicad/canvasController.ts
// The only surface pages, the session and the BOM units see of a renderer
// (spec §5.5). Stage 1 ships one implementation (KiCanvas, read-only). The
// later editor stage implements the same interface over KiCad-as-WebAssembly
// and starts emitting `documentChanged` and `selection`; nothing here emits
// them yet and nothing outside this folder may import a renderer directly.
import type { KicadProject } from '@public/services/kicad/types';

export type CanvasView = 'schematic' | 'board';
export type CanvasStateName = 'loading' | 'ready' | 'no-webgl' | 'timeout' | 'error';
/**
 * What a focus request came to.
 *
 * `superseded` is the one that is not a failure: a NEWER gesture — the reader
 * picking a different sheet while this focus was still loading — took the view,
 * and the focus stood down rather than dragging the drawing back to where it
 * was going. A host must treat it as "say nothing": the reader has already
 * moved on, and narrating the click they abandoned is worse than silence.
 */
export type FocusResult = 'focused' | 'not-found' | 'unsupported' | 'superseded';

export type CanvasEvent =
  | { type: 'state'; state: CanvasStateName; detail?: string }
  | { type: 'selection'; ref: string | null }
  | { type: 'documentChanged'; path: string; text: string };

export type CanvasEventType = CanvasEvent['type'];
export type CanvasHandler<T extends CanvasEventType> = (event: Extract<CanvasEvent, { type: T }>) => void;

export interface CanvasController {
  /** Load every file of the project into the host element. Resolves on `ready`; rejects never — failures arrive as `state` events. */
  mount(host: HTMLElement, project: KicadProject): Promise<void>;
  /** Show the board, or a schematic sheet (a path key from the project, or an instance path). True when a page was found. */
  activate(view: CanvasView, sheet?: string): Promise<boolean>;
  /** Select and zoom to a reference designator, switching sheet first when one is given. */
  focusRef(ref: string, sheet?: string): Promise<FocusResult>;
  /** Fit the page, or step the zoom. False when the renderer exposes no such control (the buttons then hide). */
  zoom(action: ZoomAction): Promise<boolean>;
  /**
   * Path keys of sheets THIS renderer cannot draw for this project — answerable
   * from the project alone, before anything is mounted, so a host can mark them
   * on the first paint rather than a frame later.
   *
   * Optional because it is a statement about one renderer's limits, not about
   * the project: KiCanvas keys its virtual file system by basename and so must
   * drop a second `power.kicad_sch`, where a path-keyed renderer drops nothing
   * and simply does not implement this. A host MUST treat an absent
   * implementation as "none", never as "unknown".
   */
  unrenderableSheets?(project: KicadProject): string[];
  dispose(): void;
  on<T extends CanvasEventType>(type: T, handler: CanvasHandler<T>): () => void;
}

export type ZoomAction = 'fit' | 'in' | 'out';

export interface CanvasSource {
  name: string;
  type: 'project' | 'schematic' | 'board';
  text: string;
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { KicadProject } from '@public/services/kicad/types';
import { KicanvasController, sourcesFor } from './kicanvasController';

interface FakePage { type: 'pcb' | 'schematic'; filename: string; sheet_path: string; project_path: string; document: { filename: string } }

/** ONE document object per FILE, exactly as upstream: `ProjectPage.document` is
 *  `file_by_name(filename)` (vendor kicanvas/project.ts:393-395), so two instance
 *  pages of one file hand the viewer the SAME object — which is why upstream's
 *  `DocumentViewer.load` early-returns and dispatches nothing for that switch. */
const DOCS = new Map<string, { filename: string }>();
function docFor(filename: string): { filename: string } {
  let doc = DOCS.get(filename);
  if (doc == null) {
    doc = { filename };
    DOCS.set(filename, doc);
  }
  return doc;
}

/** `KiCanvasLoadEvent.type` — vendor viewers/base/events.ts:13-14. */
const LOAD = 'kicanvas:load';

function project(files: Record<string, string>, extra: Partial<KicadProject> = {}): KicadProject {
  const map = new Map(Object.entries(files));
  const sheets = [...map.keys()].filter((k) => k.endsWith('.kicad_sch')).map((path) => ({ path, uuid: `u-${path}`, text: map.get(path) as string }));
  return { name: 'p', files: map, pro: null, root: sheets[0]?.path ?? null, sheets, board: [...map.keys()].find((k) => k.endsWith('.kicad_pcb')) ?? null, warnings: [], missingSheets: [], formatVersions: {}, ...extra };
}

function makeViewer(selectedFor: string[], log: string[]) {
  return Object.assign(new EventTarget(), {
    document: null as { filename: string } | null,
    selected: false as boolean | string,
    select(ref: string) {
      log.push(ref);
      this.selected = selectedFor.includes(ref) ? ref : false;
    },
    zoom_to_selection() { /* no-op */ },
  });
}

/** A fake embed: a shadow root holding fake app elements with the public
 *  surface the controller relies on (project, viewer). The viewers are real
 *  EventTargets that dispatch `kicanvas:load` on every page switch, because that
 *  is the only signal an instance switch within ONE file produces. */
function fakeEmbed(opts: {
  pages: FakePage[];
  selectedFor?: string[];
  boardSelectedFor?: string[];
  viewerDoc?: boolean;
  withProject?: boolean;
  /** Dispatch the load on a later turn, to prove activate() waits for it. */
  asyncLoad?: boolean;
  /** Queue loads in `pending` for the test to fire by hand. */
  manualLoad?: boolean;
  /** App elements with no viewer at all — the pre-render state. */
  noViewer?: boolean;
  onLoad?: (projectPath: string) => void;
}) {
  const embed = document.createElement('kicanvas-embed');
  const shadow = embed.attachShadow({ mode: 'open' });
  let active: FakePage | null = null;
  const selected: string[] = [];
  const boardSelected: string[] = [];
  const pending: (() => void)[] = [];
  const mode = { manual: opts.manualLoad ?? false, deferred: false };
  const viewer = makeViewer(opts.selectedFor ?? [], selected);
  const boardViewer = makeViewer(opts.boardSelectedFor ?? [], boardSelected);
  const proj = {
    pages: () => opts.pages,
    get active_page() { return active; },
    // Mirrors upstream exactly: project.ts:274 assigns the FIRST page
    // unconditionally, so on a board-bearing project this is the PCB.
    root_schematic_page: opts.pages[0] ?? null,
    set_active_page(p: FakePage | string) {
      active = typeof p === 'string' ? (opts.pages.find((x) => x.project_path === p) ?? null) : p;
      const page = active;
      if (page == null || opts.viewerDoc === false) return;
      // kc-board-app loads pcb pages, kc-schematic-app loads schematics.
      const target = page.type === 'pcb' ? boardViewer : viewer;
      // Upstream's early return: the viewer already holds this document, so it
      // returns BEFORE resolve_loaded and no `kicanvas:load` is ever dispatched
      // (viewers/base/document-viewer.ts:58-60, viewers/base/viewer.ts:128-132).
      if (target.document === page.document) return;
      // The document is assigned when the load STARTS (document-viewer.ts:64); the event
      // comes only from resolve_loaded, inside the later() tail that positions the camera
      // and clears the selection (:68-86). Modelling that GAP is what lets a test see a
      // second activate for this page find the document "already held" mid-load.
      target.document = page.document;
      const fire = () => {
        opts.onLoad?.(page.project_path);
        target.dispatchEvent(new Event(LOAD));
      };
      // A macrotask, deliberately: a microtask would land before activate()'s own
      // continuation regardless of whether it waited, faking the proof below.
      if (mode.manual) pending.push(fire);
      else if (mode.deferred) setTimeout(fire, 0);
      else fire();
    },
  };
  const sch = document.createElement('kc-schematic-app') as HTMLElement & { project?: unknown; viewer?: unknown };
  if (opts.withProject !== false) sch.project = proj;
  if (!opts.noViewer) sch.viewer = viewer;
  shadow.appendChild(sch);
  const board = document.createElement('kc-board-app') as HTMLElement & { project?: unknown; viewer?: unknown };
  if (opts.withProject !== false) board.project = proj;
  if (!opts.noViewer) board.viewer = boardViewer;
  shadow.appendChild(board);
  // The real embed sets an active page after load; the fake does it immediately — and
  // always synchronously, so an asyncLoad fixture cannot drop the CONSTRUCTOR's own load
  // event into the middle of a later assertion.
  proj.set_active_page(proj.root_schematic_page ?? opts.pages[0]!);
  mode.deferred = opts.asyncLoad ?? false;
  return {
    embed, selected, boardSelected, getActive: () => active, viewer, boardViewer, proj, sch, board, pending,
    setManual: (v: boolean) => { mode.manual = v; },
  };
}

const PAGES: FakePage[] = [
  { type: 'schematic', filename: 'main.kicad_sch', sheet_path: '/r', project_path: 'main.kicad_sch', document: docFor('main.kicad_sch') },
  { type: 'schematic', filename: 'sub.kicad_sch', sheet_path: '/r/a', project_path: 'sub.kicad_sch:/r/a', document: docFor('sub.kicad_sch') },
  { type: 'schematic', filename: 'sub.kicad_sch', sheet_path: '/r/b', project_path: 'sub.kicad_sch:/r/b', document: docFor('sub.kicad_sch') },
  { type: 'pcb', filename: 'main.kicad_pcb', sheet_path: '', project_path: 'main.kicad_pcb', document: docFor('main.kicad_pcb') },
];

function controller(fake: ReturnType<typeof fakeEmbed>, readyMs = 500) {
  return new KicanvasController({ loadModule: async () => undefined, createEmbed: () => fake.embed, readyMs, settleMs: 50, sleep: async () => undefined });
}

describe('sourcesFor', () => {
  it('emits the project file first, then sheets, then the board, by basename', () => {
    const p = project({ 'a/main.kicad_sch': 's', 'a/sub/io.kicad_sch': 't', 'a/main.kicad_pcb': 'b', 'a/main.kicad_pro': '{}' });
    const { sources, dropped } = sourcesFor(p);
    expect(sources.map((s) => [s.name, s.type])).toEqual([['main.kicad_pro', 'project'], ['main.kicad_sch', 'schematic'], ['io.kicad_sch', 'schematic'], ['main.kicad_pcb', 'board']]);
    expect(dropped).toEqual([]);
  });
  it('drops a second file with the same basename and names it — KiCanvas cannot tell them apart', () => {
    const p = project({ 'main.kicad_sch': 's', 'x/reg.kicad_sch': 't', 'y/reg.kicad_sch': 'u' });
    expect(sourcesFor(p).dropped).toEqual(['y/reg.kicad_sch']);
  });
});

describe('KicanvasController', () => {
  it('mounts, reports ready, and activates sheets and the board through the public project', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    const c = controller(fake);
    const states: string[] = [];
    c.on('state', (e) => states.push(e.state));
    const host = document.createElement('div');
    await c.mount(host, project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't', 'main.kicad_pcb': 'b' }));
    expect(states).toEqual(['loading', 'ready']);
    expect(host.firstElementChild?.tagName.toLowerCase()).toBe('kicanvas-embed');
    const sch = fake.embed.shadowRoot!.querySelector('kc-schematic-app') as HTMLElement;
    const brd = fake.embed.shadowRoot!.querySelector('kc-board-app') as HTMLElement;
    // mount() ends with an activate(), so exactly one app is visible before `ready`.
    expect([sch.hidden, brd.hidden]).toEqual([false, true]);
    expect(await c.activate('board')).toBe(true);
    expect(fake.getActive()?.type).toBe('pcb');
    expect([sch.hidden, brd.hidden]).toEqual([true, false]);
    expect(await c.activate('schematic', 'sub.kicad_sch')).toBe(true);
    expect([sch.hidden, brd.hidden]).toEqual([false, true]);
    expect(fake.getActive()?.project_path).toBe('sub.kicad_sch:/r/a');
    expect(await c.activate('schematic', '/r/b')).toBe(true);
    expect(fake.getActive()?.project_path).toBe('sub.kicad_sch:/r/b');
    expect(await c.activate('schematic', 'nope.kicad_sch')).toBe(false);
  });

  it('finds the root schematic by TYPE, because upstream hands back the board as root_schematic_page', async () => {
    // project.ts:274 reassigns root_schematic_page to the first page and PCBs are
    // inserted first (:133-144) — Glasgow revC3 is exactly this shape.
    const boardFirst: FakePage[] = [PAGES[3]!, PAGES[0]!, PAGES[1]!, PAGES[2]!];
    const fake = fakeEmbed({ pages: boardFirst });
    expect(fake.proj.root_schematic_page?.type).toBe('pcb');
    const c = controller(fake);
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'main.kicad_pcb': 'b' }));
    expect(fake.getActive()?.type).toBe('schematic');
    expect(fake.getActive()?.filename).toBe('main.kicad_sch');
    expect([fake.sch.hidden, fake.board.hidden]).toEqual([false, true]);
  });

  it('waits for the viewer load event when the document really changes', async () => {
    const order: string[] = [];
    const fake = fakeEmbed({ pages: PAGES, asyncLoad: true, onLoad: (p) => order.push(`load:${p}`) });
    // A sleep that yields to the macrotask queue, so the load event can actually land.
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 500,
      settleMs: 500,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    });
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't' }));
    order.length = 0;
    // main.kicad_sch -> sub.kicad_sch is a genuine load, so the caller must not be
    // told the switch happened until the viewer says it did.
    await c.activate('schematic', '/r/a');
    order.push('activated:/r/a');
    expect(order).toEqual(['load:sub.kicad_sch:/r/a', 'activated:/r/a']);
  });

  it('settles at once when the viewer already holds the page document, because no event is coming', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    let clock = 0;
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 5000,
      settleMs: 1500,
      now: () => clock,
      sleep: async () => { clock += 1000; }, // any wait at all shows up in the clock
    });
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't' }));
    expect(await c.activate('schematic', '/r/a')).toBe(true);
    const before = clock;
    // Same FILE, so the same shared document object: DocumentViewer.load early-returns
    // before resolve_loaded and dispatches nothing. Waiting would burn the whole
    // settleMs on what upstream treats as a no-op — and this is the common gesture
    // (a revisited sheet, a second focusRef, mount's closing activate).
    expect(await c.activate('schematic', '/r/b')).toBe(true);
    expect(fake.getActive()?.project_path).toBe('sub.kicad_sch:/r/b');
    expect(clock).toBe(before);
  });

  it('never short-circuits past its OWN in-flight load, however fast the second activate is', async () => {
    // The other half of the same coin. Upstream assigns `this.document = src` when the
    // load STARTS (vendor viewers/base/document-viewer.ts:64) and only positions the
    // camera, dispatches kicanvas:load and CLEARS THE SELECTION afterwards, in the
    // later() tail (:68-86). So holdsDocument() is already true while a load is running:
    // a second activate that short-circuited there would resolve with nothing positioned,
    // and the focusRef awaiting it would report 'focused' just before the tail deselects.
    const fake = fakeEmbed({ pages: PAGES, asyncLoad: true });
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 500,
      settleMs: 500,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    });
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't' }));
    const order: string[] = [];
    fake.viewer.addEventListener(LOAD, () => order.push('load'));
    const first = c.activate('schematic', '/r/a'); // a real load: the document changes
    const second = c.activate('schematic', '/r/a'); // same page, its document is already assigned
    expect(await second).toBe(true);
    order.push('second');
    expect(await first).toBe(false); // superseded, so it writes no `hidden` of its own
    expect(order).toEqual(['load', 'second']);
  });

  it('retires a watch that outlived its budget, so the next activate for that page is not charged twice', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    let clock = 0;
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 5000,
      settleMs: 1500,
      now: () => clock,
      sleep: async () => { clock += 500; },
    });
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't' }));
    fake.setManual(true); // the load is queued and never fired — the budget runs out
    expect(await c.activate('schematic', '/r/a')).toBe(true);
    expect(clock).toBe(1500);
    // The viewer HOLDS that document now (upstream assigns it when the load starts), and a
    // watch that never fired is no longer evidence of a load in flight — riding it would
    // spend the whole budget a second time on the same page. The first switch into a
    // hidden app times out exactly like this: its canvas is 0x0 until it is shown.
    expect(await c.activate('schematic', '/r/b')).toBe(true);
    expect(clock).toBe(1500);
  });

  it('does not wait when there is no viewer to signal it — nothing is coming', async () => {
    // `Viewer extends EventTarget` (vendor viewers/base/viewer.ts:22), so an
    // unlistenable watch means the app has not rendered its viewer yet, not that the
    // renderer lacks the event. Either way no load signal can arrive, so waiting for
    // one would just spend the settle budget.
    const fake = fakeEmbed({ pages: PAGES, noViewer: true });
    let clock = 0;
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 5000,
      settleMs: 1500,
      now: () => clock,
      sleep: async () => { clock += 1000; },
    });
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't' }));
    const before = clock;
    expect(await c.activate('schematic', '/r/a')).toBe(true);
    expect(clock).toBe(before);
  });

  it('a superseded activate never writes hidden: the newer switch wins and the older returns false', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 500,
      settleMs: 1000,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    });
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't', 'main.kicad_pcb': 'b' }));
    fake.setManual(true); // from here the test decides when each load lands
    const first = c.activate('board');
    const second = c.activate('schematic', '/r/a');
    fake.pending[1]!(); // the schematic loads first, so the SECOND switch completes first
    expect(await second).toBe(true);
    expect([fake.sch.hidden, fake.board.hidden]).toEqual([false, true]);
    fake.pending[0]!(); // the board's load arrives late, after it was superseded
    expect(await first).toBe(false);
    expect([fake.sch.hidden, fake.board.hidden]).toEqual([false, true]); // view untouched
  });

  it('focuses a reference, reports not-found when the viewer did not select, and unsupported without a document', async () => {
    const fake = fakeEmbed({ pages: PAGES, selectedFor: ['U1'] });
    const c = controller(fake);
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    expect(await c.focusRef('U1')).toBe('focused');
    expect(await c.focusRef('R999')).toBe('not-found');
    expect(fake.selected).toEqual(['U1', 'R999']);
    const noDoc = fakeEmbed({ pages: PAGES, viewerDoc: false });
    const c2 = controller(noDoc);
    await c2.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    expect(await c2.focusRef('U1')).toBe('unsupported');
  });

  it('focuses on the BOARD when the board is active — BoardViewer.select takes a ref too', async () => {
    const fake = fakeEmbed({ pages: PAGES, selectedFor: ['U1'], boardSelectedFor: ['U7'] });
    const c = controller(fake);
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'main.kicad_pcb': 'b' }));
    expect(await c.activate('board')).toBe(true);
    expect(await c.focusRef('U7')).toBe('focused');
    expect(fake.boardSelected).toEqual(['U7']);
    expect(fake.selected).toEqual([]); // the schematic viewer was never asked
    expect(await c.focusRef('U1')).toBe('not-found'); // present on the sheet, not the board
  });

  it('times out when no app element carries a project, unmounts the embed, and reports it', async () => {
    const fake = fakeEmbed({ pages: PAGES, withProject: false });
    const c = controller(fake, 120);
    const states: string[] = [];
    c.on('state', (e) => states.push(e.state));
    const host = document.createElement('div');
    await c.mount(host, project({ 'main.kicad_sch': 's' }));
    expect(states).toEqual(['loading', 'timeout']);
    expect(host.childElementCount).toBe(0);
    expect(await c.activate('board')).toBe(false);
  });

  it('refunds the REAL time a hidden tab spends, so a slow mount is not falsely timed out', async () => {
    // A chained setTimeout in a hidden tab is throttled to ~1 s, so a fixed 50 ms
    // refund gives back a twentieth of what the wait cost and the budget drains.
    const fake = fakeEmbed({ pages: PAGES, withProject: false });
    let clock = 0;
    let waits = 0;
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 15000,
      settleMs: 50,
      now: () => clock,
      visibility: () => 'hidden',
      sleep: async () => {
        clock += 1000;
        if (++waits === 20) fake.sch.project = fake.proj; // the embed finally loads
      },
    });
    const states: string[] = [];
    c.on('state', (e) => states.push(e.state));
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    expect(states).toEqual(['loading', 'ready']);
    expect(waits).toBe(20); // 20 s of hidden time on a 15 s budget, all refunded
  });

  it('spends the budget normally while VISIBLE on the same clock', async () => {
    const fake = fakeEmbed({ pages: PAGES, withProject: false });
    let clock = 0;
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 15000,
      settleMs: 50,
      now: () => clock,
      visibility: () => 'visible',
      sleep: async () => { clock += 1000; },
    });
    const states: string[] = [];
    c.on('state', (e) => states.push(e.state));
    const host = document.createElement('div');
    await c.mount(host, project({ 'main.kicad_sch': 's' }));
    expect(states).toEqual(['loading', 'timeout']);
    expect(clock).toBe(15000);
    expect(host.childElementCount).toBe(0);
  });

  it('a superseded mount goes quiet: one ready, and it never tears down the live embed', async () => {
    const stuck = fakeEmbed({ pages: PAGES, withProject: false });
    const live = fakeEmbed({ pages: PAGES });
    let nextEmbed: HTMLElement = stuck.embed;
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => nextEmbed,
      readyMs: 60,
      settleMs: 10,
      sleep: async () => undefined,
    });
    const states: string[] = [];
    c.on('state', (e) => states.push(e.state));
    const host = document.createElement('div');
    const p = project({ 'main.kicad_sch': 's' });
    const first = c.mount(host, p);
    nextEmbed = live.embed;
    const second = c.mount(host, p);
    await Promise.all([first, second]);
    expect(states.filter((s) => s === 'ready')).toEqual(['ready']);
    expect(states).not.toContain('timeout');
    expect(host.firstElementChild).toBe(live.embed);
  });

  it('an activate superseded by a REMOUNT returns false and leaves the view it captured alone', async () => {
    const first = fakeEmbed({ pages: PAGES });
    const live = fakeEmbed({ pages: PAGES });
    let nextEmbed: HTMLElement = first.embed;
    let release: () => void = () => undefined;
    // The second mount parks on its module load, so it never starts an activate of its
    // own: `seq` stays current and ONLY the epoch half of the guard can catch this one.
    const parked = new Promise<void>((resolve) => { release = () => resolve(); });
    let loads = 0;
    const c = new KicanvasController({
      loadModule: async () => { if (++loads === 2) await parked; },
      createEmbed: () => nextEmbed,
      readyMs: 500,
      settleMs: 40,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    });
    const host = document.createElement('div');
    const p = project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't', 'main.kicad_pcb': 'b' });
    await c.mount(host, p);
    expect([first.sch.hidden, first.board.hidden]).toEqual([false, true]);
    first.setManual(true); // the board's load never lands, so the activate is still settling
    const activating = c.activate('board');
    nextEmbed = live.embed;
    const remount = c.mount(host, p); // supersedes that mount mid-settle
    expect(await activating).toBe(false);
    expect([first.sch.hidden, first.board.hidden]).toEqual([false, true]); // never flipped to the board
    release();
    await remount;
    expect(host.firstElementChild).toBe(live.embed);
    expect([live.sch.hidden, live.board.hidden]).toEqual([false, true]);
  });

  it('zooms through the viewer camera when it exists and reports false when it does not', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    const v = fake.viewer as typeof fake.viewer & { zoom_to_page?: () => void; draw?: () => void; viewport?: { camera: { zoom: number } } };
    let fitted = 0;
    let drawn = 0;
    v.zoom_to_page = () => fitted++;
    // The repaint after a camera move is the VIEWER's draw(); Viewport has none
    // (vendor viewers/base/viewport.ts). Asserted so a silent no-op cannot return.
    v.draw = () => drawn++;
    v.viewport = { camera: { zoom: 1 } };
    const c = controller(fake);
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    expect(await c.zoom('fit')).toBe(true);
    expect(fitted).toBe(1);
    expect(drawn).toBe(0); // zoom_to_page repaints itself (document-viewer.ts:133-136)
    expect(await c.zoom('in')).toBe(true);
    expect(v.viewport!.camera.zoom).toBeCloseTo(1.25);
    expect(drawn).toBe(1);
    expect(await c.zoom('out')).toBe(true);
    expect(v.viewport!.camera.zoom).toBeCloseTo(1);
    expect(drawn).toBe(2);
    delete v.viewport;
    expect(await c.zoom('in')).toBe(false);
  });

  it('clamps the camera to the same bounds upstream gives its own wheel handler', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    const v = fake.viewer as typeof fake.viewer & { draw?: () => void; viewport?: { camera: { zoom: number } } };
    v.draw = () => undefined;
    v.viewport = { camera: { zoom: 1 } };
    const c = controller(fake);
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    for (let i = 0; i < 30; i++) expect(await c.zoom('in')).toBe(true);
    expect(v.viewport!.camera.zoom).toBe(190); // enable_pan_and_zoom(0.5, 190), viewer.ts:80
    for (let i = 0; i < 60; i++) expect(await c.zoom('out')).toBe(true);
    expect(v.viewport!.camera.zoom).toBe(0.5);
  });

  it('refuses a sheet whose file was dropped rather than showing its basename twin', async () => {
    const pages: FakePage[] = [
      { type: 'schematic', filename: 'main.kicad_sch', sheet_path: '/r', project_path: 'main.kicad_sch', document: docFor('main.kicad_sch') },
      { type: 'schematic', filename: 'reg.kicad_sch', sheet_path: '/r/x', project_path: 'reg.kicad_sch:/r/x', document: docFor('reg.kicad_sch') },
    ];
    const fake = fakeEmbed({ pages });
    const c = controller(fake);
    // y/reg.kicad_sch collides on basename with x/reg.kicad_sch and is dropped.
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'x/reg.kicad_sch': 't', 'y/reg.kicad_sch': 'u' }));
    expect(await c.activate('schematic', 'x/reg.kicad_sch')).toBe(true);
    expect(await c.activate('schematic', 'y/reg.kicad_sch')).toBe(false);
  });

  it('reports error when the module fails to load, and dispose is idempotent', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    const c = new KicanvasController({ loadModule: async () => { throw new Error('boom'); }, createEmbed: () => fake.embed });
    const states: { state: string; detail?: string }[] = [];
    c.on('state', (e) => states.push({ state: e.state, detail: e.detail }));
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    expect(states[1]).toEqual({ state: 'error', detail: 'boom' });
    c.dispose();
    c.dispose();
  });

  it('a load that rejects after dispose() emits nothing', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    const c = new KicanvasController({
      loadModule: async () => { await Promise.resolve(); throw new Error('boom'); },
      createEmbed: () => fake.embed,
    });
    const pending = c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    c.dispose(); // lands while the import is still in flight
    // Registered AFTER dispose on purpose: clearing the handler map must not be what
    // hides the stray emit, or the two halves of this fix mask each other.
    const after: string[] = [];
    c.on('state', (e) => after.push(e.state));
    await pending;
    expect(after).toEqual([]);
  });

  it('dispose() drops the handlers', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    const c2 = controller(fake);
    const seen: string[] = [];
    c2.on('state', (e) => seen.push(e.state));
    c2.dispose();
    await c2.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    expect(seen).toEqual([]); // dispose() cleared the handler map
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/public/components/kicad/kicanvasController.test.ts`
Expected: FAIL — cannot resolve `./kicanvasController`.

- [ ] **Step 4: Write the implementation**

```ts
// frontend/src/public/components/kicad/kicanvasController.ts
// The KiCanvas implementation of CanvasController — the ONLY file that
// reaches into KiCanvas (spec §5.3). Everything is feature-detected: the app
// element's `project` and `viewer` are public fields upstream, but they are
// alpha internals with no versioning, so every reach returns a result rather
// than throwing.
import { basename } from '@public/services/kicad/project';
import type { KicadProject } from '@public/services/kicad/types';
import type {
  CanvasController,
  CanvasEvent,
  CanvasEventType,
  CanvasHandler,
  CanvasSource,
  CanvasView,
  FocusResult,
  ZoomAction,
} from './canvasController';

interface KicanvasPage {
  type: 'pcb' | 'schematic';
  filename: string;
  sheet_path: string;
  project_path: string;
  /** `ProjectPage.document` — `file_by_name(filename)` (vendor kicanvas/project.ts:393-395),
   *  so it is ONE object shared by every instance page of a file. */
  document?: unknown;
}

interface KicanvasProject {
  pages(): Iterable<KicanvasPage>;
  active_page: KicanvasPage | null;
  root_schematic_page: KicanvasPage | null;
  set_active_page(page: KicanvasPage | string): void;
}

interface KicanvasViewer {
  document?: { filename?: string } | null;
  selected?: unknown;
  select?: (ref: string) => void;
  zoom_to_selection?: () => void;
  /** Repaints the canvas after a camera change (vendor viewers/base/viewer.ts:165,
   *  overridden at viewers/base/document-viewer.ts:138). The Viewport has no draw. */
  draw?: () => void;
}

type KicanvasApp = HTMLElement & { project?: KicanvasProject; viewer?: KicanvasViewer };

export interface KicanvasControllerOptions {
  loadModule?: () => Promise<unknown>;
  createEmbed?: () => HTMLElement;
  /** 15 s: the first GPU mount of Glasgow took 4.3 s to the app element; the deadline pauses while the tab is hidden (spec §5.2). */
  readyMs?: number;
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock. The hidden-tab refund is arithmetic on elapsed time, and a
   *  test cannot demonstrate it against a wall clock without sleeping for real. */
  now?: () => number;
  visibility?: () => DocumentVisibilityState;
}

export const CANVAS_READY_MS = 15000;
const POLL_MS = 50;

/** `KiCanvasLoadEvent.type` (vendor viewers/base/events.ts:13-14). The viewer
 *  dispatches it from `resolve_loaded` for every document it finishes loading. */
const KICANVAS_LOAD = 'kicanvas:load';

/** Upstream's own interactive zoom limits, mirrored. `Viewer.setup()` is the only
 *  call site and passes them as literals — `this.viewport.enable_pan_and_zoom(0.5, 190)`
 *  (vendor viewers/base/viewer.ts:80), overriding PanAndZoom's 0.5/10 field defaults
 *  (base/dom/pan-and-zoom.ts:36-37) — and the clamp runs inside `#handle_zoom`
 *  (pan-and-zoom.ts:210-215). They sit on an ECMAScript-private field
 *  (`Viewport.#pan_and_zoom`), so nothing exports them to read at runtime; this
 *  citation is what keeps the literals honest. A zoom BUTTON must respect the same
 *  bounds as the wheel, or it walks the camera somewhere the wheel can never reach
 *  (24 steps in from 1.0 passes 190; the same out reaches ~0.005 — a board drawn as
 *  a dot until the next wheel event silently re-clamps it). */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 190;
const ZOOM_STEP = 1.25;

/** Why an activate did not end with this call owning the view. 'superseded' is
 *  a newer activate, which is NOT evidence about whether the page exists. */
type ActivateOutcome = 'ok' | 'superseded' | 'failed';

function sourceType(path: string): CanvasSource['type'] {
  const lower = path.toLowerCase();
  if (lower.endsWith('.kicad_pro')) return 'project';
  if (lower.endsWith('.kicad_pcb')) return 'board';
  return 'schematic';
}

/** KiCanvas resolves Sheetfile references by bare filename inside its virtual
 *  file system, so sources are named by basename; a second file with the same
 *  basename cannot be represented and is dropped (the reader still read it). */
export function sourcesFor(project: KicadProject): { sources: CanvasSource[]; dropped: string[] } {
  const ordered: string[] = [];
  for (const path of project.files.keys()) if (sourceType(path) === 'project') ordered.push(path);
  for (const sheet of project.sheets) ordered.push(sheet.path);
  for (const path of project.files.keys()) if (sourceType(path) === 'schematic' && !ordered.includes(path)) ordered.push(path);
  if (project.board != null) ordered.push(project.board);
  const seen = new Set<string>();
  const sources: CanvasSource[] = [];
  const dropped: string[] = [];
  for (const path of ordered) {
    const name = basename(path);
    if (seen.has(name)) {
      dropped.push(path);
      continue;
    }
    seen.add(name);
    sources.push({ name, type: sourceType(path), text: project.files.get(path) ?? '' });
  }
  return { sources, dropped };
}

/** `app.viewer` is a GETTER over a private field that upstream assigns only in
 *  render() (vendor kicanvas/src/kicanvas/elements/common/app.ts: field at :44,
 *  getter at :56, assignment at :200), so reading it before the first render
 *  throws a TypeError. Every reach into the renderer must return a result
 *  rather than throw — that is what the seam is for. */
function viewerOf(app: KicanvasApp | null): KicanvasViewer | null {
  try {
    return app?.viewer ?? null;
  } catch {
    return null;
  }
}

/** The identity upstream's own early return compares. `KCViewerElement.load` hands the
 *  viewer `src.document`, never the page (vendor kicanvas/elements/common/viewer.ts:77-79),
 *  and `DocumentViewer.load` returns at once when it already holds that object
 *  (viewers/base/document-viewer.ts:58-60) — BEFORE `resolve_loaded`, the sole dispatcher
 *  of `kicanvas:load` (viewers/base/viewer.ts:128-132). So when this is true, NO event is
 *  coming and waiting for one would burn the whole settle budget. */
function holdsDocument(viewer: KicanvasViewer | null, page: KicanvasPage): boolean {
  const held: unknown = viewer?.document;
  const wanted: unknown = page.document;
  return held != null && wanted != null && held === wanted;
}

/** A load listener armed BEFORE a page switch, so a renderer that loads
 *  synchronously cannot dispatch before anyone is listening. */
interface LoadWatch {
  fired: boolean;
  /** False when there is no listenable viewer to arm the watch on. `Viewer extends
   *  EventTarget` upstream (vendor viewers/base/viewer.ts:22), so this means the app has
   *  not rendered its viewer yet — no load signal can arrive, so settle() returns at once
   *  rather than spending the budget, and the watch is never recorded as in flight. */
  listening: boolean;
  cancel: () => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultVisibility = (): DocumentVisibilityState =>
  typeof document === 'undefined' ? 'visible' : document.visibilityState;

export class KicanvasController implements CanvasController {
  private readonly options: Required<KicanvasControllerOptions>;
  private embed: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private disposed = false;
  /** Bumped by every mount(). A superseded mount must not emit and must not run
   *  disposeEmbed() — its deadline would otherwise tear down the embed that
   *  replaced it. Remounting is the "Try again" gesture, so this is reachable. */
  private epoch = 0;
  /** Bumped by every activate(). The `hidden` writes happen after an await, so a slow
   *  earlier switch must not land on top of a newer one — that IS the "screen duplicates
   *  itself" class, arriving late. */
  private activation = 0;
  /** The load watch this controller armed for each view and has not yet seen fire.
   *  `holdsDocument()` turns true when a load BEGINS, not when it ends, so this is the
   *  only thing that can tell a finished load from one still running — see activate(). */
  private readonly inFlight = new Map<CanvasView, LoadWatch>();
  /** Path keys sourcesFor() could not hand to the embed (basename collision). */
  private droppedPaths = new Set<string>();
  private readonly handlers = new Map<CanvasEventType, Set<(e: CanvasEvent) => void>>();

  constructor(options: KicanvasControllerOptions = {}) {
    this.options = {
      loadModule: options.loadModule ?? (() => import('@vendor-build/kicanvas')),
      createEmbed: options.createEmbed ?? (() => document.createElement('kicanvas-embed')),
      readyMs: options.readyMs ?? CANVAS_READY_MS,
      settleMs: options.settleMs ?? 1500,
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? (() => Date.now()),
      visibility: options.visibility ?? defaultVisibility,
    };
  }

  on<T extends CanvasEventType>(type: T, handler: CanvasHandler<T>): () => void {
    const set = this.handlers.get(type) ?? new Set();
    const wrapped = handler as unknown as (e: CanvasEvent) => void;
    set.add(wrapped);
    this.handlers.set(type, set);
    return () => {
      set.delete(wrapped);
    };
  }

  private emit(event: CanvasEvent): void {
    for (const h of this.handlers.get(event.type) ?? []) h(event);
  }

  /** True once this mount has been superseded or disposed: it must go quiet. */
  private stale(epoch: number): boolean {
    return this.disposed || epoch !== this.epoch;
  }

  private apps(): { schematic: KicanvasApp | null; board: KicanvasApp | null } {
    const root = this.embed?.shadowRoot ?? null;
    return {
      schematic: (root?.querySelector('kc-schematic-app') as KicanvasApp | null) ?? null,
      board: (root?.querySelector('kc-board-app') as KicanvasApp | null) ?? null,
    };
  }

  private project(): KicanvasProject | null {
    const { schematic, board } = this.apps();
    return schematic?.project ?? board?.project ?? null;
  }

  /** The app showing the active page. Both `focusRef` and `zoom` must reach the
   *  same one, or they act on whatever the schematic viewer last held. */
  private activeApp(): KicanvasApp | null {
    const { schematic, board } = this.apps();
    return this.project()?.active_page?.type === 'pcb' ? board : schematic;
  }

  /** The basename collision, stated as the renderer's own limit. `sourcesFor` is
   *  the same function mount() builds the embed's sources with, so the answer
   *  cannot drift from what actually gets handed over. */
  unrenderableSheets(project: KicadProject): string[] {
    return sourcesFor(project).dropped;
  }

  async mount(host: HTMLElement, project: KicadProject): Promise<void> {
    const epoch = ++this.epoch;
    this.disposeEmbed();
    this.host = host;
    this.disposed = false;
    this.emit({ type: 'state', state: 'loading' });
    try {
      // No memo here on purpose. A dynamic import() of one specifier already
      // evaluates the module body exactly once and hands back the same namespace
      // (proven for concurrent calls too), so the bundle is fetched once anyway.
      // A module-level cache would instead PIN the first failure forever — one
      // failed chunk fetch and no later mount in the page could ever recover —
      // and would hand every later controller the first one's loader.
      await this.options.loadModule();
    } catch (err) {
      if (this.stale(epoch)) return;
      this.emit({ type: 'state', state: 'error', detail: err instanceof Error ? err.message : 'renderer failed to load' });
      return;
    }
    if (this.stale(epoch)) return;
    const { sources, dropped } = sourcesFor(project);
    this.droppedPaths = new Set(dropped);
    const embed = this.options.createEmbed();
    embed.setAttribute('controls', 'basic');
    embed.setAttribute('controlslist', 'nodownload nooverlay');
    embed.setAttribute('theme', 'kicad');
    for (const source of sources) {
      const el = document.createElement('kicanvas-source');
      el.setAttribute('name', source.name);
      el.setAttribute('type', source.type);
      el.textContent = source.text;
      embed.appendChild(el);
    }
    this.embed = embed;
    host.replaceChildren(embed);

    let deadline = this.options.now() + this.options.readyMs;
    while (this.options.now() < deadline) {
      if (this.stale(epoch)) return;
      if (this.project()?.active_page != null) {
        // The embed activates `root_schematic_page` as soon as it has loaded
        // (vendor kicanvas/elements/kicanvas-embed.ts:173) — and that field is
        // whatever page came FIRST, because project.ts:274 reassigns it
        // unconditionally, which on any board-bearing project is the BOARD
        // (PCB pages are inserted at file-load time, :133-144). Neither app's
        // `hidden` belongs to us until we set it, so the mount ENDS with an
        // activate (spec §5.3): one enforced view before anyone sees `ready`.
        await this.activate(project.sheets.length > 0 ? 'schematic' : 'board');
        if (this.stale(epoch)) return;
        this.emit({ type: 'state', state: 'ready' });
        return;
      }
      const t0 = this.options.now();
      await this.options.sleep(POLL_MS);
      // A hidden tab throttles chained timers to about a second, so refunding a
      // fixed POLL_MS gives back ~1/20th of what the wait actually spent and fires
      // a FALSE timeout on a mount that was fine. Refund the real elapsed time.
      if (this.options.visibility() === 'hidden') deadline += this.options.now() - t0;
    }
    if (this.stale(epoch)) return;
    this.disposeEmbed();
    this.emit({ type: 'state', state: 'timeout' });
  }

  private findPage(view: CanvasView, sheet?: string): KicanvasPage | null {
    const project = this.project();
    if (project == null) return null;
    const pages = [...project.pages()];
    if (view === 'board') return pages.find((p) => p.type === 'pcb') ?? null;
    if (sheet == null) {
      // `root_schematic_page` is NOT trustworthy as a schematic: upstream assigns
      // it the first page unconditionally (vendor kicanvas/project.ts:274 — the
      // guard below it only logs) and PCB pages are inserted before the schematic
      // hierarchy (:133-144), so on any board-bearing project — Glasgow revC3, the
      // canonical fixture — that field IS the board. Take it only when it is
      // really a schematic; otherwise the first page that is one.
      const root = project.root_schematic_page;
      if (root?.type === 'schematic') return root;
      return pages.find((p) => p.type === 'schematic') ?? null;
    }
    // A file the embed never received cannot be shown, and its basename twin is a
    // DIFFERENT file — the fallback below would happily show it and report success.
    if (this.droppedPaths.has(sheet)) return null;
    const wanted = sheet.toLowerCase();
    const byInstance = pages.find((p) => p.type === 'schematic' && p.sheet_path.toLowerCase() === wanted);
    if (byInstance) return byInstance;
    const name = basename(sheet).toLowerCase();
    return pages.find((p) => p.type === 'schematic' && basename(p.filename).toLowerCase() === name) ?? null;
  }

  private watchLoad(viewer: KicanvasViewer | null): LoadWatch {
    const target = viewer as unknown as EventTarget | null;
    if (
      target == null ||
      typeof target.addEventListener !== 'function' ||
      typeof target.removeEventListener !== 'function'
    ) {
      return { fired: false, listening: false, cancel: () => undefined };
    }
    const watch: LoadWatch = { fired: false, listening: true, cancel: () => undefined };
    const onLoad = () => {
      watch.fired = true;
    };
    // One-shot: the listener detaches AS it fires, so a superseded activate never has to
    // cancel a watch a LATER activate is still riding. cancel() is therefore only for a
    // watch that can no longer fire — the set_active_page throw, and teardown.
    target.addEventListener(KICANVAS_LOAD, onLoad, { once: true });
    watch.cancel = () => target.removeEventListener(KICANVAS_LOAD, onLoad);
    return watch;
  }

  /** Waits for one `kicanvas:load`, bounded. Reached both for a load THIS activate
   *  started and for one an earlier activate started that this one is riding (see
   *  activate). An unlistenable watch means there is no viewer at all yet: nothing is
   *  coming, and waiting would only burn the budget. (The basename comparison this
   *  replaced could never observe a same-file instance switch, and was unreachable for
   *  any real viewer.) */
  private async settle(watch: LoadWatch): Promise<void> {
    if (!watch.listening) return;
    const deadline = this.options.now() + this.options.settleMs;
    while (this.options.now() < deadline) {
      if (watch.fired) return;
      await this.options.sleep(POLL_MS);
    }
  }

  async activate(view: CanvasView, sheet?: string): Promise<boolean> {
    return (await this.activateFor(view, sheet)) === 'ok';
  }

  /**
   * activate() with its REASON kept.
   *
   * The public boolean collapses two unrelated facts into one `false`: there is
   * no such page, and a NEWER activate owns the view. focusRef has to tell them
   * apart — answering "this reference does not exist" because something else
   * moved the view is a lie about the reader's own schematic.
   */
  private async activateFor(view: CanvasView, sheet?: string): Promise<ActivateOutcome> {
    const seq = ++this.activation;
    const mountEpoch = this.epoch;
    const project = this.project();
    const page = this.findPage(view, sheet);
    if (project == null || page == null) return 'failed';
    const { schematic, board } = this.apps();
    const app = view === 'board' ? board : schematic;
    // A viewer that already holds this page's document is in one of TWO states, and they
    // need OPPOSITE treatment. Upstream assigns `this.document = src` when a load STARTS
    // (vendor viewers/base/document-viewer.ts:64) and only positions the camera, resolves
    // the load event and CLEARS THE SELECTION afterwards, in the later() tail (:68-86):
    //   - no load running — upstream's early return (:58-60) dispatches nothing, so
    //     waiting burns the whole settle budget on the COMMON gesture: a same-file
    //     instance switch, a return to an app already visited, a second focusRef on the
    //     sheet on screen, mount's closing activate on a single-type project;
    //   - a load we started still in flight — nothing is positioned and the deselect has
    //     not run, so resolving here hands focusRef a 'focused' the tail then undoes
    //     (a sheet-tab click immediately followed by a BOM-row focusRef is that shape).
    // The watch armed for this view is the only thing that tells them apart, so RIDE it
    // rather than discard it. A new one is armed BEFORE the switch, since set_active_page
    // dispatches "change" synchronously and the app loads from there.
    let watch: LoadWatch | null = null;
    let armed = false;
    if (holdsDocument(viewerOf(app), page)) {
      const running = this.inFlight.get(view);
      if (running != null && !running.fired) watch = running;
    } else {
      watch = this.watchLoad(viewerOf(app));
      armed = watch.listening;
      if (armed) this.inFlight.set(view, watch);
    }
    try {
      // The PAGE OBJECT, never the path string: upstream's set_active_page falls
      // back to first_page when a path does not resolve (vendor kicanvas/src/
      // kicanvas/project.ts:353-355), which would show the wrong sheet and still
      // look like success. findPage decides, so a miss is an honest false.
      project.set_active_page(page);
    } catch {
      // Only a watch THIS activate armed: a ridden one still belongs to the earlier
      // activate that is waiting on it. Drop it from inFlight too, or the next
      // activate for this view would ride a dead watch for a whole settle budget.
      if (armed) {
        watch?.cancel();
        if (this.inFlight.get(view) === watch) this.inFlight.delete(view);
      }
      return 'failed';
    }
    if (watch != null) {
      await this.settle(watch);
      // A watch that outlived its budget is no longer evidence of a load in flight —
      // leaving it registered would make the NEXT activate for this page ride it and
      // spend the budget over again. (The first switch into a HIDDEN app always times
      // out: its canvas is 0x0 and resolve_loaded waits on viewport.ready.) The listener
      // is one-shot, so nothing has to be cancelled to retire it.
      if (!watch.fired && this.inFlight.get(view) === watch) this.inFlight.delete(view);
    }
    // A newer activate, or a newer mount, owns the view now: this one is late and must
    // not write `hidden` at all. Upstream's app.load() assigns `hidden = false` AFTER an
    // await, so two quick page changes can leave both apps visible side by side (the
    // owner's "screen duplicates itself", reproduced 2026-09-12) — the writes below are
    // how we prevent that, and a stale one would re-create it.
    if (seq !== this.activation) return 'superseded';
    if (this.stale(mountEpoch)) return 'failed';
    if (schematic) schematic.hidden = view !== 'schematic';
    if (board) board.hidden = view !== 'board';
    return 'ok';
  }

  /**
   * Put `sheet` on screen FOR A FOCUS, tolerating a host activate that overtakes
   * this one.
   *
   * Being superseded is the ordinary shape of a designator click, not an error:
   * the page names the designator's own sheet in its own state so the chip bar
   * agrees with the drawing, and that state change makes the host re-activate on
   * the very commit this call is awaiting inside. So a superseded activate
   * RE-WAITS on the newer one — its settle rides the watch that activate armed —
   * and then asks the only question that matters: is the requested sheet the one
   * now live? If it is, the newer activate did this call's work for it. If it is
   * not, the host is asking for somewhere else and the reader's gesture takes
   * the view back.
   */
  private async activateForFocus(sheet: string): Promise<ActivateOutcome> {
    const outcome = await this.activateFor('schematic', sheet);
    // 'ok' is done. 'failed' is a real miss (no such page, a dropped basename
    // twin) or a dead mount: waiting longer cannot conjure a page, and retrying
    // a set_active_page that threw only throws again.
    if (outcome !== 'superseded') return outcome;

    // A newer activation owns the view, and WHICH DOCUMENT it landed on says who
    // issued it.
    //
    // The SAME document is the host echoing this very focus: the page names the
    // designator's own sheet in its state before calling focusRef, so
    // DesignCanvas re-activates that same file. The waiting is already done —
    // `activateFor` above rode that activation's own load watch, and upstream
    // starts no second load for a document the viewer already holds — so the
    // page is on screen and settled, and this focus may select on it.
    //
    // A DIFFERENT document can only be the reader choosing another sheet while
    // this focus was still loading. That is a newer, deliberate gesture and it
    // wins. Taking the view back — which this used to do — would snap the
    // drawing off the sheet they just picked and leave the chip bar naming a
    // sheet that is not on screen, with nothing to converge it.
    return this.showing(sheet) ? 'ok' : 'superseded';
  }

  /** Is the page `sheet` names the one on screen? Compared by DOCUMENT, because
   *  that is what the viewer holds and what decides what is drawn — two instance
   *  pages of one file share it (upstream's `file_by_name`), so an instance
   *  switch within a file is not a different drawing. */
  private showing(sheet: string): boolean {
    const wanted = this.findPage('schematic', sheet);
    const active = this.project()?.active_page ?? null;
    return wanted != null && active != null && active.document === wanted.document;
  }

  async focusRef(ref: string, sheet?: string): Promise<FocusResult> {
    if (sheet != null) {
      const activated = await this.activateForFocus(sheet);
      // Stood down for a newer sheet choice — not a statement about `ref`.
      if (activated === 'superseded') return 'superseded';
      if (activated === 'failed') return 'not-found';
    }
    // The app showing the ACTIVE page, exactly as zoom() picks it: BoardViewer.select()
    // also takes a string and resolves a footprint by uuid or reference (vendor
    // viewers/board/viewer.ts:94-106), so with the board active the honest answer is
    // reachable — hard-coding the schematic app answered 'unsupported' forever.
    const viewer = viewerOf(this.activeApp());
    if (viewer?.document == null || typeof viewer.select !== 'function' || typeof viewer.zoom_to_selection !== 'function') {
      return 'unsupported';
    }
    try {
      // SchematicViewer.select takes a string and resolves it to a symbol or sheet
      // (vendor viewers/schematic/viewer.ts:62-77); an unresolved ref lands on
      // DocumentViewer.select as undefined, which sets `selected` to null rather
      // than throwing (viewers/base/document-viewer.ts:148-157).
      viewer.select(ref);
    } catch {
      return 'unsupported';
    }
    if (!viewer.selected) return 'not-found';
    try {
      viewer.zoom_to_selection();
    } catch {
      return 'unsupported';
    }
    this.emit({ type: 'selection', ref });
    return 'focused';
  }

  /** The camera API, read out of the vendored source: `zoom_to_page()` is abstract on
   *  Viewer (viewers/base/viewer.ts:244) and implemented on DocumentViewer
   *  (viewers/base/document-viewer.ts:133) — it repaints itself. The steps move
   *  `viewer.viewport.camera.zoom`, a plain number (base/math/camera2.ts:32, reached
   *  through viewers/base/viewport.ts:23), and then repaint with the VIEWER's draw():
   *  Viewport exposes no draw at all, and viewer.draw() (viewers/base/viewer.ts:165,
   *  overridden public at document-viewer.ts:138) is what upstream's own
   *  zoom_to_page and zoom_to_selection call. Every path feature-detects and
   *  returns false. */
  async zoom(action: ZoomAction): Promise<boolean> {
    const viewer = viewerOf(this.activeApp()) as (KicanvasViewer & { zoom_to_page?: () => void; viewport?: { camera?: { zoom: number } } }) | null;
    if (viewer?.document == null) return false;
    try {
      if (action === 'fit') {
        if (typeof viewer.zoom_to_page !== 'function') return false;
        viewer.zoom_to_page();
        return true;
      }
      const camera = viewer.viewport?.camera;
      if (camera == null || typeof camera.zoom !== 'number') return false;
      const next = action === 'in' ? camera.zoom * ZOOM_STEP : camera.zoom / ZOOM_STEP;
      camera.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
      viewer.draw?.();
      return true;
    } catch {
      return false;
    }
  }

  private disposeEmbed(): void {
    // These listen on THIS embed's viewers. A new embed's viewers cannot fire them, and a
    // stale unfired one would make the next same-document activate ride a watch that can
    // never fire and wait out its whole settle budget. dispose() reaches this too. A watch
    // already retired from the map (it outlived its budget) is not cancelled here: its
    // one-shot listener fires at most once on the old viewer and touches nothing else.
    for (const watch of this.inFlight.values()) watch.cancel();
    this.inFlight.clear();
    if (this.embed != null) {
      // Release the renderer's GL contexts before dropping the element: browsers cap
      // live contexts and a visitor opening several projects in one tab would otherwise
      // accumulate them (the spike's repeated loads degraded visibly).
      const canvases: HTMLCanvasElement[] = [];
      const walk = (root: ParentNode) => {
        for (const el of root.querySelectorAll('*')) {
          if (el instanceof HTMLCanvasElement) canvases.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      if (this.embed.shadowRoot) walk(this.embed.shadowRoot);
      for (const canvas of canvases) {
        try {
          const gl = canvas.getContext('webgl2') as { getExtension?: (n: string) => { loseContext: () => void } | null } | null;
          gl?.getExtension?.('WEBGL_lose_context')?.loseContext();
        } catch {
          // a canvas with a 2d context, or none — nothing to release
        }
      }
      if (this.host != null && this.embed.parentNode === this.host) this.host.removeChild(this.embed);
    }
    this.embed = null;
  }

  dispose(): void {
    this.disposed = true;
    this.disposeEmbed();
    this.host = null;
    this.droppedPaths.clear();
    // Handler closures reach the page that mounted us; a disposed controller must
    // not keep them alive, and must not call them if a stray turn still lands.
    this.handlers.clear();
  }
}
```

- [ ] **Step 5: Run the tests and gates**

Run: `cd frontend && npx vitest run src/public/components/kicad && npx tsc -b && npx eslint --ext .ts,.tsx src/`
Expected: all passed; gates clean. (If `import('@vendor-build/kicanvas')` fails type-check, confirm `vendorBuild.d.ts` from Task 0.3 is under `src/` so `tsc -b` sees it.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/public/components/kicad/canvasController.ts frontend/src/public/components/kicad/kicanvasController.ts frontend/src/public/components/kicad/kicanvasController.test.ts
git commit -m "feat(viewer): CanvasController protocol and the KiCanvas implementation — one embed, public project API for sheets and board, feature-detected focus"
```

---

### Task 2.2: `DesignCanvas` — the React host with the WebGL2 memo, the ready timeout, and the error states (spec §5.2)

**Files:**
- Create: `frontend/src/public/components/kicad/DesignCanvas.tsx`, `frontend/src/public/components/kicad/DesignCanvas.module.scss`, `frontend/src/public/components/kicad/webgl.ts`
- Test: `frontend/src/public/components/kicad/webgl.test.ts`, `frontend/src/public/components/kicad/DesignCanvas.test.ts` (both happy-dom; the component test drives a fake controller through the `createController` prop with React.createElement + react-dom/client + act — vitest discovers `*.test.ts` only and there is no testing-library)

**Interfaces:**
- Consumes: `CanvasController`, `CanvasView`, `CanvasStateName`, `FocusResult` (2.1); `KicanvasController` (2.1); `KicadProject` (1.2).
- Produces: `<DesignCanvas project view activeSheet? onState? ref>` with `DesignCanvasHandle { focusRef(ref, sheet?) }`; `webgl2Supported(create?)`, `resetWebgl2ProbeForTests()`.

- [ ] **Step 1: Write the failing probe test**

```ts
// @vitest-environment happy-dom
// frontend/src/public/components/kicad/webgl.test.ts
import { describe, expect, it } from 'vitest';
import { resetWebgl2ProbeForTests, webgl2Supported } from './webgl';

function fakeCanvas(gl: { getExtension: (n: string) => { loseContext: () => void } | null } | null) {
  return { getContext: () => gl } as unknown as HTMLCanvasElement;
}

describe('webgl2Supported', () => {
  it('probes once per document and releases the context it created', () => {
    resetWebgl2ProbeForTests();
    let lost = 0;
    let probes = 0;
    const create = () => {
      probes++;
      return fakeCanvas({ getExtension: () => ({ loseContext: () => lost++ }) });
    };
    expect(webgl2Supported(create)).toBe(true);
    expect(webgl2Supported(create)).toBe(true);
    expect(probes).toBe(1);
    expect(lost).toBe(1);
  });
  it('reports false when the browser refuses a context', () => {
    resetWebgl2ProbeForTests();
    expect(webgl2Supported(() => fakeCanvas(null))).toBe(false);
  });
});
```

Run: `cd frontend && npx vitest run src/public/components/kicad/webgl.test.ts` → FAIL (cannot resolve `./webgl`).

- [ ] **Step 2: Write the probe, the host, and its styles**

```ts
// frontend/src/public/components/kicad/webgl.ts
// One WebGL2 probe per document, released immediately: browsers cap live
// contexts (~16) and force-lose the oldest, which would blank a working
// schematic and read as a KiCanvas bug (spec §5.2, §9).
let probed: boolean | null = null;

/** Only the sliver of the context we touch: enough to release it again. */
type ProbeContext = { getExtension?: (name: string) => { loseContext: () => void } | null } | null;

export function webgl2Supported(create: () => HTMLCanvasElement = () => document.createElement('canvas')): boolean {
  if (probed != null) return probed;
  // `getContext` is specced to return null, but fingerprint-blocking browsers and
  // extensions have been seen to THROW. This runs in a render body, so an escaping
  // throw would take down the ErrorBoundary instead of showing the no-webgl card the
  // probe exists for — and with `probed` still null it would throw again every render.
  try {
    const gl = create().getContext('webgl2') as ProbeContext;
    probed = gl != null;
    // Releasing the probe context is the other call that has been seen to throw;
    // a throw here must not undo a true verdict.
    if (gl?.getExtension) gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    probed = probed ?? false;
  }
  return probed;
}

export function resetWebgl2ProbeForTests(): void {
  probed = null;
}
```

```tsx
// frontend/src/public/components/kicad/DesignCanvas.tsx
// The React host over a CanvasController (spec §5.2). Owns the container, the
// WebGL2 probe, the ready timeout's user-facing states and the "Try again".
// Never touches the embed: everything goes through the controller.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { KicadProject } from '@public/services/kicad/types';
import type { CanvasController, CanvasStateName, CanvasView, FocusResult, ZoomAction } from './canvasController';
import { KicanvasController } from './kicanvasController';
import { webgl2Supported } from './webgl';
import styles from './DesignCanvas.module.scss';

export interface DesignCanvasProps {
  /**
   * The project to render. **Referentially stable:** the host keys its mount on object
   * identity, so a new identity disposes the renderer and reloads the whole project.
   * Callers pass the SAME object across renders (the design session holds one) — never
   * a `buildProject(...)` call in a render body or a `useMemo` with an unstable dep.
   */
  project: KicadProject;
  view: CanvasView;
  /** Path key of the schematic to show, or an instance path; default root. */
  activeSheet?: string;
  onState?: (state: CanvasStateName, detail?: string) => void;
  /**
   * The sheets the mounted renderer cannot draw for this project, reported once
   * per mount and BEFORE the renderer bundle is even fetched — so a host can
   * mark them on the first paint instead of a frame later.
   *
   * Always called, with `[]` when the renderer answers none or when there is no
   * renderer at all (no WebGL2): a host must never be left holding a set from a
   * previous project, and "this renderer drops nothing" is an answer, not a
   * silence.
   */
  onUnrenderableSheets?: (paths: string[]) => void;
  /**
   * How much room the frame takes. `default` fills the parent (the viewer hands
   * it the viewport below the tabs); `compact` is a fixed slice of the viewport,
   * for a host where the drawing is context beside its real subject — the BOM
   * page's panel above the priced table.
   */
  height?: 'default' | 'compact';
  /** Test seam. Defaults to a KicanvasController. */
  createController?: () => CanvasController;
}

export interface DesignCanvasHandle {
  focusRef(ref: string, sheet?: string): Promise<FocusResult>;
  zoom(action: ZoomAction): Promise<boolean>;
}

const COPY: Record<Exclude<CanvasStateName, 'loading' | 'ready'>, { title: string; body: string }> = {
  'no-webgl': {
    title: 'This browser has WebGL disabled',
    body: 'The drawing needs WebGL 2 to render. Enable hardware acceleration or try another browser — the BOM and stackup tabs work without it.',
  },
  timeout: {
    title: "Couldn't render this file in time",
    body: 'The renderer did not finish. It reads KiCad 6 and newer files; very large boards can take longer on this device.',
  },
  error: {
    title: "Couldn't render this file",
    body: 'The renderer failed while reading it. It reads KiCad 6 and newer files.',
  },
};

const DesignCanvas = forwardRef<DesignCanvasHandle, DesignCanvasProps>(function DesignCanvas(
  { project, view, activeSheet, onState, onUnrenderableSheets, height = 'default', createController },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<CanvasController | null>(null);
  const [state, setState] = useState<CanvasStateName>('loading');
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const supported = webgl2Supported();
  // `onState` is NOT an effect dep on purpose: a parent passing an inline arrow would
  // remount the canvas — and reload the project — on every one of its renders. The ref
  // is what keeps the callback current without paying that.
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  // Same reason as `onState` above: a parent passing an inline arrow must not
  // remount the canvas — and this one reloads the project.
  const onUnrenderableRef = useRef(onUnrenderableSheets);
  onUnrenderableRef.current = onUnrenderableSheets;

  useEffect(() => {
    if (!supported) {
      setState('no-webgl');
      onStateRef.current?.('no-webgl');
      // No renderer means nothing is unrenderable for renderer-specific
      // reasons. Reporting [] rather than nothing keeps the host from carrying
      // a previous project's answer into this one.
      onUnrenderableRef.current?.([]);
      return;
    }
    const host = hostRef.current;
    if (host == null) return;
    let cancelled = false;
    const controller = (createController ?? (() => new KicanvasController()))();
    controllerRef.current = controller;
    // BEFORE mount(): that is where the renderer bundle is dynamically imported
    // and awaited, so answering here costs the host nothing and lands on the
    // same commit that first paints the sheet chips.
    onUnrenderableRef.current?.(controller.unrenderableSheets?.(project) ?? []);
    const off = controller.on('state', (e) => {
      if (cancelled) return;
      setState(e.state);
      setDetail(e.detail);
      onStateRef.current?.(e.state, e.detail);
    });
    void controller.mount(host, project);
    return () => {
      cancelled = true;
      off();
      controller.dispose();
      controllerRef.current = null;
    };
    // `attempt` re-mounts on "Try again"; onState/createController are stable by
    // convention. The react-hooks plugin isn't installed here, so no disable comment
    // (an unknown rule in a directive is itself an eslint error).
  }, [project, attempt, supported]);

  useEffect(() => {
    if (state !== 'ready') return;
    void controllerRef.current?.activate(view, activeSheet);
  }, [state, view, activeSheet]);

  // Both members read `controllerRef.current` at CALL time, so the handle never goes
  // stale and `[]` keeps its identity fixed — a parent may hold it in a dep array.
  useImperativeHandle(ref, () => ({
    focusRef: (r, sheet) => controllerRef.current?.focusRef(r, sheet) ?? Promise.resolve('unsupported' as const),
    zoom: (action) => controllerRef.current?.zoom(action) ?? Promise.resolve(false),
  }), []);

  const frameRef = useRef<HTMLDivElement>(null);
  // The mount effect's `cancelled` is per ATTEMPT; this is per COMPONENT, which is the
  // lifetime `zoom` below needs — it is not owned by that effect and awaits across it.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const [zoomable, setZoomable] = useState(true);
  const zoom = async (action: ZoomAction) => {
    const ok = await controllerRef.current?.zoom(action);
    if (ok === false && aliveRef.current) setZoomable(false);
  };
  const fullscreenEnabled = typeof document !== 'undefined' && document.fullscreenEnabled;
  const toggleFullscreen = () => {
    const el = frameRef.current;
    if (el == null) return;
    // Both reject on reachable paths — a permissions-policy denial, an iframe without
    // allow="fullscreen", a request the browser does not count as user-activated. `void`
    // discards the VALUE, not the rejection, so without this a plain button click raises
    // an unhandledrejection.
    if (document.fullscreenElement === el) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen().catch(() => undefined);
  };

  const failed = state === 'no-webgl' || state === 'timeout' || state === 'error';
  return (
    <div
      ref={frameRef}
      className={height === 'compact' ? `${styles.frame} ${styles.frameCompact}` : styles.frame}
    >
      <div ref={hostRef} className={styles.host} hidden={failed} />
      {state === 'ready' && (
        <div className={styles.controls} role="group" aria-label="View controls">
          {zoomable && (
            <>
              <button type="button" className={styles.ctl} onClick={() => void zoom('fit')} aria-label="Fit to page">Fit</button>
              <button type="button" className={styles.ctl} onClick={() => void zoom('in')} aria-label="Zoom in">&#43;</button>
              <button type="button" className={styles.ctl} onClick={() => void zoom('out')} aria-label="Zoom out">&#8722;</button>
            </>
          )}
          {fullscreenEnabled && (
            <button type="button" className={styles.ctl} onClick={toggleFullscreen} aria-label="Fullscreen">&#x26F6;</button>
          )}
        </div>
      )}
      {state === 'loading' && (
        <p className={styles.status} role="status">
          Rendering&#8230;
        </p>
      )}
      {failed && (
        <div className={styles.problem} role="alert">
          <p className={styles.problemTitle}>{COPY[state].title}</p>
          <p className={styles.problemBody}>
            {COPY[state].body}
            {detail != null && state === 'error' ? ` (${detail})` : ''}
          </p>
          {state !== 'no-webgl' && (
            <button type="button" className={styles.retry} onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
});

export default DesignCanvas;
```

```scss
// frontend/src/public/components/kicad/DesignCanvas.module.scss
@use '@shared/styles/variables' as *;
@use '@shared/styles/mixins' as *;
@use '@public/styles/bomMaterial' as *;

// The frame is a bom-card with an inset hairline so the renderer's grey
// does not float on the page (spec §13). It FILLS whatever its parent gives it
// (the viewer page's flex column hands it the viewport below the tabs; the BOM
// page's panel hands it 45vh), never under 320px; KiCanvas's own size observer
// follows the box. Owner, Phase 0 gate: the window must fill the area on both
// desktop and mobile.
.frame {
  @include bom-card;
  position: relative;
  flex: 1 1 auto;
  min-height: 320px;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
  overflow: hidden;
  // The browser must never compete with the renderer for a two-finger gesture
  // (CLAUDE.md: pan-y cancels pointermove; none is full tracking).
  touch-action: none;
  overscroll-behavior: contain;

  &:fullscreen {
    border-radius: 0;
  }
}

// `height="compact"`: the drawing is context, not the subject — the BOM page
// puts it above a priced table the reader came for, so it takes a fixed slice
// of the viewport instead of whatever its parent has left. `.frame`'s 320px
// floor still applies on a short window, and fullscreen overrides both.
.frameCompact {
  flex: 0 0 auto;
  height: 45vh;

  &:fullscreen {
    height: 100%;
  }
}

// Fit / + / − / fullscreen over the drawing: essential on coarse pointers
// (KiCanvas's pinch-zoom barely works on a phone — owner, Phase 0 gate), kept on
// desktop too. Glass controls float over content, which is what the recipe is for.
// The 6px gap is what caps the hit-area growth below: the ::before overlays of two
// neighbours are positioned siblings, so anything past half the gap puts the later
// button's overlay on top of the earlier one's VISIBLE face and steals its clicks.
.controls {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: flex;
  gap: 6px;
  z-index: 2;
}

.ctl {
  @include bom-glass-control;
  // `bom-glass-control` sets no `position`, so the mixin's absolute ::before would
  // anchor to `.frame` without this.
  position: relative;
  @include tap-target(-3px);
  min-width: 40px;
  min-height: 40px;
  padding: 0 12px;
  line-height: 1;
  font-size: 0.95rem;
  cursor: pointer;
}

.host {
  position: absolute;
  inset: 0;

  :global(kicanvas-embed) {
    width: 100%;
    height: 100%;
    aspect-ratio: auto;
    max-height: none;
  }
}

.status {
  position: absolute;
  inset: 0;
  margin: 0;
  display: grid;
  place-items: center;
  color: $text-secondary;
  font-size: 0.9rem;
  pointer-events: none;
}

.problem {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
}

.problemTitle {
  margin: 0;
  font-weight: 600;
  color: $text-primary;
}

.problemBody {
  margin: 0;
  max-width: 44ch;
  color: $text-secondary;
  font-size: 0.9rem;
}

// ~31px tall as drawn (13.3px UA button text — `global.scss` gives buttons a
// font-family but no size — plus 16px padding and 2px border), so it needs 7px to
// clear 44. It has no neighbour, and 7px stays inside `.problem`'s 8px gap.
.retry {
  @include bom-glass-control;
  position: relative;
  @include tap-target(-7px);
  justify-self: center;
  padding: 8px 16px;
  line-height: 1;
  cursor: pointer;
}
```

If `bom-glass-control` or `bom-card` need arguments in `_bomMaterial.scss`, mirror how `BomPage.module.scss` calls them.

The component test (review ruling, Task 2.2 fix round 1 — no-webgl builds no controller; retry disposes and rebuilds; unmount mid-mount disposes without a state update; the stale-closure and throwing-probe cases):

```ts
// @vitest-environment happy-dom
// Covers the paths the /viewer playtest cannot reach cheaply: the no-webgl short
// circuit, the retry teardown, and unmount while mount() is still pending. No JSX
// (vitest only discovers *.test.ts here) and no testing-library — createRoot + act.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasController, CanvasStateName } from './canvasController';
import type { KicadProject } from '@public/services/kicad/types';
import DesignCanvas from './DesignCanvas';
import { resetWebgl2ProbeForTests } from './webgl';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = { name: 'demo', files: new Map(), sheets: [] } as unknown as KicadProject;

/** Force the probe's answer: happy-dom's canvas has no real webgl2 context. */
function setWebgl(ok: boolean) {
  resetWebgl2ProbeForTests();
  HTMLCanvasElement.prototype.getContext = (() => (ok ? { getExtension: () => null } : null)) as never;
}

function fakeController() {
  let handler: ((e: { type: 'state'; state: CanvasStateName }) => void) | null = null;
  const f = {
    disposed: 0,
    emit: (state: CanvasStateName) => handler?.({ type: 'state', state }),
    // Never resolves: every case here unmounts or retries while mount() is in flight.
    ctrl: {
      mount: () => new Promise<void>(() => {}),
      activate: async () => true,
      focusRef: async () => 'focused' as const,
      zoom: async () => true,
      dispose: () => {
        f.disposed++;
      },
      on: (kind: string, h: unknown) => {
        if (kind === 'state') handler = h as typeof handler;
        return () => {
          handler = null;
        };
      },
    } as unknown as CanvasController,
  };
  return f;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.restoreAllMocks();
  container.remove();
});

describe('DesignCanvas', () => {
  it('shows the no-webgl card and never builds a controller', async () => {
    setWebgl(false);
    let built = 0;
    const seen: CanvasStateName[] = [];
    await act(async () => {
      root.render(
        createElement(DesignCanvas, {
          project,
          view: 'schematic',
          onState: (s: CanvasStateName) => seen.push(s),
          createController: () => {
            built++;
            return fakeController().ctrl;
          },
        }),
      );
    });
    expect(container.textContent).toContain('WebGL disabled');
    expect(built).toBe(0);
    expect(seen).toEqual(['no-webgl']);
    await act(async () => root.unmount());
  });

  it('disposes the controller and builds a fresh one when retry is clicked', async () => {
    setWebgl(true);
    const made: ReturnType<typeof fakeController>[] = [];
    await act(async () => {
      root.render(
        createElement(DesignCanvas, {
          project,
          view: 'schematic',
          createController: () => {
            const f = fakeController();
            made.push(f);
            return f.ctrl;
          },
        }),
      );
    });
    expect(made).toHaveLength(1);
    await act(async () => made[0].emit('timeout'));
    // Only the retry renders in this state — the zoom cluster is ready-only.
    const retry = container.querySelector('button');
    expect(retry?.textContent).toBe('Try again');
    await act(async () => retry?.click());
    expect(made[0].disposed).toBe(1);
    expect(made).toHaveLength(2);
    await act(async () => root.unmount());
  });

  it('calls the CURRENT onState, not the one captured when it mounted', async () => {
    setWebgl(true);
    const f = fakeController();
    const first: CanvasStateName[] = [];
    const second: CanvasStateName[] = [];
    const render = (onState: (s: CanvasStateName) => void) =>
      root.render(createElement(DesignCanvas, { project, view: 'schematic', onState, createController: () => f.ctrl }));
    await act(async () => render((s) => first.push(s)));
    // Same `project` identity, so this re-renders WITHOUT remounting the controller.
    await act(async () => render((s) => second.push(s)));
    await act(async () => f.emit('ready'));
    expect(second).toEqual(['ready']);
    expect(first).toEqual([]);
    await act(async () => root.unmount());
  });

  it('renders the no-webgl card when the browser THROWS from getContext', async () => {
    resetWebgl2ProbeForTests();
    HTMLCanvasElement.prototype.getContext = (() => {
      throw new Error('blocked by a fingerprint guard');
    }) as never;
    await act(async () => {
      root.render(createElement(DesignCanvas, { project, view: 'schematic' }));
    });
    expect(container.textContent).toContain('WebGL disabled');
    await act(async () => root.unmount());
  });

  it('disposes on unmount while mount() is pending, with no late state update', async () => {
    setWebgl(true);
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a);
    });
    const f = fakeController();
    await act(async () => {
      root.render(createElement(DesignCanvas, { project, view: 'schematic', createController: () => f.ctrl }));
    });
    await act(async () => root.unmount());
    expect(f.disposed).toBe(1);
    // The controller detached its handler, so a late event reaches no setState.
    await act(async () => f.emit('ready'));
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests and gates**

Run: `cd frontend && npx vitest run src/public/components/kicad && npx tsc -b && npx eslint --ext .ts,.tsx src/`
Expected: all passed; gates clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/public/components/kicad/webgl.ts frontend/src/public/components/kicad/webgl.test.ts frontend/src/public/components/kicad/DesignCanvas.tsx frontend/src/public/components/kicad/DesignCanvas.module.scss
git commit -m "feat(viewer): DesignCanvas host — one WebGL2 probe per document, ready timeout with teardown and retry, controller-only access"
```

---

### Task 2.3: The design session (spec §3, §7.1)

**Files:**
- Create: `frontend/src/public/services/designSession.ts`
- Test: `frontend/src/public/services/designSession.test.ts`

**Interfaces:**
- Consumes: `readSchematic`, `RefLocation` (1.6); `KicadProject` (1.2); `ParseResult` (1.1).
- Produces: `interface DesignSession { project; parsed; refs }`, `openDesign(project): DesignSession` (reads the BOM once and stores it), `getDesignSession()`, `clearDesignSession()`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/public/services/designSession.test.ts
import { describe, expect, it } from 'vitest';
import { ROOT_UUID, schematic, symbol } from '@public/services/kicad/fixtures';
import { buildProject } from '@public/services/kicad/project';
import { clearDesignSession, getDesignSession, openDesign } from './designSession';

describe('designSession', () => {
  it('holds one project with its BOM read once, and clears both', async () => {
    const project = await buildProject([new File([schematic({ uuid: ROOT_UUID, body: symbol({ lib: 'Device:R', uuid: 'x', ref: 'R1', value: '1k' }) })], 'main.kicad_sch')]);
    expect(getDesignSession()).toBeNull();
    const s = openDesign(project);
    expect(getDesignSession()).toBe(s);
    // The ONE stable project object: DesignCanvas keys its KiCanvas mount on this
    // reference, so a clone here would reload the viewer on every /viewer <-> /bom trip.
    expect(s.project).toBe(project);
    expect(s.parsed.lines).toHaveLength(1);
    expect(s.refs.get('R1')?.sheet).toBe('main.kicad_sch');
    clearDesignSession();
    expect(getDesignSession()).toBeNull();
  });
});
```

- [ ] **Step 2: Write the module**

```ts
// frontend/src/public/services/designSession.ts
// Module-memory holder for the current design (the category-memo pattern):
// /viewer and /bom share one project and ONE parse of its BOM, so a round trip
// between the pages costs one /api/bom/match, not three (spec §7.1). Dies on
// reload — anonymous visitors are browser-only by ruling (D3).
import { readSchematic, type RefLocation } from '@public/services/kicad/schematicBom';
import type { KicadProject } from '@public/services/kicad/types';
import type { ParseResult } from '@public/services/bom/parseBom';

export interface DesignSession {
  project: KicadProject;
  parsed: ParseResult;
  refs: Map<string, RefLocation>;
}

let current: DesignSession | null = null;

export function openDesign(project: KicadProject): DesignSession {
  const read = readSchematic(project);
  current = { project, parsed: read.result, refs: read.refs };
  return current;
}

export function getDesignSession(): DesignSession | null {
  return current;
}

export function clearDesignSession(): void {
  current = null;
}
```

- [ ] **Step 3: Run and commit**

Run: `cd frontend && npx vitest run src/public/services/designSession.test.ts && npx tsc -b` → 1 passed.

```bash
git add frontend/src/public/services/designSession.ts frontend/src/public/services/designSession.test.ts
git commit -m "feat(viewer): design session — one project, one BOM parse, shared by /viewer and /bom"
```

---

### Task 2.4: The viewer intake, the Glasgow sample, the notice, and the icon font-face (spec §7.1, §5.1)

**Files:**
- Create: `frontend/src/public/pages/viewer/components/ViewerIntake.tsx`, `frontend/src/public/pages/viewer/ViewerPage.module.scss`, `frontend/src/public/styles/_dropFrame.scss` (the shared `drop-frame-intake` mixin — ruling below), `frontend/public/samples/glasgow-revC3.zip`, `frontend/public/vendor/kicanvas/NOTICE.txt`
- Modify: `frontend/src/shared/styles/global.scss` (one `@font-face`), `frontend/src/public/pages/bom/BomPage.module.scss` (the moved drop-frame blocks become `@include drop-frame-intake;`)

**Interfaces:**
- Consumes: `buildProject` (1.5), `KicadReadError` (1.2), `KicadProject`.
- Produces: `<ViewerIntake onProject>` (busy is internal state); `/samples/glasgow-revC3.zip`; `/vendor/kicanvas/NOTICE.txt`; the `"Material Symbols Outlined"` face.

- [ ] **Step 1: Build the sample zip and the notice**

```bash
cd /home/matthew/circuits-com/frontend
mkdir -p public/samples public/vendor/kicanvas
( cd src/public/services/kicad/fixtures/glasgow-revC3 && python3 -m zipfile -c ../../../../../../public/samples/glasgow-revC3.zip glasgow.kicad_pro glasgow.kicad_sch io_banks.kicad_sch io_buffer.kicad_sch glasgow.kicad_pcb LICENSE )
python3 -m zipfile -l public/samples/glasgow-revC3.zip   # six entries, no directory prefix
{
  echo "Circuit Center — third-party notices for the Design Viewer"; echo; echo "This programme is licensed under the GNU General Public License v3.0 or later (see /LICENSE in the source repository)."; echo;
  echo "=== KiCanvas — https://github.com/theacodes/kicanvas @ b031159eb74aaa7eef2b026fd85d35bc05ff2095 (vendored as source with two local patches; see frontend/vendor/kicanvas/patches) ==="; echo; cat vendor/kicanvas/LICENSE.md; echo;
  echo "=== earcut (polygon triangulation, bundled inside the KiCanvas build from frontend/vendor/kicanvas/third_party/earcut) — https://github.com/mapbox/earcut — ISC License ==="; echo; cat vendor/kicanvas/third_party/earcut/LICENSE; echo;
  echo "=== Material Symbols Outlined (16-glyph subset) — https://github.com/google/material-design-icons — Apache License 2.0 ==="; echo; cat public/fonts/kicanvas/LICENSE-Apache-2.0.txt; echo;
  echo "=== Example project: Glasgow Interface Explorer revC3 — https://github.com/GlasgowEmbedded/glasgow @ 49e29452a3372fcc5aea790c080c0be554d15800 — 0BSD ==="; echo; cat src/public/services/kicad/fixtures/glasgow-revC3/LICENSE; echo;
} > public/vendor/kicanvas/NOTICE.txt
```

- [ ] **Step 2: Declare the icon face once, globally**

In `frontend/src/shared/styles/global.scss`, near the Phosphor `@font-face` (or at the top if there is none — the Phosphor face lives in `index.html`; either home is fine, `global.scss` is the one that ships with every page):

```scss
// The 16-glyph Material Symbols subset the vendored KiCanvas UI expects
// (frontend/vendor/kicanvas/patches/0002-icon-codepoints.patch). Served from
// /fonts/ like Phosphor; a regenerated subset gets a new -vN filename because
// /fonts/* is cached immutable for a year.
@font-face {
  font-family: 'Material Symbols Outlined';
  src: url('/fonts/kicanvas/material-symbols-subset-v1.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: block;
}
```

- [ ] **Step 3: Write the intake and the page styles**

```tsx
// frontend/src/public/pages/viewer/components/ViewerIntake.tsx
// The viewer's drop zone: a zip, a .kicad_pro, .kicad_sch files and a
// .kicad_pcb, several at once (a folder where the browser supports it). The
// example loads Glasgow revC3 (0BSD) through the SAME buildProject a drop uses.
import { useCallback, useState } from 'react';
import { useDropzone, type Accept, type FileRejection } from 'react-dropzone';
import { buildProject } from '@public/services/kicad/project';
import { KicadReadError, type KicadProject } from '@public/services/kicad/types';
import styles from '../ViewerPage.module.scss';

const ACCEPT: Accept = {
  'application/zip': ['.zip'],
  'application/octet-stream': ['.kicad_pro', '.kicad_sch', '.kicad_pcb', '.sch', '.pro'],
};

export const EXAMPLE_URL = '/samples/glasgow-revC3.zip';
export const EXAMPLE_CREDIT = 'Example: Glasgow Interface Explorer revC3, 0BSD';

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function rejectionCopy(name: string): string {
  const ext = extensionOf(name);
  const what = ext === '' ? 'That file has no extension' : `That's a ${ext}`;
  return `${what} — drop the .kicad_pro, .kicad_sch and .kicad_pcb files, or a zip of the project folder.`;
}

interface ViewerIntakeProps {
  onProject: (project: KicadProject) => void;
}

export default function ViewerIntake({ onProject }: ViewerIntakeProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(
    async (files: File[]) => {
      setBusy(true);
      setError(null);
      try {
        onProject(await buildProject(files));
      } catch (err) {
        setError(err instanceof KicadReadError ? err.message : 'Those files could not be read. Drop the project folder as a zip and try again.');
      } finally {
        setBusy(false);
      }
    },
    [onProject],
  );

  const onDrop = useCallback(
    (accepted: File[], rejections: FileRejection[]) => {
      const rejected = rejections[0];
      if (rejected && accepted.length === 0) {
        setError(rejectionCopy(rejected.file.name));
        return;
      }
      if (accepted.length === 0) return;
      void read(accepted);
    },
    [read],
  );

  const loadExample = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(EXAMPLE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      await read([new File([blob], 'glasgow-revC3.zip', { type: 'application/zip' })]);
    } catch {
      setError('The example project could not be loaded right now. Drop a project of your own instead.');
      setBusy(false);
    }
  }, [read]);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: ACCEPT,
    multiple: true,
    noClick: true,
    noKeyboard: true,
    useFsAccessApi: false,
  });

  return (
    <div className={styles.intake}>
      <section
        {...getRootProps({ className: `${styles.drop} ${isDragActive ? styles.dropActive : ''}` })}
        aria-label="Open a KiCad project"
      >
        <input {...getInputProps()} />
        <span className={`${styles.crop} ${styles.cropTl}`} aria-hidden="true" />
        <span className={`${styles.crop} ${styles.cropTr}`} aria-hidden="true" />
        <span className={`${styles.crop} ${styles.cropBl}`} aria-hidden="true" />
        <span className={`${styles.crop} ${styles.cropBr}`} aria-hidden="true" />
        <p className={styles.dropLead}>
          {isDragActive ? 'Drop the project here' : 'Drop your KiCad project here, or'}
        </p>
        <div className={styles.btnRow}>
          <button type="button" className={styles.dropBtn} onClick={open} disabled={busy}>
            {busy ? 'Reading…' : 'Choose files'}
          </button>
          <button type="button" className={styles.exampleBtn} onClick={() => void loadExample()} disabled={busy}>
            Try the example project
          </button>
        </div>
        <p className={styles.formatLine}>
          .kicad_pro&ensp;.kicad_sch&ensp;.kicad_pcb&ensp;.zip&ensp;&middot;&ensp;KiCad 6 or newer
        </p>
        <p className={styles.credit}>{EXAMPLE_CREDIT}</p>
      </section>
      {error != null && (
        <p className={styles.intakeError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
```

**Controller ruling (pre-flight scan): no verbatim duplication.** Create `frontend/src/public/styles/_dropFrame.scss` exporting ONE mixin, `drop-frame-intake`, and MOVE into it (cut, not copy) these rule blocks from `BomPage.module.scss`: `.page`, `.stack`, `.intake`, `.drop`, `.dropActive`, `.crop`, `.cropTl`, `.cropTr`, `.cropBl`, `.cropBr`, `.dropLead`, `.btnRow`, `.formatLine`, `.dropBtn`, `.exampleBtn` (with the `.pasteToggle, .exampleBtn` disabled state), `.intakeError`, `.phaseText`, `.phaseWarn`, `.pageError`, AND the `@include responsive($bp-mobile) { .page, .drop … }` block (nested selectors a `^\.class` scan misses — it holds only moved classes, and leaving it behind would let /bom override the shared mixin on phones). The mixin file starts with the same `@use` lines those rules need (`@shared/styles/variables`, `@shared/styles/mixins`, `@public/styles/bomMaterial`). `BomPage.module.scss` then replaces the moved blocks with `@use '@public/styles/dropFrame' as *;` + `@include drop-frame-intake;` at the same position, and `ViewerPage.module.scss` starts with the same `@use` lines plus `@include drop-frame-intake;`. Prove the BOM page is pixel-identical: build the CSS before and after (`npx vite build --mode development` or `npx sass` on the module) and diff the emitted rules for the BOM page's class list — the emitted declarations for every moved class must be unchanged (order within the file may shift). Then add:

```scss
.credit {
  margin: 6px 0 0;
  font-size: 0.75rem;
  color: $text-secondary;
}

.intro {
  margin: 0 0 18px;
  max-width: 72ch;
  color: $text-secondary;
  font-size: 0.95rem;
}

// Loaded phase ---------------------------------------------------------------
// A flex column: strip and tabs at their natural height, the drawing takes the
// rest of the viewport below the navbar, at every width (owner, Phase 0 gate).
.loaded {
  display: flex;
  flex-direction: column;
  min-height: calc(100dvh - #{$nav-height});
}

.drawing {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

.strip {
  @include bom-card;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 18px;
  padding: 12px 16px;
  margin-bottom: 14px;
}

.stripName {
  font-weight: 600;
  color: $text-primary;
}

.stripMeta {
  color: $text-secondary;
  font-size: 0.88rem;
}

.stripAction {
  @include bom-glass-control;
  margin-left: auto;
  padding: 7px 14px;
  line-height: 1;
  cursor: pointer;
}

.tabs {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 6px;
  margin-bottom: 12px;
  @include scrollbar-thin(4px);
}

.tab {
  @include bom-glass-control;
  padding: 8px 14px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;

  &[aria-selected='true'] {
    @include bom-primary-control;
  }
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.chip {
  @include bom-glass-control;
  padding: 5px 10px;
  font-size: 0.8rem;
  line-height: 1;
  cursor: pointer;

  &[aria-current='true'] {
    @include bom-primary-control;
  }
}

.notice {
  margin: 10px 0 0;
  font-size: 0.78rem;
  color: $text-secondary;

  a {
    color: inherit;
    text-decoration: underline;
  }
}

.toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  @include bom-card;
  padding: 10px 16px;
  font-size: 0.88rem;
  z-index: 50;
}

// Task 2.5 review additions (landed 7f3c944): the drawing column must honour the
// host's `hidden` prop, and the strip above the page is $nav-height-mobile (48px)
// on phones — same specificity, so this override must sit AFTER `.loaded`.
.drawing {
  &[hidden] {
    display: none;
  }
}

@include responsive($bp-mobile) {
  .loaded {
    min-height: calc(100dvh - #{$nav-height-mobile});
  }
}
```

(`scrollbar-thin` is the existing mixin in `@shared/styles/mixins`. If a bom mixin takes parameters, copy the invocation form used in `BomPage.module.scss`.)

- [ ] **Step 4: Gates and commit**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/` (the SCSS compiles on the next `npm run build`; run `npx vite build` once now to catch a Sass error early — the prebuild runs too).

```bash
cd /home/matthew/circuits-com
git add frontend/src/public/pages/viewer frontend/public/samples/glasgow-revC3.zip frontend/public/vendor/kicanvas/NOTICE.txt frontend/src/shared/styles/global.scss frontend/src/public/styles/_dropFrame.scss frontend/src/public/pages/bom/BomPage.module.scss
git commit -m "feat(viewer): intake with the Glasgow revC3 sample (0BSD), third-party NOTICE, icon-subset font face"
```

---

### Task 2.5: The `/viewer` page — Schematic and Board tabs, sheet chips, hash focus (spec §7.1)

**Files:**
- Create: `frontend/src/public/pages/viewer/index.tsx`
- Modify: `frontend/src/App.tsx` (lazy import + route)

**Interfaces:**
- Consumes: `ViewerIntake` (2.4), `DesignCanvas`/`DesignCanvasHandle` (2.2), `openDesign`/`getDesignSession`/`clearDesignSession` (2.3), `STATIC_PAGE_SEO.viewer` (2.6 — add the SEO entry in the same commit or this page will not type-check; see 2.6 Step 1), `PageHead`, `PageHeaderBand`.
- Produces: the route `/viewer`; Phase 3 adds the BOM tab and Phase 4 the Stackup tab inside this file at the marked places.

- [ ] **Step 1: Write the page**

```tsx
// frontend/src/public/pages/viewer/index.tsx
// Design Viewer — open a KiCad project in the browser (spec §7.1). Tabs:
// Schematic, Board, Stackup, BOM. ONE canvas element serves both drawing tabs
// (one embed per project); it is hidden, not unmounted, when another tab is
// active — and so is every other panel, so that switching tabs never bins work
// the reader has already paid for.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { motion } from 'framer-motion';
import { useLocation } from 'react-router-dom';
import PageHead from '@public/components/PageHead';
import PageHeaderBand from '@public/components/layout/PageHeaderBand';
import DesignCanvas, { type DesignCanvasHandle } from '@public/components/kicad/DesignCanvas';
import type { CanvasStateName } from '@public/components/kicad/canvasController';
import StackupPanel from '@public/components/kicad/StackupPanel';
import BomTable from '@public/components/bom/BomTable';
import ShareBar from '@public/components/bom/ShareBar';
import { useBomWorkbench } from '@public/services/bom/useBomWorkbench';
import { readStackup } from '@public/services/kicad/boardStackup';
import { basename } from '@public/services/kicad/project';
import type { KicadProject } from '@public/services/kicad/types';
import { clearDesignSession, getDesignSession, openDesign, type DesignSession } from '@public/services/designSession';
import { STATIC_PAGE_SEO } from '@public/services/seoRoutes';
import ViewerIntake from './components/ViewerIntake';
import styles from './ViewerPage.module.scss';

type Tab = 'schematic' | 'board' | 'stackup' | 'bom';

export const POSITIONING =
  'Open your KiCad project in the browser and get every line of the BOM priced across our whole distributor catalog — read straight out of your schematic, with no CSV export, no account, and nobody trying to win your board order.';

/** Why a chip is inert, in the two places that have to say it: the hover title
 *  and the toast a click raises. The renderer addresses its files by BASENAME,
 *  so a second `power.kicad_sch` cannot be represented at all. */
const DROPPED_SHEET_HINT =
  'Another sheet in this project has the same filename, so only one of them can be drawn.';

/** One visually-hidden node carries the reason for every dropped chip; the
 *  chips point at it with `aria-describedby`, so the reason is ANNOUNCED rather
 *  than living only in a `title` (inconsistently read, invisible on touch) and
 *  the dashed styling. */
const DROPPED_REASON_ID = 'viewer-unrenderable-sheet-reason';

/** The same fact as a toast. `ref` is present when the gesture was about a
 *  designator rather than the chip itself — the reader needs to know which part
 *  they clicked went nowhere, not only that some sheet cannot be drawn. */
function droppedSheetToast(path: string, ref?: string): string {
  const subject =
    ref == null
      ? `${basename(path)} can't be drawn`
      : `${ref} is on ${basename(path)}, which can't be drawn`;
  return `${subject} — another sheet in this project has the same filename.`;
}

/**
 * The designator a URL is asking us to focus, or null.
 *
 * `decodeURIComponent` THROWS on a malformed escape, and `/viewer#%` is one a
 * truncated pasted link really does produce. The raw text is the fallback: a
 * reference that fails to match gets an honest "not in this schematic" toast,
 * where an exception out of an effect takes the page to the ErrorBoundary.
 */
function refFromHash(hash: string): string | null {
  if (hash.length <= 1) return null;
  const raw = hash.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function sheetLabel(project: KicadProject, path: string): string {
  const stem = basename(path).replace(/\.kicad_sch$/i, '');
  return path === project.root ? `${stem} (root)` : stem;
}

/**
 * The tablist's wiring, as ids.
 *
 * Every tab points `aria-controls` at the panel it opens and every panel points
 * `aria-labelledby` back at its tab, so the pairing is announced rather than
 * implied by position. The two DRAWING tabs share one panel on purpose: the
 * canvas is a single embed per project (hidden, never unmounted), so Schematic
 * and Board are two labels on one region.
 *
 * A reference to an element that is not in the document is worse than none —
 * `aria-controls` is therefore emitted only for a panel that is really mounted
 * (the BOM panel arrives with its first visit; the Stackup panel only exists for
 * a project that has a board).
 */
const TAB_ID: Record<Tab, string> = {
  schematic: 'viewer-tab-schematic',
  board: 'viewer-tab-board',
  stackup: 'viewer-tab-stackup',
  bom: 'viewer-tab-bom',
};

const PANEL_ID = {
  drawing: 'viewer-panel-drawing',
  stackup: 'viewer-panel-stackup',
  bom: 'viewer-panel-bom',
} as const;

const PANEL_OF: Record<Tab, keyof typeof PANEL_ID> = {
  schematic: 'drawing',
  board: 'drawing',
  stackup: 'stackup',
  bom: 'bom',
};

function defaultTab(session: DesignSession): Tab {
  return session.project.root != null ? 'schematic' : 'board';
}

export default function ViewerPage() {
  const location = useLocation();
  const [session, setSession] = useState<DesignSession | null>(() => getDesignSession());
  const [tab, setTab] = useState<Tab>(() => (session ? defaultTab(session) : 'schematic'));
  const [activeSheet, setActiveSheet] = useState<string | undefined>(undefined);
  const [canvasState, setCanvasState] = useState<CanvasStateName>('loading');
  const [toast, setToast] = useState<string | null>(null);
  /**
   * Has the BOM tab been opened for THIS project? A one-way latch, not a mirror
   * of `tab`: the workbench prices once per `parsed` IDENTITY, so a flag that
   * fell back to false on leaving the tab would hand the hook null and then the
   * same object again — a fresh identity transition, a second `/api/bom/match`,
   * and a second bite of the visitor's 100-lookups-a-day resolve budget, all
   * for a tab click. Latched, the input goes null → parsed → parsed: one match,
   * and the priced panel survives every flip back to the drawing.
   */
  const [bomSeen, setBomSeen] = useState(false);
  const canvasRef = useRef<DesignCanvasHandle>(null);
  /** The tab buttons, so an arrow key can move real DOM focus and not only the
   *  selection. Keyed by tab id rather than by index: `tabs` changes shape with
   *  the project, and a stale index would focus the wrong button. */
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  /** A focus the canvas still owes us, held until it reports `ready`. */
  const pendingFocus = useRef<string | null>(null);
  /**
   * Which gesture owns the view, and therefore the toast.
   *
   * A focus is awaited across a sheet load, and the reader can act again inside
   * that window — another designator, or a sheet chip. Whoever acted LAST is who
   * the page is answering; an older focus landing afterwards must say nothing,
   * or the reader is told "U1 was not found" about a click they have already
   * replaced, over a drawing that is showing something else entirely.
   */
  const focusSeq = useRef(0);
  /**
   * Sheets the MOUNTED renderer cannot draw for this project — its answer, not
   * this page's guess. KiCanvas keys its file system by basename and so must
   * drop a second `power.kicad_sch`; the editor renderer that replaces it later
   * is path-keyed and will answer none, at which point these chips stop being
   * marked without a line changing here.
   *
   * Reported before the renderer bundle is even fetched, so the chips carry it
   * on the commit that first paints them.
   */
  const [droppedSheets, setDroppedSheets] = useState<ReadonlySet<string>>(new Set());
  const handleUnrenderable = useCallback((paths: string[]) => {
    setDroppedSheets((prev) => {
      // The canvas remounts on every project identity, and re-reporting an
      // unchanged answer would re-render the whole page for nothing.
      if (prev.size === paths.length && paths.every((p) => prev.has(p))) return prev;
      return new Set(paths);
    });
  }, []);

  const wb = useBomWorkbench(
    // Armed by the first BOM-tab visit and never disarmed short of a new
    // project. A parse that failed has nothing to price — the panel shows the
    // reason instead.
    bomSeen && session != null && session.parsed.error == null ? session.parsed : null,
    // No viewer route: this IS the viewer. Designator chips act in place via
    // `onRefClick`, which outranks a link (spec §6).
    null,
  );

  // The session is opened HERE and only here — never in an effect. React 19's
  // StrictMode double-invokes effects, and openDesign re-parses the schematic.
  const handleProject = useCallback((project: KicadProject) => {
    const next = openDesign(project);
    setSession(next);
    setTab(defaultTab(next));
    setActiveSheet(undefined);
    setCanvasState('loading');
    setBomSeen(false);
  }, []);

  // Deliberately NOT called on unmount: surviving the /viewer ↔ /bom trip is
  // the whole point of the session. Only this button ends it.
  const openAnother = () => {
    // reset() FIRST, while the workbench still owns this BOM: it bumps the
    // generation, so a match already on the wire cannot land on the table we
    // are emptying and open a resolve stream against it. Clearing the session
    // (and the latch) is what then holds the hook at null.
    wb.reset();
    clearDesignSession();
    setSession(null);
    setBomSeen(false);
    setActiveSheet(undefined);
    // The canvas is about to unmount with the session. Leaving this at 'ready'
    // would leave the hash effect believing a drawing is on screen.
    setCanvasState('loading');
    setDroppedSheets(new Set());
    // A toast raised a moment ago would otherwise float over the fresh intake.
    setToast(null);
    pendingFocus.current = null;
  };

  const focus = useCallback(
    async (ref: string) => {
      // Claimed before any early return, so a focus that answers immediately
      // still silences an older one that is still in flight.
      const seq = ++focusSeq.current;
      const s = session;
      if (s == null) return;
      if (s.project.root == null) {
        // Reachable: arrive at /viewer#U1, then open a board-only project. Without
        // this we would select a Schematic tab that the tablist does not render.
        setToast(`${ref} can't be shown — this project has no schematic.`);
        return;
      }
      const where = s.refs.get(ref);
      // The same wall `chooseSheet` puts in front of the chips. Without it the
      // BOM row is a second door onto the state I4 closed: `activeSheet` would
      // name a sheet the renderer never received, the chip this page marks
      // "can't be drawn" would take `aria-current`, and the canvas would not
      // move — inert and silent, through a new entrance.
      if (where != null && droppedSheets.has(where.sheet)) {
        setToast(droppedSheetToast(where.sheet, ref));
        return;
      }
      // Page state moves BEFORE the drawing does. DesignCanvas re-activates on
      // every `view`/`activeSheet` change, and when `setTab` really flips the
      // view that effect can land AFTER focusRef has finished — re-activating
      // whatever sheet the page still believed was current and dragging the
      // canvas off the one the focus just selected. Naming the designator's own
      // sheet first makes the late activate a no-op instead of a fight.
      if (where != null) setActiveSheet(where.sheet);
      setTab('schematic');
      const result = await canvasRef.current?.focusRef(ref, where?.instancePath);
      // A newer gesture took the view while this was loading. 'superseded' is
      // the renderer saying so; the sequence check catches the rest (a second
      // designator, or a focus that never reached the renderer at all).
      if (seq !== focusSeq.current || result === 'superseded') return;
      if (result === 'focused') setToast(`Focused ${ref}`);
      else if (result === 'not-found') setToast(where ? `${ref} was not found on sheet ${basename(where.sheet)}` : `${ref} is not in this schematic`);
      // 'unsupported' (no WebGL, or no renderer mounted) and an absent handle both
      // land here: say so rather than leaving the click with no answer at all.
      else setToast(`${ref} can't be focused — the drawing is not available in this browser.`);
    },
    [session, droppedSheets],
  );

  // A #ref the URL is carrying, including one that ARRIVES while this page is
  // already mounted — a BOM-row link, an in-page anchor, back/forward between
  // two refs. (Reading the hash once into a ref at mount, as this used to, only
  // ever saw the first one.)
  //
  // The hash alone is the dep list, on purpose: React runs the effect function
  // belonging to the render that just committed, so `canvasState` and `focus`
  // are read CURRENT without being depended on — while listing them would
  // re-fire this on every canvas state change and every new session, re-playing
  // a hash the reader moved past long ago (and which `openAnother` deliberately
  // drops).
  useEffect(() => {
    const ref = refFromHash(location.hash);
    pendingFocus.current = ref;
    if (ref == null || canvasState !== 'ready') return;
    pendingFocus.current = null;
    void focus(ref);
  }, [location.hash]);

  // …and the same focus when the canvas was not ready to take it yet. Declared
  // AFTER the effect above so a mount carrying #U1 has already recorded it.
  useEffect(() => {
    if (canvasState !== 'ready' || pendingFocus.current == null || session == null) return;
    const ref = pendingFocus.current;
    pendingFocus.current = null;
    void focus(ref);
  }, [canvasState, session, focus]);

  // One-way: see `bomSeen`.
  useEffect(() => {
    if (tab === 'bom') setBomSeen(true);
  }, [tab]);

  useEffect(() => {
    if (toast == null) return;
    const id = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(id);
  }, [toast]);

  const tabs = useMemo<{ id: Tab; label: string }[]>(() => {
    if (session == null) return [];
    const out: { id: Tab; label: string }[] = [];
    if (session.project.root != null) out.push({ id: 'schematic', label: 'Schematic' });
    if (session.project.board != null) out.push({ id: 'board', label: 'Board' });
    // Offered for any project with a board, INCLUDING one whose board this
    // reader cannot parse — the panel then says why, which is a better answer
    // than a tab that quietly is not there.
    if (session.project.board != null) out.push({ id: 'stackup', label: 'Stackup' });
    if (session.project.root != null) out.push({ id: 'bom', label: 'BOM' });
    return out;
  }, [session]);

  /**
   * The board's layer stack, or null when there is no board or it cannot be
   * read.
   *
   * `readStackup` THROWS a KicadReadError for a file that does not open with
   * `(kicad_pcb …)` or that is truncated — and `project.ts` picks the board by
   * EXTENSION alone, so a mis-saved or half-copied `.kicad_pcb` really does
   * reach here. Uncaught, that exception is thrown from a render and takes the
   * whole page to the ErrorBoundary: the reader loses the schematic and the BOM
   * over a file they may not even have come for. Caught, they lose only the
   * stackup, and the panel below says so.
   */
  const stackup = useMemo(() => {
    const board = session?.project.board;
    if (session == null || board == null) return null;
    try {
      return readStackup(session.project.files.get(board) ?? '');
    } catch {
      return null;
    }
  }, [session]);

  /**
   * Which drawing tab currently labels the shared canvas panel.
   *
   * Schematic and Board both control it, so the region's `aria-labelledby` has
   * to name whichever one is live — and must never name a tab this project does
   * not have (a board-only drop has no Schematic tab to point at, and a drop
   * with neither has no drawing tab at all).
   */
  const drawingTab: Tab | null = useMemo(() => {
    const has = (id: Tab) => tabs.some((t) => t.id === id);
    if (tab === 'board' && has('board')) return 'board';
    if (has('schematic')) return 'schematic';
    if (has('board')) return 'board';
    // A drop with neither a schematic nor a board: no drawing tab to name.
    return null;
  }, [tabs, tab]);

  /**
   * Arrow keys move focus AND selection across the tablist, as the tabs pattern
   * expects of an automatic-activation tablist; Home and End jump to the ends.
   * Together with the roving `tabIndex` below this makes the strip ONE tab stop,
   * so a keyboard reader does not have to step through four buttons to reach the
   * drawing.
   */
  const onTabKeys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (tabs.length === 0) return;
    const here = tabs.findIndex((t) => t.id === tab);
    let next: number;
    if (e.key === 'ArrowRight') next = (here + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (here - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    const target = tabs[next];
    if (target == null) return;
    // Only now, so an unhandled key (Tab out of the strip, a shortcut) keeps
    // its default behaviour.
    e.preventDefault();
    setTab(target.id);
    tabRefs.current[target.id]?.focus();
  };

  const chooseSheet = (path: string) => {
    // A sheet chip is a newer gesture than any focus still in flight. The
    // controller yields the view to it; this hands it the toast to match.
    focusSeq.current += 1;
    if (droppedSheets.has(path)) {
      setToast(droppedSheetToast(path));
      return;
    }
    setActiveSheet(path);
  };

  const drawingVisible = tab === 'schematic' || tab === 'board';

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >
      <PageHead seo={STATIC_PAGE_SEO.viewer} />
      <PageHeaderBand
        page="viewer"
        title="Design Viewer"
        subtitle={
          <>
            Open a KiCad project. See the schematic and board, and price the BOM read straight from your{' '}
            <strong>schematic</strong>.
          </>
        }
      />
      <div className={styles.page}>
        <div className={styles.stack}>
          {session == null && (
            <>
              <p className={styles.intro}>{POSITIONING} Your design files never leave your browser.</p>
              <ViewerIntake onProject={handleProject} />
            </>
          )}

          {session != null && (
            <div className={styles.loaded}>
              <div className={styles.strip}>
                <span className={styles.stripName}>{session.project.name}</span>
                <span className={styles.stripMeta}>
                  {session.project.sheets.length} {session.project.sheets.length === 1 ? 'sheet' : 'sheets'} &middot;{' '}
                  {session.parsed.lines.reduce((n, l) => n + l.qty, 0).toLocaleString('en-US')} parts &middot; board:{' '}
                  {session.project.board != null ? 'yes' : 'no'}
                </span>
                <button type="button" className={styles.stripAction} onClick={openAnother}>
                  Open another
                </button>
              </div>

              {[...session.project.warnings, ...session.parsed.warnings].map((w) => (
                <p key={w} className={styles.phaseWarn}>
                  {w}
                </p>
              ))}
              {session.project.missingSheets.length > 0 && (
                <p className={styles.pageError} role="alert">
                  Missing sheet file{session.project.missingSheets.length === 1 ? '' : 's'}:{' '}
                  {session.project.missingSheets.join(', ')} &mdash; add {session.project.missingSheets.length === 1 ? 'it' : 'them'} to
                  the drop and the drawing and BOM will include {session.project.missingSheets.length === 1 ? 'it' : 'them'}.
                </p>
              )}

              <div className={styles.tabs} role="tablist" aria-label="Views" onKeyDown={onTabKeys}>
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    id={TAB_ID[t.id]}
                    type="button"
                    role="tab"
                    className={styles.tab}
                    aria-selected={tab === t.id}
                    // Only for a panel that is really in the document: the BOM
                    // panel arrives with its first visit.
                    aria-controls={t.id === 'bom' && !bomSeen ? undefined : PANEL_ID[PANEL_OF[t.id]]}
                    // Roving: the strip is one tab stop and the arrows move
                    // inside it.
                    tabIndex={tab === t.id ? 0 : -1}
                    ref={(el) => {
                      tabRefs.current[t.id] = el;
                    }}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {tab === 'schematic' && session.project.sheets.length > 1 && (
                <div className={styles.chips} role="group" aria-label="Sheets">
                  {droppedSheets.size > 0 && (
                    <span id={DROPPED_REASON_ID} className={styles.srOnly}>
                      {DROPPED_SHEET_HINT}
                    </span>
                  )}
                  {session.project.sheets.map((s) => {
                    const dropped = droppedSheets.has(s.path);
                    return (
                      <button
                        key={s.path}
                        type="button"
                        className={dropped ? `${styles.chip} ${styles.chipDropped}` : styles.chip}
                        aria-current={(activeSheet ?? session.project.root) === s.path}
                        aria-disabled={dropped || undefined}
                        aria-describedby={dropped ? DROPPED_REASON_ID : undefined}
                        title={dropped ? DROPPED_SHEET_HINT : undefined}
                        onClick={() => chooseSheet(s.path)}
                      >
                        {sheetLabel(session.project, s.path)}
                        {dropped && <span aria-hidden="true"> &#9888;</span>}
                      </button>
                    );
                  })}
                </div>
              )}

              <div
                id={PANEL_ID.drawing}
                role="tabpanel"
                aria-labelledby={drawingTab == null ? undefined : TAB_ID[drawingTab]}
                className={styles.drawing}
                hidden={!drawingVisible}
              >
                <DesignCanvas
                  ref={canvasRef}
                  project={session.project}
                  view={tab === 'board' ? 'board' : 'schematic'}
                  activeSheet={tab === 'board' ? undefined : activeSheet}
                  onState={setCanvasState}
                  onUnrenderableSheets={handleUnrenderable}
                />
                <p className={styles.notice}>
                  Rendering by KiCanvas &mdash;{' '}
                  <a href="/vendor/kicanvas/NOTICE.txt" target="_blank" rel="noopener noreferrer">
                    licences
                  </a>
                </p>
              </div>

              {bomSeen && (
                <section
                  id={PANEL_ID.bom}
                  role="tabpanel"
                  aria-labelledby={TAB_ID.bom}
                  hidden={tab !== 'bom'}
                  className={styles.bomPanel}
                  // Kept beside `aria-labelledby` (which wins) as the name
                  // this region has always answered to.
                  aria-label="Bill of materials"
                >
                  {session.parsed.error != null && (
                    <p className={styles.pageError} role="alert">
                      {session.parsed.error}
                    </p>
                  )}
                  {wb.resolveNote != null && <p className={styles.phaseWarn}>{wb.resolveNote}</p>}
                  {wb.matchError != null && (
                    <p className={styles.pageError} role="alert">
                      {wb.matchError}
                    </p>
                  )}
                  {wb.resolveError != null && (
                    <p className={styles.phaseWarn} role="status">
                      {wb.resolveError}
                    </p>
                  )}
                  {wb.matching && (
                    <p className={styles.phaseText} role="status">
                      Pricing {session.parsed.lines.length.toLocaleString('en-US')}{' '}
                      {session.parsed.lines.length === 1 ? 'line' : 'lines'} against the catalog&#8230;
                    </p>
                  )}
                  {session.parsed.error == null && session.parsed.lines.length === 0 && (
                    <p className={styles.phaseText}>
                      Nothing to price &mdash; no BOM lines were read from this schematic. Power,
                      virtual and unreferenced symbols, and anything marked not-in-BOM, are left
                      out on purpose; the notes above this panel say what was skipped.
                    </p>
                  )}
                  {!wb.matching && wb.rows.length > 0 && (
                    <>
                      <BomTable
                        rows={wb.rows}
                        buildQty={wb.buildQty}
                        onBuildQtyChange={wb.setBuildQty}
                        onPickSimilar={wb.pickSimilar}
                        includeDnp={wb.includeDnp}
                        onIncludeDnpChange={wb.setIncludeDnp}
                        onRefClick={(ref) => void focus(ref)}
                      />
                      <ShareBar rows={wb.rows} buildQty={wb.buildQty} includeDnp={wb.includeDnp} onChangeFile={openAnother} />
                    </>
                  )}
                </section>
              )}

              {session.project.board != null && (
                // Mounted for the whole session and hidden when another tab is
                // live, like every other panel here: the region `aria-controls`
                // names has to exist, and re-reading the board on each visit
                // would be work for nothing.
                <section
                  id={PANEL_ID.stackup}
                  role="tabpanel"
                  aria-labelledby={TAB_ID.stackup}
                  hidden={tab !== 'stackup'}
                  className={styles.stackupPanel}
                >
                  {stackup != null ? (
                    <StackupPanel stackup={stackup} />
                  ) : (
                    <p className={styles.pageError} role="alert">
                      {basename(session.project.board)} could not be read as a KiCad board, so there is no
                      layer stack to show. Open the project in KiCad 6 or newer and save it, then drop it
                      again.
                    </p>
                  )}
                </section>
              )}
            </div>
          )}
        </div>
      </div>

      {toast != null && (
        <div className={styles.toast} role="status">
          {toast}
        </div>
      )}
    </motion.div>
  );
}
```

`frontend/src/App.tsx`: after `const BomPage = lazy(() => import("@public/pages/bom"));` add `const ViewerPage = lazy(() => import("@public/pages/viewer"));`; after the `/bom/s/:slug` route add `<Route path="/viewer" element={<ViewerPage />} />`.

- [ ] **Step 2: Add the SEO entry now (2.6 Step 1) so the page type-checks, then run the gates**

Do Task 2.6 Step 1 (the `seoRoutes.ts` change) before running:

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`
Expected: clean.

- [ ] **Step 3: Local smoke**

```bash
cd /home/matthew/circuits-com && docker compose up -d --build frontend   # or: cd frontend && npm run dev
```

Open `http://localhost:3000/viewer` (through nginx: `http://localhost/viewer`): the intake renders; "Try the example project" loads Glasgow; tabs Schematic/Board appear; sheet chips switch sheets; Board shows the board; `http://localhost/viewer#U1` after loading focuses U1 (a toast reads "Focused U1"); the notice link opens the NOTICE file. Network panel: no request to any host but ours.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/public/pages/viewer/index.tsx frontend/src/App.tsx frontend/src/public/services/seoRoutes.ts
git commit -m "feat(viewer): /viewer page — intake, Schematic and Board tabs on one canvas, sheet chips, #ref focus, notice"
```

---

### Task 2.6: SEO, prerender, sitemap, and navigation (spec §7.4)

**Files:**
- Modify: `frontend/src/public/services/seoRoutes.ts` (`StaticPageKey` + entry), `frontend/scripts/seoPrerender.ts` (route), `api/app/routes/sitemap.py` (`STATIC_PAGES`), `api/tests/test_sitemap.py`, `frontend/src/public/pages/home/components/HeroSection.tsx`, `frontend/src/public/components/layout/BrowseDrawer/BrowseDrawerBody.tsx`

- [ ] **Step 1: The SEO entry (needed by Task 2.5)**

`frontend/src/public/services/seoRoutes.ts`: add `| 'viewer'` to `StaticPageKey` (alphabetical, after `'terms'`), and this entry in `STATIC_PAGE_SEO` (after `terms`):

```ts
  viewer: {
    title: 'Price a KiCad BOM from Your Schematic — Design Viewer | Circuit Center',
    description:
      'Open a KiCad project in your browser: schematic, board, stackup, and a BOM read from your schematic and priced across our distributor catalog.',
    canonical: `${SITE_ORIGIN}/viewer`,
    jsonLd: [],
    heading: 'Design Viewer',
    links: SITE_LINKS,
  },
```

(Description is 140 characters; the existing `seo.test.ts` asserts every description is over 40 characters and unique.)

- [ ] **Step 2: Prerender route, sitemap, and its test**

`frontend/scripts/seoPrerender.ts` — after the `/bom` route line add:

```ts
    { urlPath: '/viewer', file: 'viewer/index.html', seo: STATIC_PAGE_SEO.viewer },
```

`api/app/routes/sitemap.py` — after the `("/bom", "weekly", "0.6"),` line add:

```python
    # /viewer opens a KiCad project in the browser and prices its BOM — a real
    # indexable tool page, the same weight as /bom.
    ("/viewer", "weekly", "0.6"),
```

`api/tests/test_sitemap.py` — in `test_sitemap_core_keeps_the_static_pages` add `assert "https://circuitcenter.ai/viewer" in locs`.

Run: `cd api && pytest tests/test_sitemap.py -v` → all passed.

- [ ] **Step 3: Navigation**

`HeroSection.tsx` — after `<AnimatedLink to="/bom">BOM Tool</AnimatedLink>` add `<AnimatedLink to="/viewer">Design Viewer</AnimatedLink>`.

`BrowseDrawerBody.tsx` — after the BOM Tool button add:

```tsx
          <button type="button" className={styles.item} onClick={() => go("/viewer")}>
            <Icon name="blueprint" className={styles.itemIcon} />
            Design Viewer
            <span className={styles.meta} aria-hidden="true">
              KiCad
            </span>
          </button>
```

- [ ] **Step 4: Gates, build, and commit**

```bash
cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test && npm run build && ls dist/viewer/index.html && grep -o '<title>[^<]*</title>' dist/viewer/index.html
cd .. && git add frontend/src/public/services/seoRoutes.ts frontend/scripts/seoPrerender.ts api/app/routes/sitemap.py api/tests/test_sitemap.py frontend/src/public/pages/home/components/HeroSection.tsx frontend/src/public/components/layout/BrowseDrawer/BrowseDrawerBody.tsx
git commit -m "feat(viewer): SEO entry leading with the BOM claim, prerendered /viewer, sitemap line, hero and drawer links"
```

- [ ] **Step 5: STOP — Phase 2 gate**

Rebuild the local stack (`docker compose up -d --build frontend`). Owner checklist: open `http://localhost/viewer`; drop a project and load the example; switch sheets and views; the Board tab renders; network panel shows zero third-party requests; `http://localhost/vendor/kicanvas/NOTICE.txt` serves; the hero and the drawer link to it; a phone width (390px) via `mobile-layout-guard` shows the tabs scrolling and the canvas at 50vh; the served `dist/viewer/index.html` carries the title. Wait for explicit approval before Phase 3.

---

# Phase 3 — The BOM bridge

> **Carry-forward from the Task 2.5 review (2026-09-13) — every Phase 3 task that touches `pages/viewer/index.tsx` inherits these:**
> - **I1** a hash change while already on `/viewer` does nothing (`pendingFocus` is seeded once at mount). Task 3.2's BOM-row link and any in-page `#ref` need an effect on `location.hash` that sets the pending focus and, when the canvas is `ready`, calls `focus` directly.
> - **I2** `focus()` calls `setTab('schematic')` then `focusRef`; when the view really flips, the host's activate effect can land AFTER the focus with a stale `activeSheet`. Set `activeSheet` to the designator's sheet BEFORE `focusRef` so page state and renderer agree.
> - **I4** a chip whose sheet the controller dropped (basename collision) is inert with no feedback: `DesignCanvas` discards `activate`'s boolean. Surface it through the handle (or a chip handler that toasts) and mark dropped chips.
> - (I3 — the non-drawing tab reset the sheet to root — was fixed in Phase 2: `activeSheet` is gated on the view, not the tab.)


### Task 3.1: Lift the workbench out of the BOM page — `useBomWorkbench` with exported reducers (spec §6)

**Files:**
- Create: `frontend/src/public/services/bom/useBomWorkbench.ts`
- Modify: `frontend/src/public/pages/bom/index.tsx` (consumes the hook; the share view keeps its own read-only rows)
- Test: `frontend/src/public/services/bom/bomWorkbench.test.ts`

**Interfaces:**
- Consumes: `bomApi` (match, streamResolve), `ParseResult`, `ParsedBomLine`, `BomRow`, `MissIn`, `ResolveEvent`, `TableRow` (1.1).
- Produces: `useBomWorkbench(parsed: ParseResult | null, viewerHref: string | null): BomWorkbench` and the pure functions `buildRows`, `applyResolveEvent`, `settleStragglers`, `pickMisses`, `cappedNote`, `foldSimilarPick`, plus the constants `MATCH_FAILED`, `MATCH_THROTTLED`, `RESOLVE_CAP`, `RESOLVE_STOPPED`.

- [ ] **Step 1: Write the failing reducer tests**

```ts
// frontend/src/public/services/bom/bomWorkbench.test.ts
import { describe, expect, it } from 'vitest';
import type { BomRow, ResolveEvent, TableRow } from './types';
import {
  applyResolveEvent,
  buildRows,
  foldSimilarPick,
  pickMisses,
  RESOLVE_CAP,
  settleStragglers,
} from './useBomWorkbench';

const server = (over: Partial<BomRow>): BomRow =>
  ({
    index: 0,
    status: 'none',
    part: null,
    offers: [],
    similar: [],
    approx_reason: null,
    package_warning: null,
    recommended_supplier_id: null,
    resolve_query: null,
    ...over,
  }) as BomRow;

const line = (index: number, over: Partial<TableRow> = {}): TableRow => ({
  index,
  mpn: null,
  value: '1k',
  footprint: null,
  description: null,
  manufacturer: null,
  distributorPn: null,
  qty: 1,
  refs: [`R${index}`],
  dnp: false,
  server: null,
  state: 'matched',
  viewerHref: null,
  ...over,
});

describe('buildRows', () => {
  it('joins server answers by index, marks unanswered lines not_found, and stamps the viewer route', () => {
    const rows = buildRows([line(0), line(1)], [server({ index: 1, status: 'exact' })], '/viewer');
    expect(rows.map((r) => [r.state, r.server?.status ?? null, r.viewerHref])).toEqual([
      ['not_found', null, '/viewer'],
      ['matched', 'exact', '/viewer'],
    ]);
  });
});

describe('applyResolveEvent', () => {
  const rows = [line(0, { state: 'resolving' }), line(1, { state: 'resolving' })];
  const ev = (over: Partial<ResolveEvent>): ResolveEvent => ({
    kind: 'resolved',
    index: 0,
    detail: null,
    row: null,
    ...over,
  });
  it('lands a resolved row as resolved_live, and a rowless resolved back on matched', () => {
    expect(
      applyResolveEvent(rows, ev({ row: server({ index: 0, status: 'exact_live' }) }))[0],
    ).toMatchObject({ state: 'resolved_live', server: { status: 'exact_live' } });
    expect(applyResolveEvent(rows, ev({}))[0]?.state).toBe('matched');
  });
  it('maps not_found and resolve_unavailable, touching only the named index', () => {
    const out = applyResolveEvent(rows, ev({ kind: 'not_found', index: 1 }));
    expect(out.map((r) => r.state)).toEqual(['resolving', 'not_found']);
    expect(applyResolveEvent(rows, ev({ kind: 'resolve_unavailable', index: 0 }))[0]?.state).toBe(
      'unavailable',
    );
  });
});

describe('settleStragglers', () => {
  it('returns every still-resolving row to matched', () => {
    expect(
      settleStragglers([line(0, { state: 'resolving' }), line(1, { state: 'not_found' })]).map(
        (r) => r.state,
      ),
    ).toEqual(['matched', 'not_found']);
  });
});

describe('pickMisses', () => {
  const miss = (index: number, over: Partial<TableRow> = {}) =>
    line(index, {
      server: server({ index, status: 'resolve', resolve_query: `q${index}` }),
      ...over,
    });
  it('takes resolve rows with a query, MPN-first, skips DNP unless included, caps at RESOLVE_CAP', () => {
    const rows = [
      miss(0),
      miss(1, { mpn: 'ABC' }),
      miss(2, { dnp: true }),
      line(3),
      miss(4, { server: server({ index: 4, status: 'resolve', resolve_query: '' }) }),
    ];
    expect(pickMisses(rows, false).misses.map((m) => m.index)).toEqual([1, 0]);
    expect(pickMisses(rows, true).misses.map((m) => m.index)).toEqual([1, 0, 2]);
    const many = Array.from({ length: RESOLVE_CAP + 5 }, (_, i) => miss(i));
    const capped = pickMisses(many, false);
    // `dropped` alone is computed from the input length, so it stays right even
    // if the slice is wrong. The SLICE is what the server 422s on (one over and
    // it rejects the whole stream), so assert its length directly.
    expect(capped.misses).toHaveLength(RESOLVE_CAP);
    expect(capped).toMatchObject({ dropped: 5 });
  });

  it('drops the guesses at the cap, never the MPN-identified certainties', () => {
    // More lines than the cap, with the MPN'd ones LAST in file order: the
    // ordering claim is that they still all survive and the value-only
    // queries are what gets left behind.
    const valueOnly = Array.from({ length: RESOLVE_CAP }, (_, i) => miss(i));
    const withMpn = Array.from({ length: 4 }, (_, i) =>
      miss(RESOLVE_CAP + i, { mpn: `MPN${i}` }),
    );
    const { misses, dropped } = pickMisses([...valueOnly, ...withMpn], false);
    expect(misses).toHaveLength(RESOLVE_CAP);
    expect(dropped).toBe(4);
    expect(misses.slice(0, 4).map((m) => m.mpn)).toEqual(['MPN0', 'MPN1', 'MPN2', 'MPN3']);
    expect(misses.every((m) => m.index !== RESOLVE_CAP - 1)).toBe(true); // a guess fell off
  });
});

describe('foldSimilarPick', () => {
  it('swaps in the fresh match as approx and folds the displaced part into the menu', () => {
    const displaced = {
      id: 'p1',
      sku: 'OLD',
      manufacturer_name: 'M',
      description: null,
      package: null,
      lifecycle_status: null,
      lifecycle_verified: false,
    };
    const rows = [
      line(0, {
        server: server({
          index: 0,
          status: 'exact',
          part: displaced as BomRow['part'],
          similar: [{ ...displaced, id: 'p2', sku: 'NEW' }],
        }),
      }),
    ];
    const out = foldSimilarPick(
      rows,
      0,
      'NEW',
      server({
        index: 0,
        status: 'exact',
        part: { ...displaced, id: 'p2', sku: 'NEW' } as BomRow['part'],
      }),
    );
    expect(out[0]?.server).toMatchObject({
      status: 'approx',
      approx_reason: 'your pick — similar part',
    });
    expect(out[0]?.server?.similar.map((s) => s.sku)).toEqual(['OLD']);
  });
  it('returns the SAME array when the fresh match has no part', () => {
    // Reference identity is the behaviour, not an implementation detail: it is
    // what lets `setRows((prev) => foldSimilarPick(...))` bail out of the
    // re-render, matching the old code's `if (fresh.part == null) return;`
    // early exit. `toEqual` would pass for a freshly mapped copy too.
    const rows = [line(0), line(1)];
    expect(foldSimilarPick(rows, 0, 'X', server({ index: 0, part: null }))).toBe(rows);
  });
});
```

If `BomRow` carries more required fields than the `server()` helper sets, extend the helper — the `as BomRow` cast is there so the test names only what the reducers read.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/public/services/bom/bomWorkbench.test.ts`
Expected: FAIL — cannot resolve `./useBomWorkbench`.

- [ ] **Step 3: Write the hook — the page's logic, moved, with the pure parts exported**

```ts
// frontend/src/public/services/bom/useBomWorkbench.ts
// Everything that happens to a BOM after it is parsed: the phase-1 match, the
// phase-2 resolve stream, build quantity, the DNP toggle, the similar-pick.
// Moved from pages/bom/index.tsx so /viewer prices a schematic-derived BOM
// with the same code (spec §6). No behaviour change intended; the pure pieces
// are exported and unit-tested, the hook is the wiring.
import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { bomApi } from './bomApi';
import type { ParsedBomLine, ParseResult } from './parseBom';
import type { BomRow, MissIn, ResolveEvent, TableRow } from './types';

export const MATCH_FAILED =
  'We could not reach the pricing service. Your file is still loaded — try again in a moment.';
export const MATCH_THROTTLED =
  'That is a lot of BOMs in one minute. Wait about a minute and price this one again.';

/** Mirrors `BomResolveRequest.misses` max_length in api/app/schemas/bom.py:
 *  one over and the server 422s the whole stream, so the cap is enforced here
 *  and ANNOUNCED — a silently dropped line is a line the reader believes was
 *  priced. */
export const RESOLVE_CAP = 50;

export const RESOLVE_STOPPED =
  'Live lookups stopped early. The lines still marked NO MATCH were never looked up — try again in a moment.';

/**
 * Priced results, keyed by the PARSE they belong to.
 *
 * A hook instance dies with its page, and /viewer → /bom is two pages holding
 * the SAME `parsed` object (the design session's). Without this the second
 * mount re-issues the match the first already paid for and opens a second
 * resolve stream, re-spending up to RESOLVE_CAP of the visitor's 100-a-day
 * budget on lines that came back a minute ago. An SPA return to /viewer's BOM
 * tab is the same trip.
 *
 * A WeakMap, so the entry's lifetime IS the ParseResult's — it dies with the
 * design session that holds the parse, needs no TTL and cannot collide with
 * another BOM that happens to share a header signature. `reset()` drops it
 * explicitly: that is the reader saying this answer is finished with.
 *
 * Deliberately not a cache of the NETWORK. It is keyed on object identity, so
 * re-reading the same file (a fresh ParseResult) prices again — nothing here
 * can serve a price from a session the reader has already closed.
 */
interface PricedSnapshot {
  rows: TableRow[];
  resolveNote: string | null;
  resolveError: string | null;
}

const priced = new WeakMap<ParseResult, PricedSnapshot>();

/**
 * File a priced answer against its parse.
 *
 * An EMPTY table is never one. A priced BOM has at least one row by
 * construction — the zero-line guard means `lines.length >= 1` and `buildRows`
 * maps over `lines` — so `rows: []` here can only be the teardown ref caught
 * mid-restore, before the queued `setRows` has committed. StrictMode's
 * mount-only double-invoke (`main.tsx` enables it, so every dev session) opens
 * that window deterministically: restore → cleanup → restore, with the second
 * restore reading a snapshot the first had just blanked. Refusing the write is
 * the whole guard.
 *
 * Rows still `resolving` are SETTLED on the way in — one would otherwise be
 * restored spinning forever with no stream behind it — and their presence is
 * itself a fact the reader needs: those lines were never looked up. Restored
 * bare they read NO MATCH, which says the catalog does not carry the part.
 * `RESOLVE_STOPPED` is the sentence that already owns this, so the snapshot
 * carries it rather than the `null` a healthy stream leaves behind.
 */
function remember(
  target: ParseResult | null,
  rows: TableRow[],
  resolveNote: string | null,
  resolveError: string | null,
): void {
  if (target == null || rows.length === 0) return;
  const stopped = rows.some((row) => row.state === 'resolving');
  priced.set(target, {
    rows: settleStragglers(rows),
    resolveNote,
    resolveError: stopped ? RESOLVE_STOPPED : resolveError,
  });
}

export function cappedNote(dropped: number): string {
  const lines = dropped === 1 ? 'line was' : 'lines were';
  return (
    `Live lookups are capped at ${RESOLVE_CAP} lines per BOM — ` +
    `${dropped.toLocaleString('en-US')} further unmatched ${lines} left unresolved. ` +
    'Request a quote for those lines.'
  );
}

/**
 * Which lines phase 2 asks a distributor about, in the order it asks.
 *
 * MPN'd misses go FIRST: they resolve by an exact part lookup, which is the
 * one call that either finds the part or proves it does not exist. A
 * value+footprint query ("10k 0805") is a keyword search whose first hit is a
 * guess, so when the cap bites it is the guesses that get dropped, never the
 * certainties.
 *
 * DNP lines are not asked about unless the reader has said to include them
 * (spec §5) — nobody is buying them, and a live lookup costs real distributor
 * quota. The toggle is read at the moment the stream STARTS: flipping it
 * afterwards re-counts and re-prices the table from data already in hand, but
 * it never goes and spends more quota behind the reader's back.
 */
export function pickMisses(
  rows: TableRow[],
  includeDnp: boolean,
): { misses: MissIn[]; dropped: number } {
  const withMpn: MissIn[] = [];
  const withoutMpn: MissIn[] = [];
  for (const row of rows) {
    const server = row.server;
    if ((row.dnp && !includeDnp) || server == null || server.status !== 'resolve') continue;
    const query = server.resolve_query;
    if (query == null || query.trim() === '') continue;
    const mpn = row.mpn != null && row.mpn.trim() !== '' ? row.mpn : null;
    (mpn != null ? withMpn : withoutMpn).push({ index: row.index, query, mpn });
  }
  const ordered = [...withMpn, ...withoutMpn];
  return {
    misses: ordered.slice(0, RESOLVE_CAP),
    dropped: Math.max(0, ordered.length - RESOLVE_CAP),
  };
}

/**
 * Phase-1 rows: `matched` means "the server answered"; `not_found` means it
 * did not. The badge then reads the server status, so a `resolve`/`none` row
 * is still `matched` in this sense and simply renders NO MATCH until phase 2
 * moves it.
 *
 * `viewerHref` is the §7.6 seam: null on the standalone tool, a route when a
 * viewer session is what produced these lines.
 */
export function buildRows(
  lines: ParsedBomLine[],
  serverRows: BomRow[],
  viewerHref: string | null,
): TableRow[] {
  const byIndex = new Map(serverRows.map((row) => [row.index, row]));
  return lines.map((line) => {
    const server = byIndex.get(line.index) ?? null;
    return {
      ...line,
      server,
      state: server == null ? ('not_found' as const) : ('matched' as const),
      viewerHref,
    };
  });
}

/** Fold one streamed event into the row it names. Pure so the caller can hand
 *  it to a functional updater: events arrive over tens of seconds and the
 *  closure that started the stream has long since gone stale. */
export function applyResolveEvent(rows: TableRow[], event: ResolveEvent): TableRow[] {
  return rows.map((row) => {
    if (row.index !== event.index) return row;
    switch (event.kind) {
      case 'resolved':
        // A `resolved` with no row is a malformed event; falling back to the
        // phase-1 answer is honest, a permanent spinner is not.
        return event.row == null
          ? { ...row, state: 'matched' as const }
          : { ...row, server: event.row, state: 'resolved_live' as const };
      case 'not_found':
        return { ...row, state: 'not_found' as const };
      case 'resolve_unavailable':
        return { ...row, state: 'unavailable' as const };
      default:
        return row;
    }
  });
}

/** The server emits exactly one event per miss, so nothing should still be
 *  spinning once the stream ends. If something is, the stream died early —
 *  put the row back on its phase-1 answer rather than spin forever. */
export function settleStragglers(rows: TableRow[]): TableRow[] {
  return rows.map((row) => (row.state === 'resolving' ? { ...row, state: 'matched' as const } : row));
}

/** The Matches column's "Similar" pick applied: the fresh match replaces the
 *  answer as approx (relative to what was SUBMITTED it is still a substitute),
 *  the displaced part joins the menu, so the pick stays reversible. */
export function foldSimilarPick(
  rows: TableRow[],
  rowIndex: number,
  sku: string,
  fresh: BomRow,
): TableRow[] {
  if (fresh.part == null) return rows;
  return rows.map((r) => {
    if (r.index !== rowIndex || r.server == null) return r;
    const displaced = r.server.part;
    const keptSimilar = [
      ...(displaced != null
        ? [
            {
              id: displaced.id,
              sku: displaced.sku,
              manufacturer_name: displaced.manufacturer_name,
              description: displaced.description,
              package: displaced.package,
              lifecycle_status: displaced.lifecycle_status,
              lifecycle_verified: displaced.lifecycle_verified,
            },
          ]
        : []),
      ...r.server.similar,
    ].filter((s) => s.sku !== sku);
    return {
      ...r,
      server: {
        ...fresh,
        status: 'approx' as const,
        approx_reason: 'your pick — similar part',
        similar: keptSimilar,
      },
    };
  });
}

export interface BomWorkbench {
  rows: TableRow[];
  matching: boolean;
  matchError: string | null;
  resolveNote: string | null;
  resolveError: string | null;
  buildQty: number;
  setBuildQty: (qty: number) => void;
  includeDnp: boolean;
  setIncludeDnp: (include: boolean) => void;
  pickSimilar: (rowIndex: number, sku: string) => void;
  /**
   * Back to nothing: abandons every in-flight request, aborts the stream and
   * clears every field INCLUDING the reader's build quantity and DNP choice.
   *
   * TERMINAL for the current `parsed`: pricing does not resume on its own, by
   * design — re-issuing a match the reader just cancelled would spend the
   * resolve budget they declined. The hook prices again only when `parsed`
   * changes IDENTITY, so hand in a fresh parse, or `null` and then the same
   * one back.
   *
   * Distinct from handing the hook `null`, which means "nothing to price right
   * now" — that clears the priced result but KEEPS those two settings, so a
   * consumer that re-derives a BOM (closing and reopening a project) does not
   * silently reset the quantity somebody typed. Null-arming is the better lever
   * for "close the project"; `reset()` is "change file".
   */
  reset: () => void;
}

/**
 * Phase 1 runs at most once per IDENTITY of `parsed`, ACROSS MOUNTS: the priced
 * answer is snapshotted against the parse object itself (see `priced` above), so
 * a second page holding the same parse — /bom continuing a /viewer session, or
 * an SPA return to the viewer's BOM tab — restores the table with no network at
 * all. The snapshot's lifetime is the parse object's, which is the design
 * session's; `reset()` drops it.
 *
 * @param parsed  The BOM to price, or null for "nothing to price right now" —
 *   which clears any previous result and abandons work in flight. A parse with
 *   an error, or with NO LINES, is treated exactly as null: `/bom/match` rejects
 *   an empty `lines` array (min_length=1), so asking would buy a 422 and render
 *   it to the reader as "we could not reach the pricing service". Callers hold
 *   this object in state, never rebuild it per render.
 * @param viewerHref  Stamped onto every row (the §7.6 seam) and nothing else.
 *   Deliberately NOT a match input: it may arrive late — `/bom` gains one when
 *   a KiCad project is opened mid-session — and re-matching then would bin a
 *   priced table and re-spend the visitor's daily resolve budget. A change
 *   re-stamps the rows already on screen instead.
 */
export function useBomWorkbench(
  parsed: ParseResult | null,
  viewerHref: string | null,
): BomWorkbench {
  const [rows, setRows] = useState<TableRow[]>([]);
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [buildQty, setBuildQty] = useState(1);
  // Per-BOM, default OFF (spec §5). A ref shadows it because `startResolve`
  // runs from the phase-1 effect and must read the CURRENT answer without
  // re-running the whole match when the reader toggles it.
  const [includeDnp, setIncludeDnp] = useState(false);
  const includeDnpRef = useRef(includeDnp);
  includeDnpRef.current = includeDnp;
  // Phase-2 notes, kept apart from `matchError` because neither is fatal: the
  // table is priced and readable with both of them on screen.
  const [resolveNote, setResolveNote] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  /**
   * THE staleness mechanism. Every async landing answers one question — "does
   * this belong to a workbench that still exists?" — by comparing the
   * generation it was issued under against the current one. Bumped by the four
   * things that end a workbench: a new `parsed`, its teardown, `reset()` and
   * unmount.
   *
   * It replaces an effect-local `cancelled` flag, which `reset()` could not
   * reach: a match landing after a clear used to repopulate the emptied table
   * AND open a fresh stream, spending up to RESOLVE_CAP of the visitor's
   * 100/day resolve budget on a BOM they had just thrown away.
   */
  const genRef = useRef(0);

  /** Read at `buildRows` time rather than depended on — see the doc comment. */
  const viewerHrefRef = useRef(viewerHref);
  viewerHrefRef.current = viewerHref;

  /**
   * Has phase 1 ANSWERED for the current `parsed`? The snapshot guard: an empty
   * table recorded while the match is still on the wire would be restored, on
   * the next mount, as "this BOM priced to nothing".
   */
  const landedRef = useRef(false);

  /** What the teardown snapshot reads — the last COMMITTED state, since an
   *  unmount cleanup with `[]` deps closes over the first render. Assigned
   *  during render, like the two refs above. */
  const latest = useRef<{
    parsed: ParseResult | null;
    rows: TableRow[];
    note: string | null;
    error: string | null;
  }>({ parsed: null, rows: [], note: null, error: null });
  latest.current = { parsed, rows, note: resolveNote, error: resolveError };

  const pickSeqRef = useRef(new Map<number, number>());

  // The resolve stream is a socket THIS tab holds open. Leaving the page drops
  // it; each miss is one bounded server-side call that finishes on its own
  // either way, so aborting costs nothing but the reader. One controller is
  // enough: one stream at a time.
  const resolveAbort = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      genRef.current += 1;
      resolveAbort.current?.abort();
      // Leaving MID-STREAM keeps whatever did come back; `remember` settles the
      // rows still waiting onto their phase-1 answer, exactly as a stream that
      // died would. The settled commits are snapshotted by the effect below —
      // this is the one case that never reaches a settled commit.
      if (landedRef.current) {
        const last = latest.current;
        remember(last.parsed, last.rows, last.note, last.error);
      }
    },
    [],
  );

  /**
   * Phase 2 — the misses go and heal themselves.
   *
   * Owns the `setRows` for the rows it is about to ask about (flipping them to
   * `resolving` in the SAME commit the table first renders in, so no row ever
   * flashes NO MATCH on its way to being looked up).
   */
  const startResolve = useCallback((built: TableRow[]) => {
    // Called synchronously from the match landing, which has already proved
    // its generation current, so reading it here captures the same one.
    const gen = genRef.current;
    const { misses, dropped } = pickMisses(built, includeDnpRef.current);
    setResolveNote(dropped > 0 ? cappedNote(dropped) : null);
    setResolveError(null);
    if (misses.length === 0) {
      setRows(built);
      return;
    }

    const asking = new Set(misses.map((m) => m.index));
    setRows(
      built.map((row) => (asking.has(row.index) ? { ...row, state: 'resolving' as const } : row)),
    );

    // Never two readers on one table: a fresh parse drops the older socket.
    resolveAbort.current?.abort();
    const controller = new AbortController();
    resolveAbort.current = controller;

    bomApi
      .streamResolve(
        misses,
        (event) => {
          // Events buffered before the abort can still arrive. They name row
          // INDICES, so replaying one onto a later BOM would stamp a live
          // price on whatever line happens to sit at that index.
          if (genRef.current !== gen) return;
          setRows((prev) => applyResolveEvent(prev, event));
        },
        controller.signal,
      )
      .then(() => {
        if (genRef.current !== gen) return;
        setRows(settleStragglers);
      })
      .catch(() => {
        // An abort resolves down this path too; there is nobody left to tell.
        if (genRef.current !== gen) return;
        setRows(settleStragglers);
        setResolveError(RESOLVE_STOPPED);
      });
  }, []);

  // Phase 1: ask the catalog about the identity fields, once, per parse —
  // keyed on the IDENTITY of `parsed`, which callers hold in state or in the
  // session. A caller that is not ready to price passes null.
  //
  // The table is deliberately NOT rendered while this is in flight: rows with
  // no server answer yet would all read NO MATCH, which is a lie for the
  // second and a half it takes to come back.
  useEffect(() => {
    genRef.current += 1;
    const gen = genRef.current;
    landedRef.current = false;

    // Nothing to price: abandon the previous BOM's result rather than leave it
    // rendered under a consumer that has closed its project. The build
    // quantity and DNP choice survive — they are the reader's settings, and
    // only `reset()` owns those. The functional updater keeps the array
    // identity when it is already empty, so a null-armed hook never re-renders.
    //
    // A parse with no LINES lands here too, and that is the point: the server's
    // `BomMatchRequest.lines` is min_length=1, so asking about an empty BOM is a
    // guaranteed 422 that the catch below would render as "we could not reach
    // the pricing service" — blaming the network for a schematic that simply had
    // nothing in it. A zero-line BOM is a state, not a failure.
    if (parsed == null || parsed.error != null || parsed.lines.length === 0) {
      resolveAbort.current?.abort();
      setRows((prev) => (prev.length === 0 ? prev : []));
      setMatching(false);
      setMatchError(null);
      setResolveNote(null);
      setResolveError(null);
      return;
    }

    // Already priced under this exact parse — restore it and ask nobody. This
    // is what makes the /viewer → /bom round trip cost ONE match: the second
    // page holds the session's parse, not a copy of it.
    const snapshot = priced.get(parsed);
    if (snapshot != null) {
      landedRef.current = true;
      setRows(snapshot.rows);
      setMatching(false);
      setMatchError(null);
      setResolveNote(snapshot.resolveNote);
      setResolveError(snapshot.resolveError);
      // No cleanup: nothing was started, and bumping the generation here would
      // invalidate the restored answer on the next render.
      return;
    }

    const lines = parsed.lines;
    setRows([]);
    setMatchError(null);
    setMatching(true);

    // D7: IDENTITY FIELDS ONLY. Quantities, designators, the DNP flag and the
    // file itself never leave the browser — the privacy claim is structural,
    // not a promise, and the /bom/match schema rejects anything else. Pricing
    // math runs client-side off the break tables the response carries back.
    bomApi
      .match(
        lines.map((line) => ({
          index: line.index,
          mpn: line.mpn,
          value: line.value,
          footprint: line.footprint,
          description: line.description,
          manufacturer: line.manufacturer,
        })),
      )
      .then((serverRows) => {
        if (genRef.current !== gen) return;
        landedRef.current = true;
        setMatching(false);
        // Hand the rows straight to phase 2 — it owns the setRows, so the
        // lines it is about to look up land already flipped to `resolving`.
        startResolve(buildRows(lines, serverRows, viewerHrefRef.current));
      })
      .catch((err: unknown) => {
        if (genRef.current !== gen) return;
        const throttled = axios.isAxiosError(err) && err.response?.status === 429;
        setMatchError(throttled ? MATCH_THROTTLED : MATCH_FAILED);
        setMatching(false);
      });

    return () => {
      // A new parse invalidates the previous BOM's stream as surely as
      // leaving does — its events name row indices from a table that no
      // longer exists.
      genRef.current += 1;
      resolveAbort.current?.abort();
    };
  }, [parsed, startResolve]);

  /**
   * Keep the snapshot current. Every commit where phase 1 has answered and
   * nothing is still in flight IS an answer worth returning to — the match
   * landing, a stream that found nothing to ask about, the stream settling, and
   * a re-stamped `viewerHref` all arrive here.
   *
   * Mid-stream commits are skipped: a row still waiting is not an answer, and
   * re-recording the whole table on each of up to RESOLVE_CAP events is work
   * nobody reads. The teardown above is what catches a reader who leaves while
   * the stream is running.
   */
  useEffect(() => {
    if (!landedRef.current || matching) return;
    if (rows.some((row) => row.state === 'resolving')) return;
    remember(parsed, rows, resolveNote, resolveError);
  }, [parsed, rows, matching, resolveNote, resolveError]);

  // A viewer route that arrives after the table is priced re-stamps the rows
  // in place. Bailing out on `every` keeps the array identity when nothing
  // changed, so the common case (a stable href, or none) costs one comparison
  // pass and no re-render.
  useEffect(() => {
    setRows((prev) =>
      prev.every((row) => row.viewerHref === viewerHref)
        ? prev
        : prev.map((row) => ({ ...row, viewerHref })),
    );
  }, [viewerHref]);

  /**
   * Re-match this ONE line by the chosen SKU (identity only travels — D7).
   *
   * Two guards, because they answer different questions. The generation says
   * the answer still belongs to THIS BOM — without it a pick made before
   * "Change file" lands on the next BOM's row of the same index and labels
   * somebody else's part "your pick". The per-row sequence says it is still
   * the LATEST pick for that row; overlapping picks settle in network order,
   * so a superseded response must be dropped, not applied (review #4). The
   * generation cannot express that — both clicks share one generation.
   */
  const pickSimilar = useCallback(
    (rowIndex: number, sku: string) => {
      const gen = genRef.current;
      const line = rows.find((r) => r.index === rowIndex);
      const seq = (pickSeqRef.current.get(rowIndex) ?? 0) + 1;
      pickSeqRef.current.set(rowIndex, seq);
      bomApi
        .match([
          {
            index: rowIndex,
            mpn: sku,
            value: null,
            footprint: line?.footprint ?? null,
            description: null,
            manufacturer: null,
          },
        ])
        .then(([fresh]) => {
          if (genRef.current !== gen) return; // another BOM, or cleared
          if (pickSeqRef.current.get(rowIndex) !== seq || fresh == null) return; // superseded
          setRows((prev) => foldSimilarPick(prev, rowIndex, sku, fresh));
        })
        .catch((err) => {
          if (genRef.current !== gen) return; // another BOM, or cleared
          if (pickSeqRef.current.get(rowIndex) !== seq) return; // superseded
          const throttled = axios.isAxiosError(err) && err.response?.status === 429;
          setResolveError(
            throttled ? MATCH_THROTTLED : 'Could not switch to that part — try again in a moment.',
          );
        });
    },
    [rows],
  );

  const reset = useCallback(() => {
    // Bump FIRST: a match already on the wire must not repopulate the table we
    // are about to clear, nor open a stream against it.
    genRef.current += 1;
    resolveAbort.current?.abort();
    // The reader is finished with this answer, so the snapshot goes with it —
    // otherwise handing the same `parsed` back would restore the very table
    // they just cleared, out of a cache they cannot see.
    landedRef.current = false;
    if (latest.current.parsed != null) priced.delete(latest.current.parsed);
    pickSeqRef.current.clear();
    setRows([]);
    setMatchError(null);
    setMatching(false);
    setResolveNote(null);
    setResolveError(null);
    setBuildQty(1);
    setIncludeDnp(false);
  }, []);

  return {
    rows,
    matching,
    matchError,
    resolveNote,
    resolveError,
    buildQty,
    setBuildQty,
    includeDnp,
    setIncludeDnp,
    pickSimilar,
    reset,
  };
}
```

- [ ] **Step 4: Make the BOM page a consumer (no behaviour change)**

In `frontend/src/public/pages/bom/index.tsx`:
- Delete the local `MATCH_FAILED`, `MATCH_THROTTLED`, `RESOLVE_CAP`, `RESOLVE_STOPPED`, `cappedNote`, `pickMisses`, the `rows/matching/matchError/buildQty/includeDnp/includeDnpRef/pickSeqRef/resolveNote/resolveError/resolveAbort` state, `pickSimilar`, `applyResolveEvent`, `settleStragglers`, `startResolve`, the phase-1 effect, and the unmount-abort effect.
- Add `import { useBomWorkbench } from '@public/services/bom/useBomWorkbench';` and, after the `phase/parsed/sourceName/mapRoles` state: `const wb = useBomWorkbench(isShare || phase !== 'table' ? null : parsed, null);` (Task 3.4 replaces the `null` with the viewer route when a session exists).
- The share view keeps read-only rows of its own: `const [shareRows, setShareRows] = useState<TableRow[]>([]); const [shareQty, setShareQty] = useState(1); const [shareDnp, setShareDnp] = useState(false);` and the share-hydration effect sets those three instead of the removed state. Its `<BomTable>` reads `shareRows/shareQty/shareDnp` with `onBuildQtyChange={setShareQty}` and `onIncludeDnpChange={setShareDnp}`.
- The table phase reads `wb.rows`, `wb.matching`, `wb.matchError`, `wb.resolveNote`, `wb.resolveError`, `wb.buildQty`, `wb.setBuildQty`, `wb.pickSimilar`, `wb.includeDnp`, `wb.setIncludeDnp` where the old state was read.
- `startOver` becomes: `wb.reset(); setParsed(null); sourceText.current = ''; setSourceName(null); setMapRoles([]); setPhase('intake');`.

- [ ] **Step 5: Run the gates and a manual no-regression pass**

Run: `cd frontend && npx vitest run src/public/services/bom && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`
Then locally (`docker compose up -d --build frontend`): on `/bom`, "Try the example BOM" prices as before; a similar-pick swaps and is reversible; "Change file" returns to the intake; `/bom/s/<slug>` from a fresh share link renders read-only.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/public/services/bom/useBomWorkbench.ts frontend/src/public/services/bom/bomWorkbench.test.ts frontend/src/public/pages/bom/index.tsx
git commit -m "refactor(bom): useBomWorkbench — match/resolve/qty/DNP/similar-pick lifted out of the page with the reducers exported and tested; no behaviour change"
```

---

> **Landed (2026-09-13, commits 61fcab3 → 0770a66 → 94c0eec):** the blocks above are synced to the landed files. Two review rounds changed the hook's contract from the first draft: (1) `viewerHref` is NOT a dependency of the phase-1 match — it is held in a ref, stamped at `buildRows` time and re-stamped onto existing rows by a separate effect with an identity-preserving bail, so a late-arriving href (Task 3.4's case) never re-matches or aborts the stream; (2) ONE generation ref (bumped by the effect body, its cleanup, `reset()` and unmount) is the staleness rule checked at every async landing — `reset()` therefore invalidates an in-flight match and is TERMINAL for the current `parsed` (hand a new `parsed`, or `null` then a parse, to price again; `null` clears the result but keeps build quantity and DNP); `pickSeqRef` stays beside it because two picks on one row share a generation and only a per-row sequence gives last-click-wins; (3) `frontend/src/public/services/bom/useBomWorkbench.test.ts` (happy-dom harness, `bomApi` mocked, 19 tests, mutation-checked) pins one match per `parsed` identity, the href re-stamp without re-match, stale-parse discard, reset during an in-flight match, null clearing, the stream-failure banner and the terminal reset. Task 3.3 uses `parsed = null` to close a project and reserves `reset()` for "Change file". Under `StrictMode` (dev only) the phase-1 effect double-invokes and a dev network panel shows two `match` calls, the first discarded — not a bug.

### Task 3.2: Designator chips — the viewer route with a `#ref`, and an in-page click (spec §6)

**Files:**
- Create: `frontend/src/public/services/bom/viewerLink.ts`
- Modify: `frontend/src/public/components/bom/BomTable.tsx` (props + chip render), `frontend/src/public/components/bom/BomTable.module.scss` (`.refChipButton`), `frontend/src/public/services/bom/types.ts` (the `viewerHref` doc comment)
- Test: `frontend/src/public/services/bom/viewerLink.test.ts`

**Interfaces:**
- Produces: `viewerRefHref(base: string, ref: string): string`; `BomTable` prop `onRefClick?: (ref: string) => void`.

- [ ] **Step 1: Write the failing test and the helper**

```ts
// frontend/src/public/services/bom/viewerLink.test.ts
import { describe, expect, it } from 'vitest';
import { viewerRefHref } from './viewerLink';

describe('viewerRefHref', () => {
  it('appends the reference as an encoded hash', () => {
    expect(viewerRefHref('/viewer', 'R12')).toBe('/viewer#R12');
    expect(viewerRefHref('/viewer', 'U1/2')).toBe('/viewer#U1%2F2');
  });

  it('keeps a base that already carries a query', () => {
    expect(viewerRefHref('/viewer?doc=x', 'C7')).toBe('/viewer?doc=x#C7');
  });

  it('round-trips through the decode the viewer page does on mount', () => {
    const href = viewerRefHref('/viewer', 'U1/2');
    expect(decodeURIComponent(href.slice(href.indexOf('#') + 1))).toBe('U1/2');
  });
});
```

```ts
// frontend/src/public/services/bom/viewerLink.ts
/** `TableRow.viewerHref` is the viewer ROUTE; the chip appends the reference
 *  as a hash the viewer page reads on mount (spec §6). One home for the
 *  composition so the two sides cannot drift.
 *
 *  `encodeURIComponent` is the pair of the viewer page's `decodeURIComponent`
 *  on `location.hash.slice(1)`: a hierarchical designator ("U1/2") would
 *  otherwise be read back as a path, and a base that already carries a query
 *  ("/viewer?doc=x") keeps it — the hash is appended, never substituted. */
export function viewerRefHref(base: string, ref: string): string {
  return `${base}#${encodeURIComponent(ref)}`;
}
```

Run: `cd frontend && npx vitest run src/public/services/bom/viewerLink.test.ts` → 1 passed.

- [ ] **Step 2: The table**

In `frontend/src/public/components/bom/BomTable.tsx`:
- Add `import { viewerRefHref } from '@public/services/bom/viewerLink';`.
- In `BomTableProps` add:

```ts
  /** In-page focus: when present, designator chips are buttons that call it
   *  and `viewerHref` is ignored. Never both on one table (spec §6). */
  onRefClick?: (ref: string) => void;
```

- Destructure `onRefClick` in the component signature and replace the chip render (the `row.viewerHref != null ? (<Link …>) : (<span …>)` expression) with:

```tsx
                          onRefClick != null ? (
                            <button
                              key={ref}
                              type="button"
                              className={styles.refChipButton}
                              onClick={() => onRefClick(ref)}
                            >
                              {ref}
                            </button>
                          ) : row.viewerHref != null ? (
                            <Link key={ref} className={styles.refChip} to={viewerRefHref(row.viewerHref, ref)}>
                              {ref}
                            </Link>
                          ) : (
                            <span key={ref} className={styles.refChip}>
                              {ref}
                            </span>
                          ),
```

In `BomTable.module.scss`, after `.refChip { … }`:

```scss
.refChipButton {
  @extend .refChip;
  appearance: none;
  border: 0;
  font-weight: inherit;
  line-height: inherit; // `font: inherit` would land AFTER the @extend group and reset the mono family/size
  cursor: pointer;
}
```

In `frontend/src/public/services/bom/types.ts`, replace the `viewerHref` doc comment with:

```ts
/**
 * The viewer ROUTE (`/viewer`) when a design session holds a schematic, else
 * null. The chip appends the reference as a hash via `viewerRefHref`; the
 * viewer page focuses it on mount. When `BomTable` gets `onRefClick` the
 * chips call that instead and this field is ignored.
 */
```

- [ ] **Step 3: Gates and commit**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`

```bash
git add frontend/src/public/services/bom/viewerLink.ts frontend/src/public/services/bom/viewerLink.test.ts frontend/src/public/components/bom/BomTable.tsx frontend/src/public/components/bom/BomTable.module.scss frontend/src/public/services/bom/types.ts
git commit -m "feat(bom): designator chips link to /viewer#ref or focus in place via onRefClick"
```

---

> **Landed (2026-09-13, commits a171441 → 1d12141):** the helper blocks above are synced. The brief's `.refChipButton { font: inherit }` was a defect — Sass emits `@extend`ed declarations at the extendee's position, so the shorthand landed after them and reset the mono family/size (the reviewer compiled the counterfactual); the landed rule inherits only `font-weight` and `line-height`. `BomTable.test.ts` (happy-dom) pins the span/link/button branch, `onRefClick` outranking `viewerHref`, and the per-chip closure on a multi-ref row. The button chip carries `title="Find R12 on the schematic"` and deliberately NO aria-label (the visible designator under the "Designators" header is the accessible name). The prop doc states the precedence rather than forbidding both props — Task 3.4 passes both by design.

### Task 3.3: The BOM tab on `/viewer` (spec §7.1)

**Files:**
- Modify: `frontend/src/public/pages/viewer/index.tsx`

**Interfaces:**
- Consumes: `useBomWorkbench` (3.1), `BomTable` with `onRefClick` (3.2), `ShareBar` (1.1), the `focus` callback and `session` from 2.5.

- [ ] **Step 1: Wire the tab**

In `frontend/src/public/pages/viewer/index.tsx`:
- Imports: `import BomTable from '@public/components/bom/BomTable'; import ShareBar from '@public/components/bom/ShareBar'; import { useBomWorkbench } from '@public/services/bom/useBomWorkbench';`
- State: `const [bomSeen, setBomSeen] = useState(false);` — set to `true` the first time `tab === 'bom'` (an effect: `useEffect(() => { if (tab === 'bom') setBomSeen(true); }, [tab]);`), reset to `false` in `handleProject` and `openAnother`.
- Hook: `const wb = useBomWorkbench(bomSeen && session != null && session.parsed.error == null ? session.parsed : null, null);` — the match runs on the first BOM-tab visit, once per project, and the panel stays mounted after that.
- Tabs: uncomment/add `if (session.project.root != null) out.push({ id: 'bom', label: 'BOM' });`.
- Panel, after the drawing `<div hidden={!drawingVisible}>`:

```tsx
              {bomSeen && (
                <section hidden={tab !== 'bom'} className={styles.bomPanel} aria-label="Bill of materials">
                  {session.parsed.error != null && (
                    <p className={styles.pageError} role="alert">
                      {session.parsed.error}
                    </p>
                  )}
                  {wb.resolveNote != null && <p className={styles.phaseWarn}>{wb.resolveNote}</p>}
                  {wb.matchError != null && (
                    <p className={styles.pageError} role="alert">
                      {wb.matchError}
                    </p>
                  )}
                  {wb.resolveError != null && (
                    <p className={styles.phaseWarn} role="status">
                      {wb.resolveError}
                    </p>
                  )}
                  {wb.matching && (
                    <p className={styles.phaseText} role="status">
                      Pricing {session.parsed.lines.length.toLocaleString('en-US')}{' '}
                      {session.parsed.lines.length === 1 ? 'line' : 'lines'} against the catalog&#8230;
                    </p>
                  )}
                  {!wb.matching && wb.rows.length > 0 && (
                    <>
                      <BomTable
                        rows={wb.rows}
                        buildQty={wb.buildQty}
                        onBuildQtyChange={wb.setBuildQty}
                        onPickSimilar={wb.pickSimilar}
                        includeDnp={wb.includeDnp}
                        onIncludeDnpChange={wb.setIncludeDnp}
                        onRefClick={(ref) => void focus(ref)}
                      />
                      <ShareBar rows={wb.rows} buildQty={wb.buildQty} includeDnp={wb.includeDnp} onChangeFile={openAnother} />
                    </>
                  )}
                </section>
              )}
```

- `openAnother` also calls `wb.reset()`.
- `ViewerPage.module.scss`: add `.bomPanel { margin-top: 4px; }`.

- [ ] **Step 2: Gates, smoke, commit**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`. Locally: load Glasgow → BOM tab prices it (one `/api/bom/match` in the network panel) → switching Schematic ↔ BOM issues no new request → a chip click switches to Schematic and focuses the reference (toast).

```bash
git add frontend/src/public/pages/viewer
git commit -m "feat(viewer): BOM tab — the workbench prices the schematic-derived lines once; chips focus the drawing"
```

---

> **Landed (2026-09-13, commits 4065a68 → 1b4083c → ec85b84 → 7417b23 → 5e47264):** the BOM tab as briefed (`bomSeen` latch, one match per project, `viewerHref` null, chips call `focus`). The three carry-forwards closed: I1 (an effect on `location.hash` sets the pending focus and focuses directly when the canvas is ready), I2 (the designator's sheet is set before `focusRef`), I4 (dropped sheets are marked, with the reason reaching assistive tech). Two review rounds changed the CONTROLLER: (1) I2's early `setActiveSheet` makes `DesignCanvas` fire a superseding `activate`, which used to make `focusRef` answer 'not-found' without selecting (a Critical, measured against the real controller); `focusRef` now rides that activation — a SAME-document supersession is the host echoing the focus, so it selects; a DIFFERENT document can only be the reader picking another sheet mid-flight, so the focus yields with the new `FocusResult` member `'superseded'` (hosts say nothing for it — Task 3.4's `/bom` panel discards the result, but any future toast there needs the same rule). The retry loop and its `FOCUS_ACTIVATE_TRIES` bound were dissolved, not parked. (2) The seam carries "which sheets can't be drawn": `CanvasController.unrenderableSheets?(project)` (KiCanvas: `sourcesFor(project).dropped`), called by `DesignCanvas` at mount START and surfaced through `onUnrenderableSheets` (`[]` when unsupported); the page imports nothing from `kicanvasController.ts`. The page's `focus()` carries a `focusSeq` guard (bumped by `focus` and `chooseSheet`) so an abandoned click never toasts. `viewerPage.test.ts` (happy-dom) pins all of it. Parked to Phase 4: tablist roles/`aria-controls`/roving tabindex (the third tab), the twice-placed-sheet residual (chips address paths, `focusRef` addresses instances), the theoretical three-activation case (would need a focus-generation counter). Dev only: `StrictMode` double-invokes the match effect, so a dev network panel shows two `match` calls with the first discarded.

### Task 3.4: `/bom` accepts KiCad projects, continues from the viewer, shows the schematic (spec §7.2)

**Files:**
- Modify: `frontend/src/public/pages/bom/components/BomIntake.tsx`, `frontend/src/public/pages/bom/index.tsx`, `frontend/src/public/pages/bom/BomPage.module.scss`, `frontend/src/public/components/kicad/DesignCanvas.tsx` (+ `.module.scss`: a `compact` height)

**Interfaces:**
- Consumes: `buildProject`, `KicadReadError`, `openDesign`/`getDesignSession`/`clearDesignSession`, `DesignCanvas`, `viewerRefHref` via `viewerHref`.
- Produces: `BomIntake` props `session?: DesignSession | null; onContinue?: () => void`; `DesignCanvas` prop `height?: 'default' | 'compact'`.

- [ ] **Step 1: `DesignCanvas` compact height**

In `DesignCanvas.tsx` add `height?: 'default' | 'compact'` to the props (default `'default'`) and render `className={height === 'compact' ? `${styles.frame} ${styles.frameCompact}` : styles.frame}`. (`.frameCompact` already exists in `DesignCanvas.module.scss` from Task 2.2.)

- [ ] **Step 2: The intake accepts KiCad files and offers "Continue from the viewer"**

In `BomIntake.tsx`:
- Imports: `import { buildProject } from '@public/services/kicad/project'; import { KicadReadError } from '@public/services/kicad/types'; import { openDesign, type DesignSession } from '@public/services/designSession';`
- `ACCEPT` gains `'application/zip': ['.zip'], 'application/octet-stream': ['.kicad_pro', '.kicad_sch', '.kicad_pcb', '.sch', '.pro'],` and a helper `const KICAD_EXTENSIONS = ['.zip', '.kicad_pro', '.kicad_sch', '.kicad_pcb', '.sch', '.pro'];`.
- Props: `session?: DesignSession | null; onContinue?: () => void;` (both optional; the page passes them).
- A second reader beside `readFile`:

```tsx
  const readKicad = useCallback(
    async (files: File[]) => {
      setBusy(true);
      setError(null);
      try {
        const project = await buildProject(files);
        const next = openDesign(project);
        onParsed(next.parsed, project.name, '');
      } catch (err) {
        setError(err instanceof KicadReadError ? err.message : 'Those KiCad files could not be read. Zip the project folder and drop that.');
      } finally {
        setBusy(false);
      }
    },
    [onParsed],
  );
```

- `onDrop`: keep the rejection branch; then `const kicad = accepted.filter((f) => KICAD_EXTENSIONS.includes(extensionOf(f.name))); if (kicad.length > 0) { void readKicad(kicad); return; } const file = accepted[0]; if (!file) return; void readFile(file);`
- `useDropzone`: `multiple: true`, remove `maxFiles`, add `useFsAccessApi: false`.
- The format line becomes: `CSV&ensp;XLSX&ensp;XLS&ensp;TSV&ensp;&middot;&ensp;KiCad project (.kicad_sch, .kicad_pcb, or a .zip)&ensp;&middot;&ensp;up to 2,000 lines`.
- In `.btnRow`, before "Try the example BOM", when `session != null && onContinue != null`:

```tsx
          {session != null && onContinue != null && (
            <button type="button" className={styles.exampleBtn} onClick={onContinue} disabled={busy}>
              Continue with {session.project.name} from the viewer
            </button>
          )}
```

- The "Your file stays here" info card copy: make sure it reads "Your design files never leave your browser" (never "no upload").

- [ ] **Step 3: The page — session-aware rows, the schematic panel, session clearing**

In `pages/bom/index.tsx`:
- Imports: `import DesignCanvas, { type DesignCanvasHandle } from '@public/components/kicad/DesignCanvas'; import { clearDesignSession, getDesignSession } from '@public/services/designSession';` and `useRef` if not already imported.
- State: `const [showSchematic, setShowSchematic] = useState(false); const canvasRef = useRef<DesignCanvasHandle>(null);`
- `const session = getDesignSession();` (module state; re-read every render) and `const viewerHref = session?.project.root != null ? '/viewer' : null;`
- Hook call becomes `const wb = useBomWorkbench(isShare || phase !== 'table' ? null : parsed, viewerHref);`
- `handleParsed` is unchanged (a KiCad drop hands it a ready-mapped result with `text = ''`; `needsMapping` is false; it goes to `'table'`).
- `const continueFromViewer = () => { const s = getDesignSession(); if (s == null) return; handleParsed(s.parsed, s.project.name, ''); };`
- `<BomIntake onParsed={handleParsed} session={session} onContinue={continueFromViewer} />`
- `startOver` additionally: `clearDesignSession(); setShowSchematic(false);`
- In the table phase, before `<BomTable …>` (inside the `!wb.matching && wb.rows.length > 0` branch, above the table), when `session?.project.root != null`:

```tsx
                  <div className={styles.schematicBar}>
                    <button type="button" className={styles.pasteToggle} onClick={() => setShowSchematic((v) => !v)}>
                      {showSchematic ? 'Hide schematic' : 'Show schematic'}
                    </button>
                  </div>
                  {showSchematic && (
                    <div className={styles.schematicPanel}>
                      <DesignCanvas ref={canvasRef} project={session.project} view="schematic" height="compact" />
                    </div>
                  )}
```

- `<BomTable …>` gains `onRefClick={showSchematic ? (ref) => void canvasRef.current?.focusRef(ref, session?.refs.get(ref)?.instancePath) : undefined}` — while the panel is open chips focus in place; while closed they link to `/viewer#ref` through `viewerHref`.
- `BomPage.module.scss`: add

```scss
.schematicBar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}

.schematicPanel {
  margin-bottom: 14px;
}
```

- [ ] **Step 4: Gates, smoke, commit**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`. Locally: drop the Glasgow zip on `/bom` → prices without the mapper; "Show schematic" mounts the drawing at 45vh; a chip click focuses; hide it and chips become links to `/viewer#ref`; the CSV example and the paste path still work; from `/viewer` (project loaded) navigate to `/bom` → "Continue with glasgow from the viewer" prices it with one request.

```bash
git add frontend/src/public/pages/bom frontend/src/public/components/kicad/DesignCanvas.tsx frontend/src/public/components/kicad/DesignCanvas.module.scss
git commit -m "feat(bom): the drop zone takes a KiCad project, continues from the viewer, and shows the schematic beside the table"
```

- [ ] **Step 5: STOP — Phase 3 gate**

Rebuild the local stack. Owner checklist: price Glasgow from `/viewer` (BOM tab) and from `/bom` (drop the zip); click chips both ways (`/bom` → `/viewer#ref` focuses; the viewer's BOM tab focuses in place); `/bom` CSV example and paste rows still price; `/bom/s/<slug>` shares still render; the network panel shows one `/api/bom/match` for a `/viewer` → `/bom` "Continue" round trip. Wait for explicit approval before Phase 4.

---

> **Task 3.4 landed (2026-09-13, commits d02f8de → 882379b → 07c246e → 469e541 → 23c63ba):** `/bom` accepts a KiCad project, continues from the viewer, shows the schematic at a compact height beside the table. Corrections to the text above: (1) the panel/href gate is NOT `session?.project.root != null` (true for ANY open project — a CSV dropped after a `/viewer` visit would have borrowed an unrelated schematic and "Change file" would have destroyed it); it is `design = session != null && parsed === session.parsed ? session : null`, the identity the workbench keys its one match on, and session clearing is conditional on it; (2) `openDesign` is called only once the project is usable for pricing (schematic root + `error == null` + at least one line) — a board-only or over-cap drop shows its message and opens NO session on `/bom`; the Continue offer uses the same predicate; (3) `.frameCompact` did NOT exist before this task (added, with a `:fullscreen` override), and `.schematicPanel` must be a flex COLUMN (absolute children in a flex row resolve to zero width); (4) the hook never issues a match for zero lines, and keeps a module-level per-`parsed` SNAPSHOT (`WeakMap` keyed by the parse object: rows + note, written when the match lands and when the stream settles or the page unmounts, refusing an empty table and carrying `RESOLVE_STOPPED` for rows still resolving; dropped by `reset()`; hydrated on mount with zero requests) — so viewer → BOM tab → `/bom` → Continue costs ONE match and ONE stream, and an SPA re-entry to `/viewer`'s BOM tab does not re-price; (5) a chip clicked while the panel is still rendering is held until the canvas reports ready (the `FocusResult` is still discarded on `/bom` — no toast, `'superseded'` must never toast); (6) the failed/throttled-match state always renders the ShareBar/"Change file" exit. Repo-wide test fact found here: vitest runs `css: false`, so a CSS-module import ECHOES THE KEY — `styles.x` is truthy whether or not the rule exists; a rule's existence needs a source-level SCSS witness (see `bomPage.test.ts`). Parked for the final review: the phone `touch-action` trap of the panel (same as `/viewer`'s canvas), module state read during render (the brief's design), the snapshot's silent price age (a "priced N minutes ago" line is the honest fix; see the standing `price_stale` decision), the silent `/bom` focus on a genuinely missing designator, and a one-commit "Change file" flash before `matching` flips.

# Phase 4 — The stackup panel

### Task 4.1: Pure layout helpers for the panel (spec §7.3)

**Files:**
- Create: `frontend/src/public/components/kicad/stackupLayout.ts`
- Test: `frontend/src/public/components/kicad/stackupLayout.test.ts`

**Interfaces:**
- Consumes: `BoardStackup`, `StackupRow`, `CopperLayer`, `ViaGroup` (1.2).
- Produces: `tableRows(s): StackupTableRow[]`, `summarize(s): StackupSummary`, `bands(s, heightPx): Band[]`, `viaSpans(s, bands): ViaSpan[]`, `formatMm(n | null): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/public/components/kicad/stackupLayout.test.ts
import { describe, expect, it } from 'vitest';
import type { BoardStackup } from '@public/services/kicad/types';
import { bands, formatMm, minHeightPx, summarize, tableRows, viaSpans } from './stackupLayout';

const FULL: BoardStackup = {
  copperLayers: [{ ordinal: 1, name: 'F.Cu', kind: 'Signal' }, { ordinal: 2, name: 'In1.Cu', kind: 'Plane' }, { ordinal: 3, name: 'B.Cu', kind: 'Signal' }],
  stackup: [
    { name: 'F.SilkS', type: 'Top Silk Screen', thicknessMm: null, material: null, epsilonR: null, lossTangent: null },
    { name: 'F.Mask', type: 'Top Solder Mask', thicknessMm: 0.01, material: null, epsilonR: null, lossTangent: null },
    { name: 'F.Cu', type: 'copper', thicknessMm: 0.035, material: null, epsilonR: null, lossTangent: null },
    { name: 'dielectric 1', type: 'prepreg', thicknessMm: 0.1, material: 'FR4', epsilonR: 4.5, lossTangent: 0.02 },
    { name: 'In1.Cu', type: 'copper', thicknessMm: 0.018, material: null, epsilonR: null, lossTangent: null },
    { name: 'dielectric 2', type: 'core', thicknessMm: 1.0, material: 'FR4', epsilonR: 4.5, lossTangent: 0.02 },
    { name: 'B.Cu', type: 'copper', thicknessMm: 0.035, material: null, epsilonR: null, lossTangent: null },
  ],
  copperFinish: 'ENIG',
  listedThicknessMm: 1.198,
  designThicknessMm: 1.2,
  vias: [{ type: 'through', start: 'F.Cu', end: 'B.Cu', count: 40 }, { type: 'blind', start: 'F.Cu', end: 'In1.Cu', count: 3 }, { type: 'unknown', start: 'F.Cu', end: 'B.Cu', count: 1 }],
  layerCount: 3,
};
const BARE: BoardStackup = { ...FULL, stackup: null, copperFinish: null, listedThicknessMm: null };
// KiCad's Board Setup offers Mixed and Jumper beside Signal and Plane.
const MIXED: BoardStackup = {
  ...FULL,
  copperLayers: [
    { ordinal: 1, name: 'F.Cu', kind: 'Signal' }, { ordinal: 2, name: 'In1.Cu', kind: 'Mixed' },
    { ordinal: 3, name: 'In2.Cu', kind: 'Jumper' }, { ordinal: 4, name: 'B.Cu', kind: 'Signal' },
  ],
  layerCount: 4,
};
/** A kind `boardStackup` has no mapping for is passed straight through, and a
 *  `.Cu` row written with no type atom reads as the empty string. Both are real
 *  outputs of the reader, and neither is Signal, Plane, Mixed or Jumper. */
const UNNAMED: BoardStackup = {
  ...FULL,
  copperLayers: [
    { ordinal: 1, name: 'F.Cu', kind: 'Signal' }, { ordinal: 2, name: 'In1.Cu', kind: 'user_defined' },
    { ordinal: 3, name: 'In2.Cu', kind: '' }, { ordinal: 4, name: 'B.Cu', kind: 'Signal' },
  ],
  layerCount: 4,
};
/** 6 measured rows at MIN_BAND 2, plus F.SilkS at HAIRLINE 1. */
const FLOORS = 13;
/** Glasgow revC3's own shape — 13 physical rows, 9 of them measured — which is
 *  where the 22px floor quoted in `bands`' and `minHeightPx`' doc blocks, and
 *  relied on by the panel, comes from. */
const GLASGOW_SHAPE: BoardStackup = {
  ...FULL,
  stackup: ['F.SilkS', 'F.Paste', 'F.Mask', 'F.Cu', 'dielectric 1', 'In1.Cu', 'dielectric 2', 'In2.Cu', 'dielectric 3', 'B.Cu', 'B.Mask', 'B.Paste', 'B.SilkS'].map(
    (name, i) => ({
      name,
      type: name.endsWith('.Cu') ? 'copper' : 'core',
      // Only the 9 rows Glasgow records a thickness for; silk and paste carry none.
      thicknessMm: /SilkS|Paste/.test(name) ? null : 0.1,
      material: null,
      epsilonR: null,
      lossTangent: null,
    }),
  ),
};

describe('tableRows', () => {
  it('renders the physical stack in file order with copper ordinals joined by name', () => {
    expect(tableRows(FULL).map((r) => [r.ordinal, r.layer, r.type, r.thk])).toEqual([
      ['-', 'F.SilkS', 'Top Silk Screen', '—'], ['-', 'F.Mask', 'Top Solder Mask', '0.0100'], ['1', 'F.Cu', 'Signal', '0.0350'],
      ['-', 'dielectric 1', 'prepreg', '0.1000'], ['2', 'In1.Cu', 'Plane', '0.0180'], ['-', 'dielectric 2', 'core', '1.0000'], ['3', 'B.Cu', 'Signal', '0.0350'],
    ]);
  });
  it('degrades to the copper rows alone when the board has no stackup block', () => {
    expect(tableRows(BARE).map((r) => [r.ordinal, r.layer, r.type, r.thk])).toEqual([['1', 'F.Cu', 'Signal', '—'], ['2', 'In1.Cu', 'Plane', '—'], ['3', 'B.Cu', 'Signal', '—']]);
  });
});

describe('summarize', () => {
  it('counts what the file carries and labels the two thicknesses separately', () => {
    expect(summarize(FULL)).toEqual({ total: 3, signal: 2, plane: 1, mixed: 0, jumper: 0, other: 0, dielectric: 2, listed: '1.1980 mm', design: '1.2000 mm', thru: 40, blindBuried: 3, micro: 0, unknown: 1, finish: 'ENIG' });
    expect(summarize(BARE)).toMatchObject({ dielectric: 0, listed: null, design: '1.2000 mm', finish: null });
    // Four decimals in BOTH places: a total printed to a different precision
    // than the rows it sums invites the reader to check the arithmetic and find
    // it wrong.
    expect(summarize(FULL).listed).toBe(`${formatMm(FULL.listedThicknessMm)} mm`);
    // A non-finite figure is no figure — `toFixed` would have printed
    // "Infinity mm" as though the file had said it.
    expect(summarize({ ...FULL, listedThicknessMm: Infinity, designThicknessMm: NaN })).toMatchObject({ listed: null, design: null });
  });
  it('accounts for a copper kind it cannot name at all, so the buckets still add up', () => {
    const s = summarize(UNNAMED);
    expect([s.signal, s.plane, s.mixed, s.jumper, s.other]).toEqual([2, 0, 0, 0, 2]);
    // The invariant the strip is read against: every copper layer lands in
    // exactly one bucket, whatever KiCad called it.
    expect(s.signal + s.plane + s.mixed + s.jumper + s.other).toBe(UNNAMED.copperLayers.length);
    // …and a board using only the named kinds has nothing left over.
    expect(summarize(FULL).other).toBe(0);
    expect(summarize(MIXED).other).toBe(0);
  });

  it('accounts for the copper kinds that are neither signal nor plane', () => {
    const s = summarize(MIXED);
    expect([s.total, s.signal, s.plane, s.mixed, s.jumper]).toEqual([4, 2, 0, 1, 1]);
    expect(s.signal + s.plane + s.mixed + s.jumper).toBe(s.total);
  });
});

describe('bands and viaSpans', () => {
  it('scales thicknesses to the height, gives thickness-less rows a hairline, and spans vias between real layers', () => {
    const b = bands(FULL, 240);
    expect(b).toHaveLength(7);
    expect(b[0]).toMatchObject({ name: 'F.SilkS', kind: 'other', h: 1 });
    expect(b.find((x) => x.name === 'dielectric 2')?.h).toBeGreaterThan(b.find((x) => x.name === 'F.Cu')?.h ?? 0);
    expect(b[b.length - 1]!.y + b[b.length - 1]!.h).toBeLessThanOrEqual(240);
    const spans = viaSpans(FULL, b);
    expect(spans.map((s) => [s.type, s.count])).toEqual([['through', 40], ['blind', 3], ['unknown', 1]]);
    const through = spans[0]!;
    expect(through.y1).toBeLessThan(through.y2);
    expect(viaSpans(BARE, bands(BARE, 240))).toHaveLength(3);
  });
});

describe('formatMm', () => {
  it('prints four decimals or an em dash', () => {
    expect(formatMm(0.035)).toBe('0.0350');
    expect(formatMm(null)).toBe('—');
  });
});

describe('bands geometry', () => {
  it('fills the box exactly, floors every band, and keeps the file order contiguous', () => {
    for (const h of [240, 100, 26, 240.7, 199.33]) {
      const b = bands(FULL, h);
      expect(b[b.length - 1]!.y + b[b.length - 1]!.h).toBe(h);
      // Contiguous to the last drawable decimal. A seam is ONE accumulated
      // value, so the only difference is the sub-ULP of reading it back as
      // y + (bottom - y) — measured at 1.4e-14px on one seam of the 100px box.
      const seams = b.map((x, i) => (i === 0 ? 0 : Math.abs(x.y - (b[i - 1]!.y + b[i - 1]!.h))));
      expect(Math.max(...seams)).toBeLessThan(1e-9);
      expect(b.map((x) => x.name)).toEqual(FULL.stackup!.map((r) => r.name));
      expect(b[0]!.h).toBe(1);
      expect(Math.min(...b.slice(1).map((x) => x.h))).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps every row at its floor when the box is too small, absent, or not a number', () => {
    for (const h of [FLOORS, 12, 1, 0, -5, NaN, Infinity, -Infinity]) {
      const b = bands(FULL, h);
      expect(b[0]!.h).toBe(1);
      expect(b.slice(1).map((x) => x.h)).toEqual([2, 2, 2, 2, 2, 2]);
      expect(b[b.length - 1]!.y + b[b.length - 1]!.h).toBe(FLOORS);
    }
  });

  it('classifies each physical row so the cross-section can colour it', () => {
    expect(bands(FULL, 240).map((x) => x.kind)).toEqual(['other', 'mask', 'copper', 'dielectric', 'copper', 'dielectric', 'copper']);
    expect(bands(BARE, 240).map((x) => x.kind)).toEqual(['copper', 'copper', 'copper']);
  });
});

describe('minHeightPx', () => {
  it('reports the very floors bands reserves, for a real 13-row board and a bare one', () => {
    expect(minHeightPx(FULL)).toBe(FLOORS);
    // 9 measured at 2 + 4 unmeasured at 1 — the 22 both doc blocks quote.
    expect(minHeightPx(GLASGOW_SHAPE)).toBe(22);
    // No stackup block: every copper layer weighs the same, so none is a hairline.
    expect(minHeightPx(BARE)).toBe(6);
  });

  it('is exactly the height at which bands stops overflowing its box', () => {
    for (const s of [FULL, GLASGOW_SHAPE, BARE]) {
      const floor = minHeightPx(s);
      const bottom = (h: number) => {
        const b = bands(s, h);
        return b[b.length - 1]!.y + b[b.length - 1]!.h;
      };
      // At the floor it lands exactly; one pixel under, it draws PAST the box
      // it was given — which is what a caller clamping to this number avoids.
      expect(bottom(floor)).toBe(floor);
      expect(bottom(floor - 1)).toBe(floor);
      expect(bottom(floor + 40)).toBe(floor + 40);
    }
  });
});

describe('viaSpans lanes', () => {
  it('numbers lanes by drawn order, so a group it cannot anchor leaves no empty lane', () => {
    const drawn = bands(FULL, 240);
    expect(viaSpans(FULL, drawn).map((v) => v.x)).toEqual([24, 42, 60]);
    const orphan: BoardStackup = {
      ...FULL,
      vias: [FULL.vias[0]!, { type: 'micro', start: 'In8.Cu', end: 'In9.Cu', count: 2 }, FULL.vias[1]!],
    };
    expect(viaSpans(orphan, drawn).map((v) => [v.type, v.x])).toEqual([['through', 24], ['blind', 42]]);
  });

  it('drops a via whose two ends land on the same band', () => {
    const same: BoardStackup = { ...FULL, vias: [{ type: 'through', start: 'F.Cu', end: 'F.Cu', count: 9 }] };
    expect(viaSpans(same, bands(same, 240))).toEqual([]);
  });
});

describe('formatMm', () => {
  it('never renders a non-finite figure as a number', () => {
    expect([formatMm(NaN), formatMm(Infinity), formatMm(-Infinity)]).toEqual(['—', '—', '—']);
    expect(formatMm(0)).toBe('0.0000');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/public/components/kicad/stackupLayout.test.ts` → FAIL (cannot resolve `./stackupLayout`).

- [ ] **Step 3: Write the helpers**

```ts
// frontend/src/public/components/kicad/stackupLayout.ts
// Pure geometry and rows for StackupPanel (spec §7.3): the physical stack in
// file order joined to copper ordinals by name; counts of what the file
// carries; scaled bands for the cross-section; via spans between REAL layers.
// Absent facts are dashes, never defaults.
import type { BoardStackup, StackupRow, ViaType } from '@public/services/kicad/types';

export interface StackupTableRow {
  ordinal: string;
  layer: string;
  type: string;
  thk: string;
}

export interface StackupSummary {
  total: number;
  signal: number;
  plane: number;
  mixed: number;
  jumper: number;
  /** Copper rows whose kind this reader could not name — see `summarize`. */
  other: number;
  dielectric: number;
  listed: string | null;
  design: string | null;
  thru: number;
  blindBuried: number;
  micro: number;
  unknown: number;
  finish: string | null;
}

export type BandKind = 'copper' | 'dielectric' | 'mask' | 'other';

export interface Band {
  name: string;
  kind: BandKind;
  y: number;
  h: number;
}

export interface ViaSpan {
  type: ViaType;
  count: number;
  x: number;
  y1: number;
  y2: number;
}

/** All `bands` needs of a row — so a board with no stackup block can stand its
 *  copper layers in for the physical rows without inventing the rest. */
type BandRow = Pick<StackupRow, 'name' | 'type' | 'thicknessMm'>;

const DIELECTRIC = new Set(['core', 'prepreg']);
const HAIRLINE = 1;
const MIN_BAND = 2;
/** Where the first via lane sits and how far apart the lanes are drawn. A board
 *  with many blind and micro spans can group into a dozen lanes, so the last
 *  one sits at LANE_X + 11 × LANE_PITCH — the panel owns whether that fits. */
const LANE_X = 24;
const LANE_PITCH = 18;
/** What a figure the file never carried reads as. */
const ABSENT = '—';

/** Four decimals of a millimetre, or the placeholder. A thickness that is null
 *  (never recorded) or non-finite reads as absent — never "0", never "NaN". */
export function formatMm(value: number | null): string {
  return value != null && Number.isFinite(value) ? value.toFixed(4) : ABSENT;
}

/** A row's thickness when the file recorded a usable one. Both null (never
 *  recorded) and 0 (a row of no height) come back null, because neither can be
 *  weighed in a proportional stack — the TABLE is where the two stay apart,
 *  since formatMm renders 0 as "0.0000" and null as the placeholder. */
/** A millimetre figure with its unit, or null when there is no figure. ONE
 *  formatter for the Thk column and for the two totals (via `formatMm`), so the
 *  table and the summary can never print the same number to different
 *  precisions — and so a raw IEEE sum like 1.5999999999999999, which the reader
 *  keeps unrounded ON PURPOSE because its contract is "the sum of what the file
 *  lists", is rounded HERE, in the view, where it belongs. A non-finite figure
 *  is no figure: null, never "Infinity mm". */
function mmWithUnit(value: number | null): string | null {
  return value == null || !Number.isFinite(value) ? null : `${formatMm(value)} mm`;
}

function measuredMm(r: BandRow): number | null {
  return r.thicknessMm != null && r.thicknessMm > 0 ? r.thicknessMm : null;
}

function kindOf(name: string, type: string): BandKind {
  if (name.endsWith('.Cu') || type === 'copper') return 'copper';
  if (DIELECTRIC.has(type)) return 'dielectric';
  if (/mask/i.test(type)) return 'mask';
  return 'other';
}

export function tableRows(s: BoardStackup): StackupTableRow[] {
  if (s.stackup == null) {
    return s.copperLayers.map((c) => ({ ordinal: String(c.ordinal), layer: c.name, type: c.kind, thk: formatMm(null) }));
  }
  const ordinalByName = new Map(s.copperLayers.map((c) => [c.name, c]));
  return s.stackup.map((row) => {
    const copper = ordinalByName.get(row.name);
    return {
      ordinal: copper == null ? '-' : String(copper.ordinal),
      layer: row.name,
      type: copper == null ? row.type : copper.kind,
      thk: formatMm(row.thicknessMm),
    };
  });
}

/** What the file carries, counted. The four copper kinds are all reported —
 *  KiCad's Board Setup offers Mixed and Jumper beside Signal and Plane, and a
 *  board using one would otherwise read "4 layers · 2 signal · 1 plane" and
 *  leave a layer unaccounted for. `other` closes that gap for a kind the reader
 *  cannot name at all, so the five buckets sum to the copper count ALWAYS —
 *  each layer's kind is one string, so no layer is counted twice and the
 *  remainder can never go negative. */
export function summarize(s: BoardStackup): StackupSummary {
  const vias = (t: ViaType) => s.vias.filter((g) => g.type === t).reduce((n, g) => n + g.count, 0);
  const kind = (k: string) => s.copperLayers.filter((c) => c.kind === k).length;
  const signal = kind('Signal');
  const plane = kind('Plane');
  const mixed = kind('Mixed');
  const jumper = kind('Jumper');
  return {
    total: s.layerCount,
    signal,
    plane,
    mixed,
    jumper,
    // The copper rows none of the four named buckets claimed. `boardStackup`
    // passes a token it has no mapping for straight through, and a `.Cu` row
    // written with no type atom reads as the empty string — so a board KiCad
    // has learned a new layer kind for still adds up. Counted as the REMAINDER
    // rather than by listing tokens: the five buckets then sum to the copper
    // count for every kind, named or not, and no layer can go unaccounted for.
    other: s.copperLayers.length - signal - plane - mixed - jumper,
    dielectric: s.stackup == null ? 0 : s.stackup.filter((r) => DIELECTRIC.has(r.type)).length,
    listed: mmWithUnit(s.listedThicknessMm),
    design: mmWithUnit(s.designThicknessMm),
    thru: vias('through'),
    blindBuried: vias('blind'),
    micro: vias('micro'),
    unknown: vias('unknown'),
    finish: s.copperFinish,
  };
}

/** The rows `bands` draws: the physical stackup when the file has one, else the
 *  copper layers standing in for it. */
function drawableRows(s: BoardStackup): BandRow[] {
  return s.stackup ?? s.copperLayers.map((c) => ({ name: c.name, type: 'copper', thicknessMm: null }));
}

/** How a row is weighed and how short it is allowed to get. ONE home, because
 *  `minHeightPx` is only worth anything if it reports the very floors `bands`
 *  reserves — two copies of this rule would drift, and the panel would size its
 *  box to a number the layout does not share. */
function scale(rows: BandRow[]): { weigh: (r: BandRow) => number; floorOf: (r: BandRow) => number } {
  const anyMeasured = rows.some((r) => measuredMm(r) != null);
  const weigh = (r: BandRow): number => (anyMeasured ? (measuredMm(r) ?? 0) : 1);
  return { weigh, floorOf: (r: BandRow): number => (weigh(r) > 0 ? MIN_BAND : HAIRLINE) };
}

/** The shortest box this stack fits in: the sum of the per-row floors `bands`
 *  reserves before it shares out any remainder. A real 13-row board returns 22.
 *
 *  A caller that sizes its own drawing box MUST NOT go below this. `bands` keeps
 *  the floors and overflows a box too short for them — which is the honest
 *  choice for the geometry, and invisible in an SVG, where the overflow is
 *  simply clipped away outside the viewBox. */
export function minHeightPx(s: BoardStackup): number {
  const rows = drawableRows(s);
  const { floorOf } = scale(rows);
  return rows.reduce((n, r) => n + floorOf(r), 0);
}

/** The physical rows as a drawable column. A row's thickness is its weight, so
 *  a 1mm core towers over a 35um foil; rows the file never measured get a
 *  hairline. Every drawn row is reserved its minimum height FIRST and only the
 *  remainder is shared out by weight — a minimum added after the split would
 *  push the stack past the box it is drawn in. Bottoms are accumulated rather
 *  than heights summed, so the last row lands exactly on heightPx (a fractional
 *  height included) instead of drifting a rounding error past it. Without a
 *  stackup block the copper layers weigh the same and are drawn as equal bands,
 *  so the via spans still have anchors to run between.
 *
 *  A box too short for the reserved minimums themselves — below 22px for a real
 *  13-row board — keeps the minimums and overflows rather than shrink every row
 *  to a sub-pixel sliver that reports success and shows nothing. A heightPx that
 *  is not a finite number is read as no room at all and gets that same floor
 *  layout, so 0, a negative and NaN all behave the one way. */
export function bands(s: BoardStackup, heightPx: number): Band[] {
  const box = Number.isFinite(heightPx) ? heightPx : 0;
  const rows = drawableRows(s);
  const { weigh, floorOf } = scale(rows);
  const totalWeight = rows.reduce((n, r) => n + weigh(r), 0);
  const floors = rows.reduce((n, r) => n + floorOf(r), 0);
  const spare = Math.max(0, box - floors);
  let seen = 0;
  let reserved = 0;
  let y = 0;
  return rows.map((r) => {
    seen += weigh(r);
    reserved += floorOf(r);
    const bottom = totalWeight > 0 ? reserved + (seen / totalWeight) * spare : reserved;
    const band: Band = { name: r.name, kind: kindOf(r.name, r.type), y, h: bottom - y };
    y = bottom;
    return band;
  });
}

/** One lane per via group, run between the centres of the bands it connects.
 *  Lanes are numbered by DRAWN order, not by position in the file's groups, so
 *  a group this stack cannot anchor leaves no empty lane behind it. */
export function viaSpans(s: BoardStackup, drawn: Band[]): ViaSpan[] {
  const centre = (name: string): number | null => {
    const b = drawn.find((x) => x.name === name);
    return b == null ? null : b.y + b.h / 2;
  };
  const out: ViaSpan[] = [];
  for (const g of s.vias) {
    const a = centre(g.start);
    const z = centre(g.end);
    // Both ends have to be drawn for a span to mean anything, and both ends on
    // ONE band would draw as a zero-length line — invisible, and it would carry
    // its own count label out of sight with it.
    if (a == null || z == null || a === z) continue;
    out.push({
      type: g.type,
      count: g.count,
      x: LANE_X + out.length * LANE_PITCH,
      y1: Math.min(a, z),
      y2: Math.max(a, z),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run, gate, commit**

Run: `cd frontend && npx vitest run src/public/components/kicad/stackupLayout.test.ts && npx tsc -b && npx eslint --ext .ts,.tsx src/` → all passed.

```bash
git add frontend/src/public/components/kicad/stackupLayout.ts frontend/src/public/components/kicad/stackupLayout.test.ts
git commit -m "feat(viewer): stackup layout helpers — rows joined by name, honest summary, scaled bands, real via spans"
```

---

> **Task 4.1 landed (2026-09-14, commits 41d2fe6 → 9529e4b):** blocks synced. The brief's `bands()` was wrong — it applied the `MIN_BAND` floor after the proportional split had spent the budget, so its own test failed at 240.0050083472454; the landed algorithm reserves floors first, shares the remainder by weight and accumulates bottoms so the last band lands on `heightPx` exactly (hand-verified at 240/100/26/25/22/240.7; seams pinned to < 1e-9 rather than bit-exact). `summarize` counts EVERY copper kind (`mixed` and `jumper` buckets added; Task 4.2 adds `other` for unrecognised kind tokens so the buckets sum to the copper count). `viaSpans` numbers lanes by drawn order and skips zero-length spans; non-finite heights and values take the floor layout / placeholder. The floors' sum (22px for a 13-row board) is documented on `bands` — Task 4.2 exports `minHeightPx(s)` and clamps its box to it.

### Task 4.2: `StackupPanel` and the Stackup tab (spec §7.3)

**Files:**
- Create: `frontend/src/public/components/kicad/StackupPanel.tsx`, `frontend/src/public/components/kicad/StackupPanel.module.scss`
- Modify: `frontend/src/public/pages/viewer/index.tsx`

**Interfaces:**
- Consumes: `readStackup` (1.7), the helpers (4.1), `session.project.board`.
- Produces: `<StackupPanel stackup={BoardStackup} />`.

- [ ] **Step 1: Write the panel**

```tsx
// frontend/src/public/components/kicad/StackupPanel.tsx
// The owner's Altium 365 Viewer reference (docs/design-briefs/pcb-viewer-
// stackup-reference.md): cross-section, layer table, summary. A field the file
// does not carry is a dash; a board without a saved stackup says so and shows
// the copper layers and via counts the file does carry.
//
// Every number here is read from the file by `boardStackup` and arranged by
// `stackupLayout` — this component owns only the drawing box and the wording.
import { Fragment, useMemo } from 'react';
import type { BoardStackup, ViaType } from '@public/services/kicad/types';
import { bands, minHeightPx, summarize, tableRows, viaSpans, type Band, type BandKind } from './stackupLayout';
import styles from './StackupPanel.module.scss';

/**
 * The drawing box, in viewBox units.
 *
 * The svg is `width="100%"`, so ONE unit is not one pixel: everything inside
 * scales with the column. WIDTH is deliberately close to the narrowest column
 * the zones grid can hand it (220px), which keeps that scale near 1 rather
 * than shrinking a 10-unit label into an unreadable 6px — measured at the
 * tablet worst case (a ~243px column) as 9.3px, and 12.5px at a 390px phone
 * where the grid has already reflowed to one column.
 *
 * HEIGHT is a starting point, not a promise: a stack with more rows than it can
 * floor is drawn in a taller box instead (see `height` below).
 */
const WIDTH = 260;
const HEIGHT = 240;
/** The board itself. Its left edge is where the leader lines land; the gutter
 *  to its left holds the labels, which are the widest text in the figure
 *  ("dielectric 1" is 12 characters of mono). */
const STACK_X = 96;
const STACK_W = 158;
const LABEL_X = 86;
const LEADER_X = 88;
/** Two label centres closer together than this would overlap at the font size
 *  `.label` sets. Kept here rather than in the stylesheet because it is
 *  geometry the placement below has to reason about, and the two are checked
 *  against each other by test. */
const LABEL_GAP = 12;
/** A via lane is drawn in from the board's RIGHT edge. Any lane the helper puts
 *  further in than this would escape the board's left edge and be drawn over
 *  the labels, which would read as a barrel through nothing. */
const LANE_LIMIT = STACK_W - 4;
/** A figure this file never carried. One constant rather than an em dash typed
 *  at each of the sites that need it — and a JS string rather than JSX text,
 *  which is the form edit tooling has mangled into visible escapes before. */
const ABSENT = '—';

/** Band kind → its class. A record rather than an interpolated class name, so
 *  a new `BandKind` is a type error here instead of a silently unstyled band. */
const BAND_CLASS: Record<BandKind, string> = {
  copper: 'bandCopper',
  dielectric: 'bandDielectric',
  mask: 'bandMask',
  other: 'bandOther',
};

/** Via type → its class, for the same reason. */
const VIA_CLASS: Record<ViaType, string> = {
  through: 'viaThrough',
  blind: 'viaBlind',
  micro: 'viaMicro',
  unknown: 'viaUnknown',
};

const centreOf = (b: Band): number => b.y + b.h / 2;

/**
 * Which bands can carry a leader label without colliding.
 *
 * A real board defeats "label every row": Glasgow's 13 rows put three ~67-unit
 * dielectrics beside eight rows of 1-7 units, so the silk, paste, mask and
 * copper labels at each face land within a few units of one another and render
 * as a smear. Copper is offered a label FIRST because those rows are the stack's
 * anatomy and the dielectrics between them hold them apart; everything else
 * takes a label only if it still clears every label already placed.
 *
 * Nothing is lost by a row going unlabelled — the table beside the figure names
 * every row, which is what its caption says.
 *
 * Exported for test: this is the one piece of the panel a DOM assertion cannot
 * measure, because happy-dom has no layout.
 */
export function labelledBands(drawn: Band[], minGap: number = LABEL_GAP): Band[] {
  const offered = [...drawn.filter((b) => b.kind === 'copper'), ...drawn.filter((b) => b.kind !== 'copper')];
  const placed: number[] = [];
  const kept = new Set<Band>();
  for (const band of offered) {
    const centre = centreOf(band);
    if (placed.some((y) => Math.abs(y - centre) < minGap)) continue;
    placed.push(centre);
    kept.add(band);
  }
  // Back into file order, so the DOM reads top of the board downwards.
  return drawn.filter((b) => kept.has(b));
}

/**
 * Is the figure honestly to scale?
 *
 * `bands` weighs a row by its thickness, but falls back to equal bands when NO
 * row carries one — with no stackup block at all, and also for a block whose
 * every thickness is absent or zero. Claiming "drawn to scale" over equal bands
 * would be the one thing this panel exists not to do.
 */
function toScale(s: BoardStackup): boolean {
  return s.stackup != null && s.stackup.some((r) => r.thicknessMm != null && r.thicknessMm > 0);
}

/**
 * The copper finish, as a reader should see it.
 *
 * KiCad writes `(copper_finish "None")` on every board in our corpus, so this
 * is the common case and not an edge one. "None" is the file SAYING the finish
 * is none — a different fact from the field being absent, which is why the
 * reader keeps them apart and the wording here does too.
 */
function finishLabel(finish: string | null): string {
  if (finish == null) return ABSENT;
  const trimmed = finish.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'none') return 'none specified';
  return trimmed;
}

interface StackupPanelProps {
  stackup: BoardStackup;
}

export default function StackupPanel({ stackup }: StackupPanelProps) {
  const rows = useMemo(() => tableRows(stackup), [stackup]);
  const summary = useMemo(() => summarize(stackup), [stackup]);
  // Never shorter than the floors `bands` reserves. With HEIGHT at 240 this is
  // the identity for any real board (Glasgow's floor is 22), and it is here so
  // that a box made responsive later cannot start drawing rows outside the
  // viewBox without anything failing.
  const height = useMemo(() => Math.max(HEIGHT, minHeightPx(stackup)), [stackup]);
  const drawn = useMemo(() => bands(stackup, height), [stackup, height]);
  const spans = useMemo(() => viaSpans(stackup, drawn), [stackup, drawn]);
  const labels = useMemo(() => labelledBands(drawn), [drawn]);
  const lanes = spans.filter((v) => v.x <= LANE_LIMIT);
  const undrawnLanes = spans.length - lanes.length;
  const missing = stackup.stackup == null;
  const scaled = toScale(stackup);
  const buckets = ([
    ['Signal', summary.signal],
    ['Plane', summary.plane],
    ['Mixed', summary.mixed],
    ['Jumper', summary.jumper],
    ['Other', summary.other],
  ] as [string, number][]).filter((b) => b[1] > 0);

  return (
    <section className={styles.panel} aria-label="Board stackup">
      {missing && (
        <p className={styles.missing}>
          No Board Setup saved &mdash; this board carries no physical stackup (Board Setup &rarr; Physical
          Stackup in KiCad), so there are no thicknesses to draw it to scale by. The copper layers and via
          counts below are what the file does carry.
        </p>
      )}
      <div className={styles.zones}>
        <figure className={styles.section}>
          <svg
            className={styles.svg}
            viewBox={`0 0 ${WIDTH} ${height}`}
            width="100%"
            role="img"
            aria-label={
              scaled
                ? 'Cross-section of the board stack, drawn to scale. The layer table beside it carries the same rows as text.'
                : 'Cross-section of the board stack, drawn as equal bands because the file records no thicknesses. The layer table beside it carries the same rows as text.'
            }
          >
            {drawn.map((b) => (
              <rect
                key={`${b.name}-${b.y}`}
                className={styles[BAND_CLASS[b.kind]]}
                x={STACK_X}
                y={b.y}
                width={STACK_W}
                height={b.h}
              />
            ))}
            {labels.map((b) => (
              <g key={`label-${b.name}-${b.y}`}>
                <line className={styles.leader} x1={LEADER_X} y1={centreOf(b)} x2={STACK_X} y2={centreOf(b)} />
                <text className={styles.label} x={LABEL_X} y={centreOf(b)} textAnchor="end" dominantBaseline="middle">
                  {b.name}
                </text>
              </g>
            ))}
            {lanes.map((v, i) => (
              <g key={`${v.type}-${v.y1}-${v.y2}-${i}`} className={styles[VIA_CLASS[v.type]]}>
                <line
                  x1={STACK_X + STACK_W - v.x}
                  y1={v.y1}
                  x2={STACK_X + STACK_W - v.x}
                  y2={v.y2}
                />
                <title>{`${v.count} ${v.type} via${v.count === 1 ? '' : 's'}`}</title>
              </g>
            ))}
          </svg>
          <figcaption className={styles.caption}>
            {scaled
              ? 'Drawn to scale from the thicknesses in the file.'
              : 'Equal bands — this file records no thicknesses to draw them to scale by.'}{' '}
            Every row is named in the table.
          </figcaption>
        </figure>

        {rows.length === 0 ? (
          <p className={styles.missing}>This board file lists no copper layers.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Layer</th>
                <th scope="col">Type</th>
                <th scope="col">Thk (mm)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.layer}-${i}`}>
                  <td className={styles.num}>{r.ordinal}</td>
                  <td>{r.layer}</td>
                  <td>{r.type}</td>
                  <td className={styles.num}>{r.thk}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <dl className={styles.summary}>
          <dt>Total layers</dt>
          <dd>{summary.total}</dd>
          {buckets.map(([label, n]) => (
            // A Fragment, not a wrapper: `.summary` is a two-column grid, and
            // any real element here would take one cell and swallow the pair.
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>{n}</dd>
            </Fragment>
          ))}
          <dt>Dielectric</dt>
          <dd>{summary.dielectric}</dd>
          <dt>Listed thickness</dt>
          <dd>{summary.listed ?? ABSENT}</dd>
          {summary.design != null && (
            <>
              <dt>Design thickness</dt>
              <dd>{summary.design}</dd>
            </>
          )}
          <dt>Copper finish</dt>
          <dd>{finishLabel(summary.finish)}</dd>
          <dt>Thru vias</dt>
          <dd>{summary.thru}</dd>
          <dt>Blind/Buried vias</dt>
          <dd>{summary.blindBuried}</dd>
          <dt>Micro vias</dt>
          <dd>{summary.micro}</dd>
          {summary.unknown > 0 && (
            <>
              <dt>Unknown via type</dt>
              <dd>{summary.unknown}</dd>
            </>
          )}
        </dl>
      </div>
      <p className={styles.footnote}>
        Listed thickness is the sum of the thicknesses in the stackup block; design thickness is the board
        setting. KiCad&rsquo;s file does not distinguish blind from buried vias.
        {summary.other > 0 && ' Other counts copper layers set to a kind this reader has no name for; the table shows what the file calls each one.'}
        {undrawnLanes > 0 &&
          ` ${undrawnLanes} more via group${undrawnLanes === 1 ? '' : 's'} ${undrawnLanes === 1 ? 'is' : 'are'} counted here but left out of the figure, which has room for ${lanes.length}.`}
      </p>
    </section>
  );
}
```

```scss
// frontend/src/public/components/kicad/StackupPanel.module.scss
@use '@shared/styles/variables' as *;
@use '@shared/styles/mixins' as *;
@use '@public/styles/bomMaterial' as *;

// The Stackup tab's three zones. Colours are the board's own materials: mask
// green, copper bright, dielectric olive — the reading an assembler already has
// from looking at a bare PCB edge-on.

.panel {
  @include bom-card;
  padding: 16px;
}

// Both the no-stackup notice and the no-copper-layers one.
.missing {
  margin: 0 0 12px;
  color: $text-secondary;
  font-size: 0.9rem;
  max-width: 78ch;
}

.zones {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(260px, 1.2fr) minmax(180px, 0.8fr);
  gap: 20px;
  align-items: start;

  @include responsive($bp-mobile) {
    grid-template-columns: 1fr;
  }
}

.section {
  margin: 0;
  // The figure is a grid item; without this the svg's intrinsic width wins the
  // min-content negotiation and the three columns stop honouring their minmax.
  min-width: 0;
}

// `width="100%"` with a viewBox: the height follows the aspect ratio, so the
// figure scales with its column and the labels inside scale with it.
.svg {
  display: block;
  height: auto;
}

.caption {
  margin-top: 6px;
  font-size: 0.75rem;
  color: $text-secondary;
}

// Band fills. Named in camelCase and reached through an exhaustive record in
// the component, so a new band kind cannot arrive unstyled.
.bandCopper {
  fill: #d9a441;
}

.bandDielectric {
  fill: #7f8a3d;
}

.bandMask {
  fill: #1f7a3f;
}

.bandOther {
  fill: #c9ced4;
}

.leader {
  stroke: $text-secondary;
  stroke-width: 1;
}

// 10 viewBox units. LABEL_GAP in the component is 12 — the line box this needs
// to clear — and the two are checked against each other by test.
.label {
  fill: $text-secondary;
  font-size: 10px;
  font-family: $font-mono;
}

// Via barrels. One rule for the shared shape, then a stroke per type; the
// unknown one is dashed as well as red, so the distinction survives a
// colour-blind reading rather than resting on hue alone.
.viaThrough line,
.viaBlind line,
.viaMicro line,
.viaUnknown line {
  stroke-width: 4;
  stroke-linecap: round;
}

.viaThrough line {
  stroke: #6b7280;
}

.viaBlind line {
  stroke: #2563eb;
}

.viaMicro line {
  stroke: #7c3aed;
}

.viaUnknown line {
  stroke: $error-red;
  stroke-dasharray: 3 3;
}

.table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.85rem;

  th,
  td {
    padding: 6px 8px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.08);
    text-align: left;
  }

  th {
    font-weight: 600;
    color: $text-secondary;
  }
}

.num {
  font-family: $font-mono;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

// A flat two-column grid: every dt/dd pair is its own cell, which is why the
// component groups conditional pairs with fragments and never a wrapper.
.summary {
  display: grid;
  grid-template-columns: auto auto;
  gap: 4px 12px;
  margin: 0;
  font-size: 0.85rem;

  dt {
    color: $text-secondary;
  }

  dd {
    margin: 0;
    font-family: $font-mono;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
}

.footnote {
  margin: 12px 0 0;
  font-size: 0.75rem;
  color: $text-secondary;
  max-width: 78ch;
}
```

- [ ] **Step 2: The tab**

In `pages/viewer/index.tsx`: `import StackupPanel from '@public/components/kicad/StackupPanel'; import { readStackup } from '@public/services/kicad/boardStackup';`; in `tabs`, after Board: `if (session.project.board != null) out.push({ id: 'stackup', label: 'Stackup' });`; a memo `const stackup = useMemo(() => (session?.project.board == null ? null : readStackup(session.project.files.get(session.project.board) ?? '')), [session]);`; and after the drawing block: `{tab === 'stackup' && stackup != null && <StackupPanel stackup={stackup} />}`.

- [ ] **Step 3: Gates, smoke, commit, STOP — Phase 4 gate**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`. Locally: Glasgow's Stackup tab shows four copper rows with a saved stackup and 416 through vias; the keyboard panel board (drop `bad-thing-panel`) shows its stackup; a board saved without Board Setup (any fresh KiCad board) shows the honest message with copper rows and via counts.

```bash
git add frontend/src/public/components/kicad/StackupPanel.tsx frontend/src/public/components/kicad/StackupPanel.module.scss frontend/src/public/pages/viewer/index.tsx
git commit -m "feat(viewer): Stackup tab — cross-section to scale with real via spans, layer table, honest summary"
```

Owner checklist: compare the panel to KiCad's Board Setup → Physical Stackup for Glasgow revC3 and for one of his own boards; confirm the no-stackup state; phone width via `mobile-layout-guard`. Wait for explicit approval before Phase 5.

---

> **Task 4.2 landed (2026-09-14, commits 1d80ce1 → cb5d04d → 33248bb → the aria-selected test):** blocks synced. Beyond the brief: the summary's copper buckets always sum (`other` for unrecognised kinds; zero buckets hidden); `minHeightPx` exported and the box clamped to it; cross-section labels offered copper-first with colliders dropped (Glasgow shows 7 of 13; the table is the complete record); totals and the Thk column share one four-decimal formatter (KiCad's own Board Setup precision); the tab strip carries the full tablist contract (`tablist` "Views", `tab`/`tabpanel` ids both ways, roving tabindex, Left/Right/Home/End moving focus and selection) with the canvas staying ONE element across every tab (pinned by node identity + mount counter); an unreadable board (`readStackup` throws) still offers the tab with the honest message. Verified in the owner's Chrome on Glasgow. Parked for the final list: `readStackup` runs eagerly on project open (323 ms on an 8 MB board; a first-visit latch is 3 lines); a 3px grid overflow between 769 and 771px; the BOM tab's `aria-controls` names a panel that exists only after the first visit; an orphaned doc comment on `measuredMm`.

# Phase 5 — Docs, then deploy on ask

### Task 5.1: CLAUDE.md gotchas and the memory update

**Files:**
- Modify: `CLAUDE.md` (Gotchas), `/home/matthew/.claude/projects/-home-matthew-circuits-com/memory/project_design_viewer_2026_09_12.md`

- [ ] **Step 1: Add the gotchas (one bullet each, in the Gotchas list near the BOM tool bullets)**

```
- **The Design Viewer renders with a VENDORED KiCanvas built by a pinned esbuild step that is also the integrity gate (2026-09-12, spec docs/superpowers/specs/2026-09-12-design-viewer-design.md)** — `frontend/vendor/kicanvas/` is upstream `b031159eb74aaa7eef2b026fd85d35bc05ff2095` + two patches (no web fonts incl. Nunito; icon codepoints for a 16-glyph subset at `public/fonts/kicanvas/`); `scripts/build-kicanvas.mjs` (prebuild/predev, so it runs inside the prod image build on the t3.small) bundles it to the gitignored `vendor/build/kicanvas.js` — Vite CANNOT compile the tree directly (it loads .css/.svg as TEXT) — and fails the build if the tree drifts from `MANIFEST.sha256` or a font host survives. Re-vendor only via `scripts/vendor-kicanvas.mjs`. Nothing outside `components/kicad/kicanvasController.ts` touches KiCanvas; pages see only `CanvasController` (the seam a future KiCad-as-WASM editor implements). ONE embed per project; sheets and the board switch through the app element's public `project.set_active_page`. Quarterly check: `pushed_at == 2026-04-28T17:37:55Z`, `tags == 0`, no format-token issues, `npm view @huaqiu/ecad-renderer`.
- **The KiCad reader is ours and is REQUIRED — KiCanvas discards `in_bom` and `dnp` (2026-09-12)** — `@public/services/kicad/`: one BOM line per INSTANCE PATH (a sheet placed twice = two references), references from KiCad 7+ per-symbol `instances` else KiCad 6 root `symbol_instances` else the property; `#` refs and `(power)` symbols skipped; `qty` is the true instance count and `refs` is capped at 200 for display only; files are keyed by relative PATH (same-named sheets in two folders are different files); KiCad 5 (`.sch`/`.pro`, board version < 20211014) is refused by name; a via head may carry `blind`/`micro` (type) and `locked` (a FLAG); the stackup is `null` when the file has no `(setup (stackup …))` — never defaulted. Fixtures are open hardware under `services/kicad/fixtures/` with LICENSE + SOURCE; KiCad's GPL demos ride on the programme's GPL-3.0-or-later licence.
- **Design files never leave the browser; say exactly that (2026-09-12)** — the viewer's only network calls are the existing `/api/bom/match|resolve` (identity fields) and `/share` on an explicit click (which DOES publish qty + designators behind its disclosure). Public copy is "your design files never leave your browser", never "no upload". `designSession` holds `{project, parsed, refs}` so `/viewer` ↔ `/bom` costs one match per project.
```

- [ ] **Step 2: Update the project memory** — set the status line to "Phases 0–4 built and approved locally; awaiting the owner's deploy ask", list the measured Phase 0 numbers, and note anything that diverged from the spec during the build.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): design viewer — vendored renderer gate, reader rules, privacy wording"
```

### Deploy (only on the owner's explicit ask — not part of any phase approval)

1. `git checkout master && git merge --ff-only updates && git push && git checkout updates` (after `updates` is pushed).
2. Run the `deploy-preflight` agent; fix anything BLOCKED.
3. `setsid nohup ./deploy.sh > /home/matthew/.claude/jobs/f6b3d048/tmp/deploy.log 2>&1 < /dev/null & disown` and watch the log (the harness kills tracked background jobs on a spurious memory signal; the API recreate gives ~1–2 min of `/api` 502).
4. Live checks: `curl -sI https://circuitcenter.ai/viewer | head -3` (200) and `curl -s https://circuitcenter.ai/viewer | grep -o '<title>[^<]*'`; `curl -s https://circuitcenter.ai/api/sitemap-core.xml | grep -c viewer` (1); `curl -sI https://circuitcenter.ai/vendor/kicanvas/NOTICE.txt | head -1`; the `kicanvas-*.js` chunk size from the network panel against the §10 gate; the frontend image build on the box completed without OOM (record wall time from the deploy log); the Glasgow sample end-to-end on prod in a GPU browser.

---

# Self-review (writing-plans checklist, run once at the end)

**Spec coverage** — §3 units: vendored renderer (0.2/0.3), reader (1.2–1.7), BOM library/components/material move (1.1), design canvas + controller (2.1/2.2), session (2.3), viewer page (2.4/2.5/3.3/4.2), BOM page (3.1/3.4); §4 reader rules (1.5–1.7, incl. path keying, KiCad 5 by name, caps after filter, archive guard, `locked` flag, qty vs refs cap, ready-mapped `roleByColumn`); §5.1 vendoring/patches/build gate/notice/font (0.2/0.3/2.4); §5.2 one embed, WebGL2 memo, timeout teardown (2.1/2.2); §5.3 feature-detected focus (2.1); §5.5 protocol (2.1); §6 lift + chips (3.1/3.2); §7.1 page, tabs, chips, hash focus, BOM tab mounted-once (2.5/3.3); §7.2 `/bom` drop zone, continue, schematic toggle, session clear (3.4); §7.3 stackup (4.1/4.2); §7.4 SEO/nav/sitemap (2.6); §8 error states (2.2 copy, 2.4 intake errors, 1.5 messages); §9 privacy wording (2.5 intro, 3.4 card copy), caps (1.2), third-party gate (0.3); §10 tests (every task); §11 gates (each phase's last step); §12 files (header map); §13 tokens (2.4 styles); §14 nothing built.
**Gaps found and closed:** the §7.1 "Try the example project" credit line (2.4 `EXAMPLE_CREDIT`); the `DesignCanvas` compact height for `/bom` (3.4 Step 1); the `StaticPageKey` union (2.6 Step 1); `vitest.config.ts` alias (0.3).
**Placeholder scan:** no TBD/TODO/"similar to"; every code step carries code; every referenced symbol is defined in a task (`fixtureFiles`/`fixtureText`/`hasFixture`/`symbol`/`schematic`/`sheet` in 1.4; `resolveSheetRef`/`basename`/`versionOf` in 1.5; `readSchematic`/`RefLocation` in 1.6; `readStackup` in 1.7; `sourcesFor`/`KicanvasController` in 2.1; `webgl2Supported` in 2.2; `openDesign`/`getDesignSession`/`clearDesignSession` in 2.3; `useBomWorkbench` + reducers in 3.1; `viewerRefHref` in 3.2; `tableRows`/`summarize`/`bands`/`viaSpans`/`formatMm` in 4.1).
**Type consistency:** `KicadProject.sheets[].path` (not `file`) everywhere; `CanvasController.activate(view, sheet?)`/`focusRef(ref, sheet?)` match `DesignCanvasHandle.focusRef(ref, sheet?)` and the viewer's `focus()`; `RefLocation.instancePath` is what the controller matches against `ProjectPage.sheet_path`; `ParseResult.roleByColumn: BomRole[]` in 1.6 satisfies `canPrice` in 1.1; `BomTable` props `onRefClick?` added in 3.2 before 3.3/3.4 use it; `useBomWorkbench(parsed, viewerHref)` signature identical in 3.1, 3.3, 3.4.

---

# Rulings I made (final adjudication, 2026-09-14)

Deployed to production 2026-09-14 (master 134ba73) on the owner's instruction at 91% weekly usage; Phase 5 (docs) skipped and the separate whole-branch review agent skipped for budget — this section is the controller's adjudication of the ledger instead. 48 rulings were recorded during execution; each is reproduced verbatim from the ledger below, followed by the disposition of every parked finding.

- Ruling: Task 2.4 extracts the shared drop-frame rules into `@public/styles/_dropFrame.scss` as a mixin (`drop-frame-intake`) that BOTH `BomPage.module.scss` and `ViewerPage.module.scss` include, instead of copying ~120 lines — because the rubric treats verbatim duplication as Important and the spec's §13 already wants the two pages to read as one family. Costs if wrong: a Sass refactor of the BOM intake styles that must stay pixel-identical (the reviewer checks the class list and the implementer diffs the compiled CSS).
- Ruling: commits carry NO Co-Authored-By line — owner rule in memory (feedback_no_coauthor) overrides the harness's attribution reminder. Costs if wrong: nothing functional.
- Ruling: no worktree; work in place on `updates` — the session is configured to work in place and the owner's branch workflow is `updates` → ff-merge to master at deploy. Costs if wrong: none (the branch is the owner's dev branch).
- Ruling: vendor `third_party/` beside `src/` and put BOTH under MANIFEST.sha256, the build gate and vendorIntegrity.test.ts; entry.ts imports `./src/kicanvas/elements/kc-board/app` and `./src/kicanvas/elements/kc-schematic/app` for side effect; build-kicanvas.mjs additionally fails unless the output contains the strings `kicanvas-embed`, `kicanvas-source`, `kc-board-app`, `kc-schematic-app` — because the spec (§5.1) requires the build to be the integrity gate and a bundle that renders nothing passed it; costs if wrong: an extra ~20 KB of upstream (earcut, ISC — already named in KiCanvas's LICENSE.md) and a stricter gate. Applied as a fix round on Task 0.3 (implementer resumed) before its review; the plan text for 0.2/0.3 is patched by the controller after the fix lands.
- Ruling: the element assertion checks `define("<name>"` rather than the bare element name — the bare string occurs 3× in the broken bundle (CSS selector + template) so the literal spec would have passed the defect; costs if wrong: nothing (stricter). Ruling: vendor `third_party/earcut/` only, not all of `third_party/` — earcut is the only thing src/ compiles from there; the rest is ~16 MB of font-authoring sources that would bloat git and the Docker context; every byte the bundle compiles is still hashed; costs if wrong: a one-word widening and a re-run.
- Ruling: kicanvasController.activate() enforces both apps' `hidden` after every switch, and mount() ends with an activate() (the embed's own initial page is first_page = the board on Glasgow) — costs if wrong: none, it only asserts what the view already means. Ruling: CANVAS_READY_MS = 15000 with the deadline paused while the tab is hidden — the first GPU mount of Glasgow took 4.3 s to the app element and background tabs throttle rAF so the mount waits — costs if wrong: a stuck mount shows its card after 15 s instead of 5. Ruling: dispose() loses the embed's GL contexts before removal (repeated loads in one tab degraded) — costs if wrong: nothing. Ruling: frame gets touch-action none + overscroll-behavior contain — costs if wrong: the page cannot scroll by dragging on the drawing (intended).
- Ruling: `atom(node: SExpr, index)` — widen the parameter to `SExpr` with an `Array.isArray` guard (source-compatible; the brief's own test at sexpr.test.ts:27 passes an `SExpr` and only escaped the gate because test files are excluded from tsc/eslint) — costs if wrong: nothing.
- Ruling: `topLevelBlocks` throws on a `)` at depth 0 and on `depth !== 0` at end of input, with `parse`'s wording ('unbalanced ) at N' / 'unbalanced ( at end of input') — because a truncated board otherwise reads as a valid smaller board and the spec's 'unreadable' kind is unreachable on that path; two new tests pin it — costs if wrong: a board with a stray `)` after its final block refuses to open (KiCad never writes one).
- Ruling: fold in Minors 3 (offset wording: UTF-16 code units, start inclusive / end exclusive), 4 (`localeCompare(x, 'en')` — designators are ASCII, host locale must not order them) and 6 (test var `second` → `firstVia`); DEFER Minor 5 (dead `as string` casts / unreachable regex fallback) to the final review.
- Ruling: accept the sort — a deterministic, path-ordered output is a better contract than "whatever order the archiver wrote" and Task 1.5 keys by path anyway; the plan's zip.ts is patched to carry the same line — costs if wrong: nothing (order was unspecified).
- Ruling: two entries that normalize to the same path → `unzipToFiles` throws KicadReadError(kind 'archive') naming the path, with a test — because a silent keep-last lets a second copy shadow a real sheet and the Map in Task 1.5 could never see it; costs if wrong: a malformed archive (never produced by a normal zip tool) refuses to open with a message that names the duplicate.
- Ruling: fold in all Minors — normalizeEntryName('.')/('a/.') → null; spec §4.5 wording corrected (earlier entries do inflate before a later throw, but the running declared-total check runs before every `return true`, so the transient total never exceeds the cap; the declared total accumulates over entries the tool would READ, i.e. after the name filter — the tighter bound, as the brief prescribes); the sort and the `size > 0` short-circuit get their rationale comments; the stray space nit. Costs if wrong: nothing.
- Ruling: fixed INLINE by the controller (f0dda62): a trailing '.' segment names a directory → null, three assertion lines added, comments moved above the code they explain; verified by the covering test (8/8) + tsc + eslint; no further re-review seat for a 3-line diff — costs if wrong: a nit in 3 lines caught at the final review. Plan patched (56e4c5e).
- Ruling: no `SYNTH` — the builders `symbol`/`schematic`/`sheet` + the three UUID constants are the synthetic corpus; plan interface line patched (b799140), no code change; Tasks 1.5–1.7 are dispatched naming the builders. Corpus size accepted: the files live under src/ but nothing imports them into the bundle; they ride the Docker build context (+6.6 MB) and git — costs if wrong: a slower frontend image build by a second.
- Ruling: keep the demos (CC BY-SA 4.0 is one-way compatible with GPLv3, and attribution is the SOURCE file) but say the truth everywhere — fixed INLINE by the controller: script comment + `shareAlike` gate + SOURCE string (regenerated by re-running the script; every data file byte-identical), test regex, plan constraints/Task 1.4 text, spec §10, project memory (7fd8366 code, 4716fbc docs); covering test 3/3 + tsc + eslint green — costs if wrong: nothing legal (CC BY-SA → GPLv3 is a declared compatible port; we do not adapt the files).
- Ruling: (a) FIX — buildProject throws 'empty' when neither a schematic nor a board survives the filter (a .kicad_pro alone shows nothing); predicate is root == null && board == null so the board-only stickhub fixture keeps working; test added — costs if wrong: a project-file-only drop refuses with a message instead of a blank viewer (intended).
- Ruling: fold in M3 (unreachable warning: "are not shown", the text IS in files), M4 (cap messages: actual size rounded UP to a tenth so a 8 MiB+1 file never reads "8.0 MB; limit 8.0 MB"), M5 (two .kicad_pro files warn like two boards do). LEAVE M1 (board with no version token → 1.6 raises 'unreadable' when the head does not parse), M2 (missingSheets dedupe key — display-only, note for 1.8), M6 (root fallback follows drop order for loose files; the brief's own test pins it; zip input is sorted), M7/(c) (legacy .sch beside modern is the normal converted-project shape — no warning).
- Ruling: FIX all five Importants — I1 `index` is 1-based like the CSV path (BomTable renders it); I2 a property whose header maps to the 'dnp' role with a value not in {'', no, false, 0, n} marks the instance DNP, OR'd with the `(dnp yes)` attribute (Glasgow marks its 8 DNP parts by a "DNP" property only) + a Glasgow test summing 8; I3 when the reference came from the symbol's own Reference property (no instance table hit) the dedupe keys on `${path}|${ref}` and a warning names the sheet (a twice-placed sheet must never halve the order); I4 a reference ending in '?' is keyed by symbol uuid (never merged) and a warning says N symbols are not annotated + a synthetic test; I5 `visit` carries the ancestor chain and skips a sheet already on it (KiCad itself refuses recursive hierarchies) + a synthetic self-referencing test. Fold in M1 (Glasgow test pins io_buffer refs toHaveLength(136)) and M3 (warning wording "power, virtual or unreferenced"). LEAVE M2 (always-present footprint/description/dnp roles) and M4 (exact-case builtin property names — KiCad always capitalises). Costs if wrong: I2 could mark a part DNP from a stray field named like the alias table's dnp headers (the CSV path already behaves this way, so the two intakes agree).
- Ruling: `RefLocation` stays a single (first) location for this stage; a list for cross-sheet multi-unit parts is a 3.x contract decision — carry-forward.
- Ruling: 12 is the right assertion — `qty` sums instances, and a twice-placed sheet's DNP parts are two placements each; the per-path uuid key is accepted as a strict refinement. Plan Task 1.6 blocks replaced by the landed files (e97790b).
- Ruling: NP1–NP3 fixed INLINE by the controller (dfaacea); the schematic path stays deliberately STRICTER than the CSV path on DNP values ("no"/"false"/"0"/"n" are not DNP) because KiCad field templates default DNP fields to "No" — recorded in the code comment; NP4 deferred to the final review. Plan synced (83d0891).
- Ruling: Glasgow via count is 416 (409 + 7 locked) — my pre-flight grep -c '(via' matched '(vias' and '(viasonmask' too; spec §10 + plan Task 1.7 corrected (ea17833); costs if wrong: nothing (delimiter-aware recount by the controller agrees).
- Ruling: I1 (truncated board escaped as a raw scanner Error) and I2 (unknown via token not sticky) fixed INLINE by the controller with two tests (89b7e08); (3) listedThicknessMm stays the raw IEEE sum — rounding to 3 dp would coincidentally equal designThicknessMm and kill the comparison, the tab formats; (4) copperFinish keeps KiCad's literal "None" — the Stackup tab must LABEL it (3 of 3 stackup boards carry it), never print it as a finish; spec §4.4 "410 + 7" corrected; plan Task 1.7 blocks synced (fef87a1).
- Ruling: FIX C1 — findPage('schematic') trusts upstream's root_schematic_page only when its type is 'schematic' (upstream reassigns it to the FIRST page, which is the PCB on any board-bearing project — Glasgow included), else the first schematic page; test with a fake whose root page is the pcb. FIX C2 — the hidden-tab pause refunds REAL elapsed time (inject `now` and `visibility` through the constructor options, test-only), never a fixed 50 ms; a test drives a fake clock + 'hidden' and proves the deadline does not fire. FIX I1 — mount() ends with activate('schematic' if the project has a root schematic, else 'board') so both apps' hidden flags are enforced before 'ready' (Phase 0 ruling); the host's ready effect then activates the real view. FIX I2 — activate() settles on the viewer's own "kicanvas:load" event (KiCanvasLoadEvent, viewers/base/events.ts) after checking active_page identity, with the basename comparison only as the settleMs fallback for fakes that emit no event — two instances of one sheet file (Glasgow io_buffer) must really switch before focusRef runs. FIX I3 — focusRef picks the app from active_page.type like zoom() (BoardViewer.select(string) exists). FIX I4 — an epoch counter on mount(); every emit/disposeEmbed from a stale mount is dropped. FIX I5 — no 'error' emit after dispose(); dispose() clears the handler map. FIX I6 — the mount keeps sourcesFor()'s `dropped`; activate() of a dropped path returns false. FIX I7 — clamp camera zoom in the controller to named constants ZOOM_MIN 0.5 / ZOOM_MAX 190 with a comment citing the upstream file:line (the upstream clamp is private; the controller is the seam that touches camera.zoom). Fold in M1 (delete the dead `while` tail and the `sleep !== defaultSleep` identity branch — the injected clock replaces it) and M2 (comment: upstream calls set_active_page(root_schematic_page), which is the first page because project.ts:274 reassigns it). LEAVE M3 (Set-collapsed duplicate handlers — documented), M4 (report nit). Costs if wrong: a larger controller (~60 lines) and two more test-only constructor options.
- Ruling: FIX both (round 2): settle resolves immediately when the target viewer already holds the page's document (upstream's early return means no event will come — and a same-file instance switch is a visual no-op upstream), else awaits the load event bounded by settleMs; an activation epoch makes a superseded activate return false without touching hidden, and mount's closing activate is skipped when its mount epoch is stale. Costs if wrong: ~20 lines; the fakes must model "document already loaded".
- Ruling: FIX (round 3) — the controller remembers its own armed, unfired load watch per view; an activate that would short-circuit on holdsDocument() must instead await that in-flight watch (bounded by settleMs) — listeners are one-shot ({ once: true }) so nothing leaks, dispose() cancels the in-flight watches; fold in the comment fix and a test for the stale-mount clause; leave the null-guard divergence. Costs if wrong: ~20 lines and one more fake behaviour (document assigned before the load event).
- Ruling: FIX I1 (onState through a ref — adding it to deps would remount the canvas per parent render), I2 (fullscreen request/exit rejections caught and ignored), I3 (document the `project` identity contract in the props JSDoc: pass a stable object — the design session holds one — a new identity reloads the project). Concern (2): MANDATE a happy-dom component test as `DesignCanvas.test.ts` (vitest discovers `*.test.ts` only, no testing-library — use React.createElement + react-dom/client + act, injecting a fake controller through the existing `createController` prop): no-webgl builds no controller; retry disposes the first controller and builds a second; unmount mid-mount disposes and never sets state. Fold in Minors: controls get the tap-target mixin (Phase 0 touch feedback), useImperativeHandle deps, the probe wrapped so a throwing getContext reads as no-webgl, dead `.frameCompact`/`data-state` removed, setZoomable guarded by the cancel flag. LEAVE: 15 s in the timeout copy (reviewer: wrong for a paused-hidden deadline), fills-the-viewport unmeasured until 2.5 (precondition recorded: every .frame child is absolute so an auto-height parent collapses to 320px; $nav-height 36 vs $nav-height-mobile 48 → the calc must branch), min-height 320 in landscape (playtest), board-first schematic flash (2.5 idea: unhide the incoming app before settling), `hidden={failed}` relying on a synchronous loading emit. Costs if wrong: one more test file and ~15 lines.
- Ruling: (a) keep the brief's dep array; CARRY-FORWARD to 3.3/3.4 — `viewerHref` must be session-stable (known before `parsed` is set; never derived from state that changes after pricing) — why: the effect re-match is the brief's design and a stable input makes it inert — cost if wrong: a re-fired match burns resolve quota once per href change.
- Ruling: (b) parked for the final review (product decision on which SKU the dropdown hides) — why: untouched component, no behaviour change in this task — cost if wrong: a cosmetic duplicate menu entry.
- Ruling: (c) "needs a testing library" is false — `DesignCanvas.test.ts` establishes happy-dom + react-dom/client + act; the reviewer decides whether abort/seq/reset are load-bearing enough to require a hook test in this task (fix round if so) — cost if wrong: an untested race lands under two pages in 3.3.
- Ruling: fix round 1 on 3.1 takes M1+M2+M3 and all four Minors (M1 supersedes my "session-stable href" ruling above: guard the hook, not the callers) — why: 3.3 mounts the hook on a second page and 3.4 is the late-href case by construction; a rule without enforcement is what the reviewer refuted — cost if wrong: ~1 extra fix round on a 300-line hook.
- Ruling: fix round 2 = N1–N3 (tests + one doc sentence), verified by the controller running the gates and reading the stat, no third review seat — why: additive tests and a doc line cannot change /bom behaviour — cost if wrong: a test that pins nothing.
- Ruling: the `font: inherit` correction stands and the plan block is synced to it — why: verified in the built CSS, and the whole point of the @extend is chip parity — cost if wrong: none visible (the two inherits cover the UA button resets).
- Ruling: fix round 1 on 3.2 = Minors 1 and 3 plus, for Minor 2, a `title="Find R12 on the schematic"` on the button chip and NO aria-label — why: the visible text "R12" under the "Designators" column header is already the accessible name, and overriding it risks a label-in-name mismatch; `title` gives pointer users the affordance — cost if wrong: a screen-reader user hears the designator without the verb (the 3.3 focus toast still confirms the action). Verified by the controller's gates, no re-review seat (doc line, a title attribute, a two-line test).
- Ruling: (b) parked to the Phase 4 ruling on sheet-instance addressing — why: the chips express paths, not instances, so half-solving it here puts two address spaces in page state — cost if wrong: a twice-placed sheet highlights the first instance's chip. (c) parked to Phase 4 (Stackup adds the third tab) — cost if wrong: two phases of keyboard users without roving tabindex. (a) referred to the reviewer with the controller's lean that the seam (`canvasController.ts` / `DesignCanvas`) must carry "dropped", not the renderer module.
- Ruling: C1 is fixed IN THE CONTROLLER — `focusRef` must wait for the NEWEST in-flight activation to settle (a superseded watch re-waits, it does not fail) and select on the document that is then live, with a test against the real controller and a concurrent `activate` — why: the page has no way to know when the host's activate lands, and the seam promises `focusRef(ref, sheet)` works regardless of what the page set — cost if wrong: a chip focus that sometimes lands on the previous sheet.
- Ruling: fix round 1 on 3.3 = C1 + M1 + M2 + Minors (stale canvasState, zero-line panel copy, dropped-chip reason for AT); tablist a11y and the C2 residual stay parked to Phase 4; the StrictMode note goes into the plan's landed note.
- Ruling: (a) parked for the final review unless the re-reviewer finds a single-click path that exhausts the bound — why: only rapid competing clicks reach it and the view ends correct — cost if wrong: a stale toast. (b) folded into the Phase 4 sheet-instance ruling. (c) added to the Phase 3 gate checklist.
- Ruling: fix round 2 on 3.3 — (1) the controller YIELDS when a newer activation names a DIFFERENT document (with I2 in place a host activate for a focus always names the focus's own sheet, so a different one is the user's choice): no re-activate, answer quietly; re-wait only on same-document activations; (2) the page's `focus()` carries a `focusSeq` guard so an abandoned click never toasts. This replaces the controller's "activate it and select" step, which was the controller's own round-1 instruction and the root of NEW-1 — why: it makes both symptoms converge without a protocol change — cost if wrong: a focus abandoned by a genuine host re-activation of another sheet (none exists today). Verified by the controller's gates and a read of the controller diff; no third review seat.
- Ruling: the identity gate stands (the plan text was wrong) — why: the design session is one global slot and only the parse it produced may borrow it — cost if wrong: none (a CSV never had a schematic). `.frameCompact` addition stands; the plan's 2.2 claim is corrected in the sync note. The silent /bom chip failure is ACCEPTED for Phase 3 and parked for the final review — why: /viewer carries the explicit path and 'superseded' must never toast; a /bom toast needs the same two guards — cost if wrong: a reader on /bom clicks a dropped-sheet chip and nothing happens.
- Ruling: M1 is fixed in the HOOK — `useBomWorkbench` never issues a match for zero lines (settles empty, `matching=false`), and /bom keeps its table chrome (ShareBar/"Change file") reachable — why: the shared unit protects both pages — cost if wrong: none. M2: `openDesign` only after the parse is usable (`error == null && lines.length > 0`; a board-only or over-cap project shows the error and opens NO session on /bom) and the Continue gate uses the same predicate — cost if wrong: a stray session on /bom. M3: a module-level per-`parsed` SNAPSHOT in the hook (WeakMap keyed by parsed identity: rows + resolve note, written when the match has landed / the stream settles / on unmount, hydrated on mount with zero requests, dropped by `reset()`) — why: the spec's promise is one request per project, and SPA re-entry to /viewer's BOM tab re-prices today for the same reason — cost if wrong: stale live prices shown for a session's lifetime (bounded by the session, which dies on reload). Minors 1, 2, 4 (`aria-controls`), 5 (if ≤10 lines), 6 fixed now; Minor 3 (phone touch trap, same as /viewer's 50vh canvas) and 7 (module state in render — the brief's design) parked for the final review.
- Ruling: (2) accepted pending the re-reviewer confirming unreachability. (3) parked with the standing `price_stale` product decision (CLAUDE.md OPEN) — a timestamp line is a Phase 5/final-review candidate — cost if wrong: a reader trusts a live price that is a session old.
- Ruling: fix round 2 on 3.4 = N1 + N2 + the gate observation (1): /bom queues a chip focus until the canvas reports ready (mirroring /viewer's pendingFocus) instead of dropping it — why: a click during the 9 s "Rendering…" window is the likeliest click on /bom — cost if wrong: a queued focus lands after the reader scrolled away (one zoom). The one-commit flash is parked (cosmetic). Verified by the controller's gates; no third review seat.
- Ruling (owed to Phase 4 since the 2.5 review — the twice-placed sheet): the page's `activeSheet` stays a FILE PATH (what the sheet chips express) and `focusRef(ref, instancePath)` stays instance-exact; no per-instance chips — why: KiCanvas renders one document per sheet file and cannot re-annotate it per instance, so an instance chip would change nothing on screen; the only visible artefact is that a designator on a sheet placed twice may be drawn with the OTHER instance's reference text — recorded for the Phase 5 docs as a known limitation — cost if wrong: a reader focusing U16 on Glasgow's io_buffer sees the symbol labelled U10. The theoretical three-activation case stays parked with it.
- Ruling (owed to Phase 4 — tablist a11y): Task 4.2 adds the third tab and takes the full tablist contract with it (`role="tablist"`/`tab`/`tabpanel`, `aria-controls` ↔ panel ids, roving tabindex with Left/Right/Home/End) — carried in the 4.2 dispatch.
- Ruling: the floors-first `bands()` stands (the test is the contract, the brief's algorithm was wrong) — cost if wrong: none, the test pins the box. CARRY-FORWARD to 4.2: the panel's drawing height must never go below the floors' sum (clamp at ~40px), and via lanes should be numbered by DRAWN order, not source index — the 4.2 reviewer checks both.
- Ruling: M2 — `StackupSummary` gains `mixed` and `jumper` counts so the kind buckets SUM to the copper count (4.2 renders only non-zero buckets) — why: a summary that loses layers is wrong data, not a copy choice — cost if wrong: one more word in the strip. Minor lane numbering: renumber `viaSpans` by DRAWN order in 4.1 (the helper owns the lanes; 4.2 just draws) — supersedes the earlier "4.2 decides". Fix round 1 = M1 (the reviewer's two `it` blocks + a mutation pass) + M2 + Minors (NaN/non-finite guards, drawn-order lanes, skip zero-length spans, comment fix); scoped re-review on the same reviewer (the summary shape is what 4.2 hardcodes).
- Ruling: (a) keep 33248bb — four decimals is KiCad's own Board Setup precision and one shared formatter was the 1.7 ruling — cost if wrong: a trailing zero. (b) accepted. (c) the controller's browser pass covers legibility; the eager readStackup stays unless the reviewer finds a cost on the corpus (a latch is 3 lines, fold into a fix round if so).

## Parked findings — disposition

Nothing below blocks the deploy; each is either cosmetic, dev-only, a product decision, or a theoretical race no page path produces. Grouped by what a fix would need:

**Do at the next touch of the viewer (small, mechanical):**
- `readStackup` runs eagerly on project open (323 ms on an 8 MB board) — add a first-visit latch like `bomSeen` (3 lines).
- The BOM tab's `aria-controls` names a panel that exists only after the first visit — render the panel element (empty) from mount, or drop the attribute until the panel mounts.
- The `/bom` "Change file" exit flashes for one commit before `matching` flips — gate on the hook's phase.
- A 3px grid overflow on the stackup panel between 769 and 771px; the orphaned `measuredMm` doc comment; Task 2.6's stray `/pricing` comment; Task 1.2's dead casts; Task 1.4's Windows separator in `fixtureFiles`; Task 1.8's tmp dir.
- One surviving "upload" was fixed in `ColumnMapper`; grep the public tree again before the next public copy change.

**Product decisions (owner's call, not code):**
- The BOM snapshot restores a table priced up to a session ago with no age shown; the honest fix is a "priced N minutes ago" line, tied to the standing `price_stale` decision — not re-matching.
- `/bom` chip focus is silent on a genuinely missing designator or a dropped sheet (the `/viewer` path toasts); a toast there needs the same `focusSeq` + `'superseded'` guards.
- The phone `touch-action` trap of a canvas panel above scrollable rows (both pages) — the canvas needs it to pan; a collapse-by-default or a pan handle is a design choice.
- CSV vs schematic DNP rules differ (documented in Task 1.6); the `SimilarDropdown` hides the currently matched SKU while `foldSimilarPick` filters the clicked one.

**Known limitations to document when Phase 5 runs:**
- A sheet placed more than once shows one instance's annotations (KiCanvas renders one document per file); chips address paths, `focusRef` addresses instances.
- Under `StrictMode` (dev only) the match effect double-invokes and a dev network panel shows two `match` calls, the first discarded.
- Re-entering `/viewer` or opening the `/bom` schematic panel re-parses the whole project (about 9 s for Glasgow); keeping the embed alive across routes is the fix.
- The first match took 8.6 s server-side for 66 lines — a backend observation, not a viewer defect.
- vitest runs `css: false`: CSS-module imports echo the key, so rule existence needs a source-level SCSS witness (a CLAUDE.md gotcha candidate).

**Theoretical, no page path produces them:** the three-activation focus case (would need a focus-generation counter on the controller); cross-page load cross-talk and duplicate-handler collapse in the controller (Task 2.1); the `ZOOM` literals as a vendor-bump note.
