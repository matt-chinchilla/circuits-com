# Frontend Restructure into Bounded Contexts — Design Spec

**Date:** 2026-05-03
**Status:** Draft — awaiting user review
**Branch:** `updates` (will squash-merge to `master` only after all acceptance criteria pass)
**Prior art:** None directly; references `vibe-code-restructurer` agent's 7-phase methodology and Bulletproof React project structure conventions

## Context

`frontend/src/` is currently organized layered-by-type (`pages/`, `components/`, `hooks/`, `services/`, `types/`, `styles/`). Page-specific components live separated from their consuming page (e.g., `components/category/` has 10 files used only by `pages/CategoryPage.tsx`), making the directory hard to navigate when fixing bugs. The complaint is concrete: "no separate sub-directories for the different pages."

Surveying surfaced three structural facts that shape the design:

1. **Public and admin barely overlap.** Of 130 source files, ~5 are genuinely cross-scope (the global SCSS tokens). Everything else is either public-only or admin-only. Admin SPA is intentionally un-themed, uses different chrome (`AdminLayout` vs. `PublicLayout`), different APIs (`adminApi` vs. `api`).
2. **`components/shared/` is mis-named.** All 5 files (`CircuitTraces`, `GlowButton`, `AnimatedLink`, `SkeletonLoader`, `HeroColorTuner`) have zero admin consumers — they're public-only.
3. **A customer portal is half-architected at the type layer.** `UserInfo.role: 'admin' | 'company'` and `supplier_id?: string` already exist in `types/admin.ts:10-11`. A future "diet admin" SPA for paying customers is not hypothetical — it's an unbuilt UI for an existing data model.

The `@/*` path alias is configured in `vite.config.ts:9` and `tsconfig.app.json` but **unused** — every import in 130 files is relative (`../../components/...`). A restructure is the single moment where alias adoption is free, because we're already touching every import that breaks.

## Goals

1. **Page-folder colocation** — page-specific components live next to their consuming page
2. **Bounded contexts** — `src/public/`, `src/admin/`, `src/shared/` as sibling top-level scopes that mirror real architectural boundaries (different chrome, different APIs, different theme treatment)
3. **Per-scope path aliases** — `@public/`, `@admin/`, `@shared/` to make boundary crossings *visible* in every import line
4. **ESLint boundary enforcement** — `no-restricted-paths` rules so admin can't import `@public/*` and vice versa
5. **Zero behavior change** — purely structural; visual, performance, and behavior must be pixel-identical to pre-restructure
6. **Token-spend protection** — every cycle has an approval gate before file moves; per-cycle commits enable cheap rollback

## Non-goals

- New features (no portal scaffolding today — YAGNI)
- Backend refactor (out of scope; backend stays as-is)
- Visual redesign (theme tokens, components, animations all preserved)
- Test infrastructure (frontend has no tests today; restructure does not add them)
- Migrating off Vite, Framer Motion, or any current dep

## Target Architecture

```
frontend/src/
│
├── App.tsx                                  ← unchanged at root (route mounting + provider tree)
├── main.tsx                                 ← unchanged at root (React entry)
├── vite-env.d.ts
│
├── public/                                  ← bounded context: public site
│   ├── pages/
│   │   ├── home/{index.tsx, HomePage.module.scss, components/{HeroSection, CategoryGrid, CategoryCard}}
│   │   ├── category/{index.tsx, CategoryPage.module.scss, components/{LayoutSwitcher, PartsTable, SponsorBlock, SubcategoryChips, SupplierTable, TopPartners, layouts/{Cards, Compact, Grid, List}}}
│   │   ├── about/{index.tsx, AboutPage.module.scss}
│   │   ├── contact/{index.tsx, ContactPage.module.scss}
│   │   ├── join/{index.tsx, JoinPage.module.scss}
│   │   ├── search/{index.tsx, SearchPage.module.scss}
│   │   ├── part/{index.tsx, PartPage.module.scss}
│   │   └── keyword/{index.tsx, KeywordSponsorPage.module.scss}
│   ├── components/
│   │   ├── layout/                          ← app shell (was: components/layout/)
│   │   │   └── {Navbar, Footer, BackdropLayer, PageHeaderBand, PublicLayout, ThemeBridge, NavVariantPicker, SearchBar}
│   │   └── widgets/                         ← reusable inside public (was: components/shared/)
│   │       └── {CircuitTraces, GlowButton, AnimatedLink, SkeletonLoader, HeroColorTuner}
│   ├── hooks/{useCategories, useSearch}
│   ├── services/{api.ts}
│   └── types/{category, part, supplier, sponsor}
│
├── admin/                                   ← bounded context: admin SPA
│   ├── pages/
│   │   ├── login/{index.tsx, LoginPage.module.scss}
│   │   ├── dashboard/{index.tsx, DashboardPage.module.scss}
│   │   ├── suppliers/                       ← Plan B: explicit nesting (no implicit "index = list")
│   │   │   ├── list/{index.tsx, SuppliersPage.module.scss}
│   │   │   ├── form/{index.tsx, SupplierFormPage.module.scss}
│   │   │   └── detail/{index.tsx, SupplierDetailPage.module.scss}
│   │   ├── parts/{list/, form/, detail/}
│   │   ├── sponsors/{list/, form/}
│   │   ├── categories/{index.tsx, CategoriesPage.module.scss}
│   │   ├── reports/{index.tsx, ReportsPage.module.scss}
│   │   ├── settings/{index.tsx, SettingsPage.module.scss}
│   │   └── import/{index.tsx, ImportPage.module.scss}
│   ├── components/                          ← admin chrome (was: components/admin/)
│   │   └── {AdminLayout, Breadcrumbs, ConfirmDialog, DataTable, DemoToggle, ProtectedRoute, StatCard}
│   ├── contexts/{AuthContext, DemoContext}
│   ├── hooks/                               ← empty for now; populated as patterns emerge
│   ├── services/{adminApi.ts}
│   ├── styles/{_variables.scss}             ← was: styles/admin/_variables.scss
│   └── types/{admin.ts}
│
└── shared/                                  ← cross-scope ONLY (≥2 consumers across public+admin)
    └── styles/
        └── {_themes, _variables, _mixins, _animations, global}.scss
```

### Naming choices (and why)

- **`layout/` not `chrome/`** — `chrome` is React-community jargon for "app shell" (named after browser chrome). `layout/` is universally understood. Applies user's stated "blunt and objective over esoteric" principle.
- **`widgets/` not `shared/`** — within `public/components/`, `widgets/` describes "reusable visual primitives." Avoids overload with the top-level `shared/` directory.
- **Admin entity Plan B nesting** — `suppliers/{list, form, detail}` over implicit `suppliers/index.tsx + form/ + detail/`. Every sub-page has an explicit named folder; no hidden "index = list" convention. Trades 1 directory level for elimination of an implicit rule.

### Path aliases

In `vite.config.ts`:
```ts
resolve: {
  alias: {
    '@public': path.resolve(__dirname, './src/public'),
    '@admin': path.resolve(__dirname, './src/admin'),
    '@shared': path.resolve(__dirname, './src/shared'),
  },
},
```

In `tsconfig.app.json`:
```json
"paths": {
  "@public/*": ["src/public/*"],
  "@admin/*": ["src/admin/*"],
  "@shared/*": ["src/shared/*"]
}
```

The pre-existing `@/*` alias is removed (unused; replaced by per-scope aliases).

## Execution Plan — 4 Cycles, Each with 6-Stage Template

```
┌────────────────────────────────────────────────────────────────────┐
│                  PER-CYCLE TEMPLATE (6 stages)                     │
├────────────────────────────────────────────────────────────────────┤
│  ① Cartography           ◀─ parallel feature-dev:code-explorer     │
│  ② Plan                  ◀─ vibe-code-restructurer drafts table    │
│  ②.5 Plan Verification   ◀─ programmatic check before any move     │
│  ③ Execute               ◀─ mechanical application of verified tbl │
│  ④ Verify Gate           ◀─ build + visual + perf in parallel      │
│  ⑤ Simplify+Commit       ◀─ /simplify Big-O hunt, code-simplifier, │
│                              single commit on `updates`            │
└────────────────────────────────────────────────────────────────────┘
```

**Sequential order between cycles, parallelism inside each cycle's read + verify phases.**

### Cycle 1 — Shared/Styles (foundation)

| Stage | Deliverable |
|---|---|
| ① Cartography | 1× `feature-dev:code-explorer` maps every `@use '../../styles/...'` across all 22 component .scss files |
| ② Plan | Move `styles/{_themes, _variables, _mixins, _animations, global}.scss` → `shared/styles/`. Add `@shared` alias. Output: `cycle-1-transform-table.yaml` |
| ②.5 Verify table | All 5 plan-verification checks pass (see "Plan Verification" below) |
| ③ Execute | Sequential rewrite: ~22 SCSS file edits, alias config |
| ④ Verify gate | `tsc --noEmit` + `vite build` succeed; `visual-regression-guard` 32-cell pass; `theme-persistency-guard` confirms tokens resolve on every public route |
| ⑤ Simplify | `/simplify` SCSS pass: dead vars, duplicated rules, unused mixins |
| Commit | `refactor(frontend): cycle 1 — extract src/shared/styles + @shared alias` |

### Cycle 2 — Public (largest, LCP-critical)

| Stage | Deliverable |
|---|---|
| ① Cartography | **4× `feature-dev:code-explorer` parallel:** A=home/category/part trees; B=about/contact/join/search/keyword; C=components/layout + components/shared (becoming widgets); D=hooks + services/api.ts + types |
| ② Plan | Synthesize: ~80 file moves, ~150 import substitutions, 8 lazy() string updates. Output: `cycle-2-transform-table.yaml`. **User approval gate before execute.** |
| ②.5 Verify table | All 5 checks pass |
| ③ Execute | Sequential. ~80 files × ~3 edits each = ~240 micro-edits, all serialized |
| ④ Verify gate | Build + 32-cell visual matrix + `frontend-perf-auditor` LCP audit (within ±10% of baseline) + manual SPA smoke on all 8 public routes |
| ⑤ Simplify + Big-O | `code-simplifier` agent on moved files. Big-O targets: useCategories/useSearch filter chains, CategoryGrid/PartsTable render loops, useEffect array dep recompute. `/simplify` cleanup. |
| Commit | `refactor(frontend): cycle 2 — establish src/public/ + page colocation + @public alias` |

### Cycle 3 — Admin (Plan B nesting)

| Stage | Deliverable |
|---|---|
| ① Cartography | **3× `feature-dev:code-explorer` parallel:** A=login/dashboard/reports/settings/import/categories; B=suppliers/parts/sponsors entity tree (output entity-nesting plan); C=components/admin + contexts + adminApi + types/admin |
| ② Plan | Apply Plan B nesting (`suppliers/{list, form, detail}`, etc.). 14 lazy() string updates in App.tsx admin Routes block. Output: `cycle-3-transform-table.yaml`. **User approval gate.** |
| ②.5 Verify table | All 5 checks pass |
| ③ Execute | Sequential. ~45 file moves, ~120 import edits |
| ④ Verify gate | Build + manual SPA smoke through 14 admin routes (login, dashboard, suppliers list/new/:id/:id/edit, parts ditto, sponsors list/new/:id/edit, categories, reports, settings, import) + admin route visual regression + auth flow test |
| ⑤ Simplify + Big-O | `code-simplifier` agent. Big-O targets: DataTable sort/filter memoization, PartsPage/SuppliersPage filter chains, SponsorFormPage XOR validation, ReportsPage native-SVG chart data transforms |
| Commit | `refactor(frontend): cycle 3 — establish src/admin/ + entity-nested pages + @admin alias` |

### Cycle 4 — Polish (cross-scope hardening)

| Stage | Deliverable |
|---|---|
| ESLint | Add `.eslintrc.json` with `eslint-plugin-import` + `no-restricted-paths` rules: admin↛public, public↛admin, shared↛{public,admin}. ~30 lines, scoped to import boundaries only. |
| Dep graph | `vibe-code-restructurer` Phase 6c generates `docs/architecture/dependency-graph.dot` (and `.svg` if Graphviz available); color-coded by scope; entry points highlighted |
| CLAUDE.md | Rewrite "Frontend (frontend/)" section. Add "Adding a new page" recipe. Add customer portal forecast paragraph. |
| Final verify | One last 32-cell visual matrix + `frontend-perf-auditor` baseline lock |
| Commit | `chore(frontend): cycle 4 — import boundaries + dep graph + CLAUDE.md` |

## Plan Verification (Stage ②.5)

Before any cycle's Execute stage, the cycle's transform table is checked against five rules. **If any check fails, Execute does not run.** Table is amended at planning level (cheap), not at execute time (expensive).

### Transform table schema

```yaml
moves:
  - old: src/pages/HomePage.tsx
    new: src/public/pages/home/index.tsx
  # ... ~80 entries for Cycle 2

import_substitutions:
  - file: src/App.tsx
    line: 8
    old: './pages/HomePage'
    new: '@public/pages/home'
    kind: static
  - file: src/App.tsx
    line: 10
    old: './pages/CategoryPage'
    new: '@public/pages/category'
    kind: lazy_string                        # CRITICAL: runtime string, not static import
  # ... ~150 entries for Cycle 2

scss_substitutions:
  - file: src/public/pages/home/HomePage.module.scss   # post-move path
    old: "'../../styles/variables'"
    new: "'@shared/styles/variables'"
  # ... ~40 entries for Cycle 2

aliases:
  vite_config:
    add: [{'@public': './src/public'}, {'@admin': './src/admin'}, {'@shared': './src/shared'}]
  tsconfig_paths:
    add: [{'@public/*': ['src/public/*']}, {'@admin/*': ['src/admin/*']}, {'@shared/*': ['src/shared/*']}]
```

### Five verification checks

1. **`old_path` existence** — every `moves[*].old` must currently exist in working tree
2. **`new_path` uniqueness** — no two moves target the same `new_path`
3. **`old_import` resolution** — every `import_substitutions[*].old` joined with the importing file's `old_path` must resolve to a real file today
4. **`new_import` resolution** — every `import_substitutions[*].new` must resolve to a known `new_path` or external module in the post-move state
5. **Alias coverage** — every `new_import` starting with `@public/`, `@admin/`, `@shared/` must be covered by an alias rule; no orphan aliases

### Why this works

The transform table is the *complete* description of the cycle. Once verified, Execute is mechanical:

```python
for move in plan.moves:
    git_mv(move.old, move.new)

for sub in plan.import_substitutions:
    edit_file(sub.file, replace=sub.old, with_=sub.new)

for sub in plan.scss_substitutions:
    edit_file(sub.file, replace=sub.old, with_=sub.new)

apply_alias_config(plan.aliases)
```

No discovery, no recompute. If Execute fails, the failure is necessarily a *table bug*, not a move-sequence bug — and the rollback is `git restore .` (uncommitted).

## Agent Dispatch

| Agent | Source | Purpose | Cycles |
|---|---|---|---|
| **vibe-code-restructurer** | `~/.claude/agents/vibe-code-restructurer.md` | Lead. Synthesize cartography, draft transform table, execute moves, generate dep graph | 1, 2, 3, 4 |
| **feature-dev:code-explorer** | plugin | Parallel cartography (read-only by tool grant — no `Edit`/`Write`) | 1 (×1), 2 (×4), 3 (×3) |
| **visual-regression-guard** | project | 32-cell theme×route matrix vs. `tests/visual/baselines/`; flag drift ≥1% | 1, 2, 3 (admin), 4 |
| **theme-persistency-guard** | project | Verify `--theme-*` tokens resolve on every public route | 1, 4 |
| **frontend-perf-auditor** | project | LCP + animation-frame sampling | 2, 4 |
| **code-simplifier** | `pr-review-toolkit` | Big-O + complexity audit on moved files | 2, 3 |

**Skill invocations (run in main session, not as agents):**

- `/simplify` — generic-cleanup pass after `code-simplifier`
- `/chrome-devtools-mcp:debug-optimize-lcp` — escalation if perf gate fails

**Total agent calls across all cycles: ~22** broken down as: 8 parallel `code-explorer` reads (Cycle 1: 1, Cycle 2: 4, Cycle 3: 3) + 8 parallel verifies (Cycle 1: 2, Cycle 2: 3, Cycle 3: 1, Cycle 4: 2) + 6 sequential synthesizer/simplifier runs (1 vibe-restructurer per cycle = 4, code-simplifier in Cycles 2 + 3 = 2). Plus ~6 in-session skill invocations (`/simplify` per cycle, `/chrome-devtools-mcp:debug-optimize-lcp` if LCP gate fails, ESLint config edit). The only critical-path serial work is the Execute stage per cycle.

### Reader-agent output contract

To prevent re-reads, every `code-explorer` instance returns the same YAML block per file:

```yaml
- path: pages/HomePage.tsx
  exports: [HomePage (default)]
  imports:
    - {from: ./components/home/HeroSection, kind: relative}
    - {from: ./hooks/useCategories, kind: relative}
    - {from: framer-motion, kind: external}
  consumers: [App.tsx (eager, line 8)]
  target_path: public/pages/home/index.tsx
  flags:
    - LCP-critical (eager import)
    - has child components → keep components/ subfolder
```

Synthesizer concatenates N readers' YAML and produces ONE merged graph. No file is read twice.

## Risk Register + Rollback Strategy

### 10 ranked risks

| # | Risk | Likelihood | Impact | Mitigation | Detection | Recovery |
|---|------|-----------|--------|-----------|----------|----------|
| 1 | Build break (`tsc`/`vite`) | High → **Low** (post plan-verify) | Med | Plan-verification + sequential moves | Build gate fails | `git reset --hard HEAD~1` per cycle |
| 2 | `lazy()` string mismatch | Med → **Very low** | High | `kind: lazy_string` in transform table | Blank route in browser | Fix import string, rebuild |
| 3 | Visual regression > 1% | Low-Med | High | `visual-regression-guard` every cycle | Guard flags drifted cells | Usually missed `@use`; fix + re-verify |
| 4 | LCP regression > 10% | Low | Med | `frontend-perf-auditor` Cycle 2 + 4 | Auditor flags | `/simplify` Big-O hunt → retry |
| 5 | AnimatePresence-removed pattern broken | Low → **Negligible** | High | App.tsx changes pre-computed in table | Visual matrix shows blank pages on 2nd nav | Restore `PublicLayout` from git |
| 6 | `BackdropLayer` remounts on nav | Low → **Negligible** | High | App.tsx mount order pre-computed | SVG persistence test fails | Restore App.tsx from git |
| 7 | Token-spend overrun on retries | Med | Med | Approval gates pre-execute; per-cycle commits | User notices spend pattern | Pause; narrow next cycle's scope |
| 8 | Mid-cycle abort leaves mixed state | Low → **Lower** | High | All work on `updates`; mechanical Execute | Build broken at cycle end | `git restore .`, resume cycle |
| 9 | ESLint rule too strict | Low | Low | Cycle 4 only adds rules; tested before commit | `npx eslint` fails | Loosen rule, revisit boundary |
| 10 | Master contamination | Very low | Critical | "Always on `updates`" invariant | `git status` shows wrong branch | `git push -d origin <bad>` if pushed |

### Rollback levels

- **Level 0** — single-file edit retry (in-cycle, uncommitted): `Edit` tool fixes one bad import; no git action
- **Level 1** — cycle abort (uncommitted): `git restore .` discards WIP; re-cartograph or re-plan
- **Level 2** — cycle revert (committed; later cycle revealed bug): `git reset --hard <pre-cycle-N-sha>` on `updates`; re-run cycle N with fix
- **Level 3** — full restructure abort: `git reset --hard <pre-cycle-1-sha>`; force-push (USER CONFIRMED ONLY)
- **Level 4** — post-merge production hot-fix: `git revert <merge-sha>`; deploy; fix on `updates`; re-merge later

### Spend-protection invariants

1. **No move execution without your approval** (gate after Cartography → Plan, before Execute)
2. **One commit per cycle** — `git reset --hard HEAD~1` is always 1 step away
3. **All work on `updates`** — master never touched until you say so
4. **Read-only cartography agents** — `code-explorer`'s tool list excludes `Edit`/`Write`

## Acceptance Criteria

The merge from `updates` to `master` happens only after **all** boxes check.

### Build + types

- [ ] `cd frontend && npx tsc --noEmit` passes (zero errors)
- [ ] `cd frontend && npm run build` succeeds
- [ ] `tsconfig.app.json` `paths` matches `vite.config.ts` `resolve.alias`
- [ ] **Zero relative imports in `src/`** — `grep -r "from '\\.\\./" frontend/src/` returns 0 hits

### Visual + perf

- [ ] **32-cell visual regression matrix passes** (4 themes × 8 public routes; ≤1% pixel drift per cell)
- [ ] **All 14 admin routes load** in dev build
- [ ] **LCP within ±10% of baseline** on `/` and `/category/:slug` (i.e., absolute deviation no greater than 10% in either direction)
- [ ] **Main bundle size within ±5% of baseline** (absolute deviation no greater than 5% in either direction)
- [ ] **No new long-animation-frame events** introduced
- [ ] **Backdrop persistence test** — SVG `sessionMarker` survives SPA nav across `/` → `/about` → `/category/...`

### Architecture

- [ ] **ESLint `no-restricted-paths` passes** — `npx eslint frontend/src/` 0 violations:
  - `src/admin/**` cannot import `@public/*`
  - `src/public/**` cannot import `@admin/*`
  - `src/shared/**` cannot import `@public/*` or `@admin/*`
- [ ] **No orphan files** — final cartography pass confirms zero unreferenced `.tsx`/`.ts`
- [ ] **All `lazy(() => import(...))` strings resolve** — manual click-through every public + admin route

### Documentation

- [ ] Spec doc reflects what was built (this document)
- [ ] Three transform tables persisted at `docs/superpowers/specs/cycle-{1,2,3}-transform-table.yaml`
- [ ] `docs/architecture/dependency-graph.dot` (+ `.svg` if available); color-coded by scope; entry points highlighted
- [ ] `CLAUDE.md` "Frontend (frontend/)" section rewritten + "Adding a new page" recipe + customer portal forecast

### Process

- [ ] All work on `updates` — `git log master..updates` shows exactly 4 commits
- [ ] No `--no-verify` or `--force` flags used
- [ ] Worktree clean at end of every cycle
- [ ] No `master` commits during restructure

### Forward-compatibility

- [ ] Customer portal forecast section in this spec
- [ ] ESLint rules don't preemptively block future `@portal/*` scope

### Final merge gate (you control)

- [ ] You manually click through home → category → search → about → contact → join + admin login → dashboard → suppliers list/form/detail
- [ ] You explicitly say "merge to master"

When that final gate fires:
```bash
git switch master
git merge --squash updates
# Resolve any phantom CLAUDE.md conflict via:
# git checkout --theirs CLAUDE.md
git commit -m "refactor(frontend): restructure into bounded contexts (public/admin/shared)"
# YOU explicitly approve push:
git push origin master
./deploy.sh && ./deploy.sh --frontend
```

## Future Scope — Customer Portal Forecast

The role split `'admin' | 'company'` and `supplier_id?: string` field already exist in `types/admin.ts:10-11`. A diet admin SPA for paying customers is anticipated.

**When implementing portal:**

1. Mirror `admin/`'s structure exactly — `src/portal/{pages, components, contexts, services, types}`
2. Add `@portal/*` alias to `vite.config.ts` + `tsconfig.app.json`
3. Mount under `/portal/*` route in `App.tsx`
4. Add new `<RoleProtectedRoute role="company">` wrapper (current `<ProtectedRoute>` only checks `isAuthenticated`)
5. **Migration trigger for shared chrome:** when portal needs `<AdminLayout>`, `<DataTable>`, `<ConfirmDialog>`, `<StatCard>`, those move from `admin/components/` to `shared/components/` per the same DRY rule (≥2 consumers → shared)

**Today's restructure work to support this:** zero. Architecture is portal-ready by design.

## References

- `vibe-code-restructurer` agent definition: `~/.claude/agents/vibe-code-restructurer.md`
- `feature-dev:code-explorer` plugin agent
- Bulletproof React project structure: github.com/alan2207/bulletproof-react
- Martin Fowler, *Refactoring* (2nd ed.), ch. 4 — atomic refactor pattern
- CLAUDE.md gotchas relevant to this restructure:
  - "Adding a Supplier field requires 6 files" — same chain logic shaped the page-folder design
  - "AnimatePresence + Suspense + lazy routes" — preserved in `App.tsx` mount order
  - "PublicLayout `.outletWrap` z-index: 1 is load-bearing" — preserved
  - "Verify SVG persistence with session-marker pattern" — used as Backdrop persistence test in acceptance criteria
  - "Squash-merge phantom conflicts on updates → master" — accounted for in merge protocol
- Today's `frontend/src/` snapshot: 130 source files (108 .tsx/.ts, 22 .scss); single `@/*` alias configured but unused
