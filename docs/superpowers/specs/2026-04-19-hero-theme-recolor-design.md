# Hero Section — Theme-Driven PCB Recolor

**Date:** 2026-04-19
**Branch:** `updates`
**Status:** Approved, pending implementation plan

## Summary

The hero section's PCB visual (board, traces, IC bodies, pads, electrons) currently uses a single hardcoded gold color (`rgba(218,190,65,*)`) with a `filter: hue-rotate()` trick to shift colors per theme. We are replacing this with a CSS-custom-property cascade that sources each SVG slot from the same theme tokens that drive the navbar — so the navbar and hero read as one continuous themed surface instead of two independently-styled regions.

The **base** theme is intentionally left unchanged (pristine brand default, first-impression surface, and the only theme where white electrons on the bright-green navbar would produce low-contrast artifacts).

## Scope

### In scope

- Per-theme token-driven recoloring of `CircuitTraces.tsx` SVG for **steel, schematic, pcb** themes.
- Per-theme background textures on `.hero` for the three alternate themes (steel tonal vignette, schematic horizontal ruling, pcb 24px grid).
- A shared SVG `<filter id="traceGlow">` replacing per-element drop-shadows.
- A shadow-gap `::before` on `.hero` at the nav/hero boundary, creating visual distinction between navbar and hero.
- Removal of the now-dead `filter: hue-rotate()` + `transition: filter 300ms ease` in `CircuitTraces.module.scss`.
- A **dev-only** `HeroColorTuner` floating panel that lets the author slide contrast values and read off the resulting percentages to paste back into SCSS.
- **Pytest-based visual / layout / perf regression tests** via `pytest-playwright`, covering every theme. Three assertion families: (a) visibility — hero, SVG traces, heading, search render at non-zero size on every theme; (b) layout — bounding boxes match expected coords (brand ≤30px from left, LOGIN ≤30px from right, SVG fills `.hero`, seam `::before` = 8px); (c) perf — no long tasks >50ms during initial paint, draw-circuit animation completes within 6s ± 100ms, theme-switch repaint <100ms.

### Out of scope

- Base theme changes (board color, traces, electrons, IC bodies, pads all stay exactly as today).
- Navbar changes (`Navbar.module.scss`, `ThemeBridge.tsx`, `NavVariantPicker.tsx` all untouched — hero inherits FROM them).
- New theme tokens in `_themes.scss` (pure reuse: every derived value is computed from existing `--theme-pcb-trace`, `--theme-nav-text-hover`, `--theme-pcb-dot-glow`).
- New npm packages. The package audit confirmed 0 new dependencies required.
- Electron motion paths, trace geometry, QFP IC placements (SVG structure unchanged — only `stroke`, `fill`, and `filter` attributes change).
- Any animation timing changes. The 6s `draw-circuit` keyframe + SMIL electron motion stay as-is.

### Why base theme stays flat

Three independent agents reached the same conclusion: (a) base's navbar bright-green (`#44bd13`) and the hero's `$executive-blue` (`#0a4a2e`) don't share a textural vocabulary that could extend coherently; (b) white electrons on bright-green base = 2.7:1 contrast (below WCAG AA for text, marginal even for decoration); (c) base is the default / first-impression / fallback — introducing texture there costs paint with no thematic payoff.

## Design decisions (approved)

1. **Token source for traces: `--theme-pcb-trace`, not `--theme-cta-bg`.** The original user mapping called for LOGIN button color, but steel's `--theme-cta-bg` is `#f4f5f7` (white pill) — produces thematically wrong white traces. The existing `--theme-pcb-trace` token already has the intent-correct value per theme and is the semantically correct anchor.

2. **Glow mechanism: one shared SVG `<filter>` applied at a `<g>` group wrapper.** Per-element `filter: drop-shadow()` would cost 140 CPU rasterizations (one per trace). Applying `filter="url(#traceGlow)"` per-element still costs 140 filter applications (same shared compile, 140× runtime work). Applying the filter at a single `<g class="traceGroup">` wrapping all traces gives one filter application on the merged output — true O(1) cost. The filter consumes `--theme-pcb-dot-glow` for color parity with the `.brandDot` in the navbar.

3. **Token inheritance on `<svg>` root, not per-child `var()` lookups.** Per the performance audit, defining `--trace-color: var(--theme-pcb-trace)` once at `.circuitTraces` (the SVG root) and letting 239 child elements inherit via CSS cascade avoids per-frame custom-property resolution during the 6s draw animation. Inheritance is free; cross-boundary custom property lookups are not.

4. **Opacity-stepped IC body and pad colors via `color-mix(in srgb, var(--theme-pcb-trace) X%, transparent)`.** This pattern is already established in `ContactPage.module.scss:74-77`. Single percentages across all themes (no per-theme tuning tokens in v1); values chosen to clear the lowest-contrast theme.

5. **Nav/hero seam: shadow-gap, not copper mirror.** Option (iii) from the frontend-design validator — an 8px `::before` gradient from `rgba(0,0,0,0.45)` to transparent at the hero's top edge. Reads as "substrate recessing under a connector," preserves the PCB-authenticity reading (two parallel copper traces would shortout on a real board), and gives genuine luminance separation where the `#063a23` → `#0a4a2e` hue-shift alone would blur.

6. **Per-theme textures on hero background, not just nav.** Steel gets a tonal top-shine + edge vignette; schematic gets horizontal 28px ruling (axis-flipped from the navbar's vertical pinstripe to avoid prison-bars at 420px); PCB gets the navbar's 24px grid continued + a radial center-band vignette to keep heading/search legibility.

## Token architecture

All new tokens live on `.circuitTraces` (the SVG root), not in `_themes.scss`. They're derived from existing theme tokens:

```scss
// frontend/src/components/shared/CircuitTraces.module.scss
.circuitTraces {
  --trace-color:     var(--theme-pcb-trace);
  --trace-glow:      var(--theme-pcb-dot-glow);
  --electron-color:  var(--theme-nav-text-hover);
  --ic-body-fill:    color-mix(in srgb, var(--theme-pcb-trace) 3%,  transparent);
  --ic-body-stroke:  color-mix(in srgb, var(--theme-pcb-trace) 15%, transparent);
  --ic-pad-fill:     color-mix(in srgb, var(--theme-pcb-trace) 30%, transparent);
}
```

### Base theme carve-out

Under base (or when `data-theme` is unset), the SCSS overrides the default token values with the pre-refactor hardcoded gold literals — so base renders byte-identically to pre-change. All conditional logic lives in SCSS selectors; `CircuitTraces.tsx` has no theme awareness.

Selector gate: `:global(:root[data-theme="base"]) .circuitTraces` OR `:global(:root:not([data-theme])) .circuitTraces`:

```scss
:global(:root[data-theme="base"]) .circuitTraces,
:global(:root:not([data-theme])) .circuitTraces {
  --trace-color:     rgba(218, 190, 65, 1);     // pre-change gold, unchanged
  --electron-color:  rgba(218, 190, 65, 0.9);   // amber, unchanged
  --ic-body-fill:    rgba(218, 190, 65, 0.02);  // unchanged
  --ic-body-stroke:  rgba(218, 190, 65, 0.12);  // unchanged
  --ic-pad-fill:     rgba(218, 190, 65, 0.25);  // unchanged

  // Disable the shared glow filter under base. CircuitTraces.tsx applies
  // `filter="url(#traceGlow)"` as an SVG presentation attribute on the
  // `<g class="traceGroup">` wrapper; CSS `filter: none` beats presentation
  // attributes per CSS spec, so this single rule suppresses the glow
  // without any JSX conditional.
  .traceGroup { filter: none; }
}
```

## Per-theme behavior

| Slot | base | steel | schematic | pcb |
|---|---|---|---|---|
| Board bg | `$executive-blue` | `$executive-blue` + top-shine + edge vignette | `$executive-blue` + 28px horizontal ruling | `$executive-blue` + 24px grid + radial vignette |
| Nav/hero seam | none | 8px shadow-gap `::before` | 8px shadow-gap `::before` | 8px shadow-gap `::before` |
| Trace stroke | `rgba(218,190,65,1)` (legacy) | `--theme-pcb-trace` `#3a8a1a` | `--theme-pcb-trace` `#44bd13` | `--theme-pcb-trace` `#c49b5d` |
| Trace glow filter | `url(#traceGlow)` off by default | `url(#traceGlow)` on | `url(#traceGlow)` on | `url(#traceGlow)` on |
| Electron fill | `rgba(218,190,65,0.9)` (legacy) | `--theme-nav-text-hover` `#f4f5f7` | `--theme-nav-text-hover` `#ffffff` | `--theme-nav-text-hover` `#ffffff` |
| IC body fill | `rgba(218,190,65,0.02)` | `color-mix(…3%)` → `#3a8a1a`/3% | `color-mix(…3%)` → `#44bd13`/3% | `color-mix(…3%)` → `#c49b5d`/3% |
| IC body stroke | `rgba(218,190,65,0.12)` | `color-mix(…15%)` → `#3a8a1a`/15% | `color-mix(…15%)` → `#44bd13`/15% | `color-mix(…15%)` → `#c49b5d`/15% |
| IC pad fill | `rgba(218,190,65,0.25)` | `color-mix(…30%)` → `#3a8a1a`/30% | `color-mix(…30%)` → `#44bd13`/30% | `color-mix(…30%)` → `#c49b5d`/30% |

## File changes

### 1. `frontend/src/components/shared/CircuitTraces.tsx` (modify)

- Remove the `S()` helper's hardcoded `rgba(218,190,65,…)` literal. New signature returns `{ stroke: 'var(--trace-color)', strokeOpacity: o, strokeWidth: w }`. The opacity argument stays a numeric prop (so individual traces can still be fainter than others); the stroke *color* becomes CSS-var-driven.
- Replace every inline `fill="rgba(218,190,65,…)"` with `fill="var(--ic-body-fill)"`, `fill="var(--ic-pad-fill)"`, or `fill="var(--electron-color)"` as appropriate.
- Add `<defs><filter id="traceGlow">` as the first child of the `<svg>`:

  ```jsx
  <defs>
    <filter id="traceGlow" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur stdDeviation="1.5" result="blur"/>
      <feFlood floodColor="var(--trace-glow)" floodOpacity="0.6"/>
      <feComposite in2="blur" operator="in" result="glowColor"/>
      <feMerge>
        <feMergeNode in="glowColor"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  ```

  **Apply the filter ONCE at a `<g>` group wrapper**, not on each `<path>`. Wrap all trace paths (not IC rects, not electrons) in a `<g className={styles.traceGroup} filter="url(#traceGlow)">`. This gives one filter application on the group's merged output — the true O(1) cost the perf audit relies on. Applying `filter="url(#id)"` per-element would be 140 filter applications (same shared compile, but 140× the runtime rasterization), which defeats the whole point of replacing per-element `drop-shadow`.

  The group-level filter also produces a visually-correct "shared signal glow" — overlapping traces don't double-halo; the entire trace network reads as one illuminated circuit. IC rects and electrons remain outside the group, so they're unaffected.

  Base suppression via CSS: the base carve-out uses `.traceGroup { filter: none; }` (CSS wins over the SVG `filter` presentation attribute). No conditional JSX.
- Electrons: `<circle fill="var(--electron-color)">` instead of hardcoded.
- No geometry / no timing / no structural changes.

### 2. `frontend/src/components/shared/CircuitTraces.module.scss` (modify)

- **Remove** the `filter: hue-rotate(var(--theme-trace-hue-shift, 0deg))` block at lines 16–20.
- **Remove** `transition: filter 300ms ease` at line 10 (dead after the above).
- **Add** the `.circuitTraces { --trace-color: …; … }` token block and the base theme carve-out described above.

### 3. `frontend/src/components/home/HeroSection.module.scss` (modify)

- Keep `background: $executive-blue` on base `.hero`.
- Add theme-scoped `background-image` rules via `:global([data-theme="..."]) .hero`:

  **Steel:**
  ```scss
  background-image:
    linear-gradient(180deg, rgba(14,17,19,0.30) 0%, rgba(14,17,19,0) 20%, rgba(14,17,19,0) 80%, rgba(14,17,19,0.20) 100%),
    linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0) 18%);
  ```

  **Schematic:**
  ```scss
  background-image:
    linear-gradient(180deg, rgba(20,26,30,0.10) 0%, rgba(20,26,30,0) 15%, rgba(20,26,30,0) 75%, rgba(20,26,30,0.15) 100%),
    repeating-linear-gradient(0deg, transparent 0 27px, rgba(255,255,255,0.025) 27px 28px);
  ```

  **PCB** (reuses the `color-mix` pattern from `ContactPage.module.scss:74-77`):
  ```scss
  background-image:
    radial-gradient(ellipse 70% 45% at 50% 50%, transparent 60%, rgba(6,20,10,0.35) 100%),
    repeating-linear-gradient(0deg, transparent 0 23px, color-mix(in srgb, var(--theme-accent) 3.5%, transparent) 23px 24px),
    repeating-linear-gradient(90deg, transparent 0 23px, color-mix(in srgb, var(--theme-accent) 3.5%, transparent) 23px 24px);
  ```

- Add shadow-gap `::before` for all three alternate themes:

  ```scss
  :global([data-theme="steel"]) .hero::before,
  :global([data-theme="schematic"]) .hero::before,
  :global([data-theme="pcb"]) .hero::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 8px;
    background: linear-gradient(to bottom, rgba(0,0,0,0.45) 0%, transparent 100%);
    pointer-events: none;
    z-index: 0;
  }
  ```

- No base-theme `::before`. Base hero stays flat.

### 4. `frontend/src/components/shared/HeroColorTuner.tsx` (new, dev-only)

Floating panel in the bottom-right corner with three sliders (IC body fill %, IC body stroke %, IC pad fill %), each 0–100%. Writes live updates to `document.documentElement.style.setProperty('--ic-body-fill', …)` etc., overriding the SCSS defaults at the document root. Shows the resolved `color-mix()` string next to each slider so it can be copy-pasted back into `CircuitTraces.module.scss`.

**Gating — dev only:**
```tsx
export default function HeroColorTuner() {
  if (!import.meta.env.DEV) return null;
  // … slider UI
}
```

Mount in `App.tsx` as a sibling of `<NavVariantPicker />`. Persist slider state in `localStorage.circuits.tuner.*` so reloads don't reset. A "Reset to defaults" button restores the SCSS baseline.

**Not gated by theme** — the tuner always exposes the three sliders because the current theme already determines which `--theme-pcb-trace` color the `color-mix` is applied to. Users can flip themes via `NavVariantPicker` and tune any theme's contrast independently. The slider values are global (not per-theme) in v1 — if per-theme tuning is needed later, we bake in per-theme tokens at that point.

**Read-off behavior:** Each slider displays its integer percentage + the resolved color-mix string in monospace:

```
IC pad fill  [=====|======]  30%
             color-mix(in srgb, var(--theme-pcb-trace) 30%, transparent)
```

When the author has dialed in a value they like, they paste the string back into `CircuitTraces.module.scss` and the slider state becomes vestigial (but they can wipe it with Reset).

### 5. `frontend/src/components/shared/HeroColorTuner.module.scss` (new, dev-only)

Follows `NavVariantPicker.module.scss` aesthetic: fixed position bottom-right, backdrop-blur, frosted dark pill, 12px padding, monospace font stack.

### 6. `frontend/src/App.tsx` (modify, one line)

Add `<HeroColorTuner />` as a sibling of `<NavVariantPicker />`. Since the tuner returns `null` in prod, this is a no-op in prod builds.

### 7. `tests/visual/pyproject.toml` (new)

Declares the visual-test harness as its own minimal Python project (not folded into `api/` to keep API and frontend test concerns separate).

```toml
[project]
name = "circuits-visual-tests"
version = "0.1.0"
requires-python = ">=3.12"

[project.optional-dependencies]
dev = [
  "pytest>=8.0",
  "pytest-playwright>=0.5",
]

[tool.pytest.ini_options]
testpaths = ["."]
addopts = "-v --browser chromium --headed=false"
```

### 8. `tests/visual/conftest.py` (new)

Pytest fixtures for:
- `live_server_url` — returns `http://localhost` (assumes docker compose is up).
- `theme_urls` — a parametrized fixture yielding `(theme_name, url_with_query)` for the 4 themes: `base` (no query), `steel` (`?nav=A`), `schematic` (`?nav=B`), `pcb` (`?nav=C`).
- Playwright `browser`, `context`, `page` fixtures are provided by `pytest-playwright` automatically.
- A `wait_for_animation_end` helper that hooks the `draw-circuit` animation's `animationend` event.

### 9. `tests/visual/test_visibility.py` (new)

Per-theme visibility assertions: `.hero` non-zero rect; `<svg>` present with ≥140 `<path>` descendants; heading font-size ≥16px; contrast ratio ≥4.5:1 (computed via `page.evaluate` of a small color-contrast function); search bar + 2 quick links rendered.

### 10. `tests/visual/test_layout.py` (new)

Per-viewport × per-theme layout assertions: brand ≤30px from left, LOGIN ≤30px from right, SVG fills hero exactly, shadow-gap `::before` has height=8 on alternate themes, absent on base.

### 11. `tests/visual/test_perf.py` (new)

Per-theme perf assertions: no long tasks >50ms in first 3s; `draw-circuit` duration 6000ms ± 100ms; theme-switch repaint <100ms. Uses `page.evaluate` with `PerformanceObserver` and Performance entries.

### 12. `tests/visual/baselines/` (new, screenshots committed)

One PNG per theme per viewport, captured on first successful run. Subsequent runs compare against these with tolerance.

### 13. `CLAUDE.md` (modify, append one section)

Add a "Visual Regression Tests" paragraph under "Commands" explaining how to run `cd tests/visual && pytest -v` and under "Gotchas" noting that tests require `docker compose up -d` first (they hit `http://localhost`, not an in-process server).

### Files NOT touched

- `frontend/src/styles/_themes.scss` — no new tokens.
- `frontend/src/styles/_variables.scss` — no new variables.
- `frontend/src/styles/_mixins.scss` — no new mixins.
- `frontend/src/styles/_animations.scss` — reuse existing keyframes; no additions.
- `frontend/src/components/layout/Navbar.module.scss` — navbar unchanged.
- `frontend/src/components/layout/NavVariantPicker.tsx` — theme picker unchanged.
- `frontend/src/components/layout/ThemeBridge.tsx` — theme resolution unchanged.
- Any admin / API / backend file.

## Performance budget

Based on the diagnostic audit (239 SVG elements: 140 traces, 85 node circles, 14 electrons):

| Metric | Current (hue-rotate) | Proposed | Delta |
|---|---|---|---|
| GPU compositor layers (animation phase) | 1 (hue-rotate filter on `.circuitTraces`) | 0–1 (traceGlow filter on `.traceGroup` on non-base only) | ≤0 |
| Per-frame var() resolutions (draw animation) | 0 | 0 via inheritance | 0 |
| Filter applications per frame | 1 (hue-rotate on SVG root) | 1 (traceGlow on traceGroup) | 0 |
| Theme-switch style recalc scope | 1 element | 239 elements (gated by `contain: style`) | +238 |
| Initial paint cost | O(N) with hue-rotate pass | O(N) without | ≈equal |

### Perf guardrails (binding)

- **No per-element `filter: drop-shadow()` and no per-element `filter="url(#…)"`** — both forms cost 140 filter applications. The filter MUST be applied at the `<g class="traceGroup">` wrapper, once.
- **No animated `filter:` properties** — per CLAUDE.md gotcha "Never animate CSS `drop-shadow()` filters."
- **`contain: layout style paint` stays** on both `.hero` and `.circuitTraces`.
- **No `background-attachment: fixed`** on `.hero` (would bypass containment).
- **No `will-change` sprinkled on trace elements** — they run at 60fps on the existing animation without it; premature layer promotion is the problem we just removed.
- **`color-mix()` is cheap** (computed once per render, not per frame) — safe to use liberally.

## Risks & CLAUDE.md gotchas tracked

1. **`filter: hue-rotate(0deg)` not free** — the current codebase works around this by gating the filter to non-base themes. The proposed change removes the hue-rotate entirely, so the gate becomes unnecessary. Confirm after refactor: no `filter:` property on `.circuitTraces` at all.

2. **Subpixel text blur from transform centering** — the shadow-gap `::before` uses `position: absolute; inset: 0 0 auto 0; height: 8px` (no transforms, integer-pixel box). Does not regress the "avoid transform centering" gotcha.

3. **Framer Motion `as const` on ease** — not applicable, no Framer Motion additions here.

4. **Grid `1fr auto 1fr` asymmetric tracks** — not applicable, no grids introduced.

5. **Theme-persistence localStorage stale-read** — `HeroColorTuner` writes to `localStorage.circuits.tuner.*` synchronously before writing to `document.documentElement.style`, matching the NavVariantPicker pattern.

## Verification plan

Maps to the user's earlier skill invocations: `/verification-before-completion` + `/chrome-devtools-mcp:chrome-devtools` + `/test-driven-development`.

### Visual verification (chrome-devtools MCP)

Per theme (4 themes × screenshots of hero):
- base, steel, schematic, pcb
- Capture at viewport 1280×720 and 375×812 (mobile)
- Compare against the "desired" per-theme table in this spec.

Additionally:
- Navbar/hero seam close-up (top 80px of hero at each theme)
- Theme-switch repaint test (click NavVariantPicker between themes, verify no flicker)
- Animation frame capture at t=0, t=1.5s, t=3s, t=6s of the draw-circuit animation

### Functional verification

- TypeScript strict mode: `cd frontend && npx tsc --noEmit` passes.
- Build: `docker compose up --build -d frontend` succeeds; new bundle served.
- No console errors on any theme.
- Base theme renders byte-identically to pre-change (compare screenshot to `master` HEAD).
- HeroColorTuner returns `null` in `npm run build` production output (not rendered).

### Perf verification

- Chrome DevTools Performance trace during a page load + one theme switch:
  - No long tasks >50ms attributable to hero
  - Draw animation runs at 60fps (no dropped frames)
  - Style-recalc on theme switch <5ms

### Regression tests (pytest-playwright)

**New test infrastructure.** Until this spec, the frontend had no automated test suite — TypeScript + manual verification were the only gates. This is reversed here: a `pytest-playwright` suite is added specifically to protect the visual refactor and catch future regressions on visibility, layout anchoring, and runtime lag.

**Tooling rationale.** `pytest-playwright` bridges the user's familiar pytest harness to a real headless browser, the only environment that can verify visibility (render dimensions), layout (bounding boxes), and perf (long-task timing, animation frame rate). Alternatives considered and rejected:
- **Playwright native TS runner** — idiomatic for frontend but diverges from the pytest-first mental model.
- **Vitest + testing-library** — unit-level only; cannot assert layout or perf against a running nginx stack.
- **HTTP-only tests (`requests`, `httpx`)** — cannot probe visual rendering or runtime lag.

**Test harness location.** New `tests/visual/` at project root (not under `api/`, since these tests cover the frontend + full-stack assembled site, not API logic). `tests/visual/pyproject.toml` declares `pytest-playwright` as a dev dep. Tests assume the full Docker stack is up (`docker compose up -d`); a `conftest.py` fixture points Playwright at `http://localhost` and iterates the 4 theme variants via `?nav=A|B|C|(absent)` URL params.

**Three test families.**

1. **`test_visibility.py`** — per theme: `.hero` has non-zero bounding rect; `.circuitTraces` svg is present with ≥140 descendant `<path>` elements; hero heading computed font-size ≥16px and contrast ratio ≥4.5:1 against its background; search bar and both quick links render.

2. **`test_layout.py`** — at viewports [1280×720, 768×1024, 375×812]:
   - Navbar brand bounding rect: `left ≤ 30` across all themes.
   - LOGIN button bounding rect: `right ≥ viewport_width - 30` across all themes.
   - `.circuitTraces` fills `.hero` exactly (identical `getBoundingClientRect`).
   - Shadow-gap `::before` on `steel / schematic / pcb` themes: height == 8, top == 0, width == hero width.
   - Base theme: no `::before` rendered.

3. **`test_perf.py`** — per theme:
   - `page.evaluate("performance.getEntriesByType('longtask')")` returns no entry >50ms during the first 3s after navigation.
   - `draw-circuit` animation duration measured via `animation-end` event: 6000ms ± 100ms tolerance.
   - Theme switch (click `NavVariantPicker` button → next paint): <100ms via `page.evaluate(PerformanceObserver)` on `'paint'` entries.
   - Lighthouse score via Playwright Lighthouse plugin: Performance ≥90 on every theme (run separately, not per commit; this is a local-dev smoke gate).

**Run command.** `cd tests/visual && uv pip install -e . && pytest -v` (or the project's preferred Python install path; details nailed down in the implementation plan).

**Baseline screenshots** are captured on the first run per theme (`tests/visual/baselines/*.png`) and compared via `playwright.expect(page).to_have_screenshot(…)` on subsequent runs with a small pixel-diff tolerance to absorb anti-aliasing drift. Baselines are committed to the repo.

### Cross-validation agents (post-implementation)

Per the user's original request for "cross-validation agents to make sure nothing is broken":

1. **Code reviewer** (`pr-review-toolkit:code-reviewer`) — reviews the diff for SCSS/TSX conventions, dead code, and pattern fidelity to the existing codebase.
2. **Codebase-diagnostician** — traces whether changes to `CircuitTraces.tsx` / `HeroSection.module.scss` affect any other component (e.g., does `.circuitTraces` get used elsewhere?). Answer: it does not — verified in the pattern audit.
3. **Comment analyzer** (`pr-review-toolkit:comment-analyzer`) — verifies any comments added in the diff are accurate and non-rotting.
4. **Chrome-devtools-mcp** — performs the visual and perf verification described above.

## Non-goals

- Animating the glow filter's intensity (costs per-frame CPU rasterization).
- Per-theme tuning tokens in `_themes.scss` for IC opacities (defer until HeroColorTuner proves a specific theme needs divergent values; if one theme lands on 35% while others stay at 30%, we introduce `--theme-ic-pad-opacity` then).
- A Storybook or component playground around `CircuitTraces`. `HeroColorTuner` fills this role at 1/100th the setup cost.
- Migrating the SCSS modules architecture, Framer Motion usage, or theme system to any alternative (next-themes, Tailwind, Emotion — all explicitly rejected in the package audit).
- **Unit** tests for `CircuitTraces` internals (React component testing in isolation). The Playwright suite covers behavior against the real running stack; a separate vitest/jsdom harness is not warranted for this work.

## Implementation sequencing

The implementation plan (next step — `writing-plans` skill) will break this into parallelizable chunks. Preview:

- **Phase 0 (sequential, TDD gate):** Author the pytest-playwright test suite FIRST (`test_visibility.py`, `test_layout.py`, `test_perf.py`) against the current pre-refactor hero. These tests MUST PASS on base theme (which doesn't change) and FAIL on steel/schematic/pcb themes (because the expected per-theme behaviors don't exist yet). This is the "red" in red-green-refactor.
- **Phase 1 (parallel):** SCSS token block refactor; SVG `<filter>` + `<g class="traceGroup">` addition; HeroSection textures; shadow-gap `::before`.
- **Phase 2 (parallel):** `CircuitTraces.tsx` attribute rewrite (uses tokens from Phase 1); HeroColorTuner component + SCSS.
- **Phase 3 (sequential):** `App.tsx` tuner mount; capture baseline screenshots (first successful run auto-writes PNGs).
- **Phase 4 (sequential, TDD gate):** Rerun full test suite — all three families must pass for all four themes.
- **Phase 5 (parallel cross-validators):** code-reviewer, codebase-diagnostician, comment-analyzer, chrome-devtools visual + perf walkthrough.

Handoff to `writing-plans` skill occurs after user approves this spec.
