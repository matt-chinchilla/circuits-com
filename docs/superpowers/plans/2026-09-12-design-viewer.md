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
- **Fixtures are open hardware with a `LICENSE` + `SOURCE` beside them**; KiCad's own GPL demo files are committed only after `LICENSE` exists at the repo root (Task 0.1); until then the tests that need them `skip` with a named reason.

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
  if (parts.some((seg) => seg === '..' || seg === '' )) return null;
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
  return Object.entries(entries)
    .map(([name, data]) => [normalizeEntryName(name) ?? name, data] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, data]) => new File([data], name));
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
- Produces: `fixtureFiles(name): File[]` (reads a corpus directory into `File`s with relative names, node-only, for tests), `fixtureText(rel): string`, and the synthetic documents `SYNTH` used by Tasks 1.5–1.7.

- [ ] **Step 1: Write the fetch script**

```js
// frontend/scripts/fetch-kicad-fixtures.mjs
// Downloads the open-hardware fixture corpus at PINNED commits and writes a
// SOURCE + LICENSE beside each set. Run once; the files are committed.
// KiCad's own demo projects are GPL-3.0-or-later and are only written when the
// repo root carries LICENSE (spec D6) — otherwise they are skipped with a note.
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
    gplOnly: true,
    base: 'https://gitlab.com/kicad/code/kicad/-/raw/a8d6201d6bc1739943ea51b3bc18d8d691503539/demos',
    files: [
      ['complex_hierarchy/complex_hierarchy.kicad_pro', 'complex_hierarchy/complex_hierarchy.kicad_pro'],
      ['complex_hierarchy/complex_hierarchy.kicad_sch', 'complex_hierarchy/complex_hierarchy.kicad_sch'],
      ['complex_hierarchy/ampli_ht.kicad_sch', 'complex_hierarchy/ampli_ht.kicad_sch'],
      ['complex_hierarchy/complex_hierarchy.kicad_pcb', 'complex_hierarchy/complex_hierarchy.kicad_pcb'],
      ['stickhub/StickHub.kicad_pcb', 'stickhub/StickHub.kicad_pcb'],
    ],
    licenseUrl: 'https://gitlab.com/kicad/code/kicad/-/raw/a8d6201d6bc1739943ea51b3bc18d8d691503539/LICENSE.README',
    source: 'KiCad demo projects — https://gitlab.com/kicad/code/kicad @ a8d6201d6bc1739943ea51b3bc18d8d691503539 (2026-09-12), GPL-3.0-or-later per LICENSE.README. Retrieved 2026-09-12.',
  },
];

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

for (const set of SETS) {
  if (set.gplOnly && !existsSync(join(ROOT, 'LICENSE'))) {
    console.log(`skip ${set.dir}: repo has no LICENSE yet (spec D6) — GPL fixtures wait for it`);
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
    expect(fixtureText('kicad-demos/SOURCE')).toMatch(/GPL-3.0-or-later/);
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
    if (c.file.size > INTAKE_CAPS.perFileBytes) throw capError(`${basename(c.path)} is ${formatMb(c.file.size)} MB; the limit per file is ${formatMb(INTAKE_CAPS.perFileBytes)} MB.`);
    total += c.file.size;
  }
  if (total > INTAKE_CAPS.totalBytes) throw capError(`Those files total ${formatMb(total)} MB; the limit is ${formatMb(INTAKE_CAPS.totalBytes)} MB.`);

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

  const proPath = [...files.keys()].find((p) => extensionOf(p) === '.kicad_pro') ?? null;
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
  if (unreachable.length > 0) warnings.push(`${unreachable.length} schematic file(s) are not reachable from the root sheet and were not read: ${unreachable.map(basename).join(', ')}.`);

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
import { describe, expect, it } from 'vitest';
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

  it('dedupes multi-unit symbols on (path, reference)', async () => {
    const body = `${symbol({ lib: 'Amplifier:LM358', uuid: 'u1a', ref: 'U1', value: 'LM358', unit: 1 })} ${symbol({ lib: 'Amplifier:LM358', uuid: 'u1b', ref: 'U1', value: 'LM358', unit: 2 })}`;
    const r = await lines([f('main.kicad_sch', schematic({ uuid: ROOT_UUID, body }))]);
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

  it('returns an error, not lines, for a project with no schematic', async () => {
    const r = readBomLines(await buildProject([f('b.kicad_pcb', '(kicad_pcb (version 20241229))')]));
    expect(r.error).toMatch(/no schematic/i);
    expect(r.lines).toEqual([]);
  });
});

describe('readSchematic — Glasgow revC3', () => {
  it('reads every reference once, with the twice-placed io_buffer doubled', async () => {
    const r = await lines(fixtureFiles('glasgow-revC3'));
    const refs = r.result.lines.flatMap((l) => l.refs);
    expect(new Set(refs).size).toBe(refs.length);
    expect(r.instances).toBeGreaterThan(100);
    // Pin the exact counts on first run and keep them: they are the regression fingerprint.
    expect({ lines: r.result.lines.length, instances: r.instances }).toMatchInlineSnapshot();
    expect([...r.refs.values()].filter((l) => l.sheet === 'io_buffer.kicad_sch').map((l) => l.instancePath)).toHaveLength(r.instances - [...r.refs.values()].filter((l) => l.sheet !== 'io_buffer.kicad_sch').length);
  });
});

describe.skipIf(!hasFixture('kicad-demos'))('readSchematic — KiCad demo complex_hierarchy', () => {
  it('yields 92 references from 46 symbols in the twice-placed sheet', async () => {
    const r = await lines(fixtureFiles('kicad-demos').filter((x) => x.name.startsWith('complex_hierarchy/')));
    const ampRefs = [...r.refs.values()].filter((l) => l.sheet === 'complex_hierarchy/ampli_ht.kicad_sch');
    expect(ampRefs).toHaveLength(92);
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
  let skippedNotInBom = 0;
  let skippedPower = 0;

  const visit = (sheetPath: string, sheetUuids: string[], depth: number): void => {
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
      const ref = referenceFromInstances(sym, pathV7) ?? legacy.get(`${pathV6}/${uuid}`.toLowerCase()) ?? clean(props.get('Reference'));
      if (ref == null || ref.startsWith('#') || power.has(libId)) {
        skippedPower++;
        continue;
      }
      const key = `${pathV7}|${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let mpn: string | null = null;
      let manufacturer: string | null = null;
      let distributorPn: string | null = null;
      for (const [name, value] of props) {
        if (BUILTIN_PROPERTIES.has(name)) continue;
        const role: BomRole | null = matchHeader(name);
        const v = clean(value);
        if (v == null) continue;
        if (role === 'mpn' && mpn == null) mpn = v;
        else if (role === 'manufacturer' && manufacturer == null) manufacturer = v;
        else if (role === 'distributor_pn' && distributorPn == null) distributorPn = v;
      }
      instances.push({
        ref, mpn, manufacturer, distributorPn,
        value: clean(props.get('Value')),
        footprint: clean(props.get('Footprint')),
        description: clean(props.get('Description')),
        dnp: atom(child(sym, 'dnp') ?? [], 1) === 'yes',
        sheet: sheetPath,
        instancePath: pathV7,
      });
      refs.set(ref, { sheet: sheetPath, instancePath: pathV7 });
    }
    for (const sh of children(doc, 'sheet')) {
      const uuid = (atom(child(sh, 'uuid') ?? [], 1) ?? '').toLowerCase();
      const file = properties(sh).get('Sheetfile');
      if (uuid === '' || file == null) continue;
      const r = resolveSheetRef(sheetPath, file, docs.keys());
      if ('missing' in r) continue;
      visit(r.path, [...sheetUuids, uuid], depth + 1);
    }
  };
  visit(project.root, [], 0);

  const skipped = skippedNotInBom + skippedPower;
  if (skipped > 0) warnings.push(`${skipped} symbols skipped: ${skippedNotInBom} not in BOM, ${skippedPower} power or virtual.`);
  if (project.missingSheets.length > 0) warnings.push(`Parts on the missing sheet(s) ${project.missingSheets.join(', ')} are not in this BOM.`);

  const groups = new Map<string, Instance[]>();
  for (const inst of instances) {
    const key = [inst.mpn, inst.manufacturer, inst.value, inst.footprint, inst.dnp ? 'dnp' : ''].map((v) => v ?? '').join('\u0000');
    const bucket = groups.get(key);
    if (bucket) bucket.push(inst);
    else groups.set(key, [inst]);
  }

  const lines: ParsedBomLine[] = [];
  let index = 0;
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

  it('reads Glasgow revC3: four copper layers, a stackup, 410 through + 7 locked-through vias', () => {
    const s = readStackup(fixtureText('glasgow-revC3/glasgow.kicad_pcb'));
    expect(s.copperLayers.map((l) => l.name)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    expect(s.stackup).not.toBeNull();
    expect(s.vias.filter((g) => g.type === 'through').reduce((n, g) => n + g.count, 0)).toBe(417);
    expect(s.vias.some((g) => g.type === 'unknown')).toBe(false);
  });

  it.skipIf(!hasFixture('kicad-demos'))('reads the KiCad 10 StickHub board (version 20250907) with no unknown via', () => {
    const s = readStackup(fixtureText('kicad-demos/stickhub/StickHub.kicad_pcb'));
    expect(s.vias.reduce((n, g) => n + g.count, 0)).toBe(87);
    expect(s.stackup?.some((r) => r.type === 'core')).toBe(true);
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
import type { BoardStackup, CopperLayer, SExpr, StackupRow, ViaGroup, ViaType } from './types';

const KIND: Record<string, string> = { signal: 'Signal', power: 'Plane', mixed: 'Mixed', jumper: 'Jumper' };

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
  let copper: CopperLayer[] = [];
  let stackup: StackupRow[] | null = null;
  let copperFinish: string | null = null;
  let designThicknessMm: number | null = null;
  const groups = new Map<string, ViaGroup>();

  for (const block of topLevelBlocks(boardText)) {
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
export type FocusResult = 'focused' | 'not-found' | 'unsupported';

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
// frontend/src/public/components/kicad/kicanvasController.test.ts
import { describe, expect, it } from 'vitest';
import type { KicadProject } from '@public/services/kicad/types';
import { KicanvasController, sourcesFor } from './kicanvasController';

interface FakePage { type: 'pcb' | 'schematic'; filename: string; sheet_path: string; project_path: string }

function project(files: Record<string, string>, extra: Partial<KicadProject> = {}): KicadProject {
  const map = new Map(Object.entries(files));
  const sheets = [...map.keys()].filter((k) => k.endsWith('.kicad_sch')).map((path) => ({ path, uuid: `u-${path}`, text: map.get(path) as string }));
  return { name: 'p', files: map, pro: null, root: sheets[0]?.path ?? null, sheets, board: [...map.keys()].find((k) => k.endsWith('.kicad_pcb')) ?? null, warnings: [], missingSheets: [], formatVersions: {}, ...extra };
}

/** A fake embed: a shadow root holding fake app elements with the public
 *  surface the controller relies on (project, viewer). */
function fakeEmbed(opts: { pages: FakePage[]; selectedFor?: string[]; viewerDoc?: boolean; withProject?: boolean }) {
  const embed = document.createElement('kicanvas-embed');
  const shadow = embed.attachShadow({ mode: 'open' });
  let active: FakePage | null = null;
  const proj = {
    pages: () => opts.pages,
    get active_page() { return active; },
    root_schematic_page: opts.pages.find((p) => p.type === 'schematic') ?? null,
    set_active_page(p: FakePage | string) { active = typeof p === 'string' ? (opts.pages.find((x) => x.project_path === p) ?? null) : p; },
  };
  const selected: string[] = [];
  const viewer = {
    document: opts.viewerDoc === false ? null : { filename: 'x.kicad_sch' },
    selected: false as boolean | string,
    select(ref: string) { selected.push(ref); this.selected = (opts.selectedFor ?? []).includes(ref) ? ref : false; },
    zoom_to_selection() { /* no-op */ },
  };
  const sch = document.createElement('kc-schematic-app') as HTMLElement & { project?: unknown; viewer?: unknown };
  if (opts.withProject !== false) sch.project = proj;
  sch.viewer = viewer;
  shadow.appendChild(sch);
  const board = document.createElement('kc-board-app') as HTMLElement & { project?: unknown };
  if (opts.withProject !== false) board.project = proj;
  shadow.appendChild(board);
  // The real embed sets an active page after load; the fake does it immediately.
  proj.set_active_page(proj.root_schematic_page ?? opts.pages[0]!);
  return { embed, selected, getActive: () => active, viewer };
}

const PAGES: FakePage[] = [
  { type: 'schematic', filename: 'main.kicad_sch', sheet_path: '/r', project_path: 'main.kicad_sch' },
  { type: 'schematic', filename: 'sub.kicad_sch', sheet_path: '/r/a', project_path: 'sub.kicad_sch:/r/a' },
  { type: 'schematic', filename: 'sub.kicad_sch', sheet_path: '/r/b', project_path: 'sub.kicad_sch:/r/b' },
  { type: 'pcb', filename: 'main.kicad_pcb', sheet_path: '', project_path: 'main.kicad_pcb' },
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
    expect(await c.activate('board')).toBe(true);
    expect(fake.getActive()?.type).toBe('pcb');
    const sch = fake.embed.shadowRoot!.querySelector('kc-schematic-app') as HTMLElement;
    const brd = fake.embed.shadowRoot!.querySelector('kc-board-app') as HTMLElement;
    expect([sch.hidden, brd.hidden]).toEqual([true, false]);
    expect(await c.activate('schematic', 'sub.kicad_sch')).toBe(true);
    expect([sch.hidden, brd.hidden]).toEqual([false, true]);
    expect(fake.getActive()?.project_path).toBe('sub.kicad_sch:/r/a');
    expect(await c.activate('schematic', '/r/b')).toBe(true);
    expect(fake.getActive()?.project_path).toBe('sub.kicad_sch:/r/b');
    expect(await c.activate('schematic', 'nope.kicad_sch')).toBe(false);
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

  it('zooms through the viewer camera when it exists and reports false when it does not', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    const v = fake.viewer as typeof fake.viewer & { zoom_to_page?: () => void; viewport?: { camera: { zoom: number }; draw: () => void } };
    let fitted = 0;
    v.zoom_to_page = () => fitted++;
    v.viewport = { camera: { zoom: 1 }, draw: () => undefined };
    const c = controller(fake);
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    expect(await c.zoom('fit')).toBe(true);
    expect(fitted).toBe(1);
    expect(await c.zoom('in')).toBe(true);
    expect(v.viewport.camera.zoom).toBeCloseTo(1.25);
    expect(await c.zoom('out')).toBe(true);
    expect(v.viewport.camera.zoom).toBeCloseTo(1);
    delete v.viewport;
    expect(await c.zoom('in')).toBe(false);
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
}

type KicanvasApp = HTMLElement & { project?: KicanvasProject; viewer?: KicanvasViewer };

export interface KicanvasControllerOptions {
  loadModule?: () => Promise<unknown>;
  createEmbed?: () => HTMLElement;
  /** 15 s: the first GPU mount of Glasgow took 4.3 s to the app element; the deadline pauses while the tab is hidden (spec §5.2). */
  readyMs?: number;
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const CANVAS_READY_MS = 15000;
const POLL_MS = 50;

let moduleLoad: Promise<unknown> | null = null;
function loadKicanvasOnce(loader: () => Promise<unknown>): Promise<unknown> {
  moduleLoad ??= loader();
  return moduleLoad;
}

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

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class KicanvasController implements CanvasController {
  private readonly options: Required<KicanvasControllerOptions>;
  private embed: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private disposed = false;
  private readonly handlers = new Map<CanvasEventType, Set<(e: CanvasEvent) => void>>();

  constructor(options: KicanvasControllerOptions = {}) {
    this.options = {
      loadModule: options.loadModule ?? (() => import('@vendor-build/kicanvas')),
      createEmbed: options.createEmbed ?? (() => document.createElement('kicanvas-embed')),
      readyMs: options.readyMs ?? CANVAS_READY_MS,
      settleMs: options.settleMs ?? 1500,
      sleep: options.sleep ?? defaultSleep,
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

  async mount(host: HTMLElement, project: KicadProject): Promise<void> {
    this.disposeEmbed();
    this.host = host;
    this.disposed = false;
    this.emit({ type: 'state', state: 'loading' });
    try {
      await loadKicanvasOnce(this.options.loadModule);
    } catch (err) {
      this.emit({ type: 'state', state: 'error', detail: err instanceof Error ? err.message : 'renderer failed to load' });
      return;
    }
    if (this.disposed) return;
    const embed = this.options.createEmbed();
    embed.setAttribute('controls', 'basic');
    embed.setAttribute('controlslist', 'nodownload nooverlay');
    embed.setAttribute('theme', 'kicad');
    for (const source of sourcesFor(project).sources) {
      const el = document.createElement('kicanvas-source');
      el.setAttribute('name', source.name);
      el.setAttribute('type', source.type);
      el.textContent = source.text;
      embed.appendChild(el);
    }
    this.embed = embed;
    host.replaceChildren(embed);

    let deadline = Date.now() + this.options.readyMs;
    while (Date.now() < deadline) {
      if (this.disposed) return;
      if (this.project()?.active_page != null) {
        // The embed's own initial page is whatever `first_page` is (the board, on
        // Glasgow) — the host's first activate() sets the requested view.
        this.emit({ type: 'state', state: 'ready' });
        return;
      }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        // Background tabs throttle animation frames; the mount just waits. Do not
        // count hidden time against the deadline.
        deadline += POLL_MS;
      }
      await this.options.sleep(POLL_MS);
      if (this.options.sleep !== defaultSleep && Date.now() >= deadline) break;
    }
    this.disposeEmbed();
    this.emit({ type: 'state', state: 'timeout' });
  }

  private findPage(view: CanvasView, sheet?: string): KicanvasPage | null {
    const project = this.project();
    if (project == null) return null;
    const pages = [...project.pages()];
    if (view === 'board') return pages.find((p) => p.type === 'pcb') ?? null;
    if (sheet == null) return project.root_schematic_page ?? pages.find((p) => p.type === 'schematic') ?? null;
    const wanted = sheet.toLowerCase();
    const byInstance = pages.find((p) => p.type === 'schematic' && p.sheet_path.toLowerCase() === wanted);
    if (byInstance) return byInstance;
    const name = basename(sheet).toLowerCase();
    return pages.find((p) => p.type === 'schematic' && basename(p.filename).toLowerCase() === name) ?? null;
  }

  async activate(view: CanvasView, sheet?: string): Promise<boolean> {
    const project = this.project();
    const page = this.findPage(view, sheet);
    if (project == null || page == null) return false;
    try {
      project.set_active_page(page);
    } catch {
      return false;
    }
    const { schematic, board } = this.apps();
    const app = view === 'board' ? board : schematic;
    const deadline = Date.now() + this.options.settleMs;
    while (Date.now() < deadline) {
      const doc = app?.viewer?.document;
      if (doc == null || doc.filename == null || basename(doc.filename) === basename(page.filename)) break;
      await this.options.sleep(POLL_MS);
      if (this.options.sleep !== defaultSleep) break;
    }
    // Upstream's app.load() assigns `hidden = false` AFTER an await, so two quick page
    // changes can leave both apps visible side by side (the owner's "screen duplicates
    // itself", reproduced 2026-09-12). Visibility is ours to enforce, every time.
    if (schematic) schematic.hidden = view !== 'schematic';
    if (board) board.hidden = view !== 'board';
    return true;
  }

  async focusRef(ref: string, sheet?: string): Promise<FocusResult> {
    if (sheet != null && !(await this.activate('schematic', sheet))) return 'not-found';
    const viewer = this.apps().schematic?.viewer;
    if (viewer?.document == null || typeof viewer.select !== 'function' || typeof viewer.zoom_to_selection !== 'function') {
      return 'unsupported';
    }
    try {
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

  /** Task 2.1 finds the camera API in the vendored source (src/viewers/base/viewer.ts and
   *  src/base/math/camera2.ts): `zoom_to_page()` is documented; for the steps use the
   *  viewer's viewport camera (`viewer.viewport.camera.zoom *= 1.25` / `/= 1.25` followed by
   *  the viewport's draw) if present. Every path feature-detects and returns false. */
  async zoom(action: ZoomAction): Promise<boolean> {
    const { schematic, board } = this.apps();
    const app = this.project()?.active_page?.type === 'pcb' ? board : schematic;
    const viewer = app?.viewer as (KicanvasViewer & { zoom_to_page?: () => void; viewport?: { camera?: { zoom: number }; draw?: () => void } }) | undefined;
    if (viewer?.document == null) return false;
    try {
      if (action === 'fit') {
        if (typeof viewer.zoom_to_page !== 'function') return false;
        viewer.zoom_to_page();
        return true;
      }
      const camera = viewer.viewport?.camera;
      if (camera == null || typeof camera.zoom !== 'number') return false;
      camera.zoom = action === 'in' ? camera.zoom * 1.25 : camera.zoom / 1.25;
      viewer.viewport?.draw?.();
      return true;
    } catch {
      return false;
    }
  }

  private disposeEmbed(): void {
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
- Test: `frontend/src/public/components/kicad/webgl.test.ts` (happy-dom)

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

export function webgl2Supported(create: () => HTMLCanvasElement = () => document.createElement('canvas')): boolean {
  if (probed != null) return probed;
  const gl = create().getContext('webgl2') as { getExtension?: (name: string) => { loseContext: () => void } | null } | null;
  probed = gl != null;
  if (gl?.getExtension) gl.getExtension('WEBGL_lose_context')?.loseContext();
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
  project: KicadProject;
  view: CanvasView;
  /** Path key of the schematic to show, or an instance path; default root. */
  activeSheet?: string;
  onState?: (state: CanvasStateName, detail?: string) => void;
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
  { project, view, activeSheet, onState, createController },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<CanvasController | null>(null);
  const [state, setState] = useState<CanvasStateName>('loading');
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const supported = webgl2Supported();

  useEffect(() => {
    if (!supported) {
      setState('no-webgl');
      onState?.('no-webgl');
      return;
    }
    const host = hostRef.current;
    if (host == null) return;
    const controller = (createController ?? (() => new KicanvasController()))();
    controllerRef.current = controller;
    const off = controller.on('state', (e) => {
      setState(e.state);
      setDetail(e.detail);
      onState?.(e.state, e.detail);
    });
    void controller.mount(host, project);
    return () => {
      off();
      controller.dispose();
      controllerRef.current = null;
    };
    // `attempt` re-mounts on "Try again"; onState/createController are stable by convention.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, attempt, supported]);

  useEffect(() => {
    if (state !== 'ready') return;
    void controllerRef.current?.activate(view, activeSheet);
  }, [state, view, activeSheet]);

  useImperativeHandle(ref, () => ({
    focusRef: (r, sheet) => controllerRef.current?.focusRef(r, sheet) ?? Promise.resolve('unsupported' as const),
    zoom: (action) => controllerRef.current?.zoom(action) ?? Promise.resolve(false),
  }));

  const frameRef = useRef<HTMLDivElement>(null);
  const [zoomable, setZoomable] = useState(true);
  const zoom = async (action: ZoomAction) => {
    const ok = await controllerRef.current?.zoom(action);
    if (ok === false) setZoomable(false);
  };
  const fullscreenEnabled = typeof document !== 'undefined' && document.fullscreenEnabled;
  const toggleFullscreen = () => {
    const el = frameRef.current;
    if (el == null) return;
    if (document.fullscreenElement === el) void document.exitFullscreen();
    else void el.requestFullscreen();
  };

  const failed = state === 'no-webgl' || state === 'timeout' || state === 'error';
  return (
    <div ref={frameRef} className={styles.frame} data-state={state}>
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

.frameCompact {
  flex: 0 0 auto;
  height: 45vh;
}

// Fit / + / − / fullscreen over the drawing: essential on coarse pointers
// (KiCanvas's pinch-zoom barely works on a phone — owner, Phase 0 gate), kept on
// desktop too. Glass controls float over content, which is what the recipe is for.
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

.retry {
  @include bom-glass-control;
  justify-self: center;
  padding: 8px 16px;
  line-height: 1;
  cursor: pointer;
}
```

If `bom-glass-control` or `bom-card` need arguments in `_bomMaterial.scss`, mirror how `BomPage.module.scss` calls them.

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
- Create: `frontend/src/public/pages/viewer/components/ViewerIntake.tsx`, `frontend/src/public/pages/viewer/ViewerPage.module.scss`, `frontend/public/samples/glasgow-revC3.zip`, `frontend/public/vendor/kicanvas/NOTICE.txt`
- Modify: `frontend/src/shared/styles/global.scss` (one `@font-face`)

**Interfaces:**
- Consumes: `buildProject` (1.5), `KicadReadError` (1.2), `KicadProject`.
- Produces: `<ViewerIntake onProject busy?>`; `/samples/glasgow-revC3.zip`; `/vendor/kicanvas/NOTICE.txt`; the `"Material Symbols Outlined"` face.

- [ ] **Step 1: Build the sample zip and the notice**

```bash
cd /home/matthew/circuits-com/frontend
mkdir -p public/samples public/vendor/kicanvas
( cd src/public/services/kicad/fixtures/glasgow-revC3 && python3 -m zipfile -c ../../../../../../public/samples/glasgow-revC3.zip glasgow.kicad_pro glasgow.kicad_sch io_banks.kicad_sch io_buffer.kicad_sch glasgow.kicad_pcb LICENSE )
python3 -m zipfile -l public/samples/glasgow-revC3.zip   # six entries, no directory prefix
{
  echo "Circuit Center — third-party notices for the Design Viewer"; echo; echo "This programme is licensed under the GNU General Public License v3.0 or later (see /LICENSE in the source repository)."; echo;
  echo "=== KiCanvas — https://github.com/theacodes/kicanvas @ b031159eb74aaa7eef2b026fd85d35bc05ff2095 (vendored as source with two local patches; see frontend/vendor/kicanvas/patches) ==="; echo; cat vendor/kicanvas/LICENSE.md; echo;
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

`frontend/src/public/pages/viewer/ViewerPage.module.scss` — start with the four `@use` lines from `BomPage.module.scss` (replacing `'bomMaterial'` with `'@public/styles/bomMaterial'`), then **copy verbatim** these rule blocks from `BomPage.module.scss`: `.page`, `.stack`, `.intake`, `.drop`, `.dropActive`, `.crop`, `.cropTl`, `.cropTr`, `.cropBl`, `.cropBr`, `.dropLead`, `.btnRow`, `.formatLine`, `.dropBtn`, `.exampleBtn` (and the `.pasteToggle, .exampleBtn` disabled state), `.intakeError`, `.phaseText`, `.phaseWarn`, `.pageError`. Then add:

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
```

(`scrollbar-thin` is the existing mixin in `@shared/styles/mixins`. If a bom mixin takes parameters, copy the invocation form used in `BomPage.module.scss`.)

- [ ] **Step 4: Gates and commit**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/` (the SCSS compiles on the next `npm run build`; run `npx vite build` once now to catch a Sass error early — the prebuild runs too).

```bash
cd /home/matthew/circuits-com
git add frontend/src/public/pages/viewer frontend/public/samples/glasgow-revC3.zip frontend/public/vendor/kicanvas/NOTICE.txt frontend/src/shared/styles/global.scss
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
// Design Viewer — open a KiCad project in the browser (spec §7.1). Stage 1
// tabs: Schematic, Board; Phase 3 adds BOM, Phase 4 adds Stackup. ONE canvas
// element serves both drawing tabs (one embed per project); it is hidden, not
// unmounted, when another tab is active.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useLocation } from 'react-router-dom';
import PageHead from '@public/components/PageHead';
import PageHeaderBand from '@public/components/layout/PageHeaderBand';
import DesignCanvas, { type DesignCanvasHandle } from '@public/components/kicad/DesignCanvas';
import type { CanvasStateName } from '@public/components/kicad/canvasController';
import { basename } from '@public/services/kicad/project';
import type { KicadProject } from '@public/services/kicad/types';
import { clearDesignSession, getDesignSession, openDesign, type DesignSession } from '@public/services/designSession';
import { STATIC_PAGE_SEO } from '@public/services/seoRoutes';
import ViewerIntake from './components/ViewerIntake';
import styles from './ViewerPage.module.scss';

type Tab = 'schematic' | 'board' | 'stackup' | 'bom';

export const POSITIONING =
  'Open your KiCad project in the browser and get every line of the BOM priced across our whole distributor catalog — read straight out of your schematic, with no CSV export, no account, and nobody trying to win your board order.';

function sheetLabel(project: KicadProject, path: string): string {
  const stem = basename(path).replace(/\.kicad_sch$/i, '');
  return path === project.root ? `${stem} (root)` : stem;
}

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
  const canvasRef = useRef<DesignCanvasHandle>(null);
  const pendingFocus = useRef<string | null>(location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : null);

  const handleProject = useCallback((project: KicadProject) => {
    const next = openDesign(project);
    setSession(next);
    setTab(defaultTab(next));
    setActiveSheet(undefined);
    setCanvasState('loading');
  }, []);

  const openAnother = () => {
    clearDesignSession();
    setSession(null);
    setActiveSheet(undefined);
    pendingFocus.current = null;
  };

  const focus = useCallback(
    async (ref: string) => {
      const s = session;
      if (s == null) return;
      const where = s.refs.get(ref);
      setTab('schematic');
      const result = await canvasRef.current?.focusRef(ref, where?.instancePath);
      if (result === 'focused') setToast(`Focused ${ref}`);
      else if (result === 'not-found') setToast(where ? `${ref} was not found on sheet ${basename(where.sheet)}` : `${ref} is not in this schematic`);
    },
    [session],
  );

  // A #ref arrival (from /bom) focuses once, after the canvas is ready.
  useEffect(() => {
    if (canvasState !== 'ready' || pendingFocus.current == null || session == null) return;
    const ref = pendingFocus.current;
    pendingFocus.current = null;
    void focus(ref);
  }, [canvasState, session, focus]);

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
    // Phase 4: { id: 'stackup', label: 'Stackup' } when board != null
    // Phase 3: { id: 'bom', label: 'BOM' } when root != null
    return out;
  }, [session]);

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
                  {session.project.missingSheets.join(', ')} — add {session.project.missingSheets.length === 1 ? 'it' : 'them'} to
                  the drop and the drawing and BOM will include {session.project.missingSheets.length === 1 ? 'it' : 'them'}.
                </p>
              )}

              <div className={styles.tabs} role="tablist" aria-label="Views">
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    className={styles.tab}
                    aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {tab === 'schematic' && session.project.sheets.length > 1 && (
                <div className={styles.chips} role="group" aria-label="Sheets">
                  {session.project.sheets.map((s) => (
                    <button
                      key={s.path}
                      type="button"
                      className={styles.chip}
                      aria-current={(activeSheet ?? session.project.root) === s.path}
                      onClick={() => setActiveSheet(s.path)}
                    >
                      {sheetLabel(session.project, s.path)}
                    </button>
                  ))}
                </div>
              )}

              <div className={styles.drawing} hidden={!drawingVisible}>
                <DesignCanvas
                  ref={canvasRef}
                  project={session.project}
                  view={tab === 'board' ? 'board' : 'schematic'}
                  activeSheet={tab === 'schematic' ? activeSheet : undefined}
                  onState={setCanvasState}
                />
                <p className={styles.notice}>
                  Rendering by KiCanvas &mdash;{' '}
                  <a href="/vendor/kicanvas/NOTICE.txt" target="_blank" rel="noopener noreferrer">
                    licences
                  </a>
                </p>
              </div>

              {/* Phase 4: {tab === 'stackup' && <StackupPanel … />} */}
              {/* Phase 3: {tab === 'bom' && … workbench … onRefClick={(ref) => void focus(ref)} } */}
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
import { applyResolveEvent, buildRows, foldSimilarPick, pickMisses, RESOLVE_CAP, settleStragglers } from './useBomWorkbench';

const server = (over: Partial<BomRow>): BomRow =>
  ({ index: 0, status: 'none', part: null, offers: [], similar: [], approx_reason: null, resolve_query: null, ...over }) as BomRow;

const line = (index: number, over: Partial<TableRow> = {}): TableRow => ({
  index, mpn: null, value: '1k', footprint: null, description: null, manufacturer: null, distributorPn: null, qty: 1, refs: [`R${index}`], dnp: false,
  server: null, state: 'matched', viewerHref: null, ...over,
});

describe('buildRows', () => {
  it('joins server answers by index, marks unanswered lines not_found, and stamps the viewer route', () => {
    const rows = buildRows([line(0), line(1)], [server({ index: 1, status: 'exact' })], '/viewer');
    expect(rows.map((r) => [r.state, r.server?.status ?? null, r.viewerHref])).toEqual([['not_found', null, '/viewer'], ['matched', 'exact', '/viewer']]);
  });
});

describe('applyResolveEvent', () => {
  const rows = [line(0, { state: 'resolving' }), line(1, { state: 'resolving' })];
  const ev = (over: Partial<ResolveEvent>): ResolveEvent => ({ kind: 'resolved', index: 0, detail: null, row: null, ...over });
  it('lands a resolved row as resolved_live, and a rowless resolved back on matched', () => {
    expect(applyResolveEvent(rows, ev({ row: server({ index: 0, status: 'exact_live' }) }))[0]).toMatchObject({ state: 'resolved_live', server: { status: 'exact_live' } });
    expect(applyResolveEvent(rows, ev({}))[0]?.state).toBe('matched');
  });
  it('maps not_found and resolve_unavailable, touching only the named index', () => {
    const out = applyResolveEvent(rows, ev({ kind: 'not_found', index: 1 }));
    expect(out.map((r) => r.state)).toEqual(['resolving', 'not_found']);
    expect(applyResolveEvent(rows, ev({ kind: 'resolve_unavailable', index: 0 }))[0]?.state).toBe('unavailable');
  });
});

describe('settleStragglers', () => {
  it('returns every still-resolving row to matched', () => {
    expect(settleStragglers([line(0, { state: 'resolving' }), line(1, { state: 'not_found' })]).map((r) => r.state)).toEqual(['matched', 'not_found']);
  });
});

describe('pickMisses', () => {
  const miss = (index: number, over: Partial<TableRow> = {}) => line(index, { server: server({ index, status: 'resolve', resolve_query: `q${index}` }), ...over });
  it('takes resolve rows with a query, MPN-first, skips DNP unless included, caps at RESOLVE_CAP', () => {
    const rows = [miss(0), miss(1, { mpn: 'ABC' }), miss(2, { dnp: true }), line(3), miss(4, { server: server({ index: 4, status: 'resolve', resolve_query: '' }) })];
    expect(pickMisses(rows, false).misses.map((m) => m.index)).toEqual([1, 0]);
    expect(pickMisses(rows, true).misses.map((m) => m.index)).toEqual([1, 0, 2]);
    const many = Array.from({ length: RESOLVE_CAP + 5 }, (_, i) => miss(i));
    expect(pickMisses(many, false)).toMatchObject({ dropped: 5 });
  });
});

describe('foldSimilarPick', () => {
  it('swaps in the fresh match as approx and folds the displaced part into the menu', () => {
    const displaced = { id: 'p1', sku: 'OLD', manufacturer_name: 'M', description: null, package: null, lifecycle_status: null, lifecycle_verified: false };
    const rows = [line(0, { server: server({ index: 0, status: 'exact', part: displaced as BomRow['part'], similar: [{ ...displaced, id: 'p2', sku: 'NEW' }] }) })];
    const out = foldSimilarPick(rows, 0, 'NEW', server({ index: 0, status: 'exact', part: { ...displaced, id: 'p2', sku: 'NEW' } as BomRow['part'] }));
    expect(out[0]?.server).toMatchObject({ status: 'approx', approx_reason: 'your pick — similar part' });
    expect(out[0]?.server?.similar.map((s) => s.sku)).toEqual(['OLD']);
  });
  it('leaves other rows and rows with no server answer untouched', () => {
    const rows = [line(0), line(1)];
    expect(foldSimilarPick(rows, 0, 'X', server({ index: 0, part: null }))).toEqual(rows);
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
export const RESOLVE_CAP = 50;
export const RESOLVE_STOPPED =
  'Live lookups stopped early. The lines still marked NO MATCH were never looked up — try again in a moment.';

export function cappedNote(dropped: number): string {
  const lines = dropped === 1 ? 'line was' : 'lines were';
  return (
    `Live lookups are capped at ${RESOLVE_CAP} lines per BOM — ` +
    `${dropped.toLocaleString('en-US')} further unmatched ${lines} left unresolved. ` +
    'Request a quote for those lines.'
  );
}

export function pickMisses(rows: TableRow[], includeDnp: boolean): { misses: MissIn[]; dropped: number } {
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
  return { misses: ordered.slice(0, RESOLVE_CAP), dropped: Math.max(0, ordered.length - RESOLVE_CAP) };
}

/** Phase-1 rows: `matched` means "the server answered"; `not_found` means it did not. */
export function buildRows(lines: ParsedBomLine[], serverRows: BomRow[], viewerHref: string | null): TableRow[] {
  const byIndex = new Map(serverRows.map((row) => [row.index, row]));
  return lines.map((line) => {
    const server = byIndex.get(line.index) ?? null;
    return { ...line, server, state: server == null ? ('not_found' as const) : ('matched' as const), viewerHref };
  });
}

export function applyResolveEvent(rows: TableRow[], event: ResolveEvent): TableRow[] {
  return rows.map((row) => {
    if (row.index !== event.index) return row;
    switch (event.kind) {
      case 'resolved':
        return event.row == null ? { ...row, state: 'matched' as const } : { ...row, server: event.row, state: 'resolved_live' as const };
      case 'not_found':
        return { ...row, state: 'not_found' as const };
      case 'resolve_unavailable':
        return { ...row, state: 'unavailable' as const };
      default:
        return row;
    }
  });
}

export function settleStragglers(rows: TableRow[]): TableRow[] {
  return rows.map((row) => (row.state === 'resolving' ? { ...row, state: 'matched' as const } : row));
}

/** The Matches column's "Similar" pick applied: the fresh match replaces the
 *  answer as approx, the displaced part joins the menu, the pick stays reversible. */
export function foldSimilarPick(rows: TableRow[], rowIndex: number, sku: string, fresh: BomRow): TableRow[] {
  if (fresh.part == null) return rows;
  return rows.map((r) => {
    if (r.index !== rowIndex || r.server == null) return r;
    const displaced = r.server.part;
    const keptSimilar = [
      ...(displaced != null
        ? [{ id: displaced.id, sku: displaced.sku, manufacturer_name: displaced.manufacturer_name, description: displaced.description, package: displaced.package, lifecycle_status: displaced.lifecycle_status, lifecycle_verified: displaced.lifecycle_verified }]
        : []),
      ...r.server.similar,
    ].filter((s) => s.sku !== sku);
    return { ...r, server: { ...fresh, status: 'approx' as const, approx_reason: 'your pick — similar part', similar: keptSimilar } };
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
  /** Back to nothing: aborts any stream and clears every field. */
  reset: () => void;
}

export function useBomWorkbench(parsed: ParseResult | null, viewerHref: string | null): BomWorkbench {
  const [rows, setRows] = useState<TableRow[]>([]);
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [buildQty, setBuildQty] = useState(1);
  const [includeDnp, setIncludeDnp] = useState(false);
  const includeDnpRef = useRef(includeDnp);
  includeDnpRef.current = includeDnp;
  const pickSeqRef = useRef(new Map<number, number>());
  const [resolveNote, setResolveNote] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const resolveAbort = useRef<AbortController | null>(null);

  useEffect(() => () => resolveAbort.current?.abort(), []);

  const startResolve = useCallback((built: TableRow[]) => {
    const { misses, dropped } = pickMisses(built, includeDnpRef.current);
    setResolveNote(dropped > 0 ? cappedNote(dropped) : null);
    setResolveError(null);
    if (misses.length === 0) {
      setRows(built);
      return;
    }
    const asking = new Set(misses.map((m) => m.index));
    setRows(built.map((row) => (asking.has(row.index) ? { ...row, state: 'resolving' as const } : row)));
    resolveAbort.current?.abort();
    const controller = new AbortController();
    resolveAbort.current = controller;
    bomApi
      .streamResolve(misses, (event) => setRows((prev) => applyResolveEvent(prev, event)), controller.signal)
      .then(() => {
        if (controller.signal.aborted) return;
        setRows(settleStragglers);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setRows(settleStragglers);
        setResolveError(RESOLVE_STOPPED);
      });
  }, []);

  // Phase 1 — once per parse, keyed on the IDENTITY of `parsed` (callers hold it in state or the session).
  useEffect(() => {
    if (parsed == null || parsed.error != null) return;
    const lines = parsed.lines;
    setRows([]);
    setMatchError(null);
    setMatching(true);
    let cancelled = false;
    bomApi
      .match(lines.map((l) => ({ index: l.index, mpn: l.mpn, value: l.value, footprint: l.footprint, description: l.description, manufacturer: l.manufacturer })))
      .then((serverRows) => {
        if (cancelled) return;
        setMatching(false);
        startResolve(buildRows(lines, serverRows, viewerHref));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const throttled = axios.isAxiosError(err) && err.response?.status === 429;
        setMatchError(throttled ? MATCH_THROTTLED : MATCH_FAILED);
        setMatching(false);
      });
    return () => {
      cancelled = true;
      resolveAbort.current?.abort();
    };
  }, [parsed, viewerHref, startResolve]);

  const pickSimilar = useCallback(
    (rowIndex: number, sku: string) => {
      const line = rows.find((r) => r.index === rowIndex);
      const seq = (pickSeqRef.current.get(rowIndex) ?? 0) + 1;
      pickSeqRef.current.set(rowIndex, seq);
      bomApi
        .match([{ index: rowIndex, mpn: sku, value: null, footprint: line?.footprint ?? null, description: null, manufacturer: null }])
        .then(([fresh]) => {
          if (pickSeqRef.current.get(rowIndex) !== seq || fresh == null) return;
          setRows((prev) => foldSimilarPick(prev, rowIndex, sku, fresh));
        })
        .catch((err) => {
          if (pickSeqRef.current.get(rowIndex) !== seq) return;
          const throttled = axios.isAxiosError(err) && err.response?.status === 429;
          setResolveError(throttled ? MATCH_THROTTLED : 'Could not switch to that part — try again in a moment.');
        });
    },
    [rows],
  );

  const reset = useCallback(() => {
    resolveAbort.current?.abort();
    setRows([]);
    setMatchError(null);
    setMatching(false);
    setResolveNote(null);
    setResolveError(null);
    setBuildQty(1);
    setIncludeDnp(false);
  }, []);

  return { rows, matching, matchError, resolveNote, resolveError, buildQty, setBuildQty, includeDnp, setIncludeDnp, pickSimilar, reset };
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
});
```

```ts
// frontend/src/public/services/bom/viewerLink.ts
/** `TableRow.viewerHref` is the viewer ROUTE; the chip appends the reference
 *  as a hash the viewer page reads on mount (spec §6). One home for the
 *  composition so the two sides cannot drift. */
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
  font: inherit;
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
import { bands, formatMm, summarize, tableRows, viaSpans } from './stackupLayout';

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
    expect(summarize(FULL)).toEqual({ total: 3, signal: 2, plane: 1, dielectric: 2, listed: '1.198 mm', design: '1.200 mm', thru: 40, blindBuried: 3, micro: 0, unknown: 1, finish: 'ENIG' });
    expect(summarize(BARE)).toMatchObject({ dielectric: 0, listed: null, design: '1.200 mm', finish: null });
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
import type { BoardStackup, ViaType } from '@public/services/kicad/types';

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

const DIELECTRIC = new Set(['core', 'prepreg']);
const HAIRLINE = 1;
const MIN_BAND = 2;

export function formatMm(value: number | null): string {
  return value == null ? '—' : value.toFixed(4);
}

function kindOf(name: string, type: string): BandKind {
  if (name.endsWith('.Cu') || type === 'copper') return 'copper';
  if (DIELECTRIC.has(type)) return 'dielectric';
  if (/mask/i.test(type)) return 'mask';
  return 'other';
}

export function tableRows(s: BoardStackup): StackupTableRow[] {
  const ordinalByName = new Map(s.copperLayers.map((c) => [c.name, c]));
  if (s.stackup == null) {
    return s.copperLayers.map((c) => ({ ordinal: String(c.ordinal), layer: c.name, type: c.kind, thk: '—' }));
  }
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

export function summarize(s: BoardStackup): StackupSummary {
  const count = (t: ViaType) => s.vias.filter((g) => g.type === t).reduce((n, g) => n + g.count, 0);
  return {
    total: s.layerCount,
    signal: s.copperLayers.filter((c) => c.kind === 'Signal').length,
    plane: s.copperLayers.filter((c) => c.kind === 'Plane').length,
    dielectric: s.stackup == null ? 0 : s.stackup.filter((r) => DIELECTRIC.has(r.type)).length,
    listed: s.listedThicknessMm == null ? null : `${s.listedThicknessMm.toFixed(3)} mm`,
    design: s.designThicknessMm == null ? null : `${s.designThicknessMm.toFixed(3)} mm`,
    thru: count('through'),
    blindBuried: count('blind'),
    micro: count('micro'),
    unknown: count('unknown'),
    finish: s.copperFinish,
  };
}

/** Rows with a thickness share the height in proportion (never under MIN_BAND
 *  px); rows without one get a hairline. Without a stackup block the copper
 *  layers are drawn as equal bands so the via spans still have anchors. */
export function bands(s: BoardStackup, heightPx: number): Band[] {
  const rows = s.stackup ?? s.copperLayers.map((c) => ({ name: c.name, type: 'copper', thicknessMm: null as number | null }));
  const sized = rows.filter((r) => r.thicknessMm != null && r.thicknessMm > 0);
  const total = sized.reduce((n, r) => n + (r.thicknessMm as number), 0);
  const hairlines = rows.length - sized.length;
  const available = Math.max(0, heightPx - hairlines * HAIRLINE);
  const equal = sized.length === 0 ? available / Math.max(1, rows.length) : 0;
  let y = 0;
  return rows.map((r) => {
    const h = r.thicknessMm != null && r.thicknessMm > 0 && total > 0
      ? Math.max(MIN_BAND, (r.thicknessMm / total) * available)
      : sized.length === 0
        ? Math.max(MIN_BAND, equal)
        : HAIRLINE;
    const band: Band = { name: r.name, kind: kindOf(r.name, r.type), y, h };
    y += h;
    return band;
  });
}

export function viaSpans(s: BoardStackup, drawn: Band[]): ViaSpan[] {
  const centre = (name: string): number | null => {
    const b = drawn.find((x) => x.name === name);
    return b == null ? null : b.y + b.h / 2;
  };
  const out: ViaSpan[] = [];
  s.vias.forEach((g, i) => {
    const y1 = centre(g.start);
    const y2 = centre(g.end);
    if (y1 == null || y2 == null) return;
    out.push({ type: g.type, count: g.count, x: 24 + i * 18, y1: Math.min(y1, y2), y2: Math.max(y1, y2) });
  });
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
import { useMemo } from 'react';
import type { BoardStackup } from '@public/services/kicad/types';
import { bands, summarize, tableRows, viaSpans } from './stackupLayout';
import styles from './StackupPanel.module.scss';

const HEIGHT = 240;
const WIDTH = 320;
const STACK_X = 120;
const STACK_W = 180;

interface StackupPanelProps {
  stackup: BoardStackup;
}

export default function StackupPanel({ stackup }: StackupPanelProps) {
  const rows = useMemo(() => tableRows(stackup), [stackup]);
  const summary = useMemo(() => summarize(stackup), [stackup]);
  const drawn = useMemo(() => bands(stackup, HEIGHT), [stackup]);
  const spans = useMemo(() => viaSpans(stackup, drawn), [stackup, drawn]);
  const missing = stackup.stackup == null;

  return (
    <section className={styles.panel} aria-label="Board stackup">
      {missing && (
        <p className={styles.missing} role="status">
          This board has no physical stackup saved (Board Setup &rarr; Physical Stackup in KiCad); showing the copper layers
          and via counts the file does carry.
        </p>
      )}
      <div className={styles.zones}>
        <figure className={styles.section}>
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" role="img" aria-label="Cross-section of the board stack, to scale">
            {drawn.map((b) => (
              <g key={`${b.name}-${b.y}`}>
                <rect className={styles[`band_${b.kind}`]} x={STACK_X} y={b.y} width={STACK_W} height={b.h} />
                <line className={styles.leader} x1={STACK_X - 6} y1={b.y + b.h / 2} x2={STACK_X} y2={b.y + b.h / 2} />
                <text className={styles.label} x={STACK_X - 10} y={b.y + b.h / 2} textAnchor="end" dominantBaseline="middle">
                  {b.name}
                </text>
              </g>
            ))}
            {spans.map((v, i) => (
              <g key={i} className={styles[`via_${v.type}`]}>
                <line x1={STACK_X + STACK_W - v.x} y1={v.y1} x2={STACK_X + STACK_W - v.x} y2={v.y2} />
                <title>{`${v.count} ${v.type} via${v.count === 1 ? '' : 's'}`}</title>
              </g>
            ))}
          </svg>
          <figcaption className={styles.caption}>Drawn to scale from the thicknesses in the file</figcaption>
        </figure>

        <table className={styles.table}>
          <thead>
            <tr>
              <th>#</th>
              <th>Layer</th>
              <th>Type</th>
              <th>Thk (mm)</th>
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

        <dl className={styles.summary}>
          <dt>Total layers</dt><dd>{summary.total}</dd>
          <dt>Signal</dt><dd>{summary.signal}</dd>
          <dt>Plane</dt><dd>{summary.plane}</dd>
          <dt>Dielectric</dt><dd>{summary.dielectric}</dd>
          <dt>Listed thickness</dt><dd>{summary.listed ?? '—'}</dd>
          {summary.design != null && (
            <>
              <dt>Design thickness</dt><dd>{summary.design}</dd>
            </>
          )}
          {summary.finish != null && (
            <>
              <dt>Copper finish</dt><dd>{summary.finish}</dd>
            </>
          )}
          <dt>Thru vias</dt><dd>{summary.thru}</dd>
          <dt>Blind/Buried vias</dt><dd>{summary.blindBuried}</dd>
          <dt>Micro vias</dt><dd>{summary.micro}</dd>
          {summary.unknown > 0 && (
            <>
              <dt>Unknown via type</dt><dd>{summary.unknown}</dd>
            </>
          )}
        </dl>
      </div>
      <p className={styles.footnote}>
        Listed thickness is the sum of the thicknesses in the stackup block; design thickness is the board setting.
        KiCad&rsquo;s file does not distinguish blind from buried vias.
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

.panel {
  @include bom-card;
  padding: 16px;
}

.missing {
  margin: 0 0 12px;
  color: $text-secondary;
  font-size: 0.9rem;
}

.zones {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(260px, 1.2fr) minmax(180px, 0.8fr);
  gap: 20px;

  @media (max-width: $bp-mobile) {
    grid-template-columns: 1fr;
  }
}

.section {
  margin: 0;
}

.caption {
  margin-top: 6px;
  font-size: 0.75rem;
  color: $text-secondary;
}

// Band colours are tokens: mask green, copper bright, dielectric olive.
.band_copper { fill: #d9a441; }
.band_dielectric { fill: #7f8a3d; }
.band_mask { fill: #1f7a3f; }
.band_other { fill: #c9ced4; }

.leader {
  stroke: $text-secondary;
  stroke-width: 1;
}

.label {
  fill: $text-secondary;
  font-size: 9px;
  font-family: $font-mono;
}

.via_through line,
.via_blind line,
.via_micro line,
.via_unknown line {
  stroke-width: 4;
  stroke-linecap: round;
}
.via_through line { stroke: #6b7280; }
.via_blind line { stroke: #2563eb; }
.via_micro line { stroke: #7c3aed; }
.via_unknown line { stroke: $error-red; stroke-dasharray: 3 3; }

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
}
```

- [ ] **Step 2: The tab**

In `pages/viewer/index.tsx`: `import StackupPanel from '@public/components/kicad/StackupPanel'; import { readStackup } from '@public/services/kicad/boardStackup';`; in `tabs`, after Board: `if (session.project.board != null) out.push({ id: 'stackup', label: 'Stackup' });`; a memo `const stackup = useMemo(() => (session?.project.board == null ? null : readStackup(session.project.files.get(session.project.board) ?? '')), [session]);`; and after the drawing block: `{tab === 'stackup' && stackup != null && <StackupPanel stackup={stackup} />}`.

- [ ] **Step 3: Gates, smoke, commit, STOP — Phase 4 gate**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`. Locally: Glasgow's Stackup tab shows four copper rows with a saved stackup and 417 through vias; the keyboard panel board (drop `bad-thing-panel`) shows its stackup; a board saved without Board Setup (any fresh KiCad board) shows the honest message with copper rows and via counts.

```bash
git add frontend/src/public/components/kicad/StackupPanel.tsx frontend/src/public/components/kicad/StackupPanel.module.scss frontend/src/public/pages/viewer/index.tsx
git commit -m "feat(viewer): Stackup tab — cross-section to scale with real via spans, layer table, honest summary"
```

Owner checklist: compare the panel to KiCad's Board Setup → Physical Stackup for Glasgow revC3 and for one of his own boards; confirm the no-stackup state; phone width via `mobile-layout-guard`. Wait for explicit approval before Phase 5.

---

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
