# Hero Trace Brightness — Design Spec

**Date:** 2026-04-19
**Status:** Draft — awaiting user review
**Prior art:** `2026-04-19-hero-theme-recolor-design.md` (shipped a303679)

## Context

Post-a303679 user feedback is uniform: **trace colors are not bright enough against hero backgrounds, especially on the steel theme.** The issue is visible on all 8 pages that render `<CircuitTraces />` (Home, Category, Search, Contact, Join, About, KeywordSponsor, Part) but reads worst on steel's near-black `#0e1113` background.

## Diagnosis — multiplicative dimness

Three stacked factors compound:

1. **Source color** — steel's `--theme-pcb-trace: #3a8a1a` (HSL L=32%) reads muddy against `#0e1113` bg despite adequate numeric contrast.
2. **Stroke opacity** — `frontend/src/components/shared/CircuitTraces.tsx:9`'s `S()` helper scales `strokeOpacity = Math.min(o*2.5, 1)` where `o ∈ [0.03, 0.10]` → effective 7.5–25%.
3. **No mobile glow** — `@media (max-width: 768px) { .traceGroup { filter: none }}` (landed a303679 to fix the mobile perf regression) removes the desktop glow that partially compensates.

Any single-factor fix leaves the other two dragging visibility down.

## Scope

- **In:** `--theme-pcb-trace` and `--theme-pcb-dot-glow` tokens for steel, schematic, pcb.
- **Out:** base theme (its hardcoded rgba carve-out in `CircuitTraces.module.scss:31-45` stays untouched).
- **Out:** stroke-width changes, re-enabling mobile glow, `filter: brightness()` tricks, opacity-scale multipliers (Approach B deferred).

## Approach — Approach A (token-brighten)

Single-file edit to `frontend/src/styles/_themes.scss`. The 6-token `color-mix` cascade defined in `CircuitTraces.module.scss` propagates the source-color change to all downstream tokens (`--trace-color`, `--node-color`, `--ic-body-fill` at 3%, `--ic-body-stroke` at 15%, `--ic-pad-fill` at 30%) automatically. One variable tuned, ~140 elements lifted.

### Proposed per-theme values (subject to visual verification)

| Token | Steel | Schematic | PCB |
|---|---|---|---|
| `--theme-pcb-trace` current | `#3a8a1a` (L=32%) | `#44bd13` (L=40%) | `#c49b5d` (L=57%) |
| `--theme-pcb-trace` proposed | **`#7dec45`** (L=60%) | `#5ad129` (L=49%) | `#d8b074` (L=65%) |
| `--theme-pcb-dot-glow` current | `rgba(68,189,19,0.55)` | `rgba(68,189,19,0.75)` | `rgba(196,155,93,0.40)` |
| `--theme-pcb-dot-glow` proposed | `rgba(125,236,69,0.70)` | `rgba(90,209,41,0.90)` | `rgba(216,176,116,0.55)` |

**Rationale:** steel gets the largest lift (+28 L-points) since user feedback flagged it as worst. Schematic and pcb receive modest +8–9 L-point lifts to preserve theme identity while still addressing the multiplicative-dimness issue reported across all alternate themes.

**Distinguishability check:** steel's new HSL (100°, 82%, 60%) versus schematic's new (107°, 66%, 49%) differ in hue, saturation, AND lightness. Expected to remain visually distinct. Confirm via side-by-side screenshot before merge.

## Non-goals

- Not touching `--theme-pcb-dot` (nav-accent dots — unrelated to hero visual).
- Not re-enabling mobile glow filter (perf cost documented in CLAUDE.md).
- Not changing trace stroke-widths (schematic spatial feel preserved).
- Not introducing `--trace-opacity-scale` multiplier (Approach B, deferred).

## Verification plan

1. **Visual baselines** — refresh `tests/visual/baselines/{steel,schematic,pcb}-*.png` via `chrome-devtools-mcp` `take_screenshot` at desktop viewport. Base unchanged = regression control.
2. **Distinguishability** — confirm steel vs schematic side-by-side (expect clear hue/saturation difference).
3. **Perf smoke** — `performance_start_trace` on `/?nav=A` (steel), verify no new `long-animation-frame` events during the 6s draw-circuit animation vs a303679 baseline.
4. **Mobile emulation** — emulate iPhone 14 viewport, navigate each of 4 themes, confirm traces read clearly without the glow filter.
5. **Base-theme regression** — byte-identical to a303679 (hardcoded rgba carve-out must not be perturbed).

## Future work (deferred sub-project)

### Cross-page theme continuity for hero backdrops

Currently the per-theme `.hero` `background-image` (steel gradient, schematic scanlines, pcb grid) and `background-color: var(--theme-nav-bg)` are defined **only** in `frontend/src/components/home/HeroSection.module.scss`. The other 7 pages rendering `<CircuitTraces />` (Category, Search, About, Contact, Join, KeywordSponsor, Part) lack matching themed backdrops. When a user switches themes mid-session, the theme change "disappears" on non-home pages even though traces are still rendered — creating a discontinuity in the theming experience.

**Proposed direction (to spec separately):**
- Extract per-theme backdrops into a shared `<PageBackdrop>` component OR a `_page-backdrop.scss` partial.
- Apply at a layout level (wrapper of `<AnimatePresence>` in `App.tsx`) so every non-admin page inherits.
- Simpler alternative: scope alternate-theme `body { background-color: var(--theme-nav-bg) }` so at minimum the dark backdrop stays consistent across pages.

Will be specced as its own design doc once trace-brightness lands.

## Files touched

- `frontend/src/styles/_themes.scss` — 6-value edit (3 hex, 3 rgba)
- `tests/visual/baselines/*.png` — 3 refreshed screenshots (base unchanged)
- No component code changes, no CSS module edits, no CLAUDE.md update needed.

## Rollback

Single revert on `frontend/src/styles/_themes.scss` restores prior values. Zero structural/schema/API risk.
