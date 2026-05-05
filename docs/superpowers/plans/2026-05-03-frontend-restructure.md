# Frontend Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `/home/matthew/circuits-com/frontend/src/` from layered-by-type into bounded contexts (`src/public/`, `src/admin/`, `src/shared/`) with per-scope path aliases, page-folder colocation, and ESLint import boundaries — preserving all behavior.

**Architecture:** 4 sequential cycles. Each cycle follows a 6-stage template (cartography → plan → plan-verification → execute → verify-gate → simplify+commit) and produces exactly one git commit on `updates`. Hard verification gates between cycles. Per-cycle commits enable cheap rollback (`git reset --hard HEAD~1`).

**Tech Stack:** Vite 6, React 19, TypeScript 5.7, SCSS Modules, Framer Motion 12, lucide-react, react-router-dom 7. No tests exist for the frontend — verification is via 32-cell visual baselines at `tests/visual/baselines/`, `tsc --noEmit`, `vite build`, and agent-driven SPA smoke checks.

**Source of truth:** `docs/superpowers/specs/2026-05-03-frontend-restructure-design.md` (commit `5bad22b`). Plan steps reference the spec for architectural rationale; the spec is not duplicated here.

**Branch invariant:** All work on `updates`. No commits to master during this plan. No `--no-verify`, no `--force` git ops without explicit user permission.

---

## Pre-Flight Tasks (Phase 0)

### Task 0.1: Verify clean working tree on `updates` branch

**Files:**
- None modified

- [ ] **Step 1: Confirm branch and clean state**

Run:
```bash
cd /home/matthew/circuits-com
git status --short
git branch --show-current
git status -sb | head -1
```

Expected output:
```
(no modified files listed)
updates
## updates...origin/updates
```

If the working tree is dirty, halt. Investigate and either commit, stash, or discard before proceeding.

If the branch is not `updates`, run `git switch updates` and re-verify.

### Task 0.2: Capture pre-restructure perf + bundle baseline

**Files:**
- Create: `docs/superpowers/specs/2026-05-03-baseline.md`

- [ ] **Step 1: Build production bundle and record sizes**

Run:
```bash
cd /home/matthew/circuits-com/frontend
npm run build 2>&1 | tail -30
```

Capture: main chunk size in KB, framer chunk, router chunk, total dist size.

- [ ] **Step 2: Record baseline LCP for `/` and `/category/:slug`**

Use the chrome-devtools-mcp Lighthouse audit on the local dev server (`localhost`):
- Navigate to `/`, capture LCP value
- Navigate to `/category/active-components`, capture LCP value

- [ ] **Step 3: Write baseline to disk**

Create `docs/superpowers/specs/2026-05-03-baseline.md` with this exact content (substituting actual measurements):

```markdown
# Pre-Restructure Baseline

**Captured:** 2026-05-03 (pre-Cycle 1 of frontend restructure)

## Bundle sizes (`npm run build` output)
- Main chunk: <KB>
- framer chunk: <KB>
- router chunk: <KB>
- Total dist: <KB>

## LCP (Lighthouse, local dev server)
- `/`: <ms>
- `/category/active-components`: <ms>

## Acceptance reference
- Bundle within ±5% of these baselines = PASS
- LCP within ±10% of these baselines = PASS
```

- [ ] **Step 4: Commit baseline**

Run:
```bash
git add docs/superpowers/specs/2026-05-03-baseline.md
git commit -m "docs(specs): capture pre-restructure perf baseline"
```

### Task 0.3: Verify visual baselines exist

**Files:**
- Read-only check

- [ ] **Step 1: Confirm baseline directory**

Run:
```bash
ls -la /home/matthew/circuits-com/tests/visual/baselines/ 2>&1 | head -50
```

Expected: PNG files for the 32-cell theme×route matrix (4 themes × 8 routes minimum). Naming convention per CLAUDE.md: `<theme>-post-<taskN>.png`.

If the directory is empty or has fewer than 32 files, halt and ask user whether to capture fresh baselines via chrome-devtools-mcp before proceeding.

### Task 0.4: Note pre-Cycle-1 SHA for rollback

**Files:**
- None modified

- [ ] **Step 1: Record current commit SHA**

Run:
```bash
cd /home/matthew/circuits-com
git rev-parse HEAD
```

Save the SHA. This is the rollback point if the entire restructure is abandoned (Level 3 rollback per spec).

### Task 0.5: Confirm spec exists and is referenced correctly

**Files:**
- Read-only check

- [ ] **Step 1: Verify spec commit**

Run:
```bash
git log --oneline -5 docs/superpowers/specs/2026-05-03-frontend-restructure-design.md
```

Expected: most recent commit is `5bad22b docs(specs): frontend restructure into bounded contexts`.

If absent or different SHA, halt — the spec is the source of truth; this plan is invalid without it.

---

## Cycle 1: Shared/Styles

**Scope:** Move 5 global SCSS files from `src/styles/` to `src/shared/styles/`. Add `@shared` Vite + tsconfig alias. Rewrite all `@use` paths in component .scss files. Single commit.

### Task 1.1: Cycle 1 Cartography

**Files:**
- Create: `docs/superpowers/specs/cycle-1-cartography.yaml` (output of agent)

- [ ] **Step 1: Dispatch `feature-dev:code-explorer` to map all @use paths**

Use the Agent tool:
```
subagent_type: feature-dev:code-explorer
description: Cycle 1 SCSS @use cartography
prompt:
  You are mapping SCSS @use paths in /home/matthew/circuits-com/frontend/src/
  for Cycle 1 of a restructuring project. Spec at
  docs/superpowers/specs/2026-05-03-frontend-restructure-design.md.

  Goal: list every component .scss file (not the global styles in src/styles/
  themselves) that has at least one `@use` referring to ../../styles/foo
  or similar relative path.

  For EACH such file, return ONE YAML block in this exact schema:
  - path: <relative path from src/>
    @use_imports:
      - {from: '<original path>', will_become: '<@shared/styles/...>'}
    target_path: <unchanged for Cycle 1; component files don't move>

  After listing all component .scss files, append a moves-block:
  scss_globals_moves:
    - {old: src/styles/_themes.scss, new: src/shared/styles/_themes.scss}
    - {old: src/styles/_variables.scss, new: src/shared/styles/_variables.scss}
    - {old: src/styles/_mixins.scss, new: src/shared/styles/_mixins.scss}
    - {old: src/styles/_animations.scss, new: src/shared/styles/_animations.scss}
    - {old: src/styles/global.scss, new: src/shared/styles/global.scss}

  Constraints:
  - Read-only. Use Glob, Grep, Read, LS only.
  - Output the YAML blocks concatenated. No commentary, no summary, no markdown headers.
  - Save the result to docs/superpowers/specs/cycle-1-cartography.yaml via Write tool.
```

- [ ] **Step 2: Verify cartography output exists**

Run:
```bash
ls -la /home/matthew/circuits-com/docs/superpowers/specs/cycle-1-cartography.yaml
wc -l /home/matthew/circuits-com/docs/superpowers/specs/cycle-1-cartography.yaml
```

Expected: file exists, has at least 30 lines (covering ~22 component .scss files).

### Task 1.2: Synthesize Cycle 1 transform table

**Files:**
- Create: `docs/superpowers/specs/cycle-1-transform-table.yaml`

- [ ] **Step 1: Dispatch vibe-code-restructurer to draft transform table**

Use the Agent tool:
```
subagent_type: vibe-code-restructurer
description: Cycle 1 transform table synthesis
prompt:
  You are the synthesizer for Cycle 1 of the frontend restructure. Spec at
  docs/superpowers/specs/2026-05-03-frontend-restructure-design.md.

  Cartography input is at docs/superpowers/specs/cycle-1-cartography.yaml.

  Your task: produce the Cycle 1 transform table at
  docs/superpowers/specs/cycle-1-transform-table.yaml, in this exact schema
  (see spec section "Plan Verification" for the full schema):

  ```yaml
  # === BLOCK 1: file moves ===
  moves:
    - {old: src/styles/_themes.scss, new: src/shared/styles/_themes.scss}
    - {old: src/styles/_variables.scss, new: src/shared/styles/_variables.scss}
    - {old: src/styles/_mixins.scss, new: src/shared/styles/_mixins.scss}
    - {old: src/styles/_animations.scss, new: src/shared/styles/_animations.scss}
    - {old: src/styles/global.scss, new: src/shared/styles/global.scss}
    # styles/admin/_variables.scss is NOT moved in Cycle 1 — that's Cycle 3

  # === BLOCK 2: import_substitutions (none for Cycle 1 — TS imports unaffected) ===
  import_substitutions: []

  # === BLOCK 3: scss_substitutions ===
  scss_substitutions:
    # one entry per @use rewrite, derived from cartography
    - file: <component scss file path (current)>
      old: "'../../styles/variables'"   # or whatever the existing path is
      new: "'@shared/styles/variables'"
    # ... one entry per @use found in cartography

  # === BLOCK 4: alias config ===
  aliases:
    vite_config:
      add:
        - {'@shared': './src/shared'}
    tsconfig_paths:
      add:
        - {'@shared/*': ['src/shared/*']}
  ```

  Save to docs/superpowers/specs/cycle-1-transform-table.yaml.

  Then run the 5 plan-verification checks (spec section "Plan Verification"):
  1. Every old_path in moves[] currently exists (ls each)
  2. No two new_paths collide
  3. Every scss_substitutions[*].old, when joined with the file's current
     path, resolves to a real file today
  4. Every scss_substitutions[*].new resolves to a known new_path post-move
  5. Every aliased new_import (every '@shared/...') is covered by aliases.add

  Output a markdown table with the 5 checks and PASS/FAIL for each. If any
  fail, list the failures explicitly.

  Constraints:
  - Read + Write to scope only. Do NOT execute any moves.
  - Verification report goes to stdout (your final message). The YAML goes to disk.
```

- [ ] **Step 2: Verify transform table file exists and verification report shows all PASS**

Run:
```bash
ls -la /home/matthew/circuits-com/docs/superpowers/specs/cycle-1-transform-table.yaml
```

Read the synthesizer's final message — confirm the verification table shows 5/5 PASS.

If any check FAILED, halt. The transform table is incorrect; loop back to Task 1.1 cartography or amend the table directly. Do NOT proceed to Task 1.3 with failing checks.

### Task 1.3: 🛑 USER APPROVAL — Cycle 1 transform table

**Files:**
- None modified

- [ ] **Step 1: Surface the transform table to the user**

Send a message to the user with:
- The full content of `docs/superpowers/specs/cycle-1-transform-table.yaml`
- The 5/5 PASS verification report from Task 1.2
- The exact list of files that will be edited and moved
- Ask: "Approve Cycle 1 execution? (yes / amend X / abort)"

- [ ] **Step 2: Wait for explicit user approval before proceeding**

DO NOT proceed to Task 1.4 without user reply containing approval. If user requests amendments, loop back: edit the transform table, re-run the 5 verification checks, re-surface for approval.

### Task 1.4: Execute Cycle 1 moves

**Files:**
- Move: 5 SCSS files from `src/styles/` to `src/shared/styles/`
- Modify: every component .scss file with `@use '../../styles/...'` (per transform table)
- Modify: `frontend/vite.config.ts` (add `@shared` alias)
- Modify: `frontend/tsconfig.app.json` (add `@shared/*` path)

- [ ] **Step 1: Apply moves via `git mv`**

Run each move from the transform table's `moves:` block (5 moves):
```bash
cd /home/matthew/circuits-com
mkdir -p frontend/src/shared/styles
git mv frontend/src/styles/_themes.scss frontend/src/shared/styles/_themes.scss
git mv frontend/src/styles/_variables.scss frontend/src/shared/styles/_variables.scss
git mv frontend/src/styles/_mixins.scss frontend/src/shared/styles/_mixins.scss
git mv frontend/src/styles/_animations.scss frontend/src/shared/styles/_animations.scss
git mv frontend/src/styles/global.scss frontend/src/shared/styles/global.scss
```

- [ ] **Step 2: Apply scss_substitutions via Edit tool**

For each entry in `cycle-1-transform-table.yaml` `scss_substitutions:`, use the Edit tool with `old_string` + `new_string` from the table.

Example for `frontend/src/components/home/HeroSection.module.scss`:
```
Edit:
  old_string: @use '../../styles/variables' as *;
  new_string: @use '@shared/styles/variables' as *;
```

Repeat for every file in scss_substitutions[]. ~40 edits expected.

- [ ] **Step 3: Update `vite.config.ts` to add `@shared` alias**

Edit `frontend/vite.config.ts`:
```typescript
// Old:
resolve: {
  alias: {
    '@': path.resolve(__dirname, './src'),
  },
},

// New:
resolve: {
  alias: {
    '@shared': path.resolve(__dirname, './src/shared'),
  },
},
```

(The `@` alias was unused per cartography; removed in favor of per-scope aliases. `@public` and `@admin` will be added in later cycles.)

- [ ] **Step 4: Update `tsconfig.app.json` to add `@shared/*` path**

Edit `frontend/tsconfig.app.json`:
```json
// Old:
"paths": { "@/*": ["src/*"] }

// New:
"paths": { "@shared/*": ["src/shared/*"] }
```

- [ ] **Step 5: Verify file system reflects the moves**

Run:
```bash
ls /home/matthew/circuits-com/frontend/src/shared/styles/
ls /home/matthew/circuits-com/frontend/src/styles/ 2>&1
```

Expected: 5 files in `shared/styles/`; `src/styles/` either empty (then remove with `rmdir frontend/src/styles`) or no longer exists.

If `src/styles/` is empty, remove it:
```bash
rmdir /home/matthew/circuits-com/frontend/src/styles
```

### Task 1.5: Cycle 1 Verification Gate

**Files:**
- None modified (read-only verification)

- [ ] **Step 1: Run TypeScript + Vite build**

Run:
```bash
cd /home/matthew/circuits-com/frontend
npx tsc --noEmit 2>&1 | tail -20
npm run build 2>&1 | tail -30
```

Expected: zero TS errors, build succeeds. If either fails, halt — this is a Level 1 rollback (`git restore .` and `git reset --hard HEAD` if commits were created prematurely).

- [ ] **Step 2: Dispatch visual-regression-guard agent**

Use the Agent tool:
```
subagent_type: visual-regression-guard
description: Cycle 1 visual regression check
prompt:
  Run the 32-cell theme×route visual regression matrix against
  /home/matthew/circuits-com/tests/visual/baselines/.

  Routes: /, /category/<slug>, /search, /join, /contact, /about,
          /keyword/<keyword>, /part/<id>
  Themes: base, steel, schematic, pcb (URL ?nav=A|B|C or none)

  For each cell, screenshot the live dev server (localhost:3000) and compare
  to the baseline using ImageMagick `compare -metric AE`. Flag any cell with
  pixel drift > 1%.

  Return a markdown table of (route, theme, drift%, PASS/FAIL).

  Constraints: read-only. Do not modify baselines.
```

Expected: all 32 cells PASS (drift ≤ 1%). If any cell fails, halt — likely cause is a missed `@use` rewrite. Investigate and fix before commit.

- [ ] **Step 3: Dispatch theme-persistency-guard agent**

Use the Agent tool:
```
subagent_type: theme-persistency-guard
description: Cycle 1 theme persistence + resource audit
prompt:
  Verify --theme-* CSS variables resolve correctly on every public route
  (/, /category/<slug>, /search, /join, /contact, /about, /keyword, /part)
  for all 4 themes. Use chrome-devtools-mcp evaluate_script to read
  computed values of --theme-accent, --theme-cta-bg, --theme-surface-bg,
  --theme-pcb-trace at the document root.

  Also audit per-page byte budget (DOM count + JS+CSS+image weight) — flag
  any 10%+ regression vs prior known-good (current tree on master is the
  reference).

  Return PASS/FAIL with details.
```

Expected: PASS on all routes/themes. Resource regressions ≤ 10%.

If FAIL, halt and investigate. Common cause: a SCSS file that was mid-conversion or had a typo'd `@use` path.

### Task 1.6: Cycle 1 Simplify Pass

**Files:**
- Modify: `frontend/src/shared/styles/*.scss` (if dead code found)

- [ ] **Step 1: Invoke /simplify on the moved SCSS files**

Use the Skill tool: invoke `simplify` with args pointing to `frontend/src/shared/styles/`.

The skill will identify: dead variables, unused mixins, duplicated rules. Apply any improvements directly.

- [ ] **Step 2: Re-verify build still passes after simplify edits**

Run:
```bash
cd /home/matthew/circuits-com/frontend
npx tsc --noEmit 2>&1 | tail -5
npm run build 2>&1 | tail -10
```

Expected: still zero errors, still builds.

### Task 1.7: Commit Cycle 1

**Files:**
- All Cycle 1 changes

- [ ] **Step 1: Verify clean staging**

Run:
```bash
cd /home/matthew/circuits-com
git status --short
```

Expected: only Cycle 1 files appear (5 moved SCSS, ~40 .module.scss edits, vite.config.ts, tsconfig.app.json, possibly the cartography + transform-table YAMLs).

- [ ] **Step 2: Stage and commit**

Run:
```bash
cd /home/matthew/circuits-com
git add frontend/ docs/superpowers/specs/cycle-1-cartography.yaml docs/superpowers/specs/cycle-1-transform-table.yaml
git commit -m "refactor(frontend): cycle 1 — extract src/shared/styles + @shared alias"
```

- [ ] **Step 3: Verify commit landed on `updates`**

Run:
```bash
git log --oneline -3
git branch --show-current
```

Expected: HEAD is the cycle-1 commit, branch is `updates`. Note this SHA as the pre-Cycle-2 rollback point.

---

## Cycle 2: Public

**Scope:** ~80 files. Move all 8 public pages into per-page folders, move `components/layout/`, move `components/shared/` to `public/components/widgets/`, move `hooks/`, `services/api.ts`, public `types/*`. Add `@public` alias. Rewrite ~150 imports + 8 lazy() strings in App.tsx.

### Task 2.1: Cycle 2 Cartography (4 parallel readers)

**Files:**
- Create: `docs/superpowers/specs/cycle-2-cartography.yaml` (synthesized from 4 reader outputs)

- [ ] **Step 1: Dispatch 4 parallel `feature-dev:code-explorer` agents in a single message**

In one message, send 4 parallel Agent tool invocations:

**Reader A — home/category/part page trees:**
```
subagent_type: feature-dev:code-explorer
description: Cycle 2 Reader A — home/category/part trees
prompt:
  Map these files: pages/HomePage.tsx, pages/CategoryPage.tsx, pages/PartPage.tsx,
  components/home/*, components/category/* (including layouts/).

  For each, return ONE YAML block:
  - path: <relative from src/>
    exports: [list]
    imports:
      - {from: <path>, kind: relative|alias|external}
    consumers: [files that import this]
    target_path: <post-move per spec target architecture>
    flags: [LCP-critical, has child components, etc]

  Target paths follow these rules per spec:
  - pages/HomePage.tsx → public/pages/home/index.tsx
  - pages/CategoryPage.tsx → public/pages/category/index.tsx
  - pages/PartPage.tsx → public/pages/part/index.tsx
  - components/home/X.tsx → public/pages/home/components/X.tsx
  - components/category/X.tsx → public/pages/category/components/X.tsx
  - components/category/layouts/X.tsx → public/pages/category/components/layouts/X.tsx

  Constraints: read-only. Output ONLY the YAML blocks concatenated, nothing else.
```

**Reader B — about/contact/join/search/keyword pages:**
```
subagent_type: feature-dev:code-explorer
description: Cycle 2 Reader B — secondary public pages
prompt:
  Map these files: pages/AboutPage.tsx, pages/ContactPage.tsx, pages/JoinPage.tsx,
  pages/SearchPage.tsx, pages/KeywordSponsorPage.tsx, plus their .module.scss files.

  Schema same as Reader A. Target paths:
  - pages/AboutPage.tsx → public/pages/about/index.tsx
  - pages/ContactPage.tsx → public/pages/contact/index.tsx
  - pages/JoinPage.tsx → public/pages/join/index.tsx
  - pages/SearchPage.tsx → public/pages/search/index.tsx
  - pages/KeywordSponsorPage.tsx → public/pages/keyword/index.tsx
  - .module.scss files: same parent directory as their .tsx counterpart

  Constraints: read-only. Output ONLY YAML blocks.
```

**Reader C — components/layout + components/shared:**
```
subagent_type: feature-dev:code-explorer
description: Cycle 2 Reader C — chrome + widgets
prompt:
  Map these files: components/layout/*, components/shared/*.

  Schema same as Reader A. Target paths per spec:
  - components/layout/X.tsx → public/components/layout/X.tsx (no rename — keep "layout")
  - components/shared/X.tsx → public/components/widgets/X.tsx (rename "shared" to "widgets")

  Constraints: read-only. Output ONLY YAML blocks.
```

**Reader D — hooks + services/api.ts + public types:**
```
subagent_type: feature-dev:code-explorer
description: Cycle 2 Reader D — hooks/services/types
prompt:
  Map these files: hooks/useCategories.ts, hooks/useSearch.ts, hooks/useAnimateOnScroll.ts,
  services/api.ts, types/category.ts, types/part.ts, types/supplier.ts, types/sponsor.ts.

  Schema same as Reader A. Target paths:
  - hooks/X.ts → public/hooks/X.ts
  - services/api.ts → public/services/api.ts
  - types/X.ts (except admin.ts) → public/types/X.ts

  IMPORTANT for hooks/useAnimateOnScroll.ts: report consumers carefully. If
  zero consumers found, set flags: [dead code candidate].

  Constraints: read-only. Output ONLY YAML blocks.
```

- [ ] **Step 2: Concatenate the 4 reader outputs**

After all 4 agents return, write the concatenated YAML to:
`docs/superpowers/specs/cycle-2-cartography.yaml`

Use the Write tool. The file should contain all 4 readers' blocks back-to-back.

### Task 2.2: Synthesize Cycle 2 transform table

**Files:**
- Create: `docs/superpowers/specs/cycle-2-transform-table.yaml`

- [ ] **Step 1: Dispatch vibe-code-restructurer to draft the table**

Use the Agent tool:
```
subagent_type: vibe-code-restructurer
description: Cycle 2 transform table synthesis
prompt:
  You are the synthesizer for Cycle 2 of the frontend restructure. Spec at
  docs/superpowers/specs/2026-05-03-frontend-restructure-design.md. Cartography
  at docs/superpowers/specs/cycle-2-cartography.yaml.

  Produce the Cycle 2 transform table at
  docs/superpowers/specs/cycle-2-transform-table.yaml, in the schema from the
  spec's "Plan Verification" section:

  - moves: every (old_path → new_path) — ~80 entries
  - import_substitutions: every (file, old_import, new_import) tuple,
    INCLUDING App.tsx lazy() strings (kind: lazy_string) — ~150 entries.
    For App.tsx specifically, every lazy() that points to a public page must
    be updated. Example:
      {file: src/App.tsx, line: 10, old: './pages/CategoryPage',
       new: '@public/pages/category', kind: lazy_string}
  - scss_substitutions: every @use rewrite for moved component .scss files
    where the @use path needs to change because the file's location changed
    (relative paths recompute).
  - aliases:
    vite_config.add: [{'@public': './src/public'}]
    tsconfig_paths.add: [{'@public/*': ['src/public/*']}]
    (Cycle 1's @shared alias is already in place; do NOT re-add it.)

  After writing the YAML, run all 5 plan-verification checks (spec). Report
  PASS/FAIL in a markdown table.

  IMPORTANT:
  - hooks/useAnimateOnScroll.ts: if cartography flagged it as dead code,
    INCLUDE in moves to public/hooks/useAnimateOnScroll.ts AND add a flag
    `dead_code_candidate: true` for the user to decide. Do NOT delete.
  - Pay special attention to the 8 lazy() string imports in App.tsx — these
    are runtime strings, not static imports. Every one must appear in
    import_substitutions with kind: lazy_string.

  Constraints: read + write transform table only. NO file moves yet.
```

- [ ] **Step 2: Verify transform table + verification table 5/5 PASS**

Run:
```bash
ls -la /home/matthew/circuits-com/docs/superpowers/specs/cycle-2-transform-table.yaml
```

Read synthesizer's verification report. All 5 checks must PASS.

If any FAIL, do NOT proceed. Amend the table or re-run cartography.

### Task 2.3: 🛑 USER APPROVAL — Cycle 2 transform table

**Files:**
- None modified

- [ ] **Step 1: Surface table to user**

Send the user:
- Summary of move counts (moves: N, import_substitutions: M, scss_substitutions: K)
- The 8 lazy() string updates from `import_substitutions` filtered by `kind: lazy_string`
- Any flags the synthesizer added (e.g., `dead_code_candidate` for `useAnimateOnScroll`)
- Verification 5/5 PASS table
- Ask: "Approve Cycle 2 execution? (yes / amend X / abort)"

- [ ] **Step 2: Wait for explicit approval before Task 2.4**

If user requests amendments (e.g., "delete useAnimateOnScroll instead of moving" or "skip the rename of shared→widgets"), edit the transform table, re-run plan-verification, re-surface.

### Task 2.4: Execute Cycle 2 moves

**Files:**
- Move: ~80 files across 8 page subdirs + components/layout + components/widgets + hooks + services + types
- Modify: ~150 import statements across moved files + App.tsx lazy() strings
- Modify: `frontend/vite.config.ts` (add `@public` alias)
- Modify: `frontend/tsconfig.app.json` (add `@public/*` path)

- [ ] **Step 1: Apply moves via `git mv`**

Iterate over the transform table's `moves:` block. For each entry:

```bash
mkdir -p $(dirname <new_path>)
git mv <old_path> <new_path>
```

Approximately 80 invocations. Process them in deterministic order (e.g., alphabetic on `new_path`) to make any error traceable.

- [ ] **Step 2: Apply import_substitutions via Edit tool**

For each entry in `import_substitutions:`, use Edit tool:
- `file_path`: the file's POST-move path (since edits happen after moves)
- `old_string`: `sub.old`
- `new_string`: `sub.new`

For lazy() strings in App.tsx, the substitution looks like:
```
old_string: const CategoryPage = lazy(() => import("./pages/CategoryPage"));
new_string: const CategoryPage = lazy(() => import("@public/pages/category"));
```

(Note the trailing path part: `.../CategoryPage` → `.../category` because `index.tsx` makes the page available at the directory level.)

- [ ] **Step 3: Apply scss_substitutions via Edit tool**

For each entry in `scss_substitutions:`, use Edit tool to update the .scss file's `@use` paths.

Example:
```
file: src/public/pages/home/components/HeroSection.module.scss (post-move path)
old_string: @use '../../shared/styles/variables' as *;  (would be wrong if file moved)
new_string: @use '@shared/styles/variables' as *;
```

- [ ] **Step 4: Update `vite.config.ts` to add `@public` alias**

Edit `frontend/vite.config.ts`:
```typescript
// Old (after Cycle 1):
resolve: {
  alias: {
    '@shared': path.resolve(__dirname, './src/shared'),
  },
},

// New:
resolve: {
  alias: {
    '@public': path.resolve(__dirname, './src/public'),
    '@shared': path.resolve(__dirname, './src/shared'),
  },
},
```

- [ ] **Step 5: Update `tsconfig.app.json` to add `@public/*` path**

Edit `frontend/tsconfig.app.json`:
```json
// Old (after Cycle 1):
"paths": { "@shared/*": ["src/shared/*"] }

// New:
"paths": {
  "@public/*": ["src/public/*"],
  "@shared/*": ["src/shared/*"]
}
```

- [ ] **Step 6: Clean up empty old directories**

Run:
```bash
cd /home/matthew/circuits-com/frontend/src
rmdir pages/HomePage 2>/dev/null  # if a stale empty dir somehow remained
rmdir components/home 2>/dev/null
rmdir components/category/layouts 2>/dev/null
rmdir components/category 2>/dev/null
rmdir components/shared 2>/dev/null
# leave components/admin and components/layout pre-Cycle-3 intact
rmdir hooks 2>/dev/null
rmdir services 2>/dev/null  # adminApi.ts moves in Cycle 3
# Don't rmdir types/ — admin.ts still there until Cycle 3
```

Some `rmdir` calls will fail (directory non-empty) — that's expected. The check is that they don't fail when they SHOULD be empty.

### Task 2.5: Cycle 2 Verification Gate

**Files:**
- None modified (read-only verification)

- [ ] **Step 1: Run TypeScript + Vite build**

Run:
```bash
cd /home/matthew/circuits-com/frontend
npx tsc --noEmit 2>&1 | tail -20
npm run build 2>&1 | tail -30
```

Expected: zero TS errors. Build succeeds. Bundle main chunk size within ±5% of baseline (Task 0.2). If size has grown beyond ±5%, halt and investigate.

If TS errors, halt — typical cause is a missed import substitution. Use `npx tsc --noEmit | head -10` to find the first error, fix, retry.

- [ ] **Step 2: Run dev server, verify 8 routes load**

Start dev server in background and curl each route to confirm 200 OK + non-empty body:
```bash
cd /home/matthew/circuits-com/frontend
npm run dev &
DEV_PID=$!
sleep 5
for path in / /category/active-components /search /about /contact /join /keyword/test /part/0; do
  status=$(curl -sI -o /dev/null -w "%{http_code}" "http://localhost:3000$path")
  echo "$path → $status"
done
kill $DEV_PID
```

Expected: every route returns 200. (Note: in Vite dev mode, all routes resolve via SPA fallback so they all return the index.html.)

- [ ] **Step 3: Dispatch visual-regression-guard for full 32-cell matrix**

Use the Agent tool:
```
subagent_type: visual-regression-guard
description: Cycle 2 visual regression — 32-cell matrix
prompt:
  Same as Cycle 1 verification: run 32-cell matrix (4 themes × 8 routes)
  vs tests/visual/baselines/. Drift threshold ≤1%. Return markdown table.
```

Expected: 32/32 PASS. If fails, halt.

- [ ] **Step 4: Dispatch frontend-perf-auditor for LCP audit**

Use the Agent tool:
```
subagent_type: frontend-perf-auditor
description: Cycle 2 perf — LCP + bundle audit
prompt:
  Run Lighthouse LCP on / and /category/<slug> against the local dev build.
  Compare to baseline at docs/superpowers/specs/2026-05-03-baseline.md.
  Acceptance: LCP within ±10%, main bundle within ±5%.
  Also run rAF frame sampling for 5 seconds on / to detect long
  animation-frame events introduced by the restructure.
  Return PASS/FAIL with numeric values + deltas.
```

Expected: PASS on both LCP and bundle. If FAIL, escalate to /chrome-devtools-mcp:debug-optimize-lcp before commit.

- [ ] **Step 5: Backdrop persistence test**

Use chrome-devtools-mcp `evaluate_script` to verify the persistent SVG (per CLAUDE.md gotcha):

```javascript
// 1. Navigate to /
// 2. Stamp marker:
const svg = document.querySelector('svg.circuit-traces, svg[class*="circuitTraces"]');
svg.dataset.sessionMarker = 'test-' + Date.now();
const before = svg.dataset.sessionMarker;

// 3. SPA-navigate to /about (click NavLink, don't reload)
document.querySelector('a[href="/about"]').click();
await new Promise(r => setTimeout(r, 500));

// 4. Re-query and check marker survived:
const svg2 = document.querySelector('svg.circuit-traces, svg[class*="circuitTraces"]');
const after = svg2.dataset.sessionMarker;
console.log('PASS:', before === after, before, after);
```

Expected: marker matches (BackdropLayer SVG persisted across nav).

If marker is undefined or doesn't match, halt — BackdropLayer remount regression. Check that App.tsx mount order is preserved (BackdropLayer mounted ABOVE Routes).

### Task 2.6: Cycle 2 Big-O Hunt + Simplify

**Files:**
- Modify: any moved files where code-simplifier finds Big-O issues

- [ ] **Step 1: Dispatch code-simplifier for Big-O audit**

Use the Agent tool:
```
subagent_type: pr-review-toolkit:code-simplifier
description: Cycle 2 Big-O + complexity audit
prompt:
  Audit all files under /home/matthew/circuits-com/frontend/src/public/ for:
  1. O(n²) or worse algorithmic patterns (nested .map().filter() chains
     over arrays that could be single-pass)
  2. useEffect with array deps that recompute on every render
  3. unmemoized derived state in components rendering large lists
  4. duplicated logic across moved files (especially in
     public/pages/category/components/* — the layout components were just
     consolidated into one folder)

  Specific high-value targets:
  - hooks/useCategories.ts, hooks/useSearch.ts (filter/sort patterns)
  - public/pages/home/components/CategoryGrid.tsx (rendering loops)
  - public/pages/category/components/PartsTable.tsx (large-list rendering)
  - public/pages/category/components/layouts/*.tsx (4 layouts — verify
    no algorithmic divergence between them)

  Return findings as a markdown table: file, line, issue, suggested fix,
  estimated impact (low/med/high).

  Apply HIGH-impact fixes directly. List MED + LOW fixes for the user to
  approve. Do NOT change behavior — refactors must be pure (memoization,
  algorithmic improvements that preserve semantics).
```

- [ ] **Step 2: Apply user-approved MED/LOW fixes**

If code-simplifier surfaces fixes that need user approval, present them, get explicit approval, then apply via Edit tool.

- [ ] **Step 3: Invoke /simplify for general cleanup**

Use the Skill tool: `simplify` with args pointing to recently changed files.

- [ ] **Step 4: Re-verify build after simplify edits**

Run:
```bash
cd /home/matthew/circuits-com/frontend
npx tsc --noEmit && npm run build
```

Expected: still passes. If new errors introduced by simplification, fix or revert that change.

### Task 2.7: Commit Cycle 2

**Files:**
- All Cycle 2 changes

- [ ] **Step 1: Verify staging**

```bash
cd /home/matthew/circuits-com
git status --short | head -30
git diff --stat HEAD
```

Expected: ~80 file moves + ~150 modified files. Verify no admin/* changes leaked in (admin is Cycle 3).

- [ ] **Step 2: Stage and commit**

```bash
cd /home/matthew/circuits-com
git add frontend/ docs/superpowers/specs/cycle-2-cartography.yaml docs/superpowers/specs/cycle-2-transform-table.yaml
git commit -m "refactor(frontend): cycle 2 — establish src/public/ + page colocation + @public alias"
```

- [ ] **Step 3: Verify commit**

```bash
git log --oneline -4
```

Expected: cycle 2 commit at HEAD, cycle 1 commit one back, baseline commit two back. Note this SHA as pre-Cycle-3 rollback point.

---

## Cycle 3: Admin

**Scope:** ~45 files. Move all 14 admin pages with Plan B nesting (`suppliers/{list, form, detail}` etc.), `components/admin/`, `contexts/`, `services/adminApi.ts`, `styles/admin/`, `types/admin.ts`. Add `@admin` alias. Rewrite ~120 imports + 14 lazy() strings.

### Task 3.1: Cycle 3 Cartography (3 parallel readers)

**Files:**
- Create: `docs/superpowers/specs/cycle-3-cartography.yaml`

- [ ] **Step 1: Dispatch 3 parallel `feature-dev:code-explorer` agents**

In one message, send 3 parallel Agent tool invocations:

**Reader A — admin standalone pages:**
```
subagent_type: feature-dev:code-explorer
description: Cycle 3 Reader A — admin standalone pages
prompt:
  Map: pages/admin/LoginPage.tsx, DashboardPage.tsx, ReportsPage.tsx,
  SettingsPage.tsx, ImportPage.tsx, CategoriesPage.tsx, plus their .module.scss.
  PlaceholderPage.tsx if present (cartography to confirm).

  Target paths per spec (Plan B nesting NOT applied here — these are
  single-purpose pages without form/detail siblings):
  - pages/admin/LoginPage.tsx → admin/pages/login/index.tsx
  - pages/admin/DashboardPage.tsx → admin/pages/dashboard/index.tsx
  - pages/admin/ReportsPage.tsx → admin/pages/reports/index.tsx
  - pages/admin/SettingsPage.tsx → admin/pages/settings/index.tsx
  - pages/admin/ImportPage.tsx → admin/pages/import/index.tsx
  - pages/admin/CategoriesPage.tsx → admin/pages/categories/index.tsx
  - .module.scss files: same parent dir as their .tsx counterpart

  Schema same as Cycle 2 readers. Read-only.
```

**Reader B — admin entity-CRUD pages (Plan B nesting):**
```
subagent_type: feature-dev:code-explorer
description: Cycle 3 Reader B — admin entity-CRUD pages
prompt:
  Map all entity-CRUD admin pages: SuppliersPage, SupplierFormPage,
  SupplierDetailPage, PartsPage, PartFormPage, PartDetailPage,
  SponsorsPage, SponsorFormPage, plus their .module.scss.

  Target paths apply Plan B nesting (explicit list/form/detail subdirs):
  - SuppliersPage.tsx → admin/pages/suppliers/list/index.tsx
  - SupplierFormPage.tsx → admin/pages/suppliers/form/index.tsx
  - SupplierDetailPage.tsx → admin/pages/suppliers/detail/index.tsx
  - .module.scss files retain their original name in the new dir (e.g.,
    SuppliersPage.module.scss → admin/pages/suppliers/list/SuppliersPage.module.scss)
  - Same pattern for parts/{list,form,detail}
  - Sponsors has only list + form (no detail page in current code):
    SponsorsPage.tsx → admin/pages/sponsors/list/index.tsx
    SponsorFormPage.tsx → admin/pages/sponsors/form/index.tsx

  Note: app routing strings in App.tsx will reference these new paths via
  lazy() — flag the lazy() lines so the synthesizer captures them.

  Schema same as Cycle 2 readers. Read-only.
```

**Reader C — admin chrome + contexts + services + styles + types:**
```
subagent_type: feature-dev:code-explorer
description: Cycle 3 Reader C — admin chrome + supporting code
prompt:
  Map: components/admin/* (AdminLayout, Breadcrumbs, ConfirmDialog, DataTable,
  DemoToggle, ProtectedRoute, StatCard), contexts/AuthContext.tsx,
  contexts/DemoContext.tsx, services/adminApi.ts, styles/admin/_variables.scss,
  types/admin.ts.

  Target paths per spec:
  - components/admin/X.{tsx,scss} → admin/components/X.{tsx,scss}
  - contexts/X.tsx → admin/contexts/X.tsx
  - services/adminApi.ts → admin/services/adminApi.ts
  - styles/admin/_variables.scss → admin/styles/_variables.scss
  - types/admin.ts → admin/types/admin.ts

  Schema same as Cycle 2 readers. Read-only.
```

- [ ] **Step 2: Concatenate the 3 reader outputs**

Use the Write tool to save concatenated YAML to `docs/superpowers/specs/cycle-3-cartography.yaml`.

### Task 3.2: Synthesize Cycle 3 transform table

**Files:**
- Create: `docs/superpowers/specs/cycle-3-transform-table.yaml`

- [ ] **Step 1: Dispatch vibe-code-restructurer**

Use the Agent tool:
```
subagent_type: vibe-code-restructurer
description: Cycle 3 transform table synthesis
prompt:
  Synthesize Cycle 3 transform table from cartography at
  docs/superpowers/specs/cycle-3-cartography.yaml. Save to
  docs/superpowers/specs/cycle-3-transform-table.yaml in the spec's schema.

  - moves: ~45 entries
  - import_substitutions: ~120 entries, INCLUDING App.tsx admin lazy() strings.
    All 14 admin lazy() imports need updating. Examples:
      {file: src/App.tsx, line: 21, old: './pages/admin/LoginPage',
       new: '@admin/pages/login', kind: lazy_string}
      {file: src/App.tsx, line: 23, old: './pages/admin/SuppliersPage',
       new: '@admin/pages/suppliers/list', kind: lazy_string}
      {file: src/App.tsx, line: 24, old: './pages/admin/SupplierDetailPage',
       new: '@admin/pages/suppliers/detail', kind: lazy_string}
      {file: src/App.tsx, line: 27, old: './pages/admin/SupplierFormPage',
       new: '@admin/pages/suppliers/form', kind: lazy_string}
    (Same pattern for parts and sponsors.)

  - scss_substitutions: every @use rewrite in moved .module.scss files.
    Special attention: styles/admin/_variables.scss is moved this cycle, so
    any admin .scss file that currently does `@use '../../styles/admin/variables'`
    must rewrite to `@use '@admin/styles/variables'`.

  - aliases:
    vite_config.add: [{'@admin': './src/admin'}]
    tsconfig_paths.add: [{'@admin/*': ['src/admin/*']}]
    (@public, @shared aliases are already in place from prior cycles.)

  Run the 5 plan-verification checks. Report PASS/FAIL.

  Constraints: read + write transform table only.
```

- [ ] **Step 2: Verify 5/5 PASS in synthesizer report**

Same as prior cycles. Halt if any check fails.

### Task 3.3: 🛑 USER APPROVAL — Cycle 3 transform table

**Files:**
- None modified

- [ ] **Step 1: Surface to user**

Same format as Cycles 1-2. Highlight the 14 lazy() string updates and the Plan B entity nesting.

- [ ] **Step 2: Wait for explicit approval**

Do not proceed until user approves.

### Task 3.4: Execute Cycle 3 moves

**Files:**
- Move: ~45 files
- Modify: ~120 import statements + 14 lazy() strings in App.tsx
- Modify: `frontend/vite.config.ts` (add `@admin`)
- Modify: `frontend/tsconfig.app.json` (add `@admin/*`)

- [ ] **Step 1: Apply moves via `git mv`**

Iterate transform table `moves:`. For each:
```bash
mkdir -p $(dirname <new_path>)
git mv <old_path> <new_path>
```

- [ ] **Step 2: Apply import_substitutions via Edit**

For each entry in `import_substitutions:`, Edit the post-move file. Pay special attention to App.tsx lazy() lines — verify each substitution lands correctly via `grep "lazy.*import" frontend/src/App.tsx` after applying.

- [ ] **Step 3: Apply scss_substitutions via Edit**

Same pattern as Cycle 2.

- [ ] **Step 4: Update `vite.config.ts` to add `@admin`**

Edit `frontend/vite.config.ts`:
```typescript
// New (after Cycle 3):
resolve: {
  alias: {
    '@admin': path.resolve(__dirname, './src/admin'),
    '@public': path.resolve(__dirname, './src/public'),
    '@shared': path.resolve(__dirname, './src/shared'),
  },
},
```

- [ ] **Step 5: Update `tsconfig.app.json` to add `@admin/*`**

Edit:
```json
"paths": {
  "@admin/*": ["src/admin/*"],
  "@public/*": ["src/public/*"],
  "@shared/*": ["src/shared/*"]
}
```

- [ ] **Step 6: Clean up empty directories**

```bash
cd /home/matthew/circuits-com/frontend/src
rmdir pages/admin 2>/dev/null
rmdir pages 2>/dev/null  # public pages already moved in Cycle 2
rmdir components/admin 2>/dev/null
rmdir components/layout 2>/dev/null  # already moved in Cycle 2 to public/components/layout
rmdir components 2>/dev/null
rmdir contexts 2>/dev/null
rmdir services 2>/dev/null  # adminApi just moved
rmdir styles/admin 2>/dev/null
rmdir styles 2>/dev/null  # global SCSS moved in Cycle 1
rmdir types 2>/dev/null  # public types moved in Cycle 2, admin moved this cycle
rmdir hooks 2>/dev/null
```

After Cycle 3, the only files at `src/` root should be `App.tsx`, `main.tsx`, `vite-env.d.ts` plus the three scope directories (`public/`, `admin/`, `shared/`).

### Task 3.5: Cycle 3 Verification Gate

**Files:**
- None modified

- [ ] **Step 1: Run TypeScript + Vite build**

Same as prior cycles:
```bash
cd /home/matthew/circuits-com/frontend
npx tsc --noEmit
npm run build
```

Expected: zero errors, build succeeds.

- [ ] **Step 2: Verify `src/` shape**

```bash
ls /home/matthew/circuits-com/frontend/src/
```

Expected output:
```
admin
App.tsx
main.tsx
public
shared
vite-env.d.ts
```

If any extra files/dirs (e.g., `components/`, `pages/`, `hooks/`), halt — moves were incomplete.

- [ ] **Step 3: Dispatch visual-regression-guard for admin routes**

Use the Agent tool:
```
subagent_type: visual-regression-guard
description: Cycle 3 admin visual regression
prompt:
  Run visual regression on the 14 admin routes:
  /admin/login, /admin (dashboard), /admin/suppliers, /admin/suppliers/new,
  /admin/suppliers/:id, /admin/suppliers/:id/edit, /admin/parts,
  /admin/parts/new, /admin/parts/:id, /admin/parts/:id/edit, /admin/sponsors,
  /admin/sponsors/new, /admin/sponsors/:id/edit, /admin/categories,
  /admin/reports, /admin/settings, /admin/import.

  Admin is intentionally un-themed (no theme×route matrix needed) — only
  light surface checks. Compare against baselines if they exist; else,
  capture fresh and flag.

  For each route, also verify: no console errors, page renders meaningful
  content (not blank, not error boundary), all lucide-react icons present.

  Return markdown table.
```

Expected: PASS on all 14. If any route shows blank or errors, the most likely cause is a lazy() string mismatch — grep `frontend/src/App.tsx` for the failing route's import string.

- [ ] **Step 4: Manual SPA smoke via chrome-devtools-mcp**

Open localhost in chrome-devtools-mcp browser. Sequence:
1. Navigate `/admin/login`. Login as `matthew` / `admin`.
2. Verify redirect to `/admin` (dashboard).
3. Click each sidebar link in order: Parts → Suppliers → Categories → Sponsors → Reports → Settings → Import. Confirm each loads without error.
4. From Suppliers list, click "Add new" → Form loads. Click Cancel/Back.
5. Click a supplier row → Detail loads. Click "Edit" → Form loads with prefilled data.
6. Repeat 4-5 for Parts.
7. Logout → redirect to `/admin/login`.

If any step fails, halt — investigate via `evaluate_script` for console errors.

### Task 3.6: Cycle 3 Big-O Hunt + Simplify

**Files:**
- Modify: any admin files where code-simplifier finds Big-O issues

- [ ] **Step 1: Dispatch code-simplifier for admin Big-O audit**

Use the Agent tool:
```
subagent_type: pr-review-toolkit:code-simplifier
description: Cycle 3 admin Big-O + complexity audit
prompt:
  Audit all files under /home/matthew/circuits-com/frontend/src/admin/ for
  Big-O and complexity issues. Focus targets per spec:
  1. admin/components/DataTable.tsx — verify sort/filter is memoized (otherwise
     re-sorts on every parent re-render — O(n log n) on every keystroke)
  2. admin/pages/parts/list/index.tsx (PartsPage) — filter chain over parts list
  3. admin/pages/suppliers/list/index.tsx (SuppliersPage) — same
  4. admin/pages/sponsors/form/index.tsx (SponsorFormPage) — XOR validation
     should not run on every keystroke if it's expensive
  5. admin/pages/reports/index.tsx (ReportsPage) — native SVG chart data
     transforms (was Recharts pre-2026-04-25; verify no O(n²) snuck in)

  For each issue, report file:line, problem, suggested fix, impact tier.
  Apply HIGH-impact fixes directly; surface MED/LOW for user approval.

  Behavior must remain identical (no functional changes — just memoization,
  single-pass replacements, etc.).
```

- [ ] **Step 2: Apply approved fixes**

Same flow as Cycle 2.

- [ ] **Step 3: Invoke /simplify for general cleanup**

Use Skill tool: `simplify` with args pointing to recently changed files.

- [ ] **Step 4: Re-verify build**

```bash
cd /home/matthew/circuits-com/frontend
npx tsc --noEmit && npm run build
```

### Task 3.7: Commit Cycle 3

**Files:**
- All Cycle 3 changes

- [ ] **Step 1: Verify staging**

```bash
cd /home/matthew/circuits-com
git status --short | head -30
git diff --stat HEAD
```

Expected: ~45 admin files moved + ~120 import edits.

- [ ] **Step 2: Stage and commit**

```bash
git add frontend/ docs/superpowers/specs/cycle-3-cartography.yaml docs/superpowers/specs/cycle-3-transform-table.yaml
git commit -m "refactor(frontend): cycle 3 — establish src/admin/ + entity-nested pages + @admin alias"
```

- [ ] **Step 3: Verify commit + log**

```bash
git log --oneline -5
```

Expected: 3 cycle commits + baseline commit on `updates`. Note this SHA as pre-Cycle-4 rollback point.

---

## Cycle 4: Polish

**Scope:** Add ESLint import boundaries, generate dependency graph, update CLAUDE.md, final verification. One commit.

### Task 4.1: Add ESLint config

**Files:**
- Create: `frontend/.eslintrc.json`
- Modify: `frontend/package.json` (add eslint + plugin-import dev deps)

- [ ] **Step 1: Add dev dependencies**

```bash
cd /home/matthew/circuits-com/frontend
npm install --save-dev eslint@^9.0.0 eslint-plugin-import@^2.31.0 typescript-eslint@^8.0.0
```

- [ ] **Step 2: Create `frontend/.eslintrc.json`**

Write file with content:

```json
{
  "root": true,
  "parser": "@typescript-eslint/parser",
  "plugins": ["import"],
  "settings": {
    "import/resolver": {
      "typescript": {
        "project": "./tsconfig.app.json"
      }
    }
  },
  "rules": {
    "import/no-restricted-paths": [
      "error",
      {
        "zones": [
          {
            "target": "./src/admin",
            "from": "./src/public",
            "message": "admin/ may not import from public/. Cross-context imports must go via shared/."
          },
          {
            "target": "./src/public",
            "from": "./src/admin",
            "message": "public/ may not import from admin/. Cross-context imports must go via shared/."
          },
          {
            "target": "./src/shared",
            "from": ["./src/public", "./src/admin"],
            "message": "shared/ must not depend on public/ or admin/. Reverse the dependency."
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Verify ESLint passes against the restructured tree**

```bash
cd /home/matthew/circuits-com/frontend
npx eslint src/ --max-warnings=0
echo "Exit: $?"
```

Expected: exit 0 (zero violations). If any reported, investigate — it means a cross-scope import slipped through. Fix by either moving the file to shared/ (if genuinely needed by both) or refactoring the import.

### Task 4.2: Generate dependency graph

**Files:**
- Create: `docs/architecture/dependency-graph.dot`
- Create: `docs/architecture/dependency-graph.svg` (if Graphviz available)

- [ ] **Step 1: Dispatch vibe-code-restructurer to generate dep graph**

Use the Agent tool:
```
subagent_type: vibe-code-restructurer
description: Cycle 4 dependency graph generation
prompt:
  Per Phase 6c of your methodology, generate a dependency graph for the
  restructured frontend.

  Save to: docs/architecture/dependency-graph.dot in Graphviz DOT format.

  Requirements:
  - Color-code nodes by scope: public (light blue), admin (light orange),
    shared (light green)
  - Use subgraph clusters for the three scopes
  - Mark App.tsx + main.tsx as entry points (distinct color, e.g., gold)
  - Mark external dependencies (react, react-router-dom, framer-motion,
    lucide-react, axios, papaparse, react-dropzone) with a different shape
    (e.g., ellipse instead of box)
  - Edges represent imports (A → B means A imports B)
  - Limit graph to .tsx/.ts files; SCSS modules are noise here

  After writing the .dot file, attempt to render to SVG:
  `dot -Tsvg docs/architecture/dependency-graph.dot -o docs/architecture/dependency-graph.svg`

  If `dot` is not installed, note that in your output and skip SVG.

  Return a summary: node count, edge count, max in-degree node (highest
  fan-in = most-shared), max out-degree node (highest fan-out = most-coupled).
```

- [ ] **Step 2: Verify graph file**

```bash
ls -la /home/matthew/circuits-com/docs/architecture/
wc -l /home/matthew/circuits-com/docs/architecture/dependency-graph.dot
```

Expected: .dot file exists with non-trivial line count (>100). SVG present if Graphviz installed.

### Task 4.3: Update CLAUDE.md

**Files:**
- Modify: `/home/matthew/circuits-com/CLAUDE.md`

- [ ] **Step 1: Locate the existing "Frontend (frontend/)" section**

Run:
```bash
cd /home/matthew/circuits-com
grep -n "### Frontend (frontend/)" CLAUDE.md
```

Note the line number.

- [ ] **Step 2: Replace the section with new structure documentation**

Use Edit tool to replace the existing "### Frontend (frontend/)" section (lines from grep up to the next `###` heading) with:

```markdown
### Frontend (frontend/)

- React 19 + TypeScript + Vite + SCSS Modules + Framer Motion
- **Bounded-context structure** (post-2026-05-03 restructure):
  - `src/public/` — public site bounded context
  - `src/admin/` — admin SPA bounded context
  - `src/shared/` — cross-scope only (currently just global SCSS tokens)
- **Per-scope path aliases**: `@public/`, `@admin/`, `@shared/`. Configured in
  `frontend/vite.config.ts` `resolve.alias` and `frontend/tsconfig.app.json`
  `compilerOptions.paths`. The unused `@/*` alias was removed.
- **ESLint boundaries** (`frontend/.eslintrc.json`): admin/ may not import
  public/ and vice versa; shared/ may not import either. Crossings are
  enforced via `eslint-plugin-import`'s `no-restricted-paths`.
- **Public pages** colocate components: `public/pages/<name>/{index.tsx,
  <Name>Page.module.scss, components/}`. Import a page via `@public/pages/<name>`
  — the trailing `index.tsx` resolves automatically.
- **Admin entity pages use Plan B nesting**: `admin/pages/<entity>/{list, form,
  detail}/{index.tsx, ...}`. Each sub-page has an explicit name (no implicit
  "index = list" convention).
- **Customer portal forecast** (Future scope): role split `'admin' | 'company'`
  already exists in `admin/types/admin.ts`. When portal lands, mirror
  `admin/`'s structure as `src/portal/` with `@portal/*` alias. Chrome
  components currently in `admin/components/` may migrate to `shared/components/`
  if portal needs them (≥2 consumers rule).
- **All routes except `HomePage` lazy-load** via `React.lazy()` — strings now
  reference the new alias paths (e.g., `lazy(() => import("@public/pages/category"))`).
- **`lucide-react`** powers admin chrome (sidebar + topbar) — public site still
  uses emoji for category/glyph slots.

#### Adding a new page

For a public page named `Foo`:
1. Create `frontend/src/public/pages/foo/index.tsx` exporting default `<FooPage />`
2. Create `frontend/src/public/pages/foo/FooPage.module.scss`
3. If the page has subcomponents, add `frontend/src/public/pages/foo/components/`
4. Add lazy import in `frontend/src/App.tsx`:
   `const FooPage = lazy(() => import("@public/pages/foo"));`
5. Add `<Route path="/foo" element={<FooPage />} />` inside the public Routes block

For an admin entity-CRUD set (e.g., `widgets` with list+form+detail):
1. Create `frontend/src/admin/pages/widgets/{list, form, detail}/index.tsx`
2. Add 3 lazy imports in App.tsx
3. Add 4 `<Route>` entries (`/admin/widgets`, `/widgets/new`, `/widgets/:id`, `/widgets/:id/edit`)
```

- [ ] **Step 3: Stage CLAUDE.md change for the cycle commit**

(Don't commit yet — Cycle 4 has one final commit at the end.)

### Task 4.4: Final verification gate

**Files:**
- None modified (verification)

- [ ] **Step 1: Run final 32-cell visual matrix**

Dispatch visual-regression-guard one more time with the same prompt as Cycle 1/2.

Expected: 32/32 PASS.

- [ ] **Step 2: Run final perf audit**

Dispatch frontend-perf-auditor with same prompt as Cycle 2.

Expected: LCP within ±10%, bundle within ±5% of baseline.

- [ ] **Step 3: Run final theme-persistency-guard**

Dispatch theme-persistency-guard with same prompt as Cycle 1.

Expected: PASS on all routes/themes.

- [ ] **Step 4: Verify no orphan files**

Run a final cartography sweep:
```bash
cd /home/matthew/circuits-com
# Find files no other file references — should match the dev-only HeroColorTuner only
grep -rl "" frontend/src --include='*.tsx' --include='*.ts' | while read f; do
  basename=$(basename "$f" .tsx)
  basename=$(basename "$basename" .ts)
  if [ "$basename" = "App" ] || [ "$basename" = "main" ] || [ "$basename" = "index" ] || [ "$basename" = "vite-env.d" ]; then continue; fi
  refs=$(grep -rl --include='*.tsx' --include='*.ts' "$basename" frontend/src | grep -v "^$f$" | wc -l)
  if [ "$refs" -eq 0 ]; then echo "ORPHAN: $f"; fi
done
```

Expected: zero orphans (or only the documented exception, `HeroColorTuner` which is dev-only and gated by `import.meta.env.DEV` at App.tsx mount site).

- [ ] **Step 5: Verify zero relative imports remain**

```bash
grep -rn "from '\\.\\./\\|from \"\\.\\.\\/" /home/matthew/circuits-com/frontend/src/ | head
```

Expected: zero hits. Every import uses `@public/`, `@admin/`, `@shared/`, or external module names.

If hits found, halt — restructure is not yet complete. Fix each one via Edit and rebuild.

### Task 4.5: Commit Cycle 4

**Files:**
- All Cycle 4 changes (ESLint config, package.json/lock, dep graph, CLAUDE.md)

- [ ] **Step 1: Verify staging**

```bash
cd /home/matthew/circuits-com
git status --short
git diff --stat HEAD
```

Expected files: `frontend/.eslintrc.json`, `frontend/package.json`, `frontend/package-lock.json`, `docs/architecture/dependency-graph.dot` (+ `.svg`), `CLAUDE.md`.

- [ ] **Step 2: Stage and commit**

```bash
git add frontend/.eslintrc.json frontend/package.json frontend/package-lock.json docs/architecture/ CLAUDE.md
git commit -m "chore(frontend): cycle 4 — import boundaries + dep graph + CLAUDE.md"
```

- [ ] **Step 3: Verify final commit shape**

```bash
git log --oneline -6
git log master..updates --oneline
```

Expected: `git log master..updates` shows exactly 4 cycle commits + 1 baseline doc commit + 1 spec doc commit on `updates` ahead of master.

---

## Acceptance + Merge Phase

### Task 5.1: Run all acceptance criteria checks

**Files:**
- None modified (verification)

- [ ] **Step 1: Build + types**

```bash
cd /home/matthew/circuits-com/frontend
npx tsc --noEmit
npm run build
```

Expected: zero errors.

- [ ] **Step 2: Zero relative imports**

```bash
grep -rE "from ['\"]\\.\\./" /home/matthew/circuits-com/frontend/src/ | head
```

Expected: zero output.

- [ ] **Step 3: Alias config consistency**

```bash
grep -A5 "alias" /home/matthew/circuits-com/frontend/vite.config.ts
grep -A5 "paths" /home/matthew/circuits-com/frontend/tsconfig.app.json
```

Expected: same three aliases in both — `@admin`, `@public`, `@shared`.

- [ ] **Step 4: ESLint boundaries**

```bash
cd /home/matthew/circuits-com/frontend && npx eslint src/ --max-warnings=0
```

Expected: exit 0.

- [ ] **Step 5: Spec checklist**

Open the spec at `docs/superpowers/specs/2026-05-03-frontend-restructure-design.md` "Acceptance Criteria" section. Verify every checkbox can be ticked off:
- Build + types ✓ (Step 1)
- Zero relative imports ✓ (Step 2)
- Visual + perf gates ✓ (from Task 4.4)
- Architecture gates ✓ (Step 4)
- Documentation gates ✓ (transform-table YAMLs, dep graph, CLAUDE.md from Task 4.3)
- Process gates ✓ (worktree clean, no force ops)
- Forward-compat gates ✓ (portal forecast in spec)

Document any criterion that DOESN'T pass. Halt before merge until all green.

### Task 5.2: 🛑 USER MANUAL CLICK-THROUGH

**Files:**
- None modified

- [ ] **Step 1: Surface to user**

Send message:
> Restructure complete on `updates`. 4 commits ahead of master. All automated acceptance criteria pass.
>
> Please manually click through:
> - **Public:** home → category page → search → about → contact → join + apply theme switcher (base/steel/schematic/pcb on each)
> - **Admin:** /admin/login → dashboard → suppliers list → add new → cancel → suppliers/:id → edit → cancel; same for parts; reports + settings
>
> Verify nothing looks/behaves different from before the restructure. When you're satisfied, reply "merge to master".

- [ ] **Step 2: Wait for explicit "merge to master" approval**

Do NOT proceed without explicit go-ahead.

### Task 5.3: Squash-merge to master

**Files:**
- Modify: master branch (single squash commit)

- [ ] **Step 1: Switch to master, pull latest**

```bash
cd /home/matthew/circuits-com
git switch master
git pull --ff-only origin master
```

If pull fails (master has commits we don't have), halt — investigate and resolve.

- [ ] **Step 2: Squash-merge updates**

```bash
git merge --squash updates
```

Expected: cleanly merges. If conflict on CLAUDE.md (phantom-conflict pattern per spec), resolve with:
```bash
git checkout --theirs CLAUDE.md
git add CLAUDE.md
```

- [ ] **Step 3: Commit the squashed restructure**

```bash
git commit -m "refactor(frontend): restructure into bounded contexts (public/admin/shared)

- Move from layered-by-type to bounded-context organization
- Per-scope path aliases (@public, @admin, @shared)
- Page-folder colocation; admin Plan B entity nesting
- ESLint import boundaries enforced
- Dependency graph at docs/architecture/dependency-graph.dot
- Spec at docs/superpowers/specs/2026-05-03-frontend-restructure-design.md
"
```

- [ ] **Step 4: 🛑 USER APPROVAL TO PUSH**

Send message: "About to `git push origin master`. Confirm?"

Wait for explicit "yes push" or equivalent.

- [ ] **Step 5: Push**

```bash
git push origin master
```

### Task 5.4: Deploy

**Files:**
- None (deploy uses scripts)

- [ ] **Step 1: Run full deploy**

```bash
cd /home/matthew/circuits-com
./deploy.sh
```

Expected: build + push to EC2 + container restart. Watch for errors.

- [ ] **Step 2: Frontend-only deploy (restarts nginx)**

```bash
cd /home/matthew/circuits-com
./deploy.sh --frontend
```

This step is critical per CLAUDE.md gotcha: "`./deploy.sh` (no flag) does NOT restart nginx — it rebuilds api/frontend/n8n containers but nginx keeps a stale DNS cache for the recreated upstream → 502 Bad Gateway. Workaround: chase a full deploy with `./deploy.sh --frontend`."

- [ ] **Step 3: Verify production**

Run:
```bash
curl -sI https://circuits.com | head -3
curl -sI https://circuits.com/admin | head -3
```

Expected: 200 OK for both. Hard-refresh browser at circuits.com (Ctrl+Shift+R) and click through home → category to confirm visual parity.

- [ ] **Step 4: Update memory**

Use Skill tool: `remember:remember` to write a handoff note for the next session capturing: restructure complete, master commit SHA, anything surprising encountered.

---

## Plan Self-Review (Author's Pass)

I ran the spec-coverage and placeholder scans inline:

**Spec coverage check:**

| Spec section | Plan task |
|---|---|
| Target architecture | Tasks 1.4, 2.4, 3.4 (per cycle execute) |
| Cycle 1 (shared/styles) | Tasks 1.1–1.7 |
| Cycle 2 (public) | Tasks 2.1–2.7 |
| Cycle 3 (admin Plan B) | Tasks 3.1–3.7 |
| Cycle 4 (polish) | Tasks 4.1–4.5 |
| Plan verification (Stage ②.5) | Tasks 1.2, 2.2, 3.2 (synthesizer runs 5 checks) |
| Agent dispatch | Embedded in each task with full prompts |
| Risk register | Mapped to halt conditions throughout |
| Rollback levels 0-4 | Implicit in halt-and-investigate language; Level 3 covered in Step 0.4 |
| Acceptance criteria | Task 5.1 maps each checkbox to a step |
| Customer portal forecast | Task 4.3 CLAUDE.md update preserves the spec reference |
| 32-cell visual baseline | Tasks 1.5, 2.5, 4.4 |
| LCP within ±10% | Tasks 0.2 (baseline), 2.5, 4.4 |
| Bundle within ±5% | Tasks 0.2, 2.5, 4.4 |
| `git checkout --theirs CLAUDE.md` | Task 5.3 Step 2 (phantom-conflict resolution) |

**Placeholder scan:** Zero TBDs/TODOs in plan steps. All agent prompts inline.

**Type consistency:** Same alias names (`@public`, `@admin`, `@shared`) used throughout. Same commit messages match spec. Cycle ordering consistent.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-03-frontend-restructure.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task with two-stage review between tasks. Best when each task should be reviewed independently before the next runs. Slower per task but tighter quality gates.

**2. Inline Execution** — Tasks run in this session via `executing-plans` skill, batched with checkpoints. Faster overall; checkpoints land at the per-cycle approval gates and acceptance phase.

**Which approach?**
