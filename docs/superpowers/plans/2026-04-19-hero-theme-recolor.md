# Hero Theme Recolor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hero section's hardcoded gold-with-hue-rotate theming with a CSS-custom-property inheritance cascade sourced from navbar theme tokens, for steel/schematic/pcb themes only (base untouched), and guard the work with a pytest-playwright visual/layout/perf regression suite.

**Architecture:** SVG elements inside `CircuitTraces.tsx` consume `var(--trace-color)` etc. defined once on the SVG root via SCSS (not per-child, to avoid per-frame var() resolution during the 6s draw animation). Trace paths are wrapped in a single `<g class="traceGroup">` so the shared `<filter id="traceGlow">` runs as one filter application, not 140. Per-theme hero background textures + a shadow-gap `::before` establish the nav/hero seam. Base theme is carved out in SCSS to preserve byte-identical rendering.

**Tech Stack:** React 19 + TypeScript + Vite + SCSS Modules; Python 3.12 + pytest + pytest-playwright for tests; Docker Compose for the runtime stack under test.

**Spec:** `docs/superpowers/specs/2026-04-19-hero-theme-recolor-design.md`

**Branch:** `updates` (already checked out)

---

## File Structure

**Modified (5):**
- `frontend/src/components/shared/CircuitTraces.tsx` — add `<defs><filter>`, wrap traces in `<g className={styles.traceGroup}>`, rewrite `S()` helper and inline `fill=` attributes to consume CSS custom properties.
- `frontend/src/components/shared/CircuitTraces.module.scss` — remove `filter: hue-rotate` + `transition: filter`, add `.circuitTraces` token block + `.traceGroup` class + base carve-out.
- `frontend/src/components/home/HeroSection.module.scss` — add `:global([data-theme=…]) .hero` rules for per-theme backgrounds + shadow-gap `::before`.
- `frontend/src/App.tsx` — mount `<HeroColorTuner />` as sibling of `<NavVariantPicker />`.
- `CLAUDE.md` — append "Visual Regression Tests" section + "Gotchas" entry about docker-prereq.

**New (8):**
- `frontend/src/components/shared/HeroColorTuner.tsx` — dev-only slider panel (3 sliders, localStorage-persisted, `import.meta.env.DEV`-gated).
- `frontend/src/components/shared/HeroColorTuner.module.scss` — floating-pill styling matching `NavVariantPicker`.
- `tests/visual/pyproject.toml` — pytest-playwright harness config.
- `tests/visual/conftest.py` — shared fixtures (live URL, theme parametrization, animation-wait helper).
- `tests/visual/test_visibility.py` — render + contrast tests.
- `tests/visual/test_layout.py` — bounding-box tests per theme per viewport.
- `tests/visual/test_perf.py` — long-task + animation + theme-switch timing tests.
- `tests/visual/baselines/.gitkeep` — placeholder so dir is tracked; baselines auto-written on first successful run.

---

## Task 1: Scaffold visual-test harness

**Files:**
- Create: `tests/visual/pyproject.toml`
- Create: `tests/visual/conftest.py`
- Create: `tests/visual/baselines/.gitkeep`

- [ ] **Step 1: Create the pyproject.toml**

```toml
# tests/visual/pyproject.toml
[project]
name = "circuits-visual-tests"
version = "0.1.0"
requires-python = ">=3.12"
description = "Playwright-driven visual/layout/perf regression tests for circuits.com"

[project.optional-dependencies]
dev = [
  "pytest>=8.0",
  "pytest-playwright>=0.5",
]

[tool.pytest.ini_options]
testpaths = ["."]
addopts = "-v --browser chromium"
```

- [ ] **Step 2: Create conftest.py with fixtures**

```python
# tests/visual/conftest.py
import pytest
from playwright.sync_api import Page


LIVE_URL = "http://localhost"

THEME_PARAMS = [
    ("base", ""),             # no query = base
    ("steel", "?nav=A"),
    ("schematic", "?nav=B"),
    ("pcb", "?nav=C"),
]


@pytest.fixture
def live_server_url() -> str:
    """Root URL of the docker-compose stack. Assumes `docker compose up -d` has been run."""
    return LIVE_URL


@pytest.fixture(params=THEME_PARAMS, ids=[p[0] for p in THEME_PARAMS])
def theme_url(request, live_server_url: str) -> tuple[str, str]:
    """Yields (theme_name, full_url) for each of the 4 themes."""
    name, query = request.param
    return name, f"{live_server_url}/{query}"


def wait_for_draw_animation_end(page: Page, timeout: int = 7000) -> float:
    """Wait for the 6s draw-circuit animation to finish on the last trace path.
    Returns the measured duration in milliseconds.
    """
    return page.evaluate(
        """
        () => new Promise((resolve) => {
            const start = performance.now();
            const traces = document.querySelectorAll('[class*="trace"]');
            if (traces.length === 0) { resolve(0); return; }
            let remaining = traces.length;
            const done = () => {
                remaining -= 1;
                if (remaining === 0) resolve(performance.now() - start);
            };
            traces.forEach(t => t.addEventListener('animationend', done, { once: true }));
            setTimeout(() => resolve(performance.now() - start), arguments[0] ?? 7000);
        })
        """,
        timeout,
    )
```

- [ ] **Step 3: Create .gitkeep so baselines/ is tracked**

```bash
touch tests/visual/baselines/.gitkeep
```

- [ ] **Step 4: Commit the scaffold**

```bash
git add tests/visual/
git commit -m "test: scaffold pytest-playwright visual test harness"
```

---

## Task 2: Write test_visibility.py (RED on alternate themes)

**Files:**
- Create: `tests/visual/test_visibility.py`

- [ ] **Step 1: Write the visibility tests**

```python
# tests/visual/test_visibility.py
"""Per-theme visibility assertions. These tests should PASS on base theme
(which is unchanged by the recolor) and initially pass on alternate themes
as well — visibility is theme-independent. Any regression here indicates
the refactor broke rendering."""
from playwright.sync_api import Page, expect


def test_hero_renders_nonzero(page: Page, theme_url: tuple[str, str]) -> None:
    """The hero section must have a non-zero bounding rect on every theme."""
    _, url = theme_url
    page.goto(url)
    hero = page.locator("section[class*='hero']").first
    box = hero.bounding_box()
    assert box is not None, f"{theme_url[0]}: .hero did not render"
    assert box["width"] > 0 and box["height"] >= 420, (
        f"{theme_url[0]}: .hero rect is {box}, expected height >= 420"
    )


def test_svg_has_traces(page: Page, theme_url: tuple[str, str]) -> None:
    """The CircuitTraces SVG must render with >=140 <path> descendants."""
    _, url = theme_url
    page.goto(url)
    path_count = page.evaluate(
        "document.querySelectorAll('svg[class*=\"circuitTraces\"] path').length"
    )
    assert path_count >= 140, (
        f"{theme_url[0]}: expected >=140 <path> elements, found {path_count}"
    )


def test_heading_visible(page: Page, theme_url: tuple[str, str]) -> None:
    """The hero heading must be rendered with readable font-size."""
    _, url = theme_url
    page.goto(url)
    heading = page.locator("h1").first
    expect(heading).to_be_visible()
    font_size_px = heading.evaluate(
        "el => parseFloat(getComputedStyle(el).fontSize)"
    )
    assert font_size_px >= 16, (
        f"{theme_url[0]}: heading font-size is {font_size_px}px, expected >=16"
    )


def test_search_and_quick_links_render(page: Page, theme_url: tuple[str, str]) -> None:
    """Search bar + 2 quick links must render on every theme."""
    _, url = theme_url
    page.goto(url)
    expect(page.get_by_placeholder("Search", exact=False)).to_be_visible()
    expect(page.get_by_role("link", name="Find Parts")).to_be_visible()
    expect(page.get_by_role("link", name="Top Distributors")).to_be_visible()
```

- [ ] **Step 2: Commit**

```bash
git add tests/visual/test_visibility.py
git commit -m "test(visual): add per-theme visibility assertions"
```

---

## Task 3: Write test_layout.py (RED on alternate themes)

**Files:**
- Create: `tests/visual/test_layout.py`

- [ ] **Step 1: Write the layout tests**

```python
# tests/visual/test_layout.py
"""Per-theme × per-viewport layout assertions.

These SHOULD pass on base (unchanged) and initially FAIL on steel/schematic/pcb
because the shadow-gap ::before only exists after the refactor. That's the
expected RED state before implementation.
"""
import pytest
from playwright.sync_api import Page


VIEWPORTS = [
    ("desktop", 1280, 720),
    ("tablet", 768, 1024),
    ("mobile", 375, 812),
]


@pytest.fixture(params=VIEWPORTS, ids=[v[0] for v in VIEWPORTS])
def viewport(request) -> tuple[str, int, int]:
    return request.param


def test_brand_pinned_left(page: Page, theme_url: tuple[str, str], viewport: tuple[str, int, int]) -> None:
    """Brand must be within 30px of the viewport's left edge."""
    name, url = theme_url
    _, w, h = viewport
    page.set_viewport_size({"width": w, "height": h})
    page.goto(url)
    brand = page.locator("[class*='brand']").first
    box = brand.bounding_box()
    assert box is not None, f"{name}@{viewport[0]}: brand not rendered"
    assert box["x"] <= 30, (
        f"{name}@{viewport[0]}: brand left edge at {box['x']}, expected <=30"
    )


def test_login_pinned_right(page: Page, theme_url: tuple[str, str], viewport: tuple[str, int, int]) -> None:
    """LOGIN button must be within 30px of the viewport's right edge."""
    name, url = theme_url
    _, w, h = viewport
    page.set_viewport_size({"width": w, "height": h})
    page.goto(url)
    login = page.get_by_role("link", name="Login")
    # LOGIN may be hidden on mobile — check responsively
    if not login.is_visible():
        return
    box = login.bounding_box()
    assert box is not None
    right_gap = w - (box["x"] + box["width"])
    assert right_gap <= 30, (
        f"{name}@{viewport[0]}: LOGIN right gap is {right_gap}, expected <=30"
    )


def test_svg_fills_hero(page: Page, theme_url: tuple[str, str]) -> None:
    """CircuitTraces <svg> must match .hero's bounding rect exactly."""
    _, url = theme_url
    page.goto(url)
    hero = page.locator("section[class*='hero']").first
    svg = page.locator("svg[class*='circuitTraces']").first
    hero_box = hero.bounding_box()
    svg_box = svg.bounding_box()
    assert hero_box and svg_box
    for k in ("x", "y", "width", "height"):
        assert abs(hero_box[k] - svg_box[k]) <= 1, (
            f"{theme_url[0]}: hero and svg .{k} mismatch: {hero_box[k]} vs {svg_box[k]}"
        )


def test_shadow_gap_on_alternate_themes(page: Page, theme_url: tuple[str, str]) -> None:
    """The shadow-gap ::before must have height 8 on steel/schematic/pcb, absent on base."""
    name, url = theme_url
    page.goto(url)
    hero = page.locator("section[class*='hero']").first
    before_height = hero.evaluate(
        "el => parseFloat(getComputedStyle(el, '::before').height) || 0"
    )
    if name == "base":
        assert before_height == 0, (
            f"base: expected no ::before, got height {before_height}"
        )
    else:
        assert 7.5 <= before_height <= 8.5, (
            f"{name}: expected ::before height ~8px, got {before_height}"
        )
```

- [ ] **Step 2: Commit**

```bash
git add tests/visual/test_layout.py
git commit -m "test(visual): add per-theme layout and shadow-gap assertions"
```

---

## Task 4: Write test_perf.py (RED on alternate themes)

**Files:**
- Create: `tests/visual/test_perf.py`

- [ ] **Step 1: Write the perf tests**

```python
# tests/visual/test_perf.py
"""Per-theme runtime-perf assertions. No long tasks >50ms in first 3s,
draw-circuit animation finishes within 6s ± 100ms, theme switch repaints
in <100ms.
"""
from playwright.sync_api import Page
from conftest import wait_for_draw_animation_end


LONGTASK_BUDGET_MS = 50
DRAW_DURATION_MS = 6000
DRAW_TOLERANCE_MS = 200
THEME_SWITCH_BUDGET_MS = 100


def test_no_long_tasks(page: Page, theme_url: tuple[str, str]) -> None:
    """PerformanceObserver must report no long tasks >50ms during first 3s."""
    _, url = theme_url
    page.goto(url)
    long_tasks = page.evaluate(
        """
        async () => {
            const entries = [];
            const obs = new PerformanceObserver(list => {
                entries.push(...list.getEntries());
            });
            obs.observe({ type: 'longtask', buffered: true });
            await new Promise(r => setTimeout(r, 3000));
            obs.disconnect();
            return entries.map(e => ({ name: e.name, duration: e.duration }));
        }
        """
    )
    offenders = [t for t in long_tasks if t["duration"] > LONGTASK_BUDGET_MS]
    assert not offenders, (
        f"{theme_url[0]}: long tasks exceed {LONGTASK_BUDGET_MS}ms budget: {offenders}"
    )


def test_draw_animation_duration(page: Page, theme_url: tuple[str, str]) -> None:
    """draw-circuit animation completes in 6000ms ± 200ms tolerance."""
    _, url = theme_url
    page.goto(url)
    duration_ms = wait_for_draw_animation_end(page, timeout=8000)
    assert DRAW_DURATION_MS - DRAW_TOLERANCE_MS <= duration_ms <= DRAW_DURATION_MS + DRAW_TOLERANCE_MS, (
        f"{theme_url[0]}: draw-circuit took {duration_ms}ms, expected 6000 ± 200"
    )


def test_theme_switch_repaint_fast(page: Page, live_server_url: str) -> None:
    """Switching from base -> pcb via NavVariantPicker must repaint in <100ms."""
    page.goto(live_server_url + "/")
    # Click the PCB picker button; measure paint duration via PerformanceObserver.
    result = page.evaluate(
        """
        async () => {
            const startPaint = performance.now();
            let paintEnd = null;
            const obs = new PerformanceObserver(list => {
                for (const entry of list.getEntries()) {
                    if (entry.name === 'first-contentful-paint' ||
                        entry.entryType === 'paint') {
                        paintEnd = entry.startTime;
                    }
                }
            });
            obs.observe({ type: 'paint', buffered: false });

            // Trigger theme switch
            document.documentElement.dataset.theme = 'pcb';

            await new Promise(r => setTimeout(r, 200));
            obs.disconnect();
            return paintEnd !== null ? paintEnd - startPaint : null;
        }
        """
    )
    if result is None:
        # No paint entry fired — the theme switch was a no-op visually, which
        # itself is a regression (repaint should have triggered).
        raise AssertionError("No paint event observed after theme switch")
    assert result < THEME_SWITCH_BUDGET_MS, (
        f"theme-switch repaint took {result}ms, expected <{THEME_SWITCH_BUDGET_MS}"
    )
```

- [ ] **Step 2: Commit**

```bash
git add tests/visual/test_perf.py
git commit -m "test(visual): add long-task, draw-animation, theme-switch perf tests"
```

---

## Task 5: Verify tests run + fail in expected places

**Files:** none modified — this is a dry-run gate.

- [ ] **Step 1: Ensure docker stack is up**

Run: `docker compose up -d`
Expected: 5 containers running (db, api, frontend, n8n, nginx).

- [ ] **Step 2: Install test dependencies**

```bash
cd tests/visual
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
playwright install chromium
```

- [ ] **Step 3: Run the suite**

Run: `cd tests/visual && pytest -v`

Expected:
- `test_visibility.py` — ALL pass (visibility is theme-independent).
- `test_layout.py::test_shadow_gap_on_alternate_themes[steel]` — FAIL (no `::before` yet)
- `test_layout.py::test_shadow_gap_on_alternate_themes[schematic]` — FAIL
- `test_layout.py::test_shadow_gap_on_alternate_themes[pcb]` — FAIL
- `test_layout.py::test_shadow_gap_on_alternate_themes[base]` — PASS
- All other layout and perf tests — PASS (behaviors pre-exist)

- [ ] **Step 4: Record the RED baseline**

Note the exact failure count in the commit message so future runs can verify the delta.

```bash
cd tests/visual && pytest -v 2>&1 | tail -20
# Expected output summary: "3 failed, N passed in Xs"
```

- [ ] **Step 5: Commit nothing (verification-only task), proceed to implementation**

No git changes required. Move to Task 6.

---

## Task 6: Refactor CircuitTraces.module.scss — remove hue-rotate, add tokens

**Files:**
- Modify: `frontend/src/components/shared/CircuitTraces.module.scss`

- [ ] **Step 1: Replace file contents**

```scss
@use '../../styles/animations';

.circuitTraces {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  contain: layout style paint;

  // Default (alternate-theme) token values. Base overrides below.
  --trace-color:     var(--theme-pcb-trace);
  --trace-glow:      var(--theme-pcb-dot-glow);
  --electron-color:  var(--theme-nav-text-hover);
  --ic-body-fill:    color-mix(in srgb, var(--theme-pcb-trace) 3%,  transparent);
  --ic-body-stroke:  color-mix(in srgb, var(--theme-pcb-trace) 15%, transparent);
  --ic-pad-fill:     color-mix(in srgb, var(--theme-pcb-trace) 30%, transparent);
}

// Base theme carve-out: restore the pre-refactor hardcoded gold values
// and suppress the shared trace-glow filter. CSS `filter: none` beats
// the SVG `filter="url(#traceGlow)"` presentation attribute.
:global(:root[data-theme="base"]) .circuitTraces,
:global(:root:not([data-theme])) .circuitTraces {
  --trace-color:     rgba(218, 190, 65, 1);
  --electron-color:  rgba(218, 190, 65, 0.9);
  --ic-body-fill:    rgba(218, 190, 65, 0.02);
  --ic-body-stroke:  rgba(218, 190, 65, 0.12);
  --ic-pad-fill:     rgba(218, 190, 65, 0.25);

  .traceGroup { filter: none; }
}

.trace {
  animation: draw-circuit 6s ease-out forwards;
}

.traceGroup {
  // Container for the animated trace paths. The shared trace-glow filter
  // is applied here (once) via filter="url(#traceGlow)" in CircuitTraces.tsx.
}

.node {
  opacity: 0.4;
}

.electron {
  opacity: 0.9;
}
```

- [ ] **Step 2: Run type check to ensure no TS import-surface break**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/shared/CircuitTraces.module.scss
git commit -m "refactor(hero): replace hue-rotate with CSS-custom-property cascade"
```

---

## Task 7: Add per-theme hero backgrounds + shadow-gap to HeroSection.module.scss

**Files:**
- Modify: `frontend/src/components/home/HeroSection.module.scss`

- [ ] **Step 1: Append theme-scoped rules to the existing file**

After the existing `.quickLinks` block (line ~78), APPEND:

```scss
// ─── Per-theme hero background textures + nav/hero shadow-gap seam ────────

:global([data-theme="steel"]) .hero {
  background-image:
    linear-gradient(
      180deg,
      rgba(14, 17, 19, 0.30) 0%,
      rgba(14, 17, 19, 0) 20%,
      rgba(14, 17, 19, 0) 80%,
      rgba(14, 17, 19, 0.20) 100%
    ),
    linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.04) 0%,
      rgba(255, 255, 255, 0) 18%
    );
  background-color: $executive-blue;
}

:global([data-theme="schematic"]) .hero {
  background-image:
    linear-gradient(
      180deg,
      rgba(20, 26, 30, 0.10) 0%,
      rgba(20, 26, 30, 0) 15%,
      rgba(20, 26, 30, 0) 75%,
      rgba(20, 26, 30, 0.15) 100%
    ),
    repeating-linear-gradient(
      0deg,
      transparent 0 27px,
      rgba(255, 255, 255, 0.025) 27px 28px
    );
  background-color: $executive-blue;
}

:global([data-theme="pcb"]) .hero {
  background-image:
    radial-gradient(
      ellipse 70% 45% at 50% 50%,
      transparent 60%,
      rgba(6, 20, 10, 0.35) 100%
    ),
    repeating-linear-gradient(
      0deg,
      transparent 0 23px,
      color-mix(in srgb, var(--theme-accent) 3.5%, transparent) 23px 24px
    ),
    repeating-linear-gradient(
      90deg,
      transparent 0 23px,
      color-mix(in srgb, var(--theme-accent) 3.5%, transparent) 23px 24px
    );
  background-color: $executive-blue;
}

// 8px shadow-gap recessing the hero under the navbar. Not applied on base.
:global([data-theme="steel"]) .hero::before,
:global([data-theme="schematic"]) .hero::before,
:global([data-theme="pcb"]) .hero::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 8px;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.45) 0%, transparent 100%);
  pointer-events: none;
  z-index: 0;
}
```

- [ ] **Step 2: Verify SCSS compiles**

Run: `docker compose up --build -d frontend`
Expected: container rebuilds without SCSS errors; new bundle served.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/home/HeroSection.module.scss
git commit -m "feat(hero): add per-theme backgrounds and nav/hero shadow-gap seam"
```

---

## Task 8: Refactor CircuitTraces.tsx — tokens + `<defs>` + `<g>` wrapper

**Files:**
- Modify: `frontend/src/components/shared/CircuitTraces.tsx`

- [ ] **Step 1: Refactor the `S()` helper**

Find (line 5):

```typescript
const S = (o: number, w = 1) => ({ stroke: `rgba(218,190,65,${Math.min(o * 2.5, 1)})`, strokeWidth: w });
```

Replace with:

```typescript
// Token-driven stroke. Color comes from var(--trace-color) on the SVG root
// (set in CircuitTraces.module.scss and overridden per theme). Opacity is
// a numeric prop kept per-element so individual traces can be fainter.
const S = (o: number, w = 1) => ({
  stroke: 'var(--trace-color)',
  strokeOpacity: Math.min(o * 2.5, 1),
  strokeWidth: w,
});
```

- [ ] **Step 2: Replace hardcoded fills with token references**

First, locate every hardcoded color in the file:

```bash
grep -n "218,190,65\|218, 190, 65" frontend/src/components/shared/CircuitTraces.tsx
```

Expected: ~50–60 matches across the `<rect>` (IC bodies + pads) and `<circle>` (electrons) elements.

Globally, in the JSX body (the SVG children starting around line 52):

- Every `fill="rgba(218,190,65,0.02)"` (IC body background) → `fill="var(--ic-body-fill)"`
- Every `fill={`rgba(218,190,65,${0.25})`}` or `fill="rgba(218,190,65,0.25)"` (IC pad) → `fill="var(--ic-pad-fill)"`
- Every `fill="rgba(218,190,65,0.1)"` on IC pads specifically → `fill="var(--ic-pad-fill)"` with `fillOpacity={0.4}` prop to preserve the lighter variants

The IC body stroke values (currently `{...S(0.12, 1)}` etc. on IC body `<rect>` elements) stay using the `S()` helper — since `S()` now returns `var(--trace-color)`, these will inherit theme. This is fine for IC body STROKES but we want them at `--ic-body-stroke`. Refine by adding a new helper:

```typescript
// IC body stroke — uses --ic-body-stroke (softer than main trace color)
const IC = (w = 1) => ({ stroke: 'var(--ic-body-stroke)', strokeWidth: w, fill: 'var(--ic-body-fill)' });
```

Replace IC body `<rect>` spreads: `<rect ... {...S(0.12, 1)} fill="rgba(218,190,65,0.02)" ...>` becomes `<rect ... {...IC(1)} ...>`.

Replace the smaller IC body's spread `{...S(0.1, 0.8)}` with `{...IC(0.8)}`.

- [ ] **Step 3: Replace electron fills**

Find every `<circle>` with `fill="rgba(218,190,65,0.9)"` (the electrons).

Replace with `fill="var(--electron-color)"`.

- [ ] **Step 4: Wrap trace paths in `<g className={styles.traceGroup}>` and add `<defs>`**

At the very top of the `<svg>` body (immediately after the `<svg ...>` opening tag, line ~49), insert:

```jsx
<defs>
  <filter id="traceGlow" x="-10%" y="-10%" width="120%" height="120%">
    <feGaussianBlur stdDeviation="1.5" result="blur" />
    <feFlood floodColor="var(--trace-glow)" floodOpacity="0.6" />
    <feComposite in2="blur" operator="in" result="glowColor" />
    <feMerge>
      <feMergeNode in="glowColor" />
      <feMergeNode in="SourceGraphic" />
    </feMerge>
  </filter>
</defs>
```

Then identify all `<path>` elements with `className={styles.trace}` (the 14 trace bundles, plus any additional path traces). Wrap them in a single `<g>`:

```jsx
<g className={styles.traceGroup} filter="url(#traceGlow)">
  {/* ...all trace <path> elements here... */}
</g>
```

IC rects and electron `<circle>` elements stay OUTSIDE the `<g>` — the glow is trace-only.

- [ ] **Step 5: Type check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Rebuild and smoke-test in browser**

Run: `docker compose up --build -d frontend`

Open `http://localhost/?nav=C` (PCB theme). Expected: traces render in copper color with a soft glow; IC bodies are faint copper ghosts; electrons are white dots.

Open `http://localhost/` (base). Expected: byte-identical to pre-change — gold traces, no glow, amber electrons.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/shared/CircuitTraces.tsx
git commit -m "refactor(hero): wire SVG to theme tokens via shared filter group"
```

---

## Task 9: Create HeroColorTuner component (dev-only)

**Files:**
- Create: `frontend/src/components/shared/HeroColorTuner.tsx`
- Create: `frontend/src/components/shared/HeroColorTuner.module.scss`

- [ ] **Step 1: Create HeroColorTuner.tsx**

```tsx
// frontend/src/components/shared/HeroColorTuner.tsx
import { useEffect, useState } from "react";
import styles from "./HeroColorTuner.module.scss";

const STORAGE_PREFIX = "circuits.tuner.";

type Slot = "ic-body-fill" | "ic-body-stroke" | "ic-pad-fill";

const DEFAULTS: Record<Slot, number> = {
  "ic-body-fill": 3,
  "ic-body-stroke": 15,
  "ic-pad-fill": 30,
};

const LABELS: Record<Slot, string> = {
  "ic-body-fill": "IC body fill",
  "ic-body-stroke": "IC body stroke",
  "ic-pad-fill": "IC pad fill",
};

function readInitial(slot: Slot): number {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + slot);
    if (raw === null) return DEFAULTS[slot];
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : DEFAULTS[slot];
  } catch {
    return DEFAULTS[slot];
  }
}

function colorMixString(percent: number): string {
  return `color-mix(in srgb, var(--theme-pcb-trace) ${percent}%, transparent)`;
}

function applySlot(slot: Slot, percent: number): void {
  document.documentElement.style.setProperty(`--${slot}`, colorMixString(percent));
  try {
    localStorage.setItem(STORAGE_PREFIX + slot, String(percent));
  } catch {
    // localStorage disabled — live override still works via document.documentElement
  }
}

function clearAll(): void {
  for (const slot of Object.keys(DEFAULTS) as Slot[]) {
    document.documentElement.style.removeProperty(`--${slot}`);
    try {
      localStorage.removeItem(STORAGE_PREFIX + slot);
    } catch {
      // noop
    }
  }
}

export default function HeroColorTuner() {
  if (!import.meta.env.DEV) return null;

  const [values, setValues] = useState<Record<Slot, number>>({
    "ic-body-fill": readInitial("ic-body-fill"),
    "ic-body-stroke": readInitial("ic-body-stroke"),
    "ic-pad-fill": readInitial("ic-pad-fill"),
  });

  // Apply any persisted overrides on first render.
  useEffect(() => {
    (Object.keys(values) as Slot[]).forEach((slot) => {
      if (values[slot] !== DEFAULTS[slot]) applySlot(slot, values[slot]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onChange = (slot: Slot) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value, 10);
    setValues((prev) => ({ ...prev, [slot]: v }));
    applySlot(slot, v);
  };

  const onReset = () => {
    clearAll();
    setValues({ ...DEFAULTS });
  };

  return (
    <div className={styles.tuner}>
      <div className={styles.header}>
        <span className={styles.title}>Hero Tuner</span>
        <button type="button" onClick={onReset} className={styles.reset}>
          Reset
        </button>
      </div>
      {(Object.keys(DEFAULTS) as Slot[]).map((slot) => (
        <div key={slot} className={styles.row}>
          <label className={styles.label}>
            <span className={styles.name}>{LABELS[slot]}</span>
            <span className={styles.value}>{values[slot]}%</span>
          </label>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={values[slot]}
            onChange={onChange(slot)}
            className={styles.slider}
          />
          <code className={styles.readout}>{colorMixString(values[slot])}</code>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create HeroColorTuner.module.scss**

```scss
// frontend/src/components/shared/HeroColorTuner.module.scss
@use '../../styles/variables' as *;

.tuner {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 200;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(20, 20, 24, 0.85);
  backdrop-filter: blur(8px);
  color: #e8e8ea;
  font-family: $font-mono;
  font-size: 0.72rem;
  width: 280px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  gap: 8px;
  user-select: none;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.title {
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 0.68rem;
}

.reset {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #e8e8ea;
  font-family: inherit;
  font-size: 0.65rem;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;

  &:hover {
    background: rgba(255, 255, 255, 0.1);
  }
}

.row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.label {
  display: flex;
  justify-content: space-between;
}

.name {
  opacity: 0.75;
}

.value {
  font-weight: 700;
}

.slider {
  width: 100%;
  accent-color: #44bd13;
}

.readout {
  font-size: 0.6rem;
  opacity: 0.55;
  word-break: break-all;
  padding-top: 2px;
}
```

- [ ] **Step 3: Type check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/shared/HeroColorTuner.tsx frontend/src/components/shared/HeroColorTuner.module.scss
git commit -m "feat(dev): add HeroColorTuner dev-only contrast slider panel"
```

---

## Task 10: Mount HeroColorTuner in App.tsx

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add import and mount**

Find the existing import block (around line 27):

```tsx
import NavVariantPicker from './components/layout/NavVariantPicker'
```

Add one line below:

```tsx
import HeroColorTuner from './components/shared/HeroColorTuner'
```

Find the existing mount (around line 86):

```tsx
      <NavVariantPicker />
```

Add one line below:

```tsx
      <HeroColorTuner />
```

- [ ] **Step 2: Type check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify in dev and prod bundles**

Dev bundle (should render tuner):
```bash
cd frontend && npm run dev
# Open http://localhost:3000 — HeroColorTuner visible bottom-right
```

Prod bundle (should NOT render tuner):
```bash
docker compose up --build -d frontend
# Open http://localhost — HeroColorTuner must NOT be in DOM
# Verify via devtools Elements panel: no .tuner element present
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(dev): mount HeroColorTuner alongside NavVariantPicker"
```

---

## Task 11: Re-run visual test suite — expect GREEN

**Files:** none modified.

- [ ] **Step 1: Ensure docker has the latest bundle**

Run: `docker compose up --build -d frontend`

- [ ] **Step 2: Run the full suite**

Run: `cd tests/visual && source .venv/bin/activate && pytest -v`

Expected: all tests PASS across all 4 themes × all viewports. The shadow-gap tests that were RED in Task 5 now GREEN because HeroSection.module.scss has the `::before` rule for alternate themes.

If any test FAILS: do NOT mark task complete. Investigate with `pytest -v --headed` to see the browser, fix the underlying implementation, re-run.

- [ ] **Step 3: Capture baseline screenshots**

Add this one-off test file temporarily to capture baselines:

```python
# tests/visual/test_baseline_capture.py (DELETE AFTER RUNNING)
from playwright.sync_api import Page


def test_capture_baselines(page: Page, theme_url: tuple[str, str]) -> None:
    name, url = theme_url
    page.set_viewport_size({"width": 1280, "height": 720})
    page.goto(url)
    page.wait_for_timeout(7000)  # let draw-circuit animation finish
    page.screenshot(path=f"baselines/{name}-1280.png", full_page=False)
```

Run:
```bash
cd tests/visual && pytest test_baseline_capture.py -v
```

Expected: 4 PNGs written to `tests/visual/baselines/`. Delete the capture test:
```bash
rm tests/visual/test_baseline_capture.py
```

- [ ] **Step 4: Commit baselines**

```bash
git add tests/visual/baselines/*.png
git commit -m "test(visual): capture baseline screenshots for all four themes"
```

---

## Task 12: Update CLAUDE.md with test-suite documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add test-run instructions to Commands section**

Find the existing "### Development" section under "## Commands" in CLAUDE.md.

After the Frontend block, add a new block:

```markdown
### Visual tests (from tests/visual/)
\`\`\`bash
cd tests/visual
source .venv/bin/activate                # one-time: python -m venv .venv && pip install -e ".[dev]" && playwright install chromium
pytest -v                                 # run all visibility/layout/perf tests
pytest test_visibility.py -v             # single file
pytest -v --headed                        # see the browser
\`\`\`
> Requires docker compose up -d first. Tests hit http://localhost (nginx), not the Vite dev server.
```

- [ ] **Step 2: Add a new gotcha**

Find the "## Gotchas" section. Append one bullet:

```markdown
- **Visual tests require docker compose up -d** — `tests/visual/` hits `http://localhost` (nginx). Running the Vite dev server directly on `:3000` won't satisfy the tests because they assume the prod build (which excludes `HeroColorTuner`). For rapid visual iteration, use `npm run dev` in the browser; for regression gating, use the docker stack + pytest.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document visual test suite + docker prereq gotcha"
```

---

## Task 13: Dispatch parallel cross-validation agents

**Files:** none modified directly — agents produce reports.

- [ ] **Step 1: Dispatch 3 agents in parallel (single message, 3 Agent tool calls)**

Per the original user request for "cross-validation agents to make sure nothing is broken":

1. **Code reviewer** (`pr-review-toolkit:code-reviewer`) — review the full diff on `updates` branch for SCSS/TSX convention fidelity, dead code, and pattern consistency with the existing codebase.
2. **Silent-failure hunter** (`pr-review-toolkit:silent-failure-hunter`) — inspect the new `HeroColorTuner.tsx`, the test files, and the `CircuitTraces.tsx` refactor for swallowed errors, empty catch blocks, or fallback logic that masks real failures.
3. **Codebase diagnostician** (`codebase-diagnostician`) — trace whether the SCSS/TSX refactor affects any component beyond the hero/CircuitTraces. Confirm `--theme-pcb-trace`, `--theme-pcb-dot-glow`, and `--theme-nav-text-hover` are not unexpectedly overridden elsewhere.

Each agent's prompt should include:
- The diff range: `git diff master..updates` (or `git log updates ^master --oneline` for commit-level summary)
- The spec path: `docs/superpowers/specs/2026-04-19-hero-theme-recolor-design.md`
- Clear output expectation: "Return issues at severity H/M/L with file:line references. Under 400 words."

- [ ] **Step 2: Review the three reports, address any H-severity issues**

If an agent raises H-severity issues: create a new task for each, fix, commit, re-run `cd tests/visual && pytest -v` to confirm no regression, then mark complete.

M and L severity: surface to the user for a go/no-go call before fixing.

- [ ] **Step 3: Commit any fixes**

```bash
git add <files>
git commit -m "fix(hero): address <agent-name> code-review findings"
```

---

## Task 14: Final verification + user visual approval

**Files:** none modified.

- [ ] **Step 1: Run full test suite one more time**

```bash
cd tests/visual && pytest -v
```

Expected: green across all 4 themes.

- [ ] **Step 2: Run TypeScript + build**

```bash
cd frontend && npx tsc --noEmit
docker compose up --build -d frontend
```

Expected: clean.

- [ ] **Step 3: Visual walkthrough — present to user**

Navigate to each of the 4 themes in the browser:
- `http://localhost/` (base) — verify byte-identical to master HEAD
- `http://localhost/?nav=A` (steel) — verify dark graphite hero + tonal vignette
- `http://localhost/?nav=B` (schematic) — verify horizontal ruling + bright green traces
- `http://localhost/?nav=C` (pcb) — verify 24px grid + copper traces + shadow-gap under navbar

Take screenshots; present to user for final approval.

- [ ] **Step 4: Persist any non-obvious learnings back into CLAUDE.md**

If any surprising gotcha emerged during implementation, append a bullet to the "Gotchas" section. Examples: a theme where `color-mix(…30%)` landed too faint and had to be bumped to 35%; a viewport where the shadow-gap needed `z-index: 1` instead of `0`.

- [ ] **Step 5: Final commit (if CLAUDE.md touched)**

```bash
git add CLAUDE.md
git commit -m "docs: capture implementation learnings in CLAUDE.md"
```

- [ ] **Step 6: Await user approval**

Stop here. User will review visually and either approve merge to master or request changes.

---

## Notes for the implementing agent

- **Branch discipline:** All work stays on `updates`. Never commit to `master` directly.
- **Commit granularity:** One commit per Task (or one per file within a Task if atomicity helps). Never squash across task boundaries — it destroys the review trail.
- **Test discipline:** If a test fails at any verification gate, stop implementing and fix the underlying issue. Do not edit tests to match buggy implementations.
- **Filter cost:** The shared `<filter id="traceGlow">` must be applied at a single `<g className={styles.traceGroup}>` wrapper, NOT per `<path>`. Per-path application multiplies cost 140× and defeats the perf budget.
- **Base theme:** Must render byte-identically to pre-refactor state. A screenshot diff against `master` HEAD is the ground truth.
- **Framer Motion:** Not used in this work. Do not add `motion.div` wrappers.
- **No new npm packages** in `frontend/package.json`. Python test deps go in `tests/visual/pyproject.toml` only.
