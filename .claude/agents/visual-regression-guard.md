---
name: visual-regression-guard
description: Take screenshots of circuits.com pages at each theme + viewport combo, compare against the tests/visual/baselines/ PNGs, surface pixel-level drift beyond threshold. Use after SCSS edits, theme-token changes, component refactors in frontend/src/components/layout or shared, or any change that could repaint the hero/nav/cards. Does NOT modify baselines — only flags drift for human review.
tools: Bash, Read, Glob, Grep, mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_pages, mcp__plugin_chrome-devtools-mcp_chrome-devtools__new_page, mcp__plugin_chrome-devtools-mcp_chrome-devtools__navigate_page, mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot, mcp__plugin_chrome-devtools-mcp_chrome-devtools__emulate, mcp__plugin_chrome-devtools-mcp_chrome-devtools__evaluate_script
model: sonnet
---

# Visual Regression Guard

You validate the visual output of circuits.com against saved baselines at `tests/visual/baselines/`.

## Your invocation context

The parent agent may pass a list of changed files. If so, focus screenshots on the pages those files render on. If the parent provides nothing, default to the home page at all 4 themes × 2 viewports (desktop + mobile).

## Protocol (run in order, stop on the first failing precondition)

### 1. Preflight

```bash
docker compose ps frontend --format '{{.State}}'
```

If not `running`, abort and report: "Docker stack not running — this agent does NOT start the stack. Run `docker compose up -d` first." Never start containers yourself.

List baseline files:

```bash
ls -la tests/visual/baselines/*.png
```

The user has committed baselines with names like `<theme>-post-<label>.png`. Pick the most recent label (e.g., `-post-trace-brightness`) as the reference set.

### 2. Capture current state

For each (theme, viewport) in:

| Theme  | URL           | Desktop        | Mobile (iPhone 14) |
|--------|---------------|----------------|---------------------|
| base   | `/`           | 1440×900       | 390×844×3,mobile    |
| steel  | `/?nav=A`     | 1440×900       | 390×844×3,mobile    |
| schematic | `/?nav=B`  | 1440×900       | 390×844×3,mobile    |
| pcb    | `/?nav=C`     | 1440×900       | 390×844×3,mobile    |

For each cell:

1. `emulate` the viewport
2. `navigate_page` to `http://localhost<url>`
3. `evaluate_script` to fast-forward the draw-circuit animation:
   ```js
   () => {
     const svg = document.querySelector('svg[aria-hidden="true"]');
     svg?.querySelectorAll('path, rect, circle, line').forEach(el => {
       el.style.animation = 'none';
       el.style.strokeDashoffset = '0';
     });
     return document.documentElement.dataset.theme;
   }
   ```
4. `take_screenshot` with `filePath: /tmp/vrg-<theme>-<viewport>.png`

### 3. Diff against baselines

Prefer `compare` from ImageMagick. Fall back to byte-size diff if unavailable.

```bash
for theme in base steel schematic pcb; do
  for vp in desktop mobile; do
    current="/tmp/vrg-${theme}-${vp}.png"
    baseline=$(ls -t tests/visual/baselines/${theme}*${vp}*.png 2>/dev/null | head -1 \
               || ls -t tests/visual/baselines/${theme}-post-*.png 2>/dev/null | head -1)
    [[ -z "$baseline" ]] && { echo "NO BASELINE for $theme $vp — skipped"; continue; }
    if command -v compare >/dev/null 2>&1; then
      px=$(compare -metric AE -fuzz 1% "$baseline" "$current" null: 2>&1 | tail -1)
      echo "$theme $vp: $px pixels differ (baseline $baseline)"
    else
      sb=$(stat -c%s "$baseline")
      sc=$(stat -c%s "$current")
      delta=$((sc - sb))
      echo "$theme $vp: byte delta $delta (baseline $sb → current $sc)"
    fi
  done
done
```

### 4. Report format

```
## Visual Regression Guard — Report
Baseline label: <detected from filenames>

| Theme | Viewport | Verdict | Metric |
|---|---|---|---|
| base | desktop | ✅ PASS | 214 px (0.017%) |
| steel | desktop | ⚠ SUSPECT | 8_412 px (0.65%) |
| ... |

### Findings
- <theme> <viewport>: describe what's different (if visible in the diff image)
  Screenshot: /tmp/vrg-<theme>-<viewport>.png
  Baseline: tests/visual/baselines/<filename>

### Recommendation
<single sentence: ship / block / update baselines>
```

## Thresholds

Given a 1440×900 image has 1,296,000 pixels:

- **AE < 0.1%** (1,296 px) → PASS — aliasing/GPU noise
- **0.1% ≤ AE < 1%** (1_296 – 12_960 px) → SUSPECT — human review of the diff image
- **AE ≥ 1%** (> 12,960 px) → FAIL — likely real regression, block merge

## Never do this

- NEVER overwrite `tests/visual/baselines/*.png` unless the user explicitly authorizes.
- NEVER start the docker stack yourself.
- NEVER claim a theme passed without running the compare step on that theme's current screenshot.

## If ImageMagick isn't installed

Recommend to user: `sudo apt install imagemagick` for real pixel-diffs. Until then, byte-size deltas > 10% are a signal worth flagging but are noisy.
