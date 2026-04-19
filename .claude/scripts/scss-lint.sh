#!/usr/bin/env bash
# CLAUDE.md gotcha enforcer — non-blocking warnings on known anti-patterns
# in SCSS/TSX/TS edits. Invoked from .claude/settings.json PostToolUse hook.
# Writes warnings to stderr so they appear in Claude's tool output context.
set -euo pipefail

filepath="${1:-}"
[[ -z "$filepath" || ! -f "$filepath" ]] && exit 0

case "$filepath" in
  *.scss|*.tsx|*.ts) ;;
  *) exit 0 ;;
esac

warnings=()
add() { warnings+=("$1"); }

# Gotcha #1 — grid-template-columns: 1fr auto 1fr collapses centering when side content is fat
if grep -qE 'grid-template-columns:\s*1fr\s+auto\s+1fr' "$filepath"; then
  add "grid-template-columns: 1fr auto 1fr — '1fr' is minmax(auto, 1fr); asymmetric side content breaks the centered middle. Use position: absolute on a relative parent instead. (CLAUDE.md Gotchas)"
fi

# Gotcha #2 — filter: hue-rotate(0deg) promotes compositor layer even at 0deg (GPU waste)
if grep -qE 'filter:\s*hue-rotate\(0deg\)' "$filepath"; then
  add "filter: hue-rotate(0deg) — still promotes a compositor layer + re-rasterizes every frame. Gate behind [data-theme=\"X\"] on non-default themes, not the base selector. (CLAUDE.md Gotchas)"
fi

# Gotcha #3 — animated drop-shadow() = severe scroll lag
if grep -qE 'drop-shadow\(' "$filepath" && grep -qE 'animation|transition' "$filepath"; then
  add "drop-shadow() alongside animation/transition in same file — scroll-lag risk. Use static box-shadow. (CLAUDE.md Gotchas)"
fi

# Gotcha #4 — top: 50% + transform: translate*(-50%) = subpixel text blur
if grep -qE 'translate[XY]?\(-?50%' "$filepath" && grep -qE 'top:\s*50%' "$filepath"; then
  add "top: 50% + translate(-50%) centering — fractional-pixel positioning promotes GPU glyph re-raster at subpixel boundaries. Use top: 0; bottom: 0; display: flex; align-items: center. (CLAUDE.md Gotchas)"
fi

# Gotcha #5 — SVG filter="url(#…)" on a tree with animating children = mobile CPU raster
if grep -qE 'filter="url\(#' "$filepath" && grep -qE 'animation|stroke-dashoffset|animateMotion' "$filepath"; then
  add "SVG filter url(#...) on an animating subtree — Blink/WebKit CPU-raster every frame on mobile. Gate via @media (max-width: 768px) { .filterGroup { filter: none; } }. (CLAUDE.md Gotchas — 2026-04-19 bug)"
fi

# Gotcha #6 — absolute /api/ URL in frontend code (breaks the "one-config cutover" property)
if [[ "$filepath" == *.tsx || "$filepath" == *.ts ]]; then
  if grep -qE '(https?:)?//[^/\s"]*/api/' "$filepath"; then
    add "Absolute /api/ URL detected in frontend — use a relative path. The circuits.com cutover was a 2-file change because api calls are relative; don't regress that. (CLAUDE.md Relative API URLs)"
  fi
fi

# Gotcha #7 — early-return on !import.meta.env.DEV before hooks = Rules of Hooks violation
if [[ "$filepath" == *.tsx ]]; then
  if grep -qE 'if\s*\(!\s*import\.meta\.env\.DEV\)\s*return' "$filepath"; then
    add "Early-return on !import.meta.env.DEV inside a component — if any Hooks come after, this violates the Rules of Hooks. Gate at the call site: {import.meta.env.DEV && <Component />}. (CLAUDE.md Gotchas)"
  fi
fi

# Gotcha #8 — deprecated Sass darken/lighten
if [[ "$filepath" == *.scss ]] && grep -qE '\b(darken|lighten)\(' "$filepath"; then
  add "Deprecated Sass darken()/lighten() — use @use 'sass:color' + color.adjust() in new code. (CLAUDE.md Gotchas)"
fi

# Gotcha #9 — animating a filter property directly (mobile perf killer)
if [[ "$filepath" == *.scss ]]; then
  if grep -qE '@keyframes.*\{[^}]*filter:' "$filepath" || grep -qE 'transition:.*filter' "$filepath"; then
    add "filter property in @keyframes or transition — reinvalidates paint every frame. Prefer transform / opacity. (CLAUDE.md Gotchas)"
  fi
fi

# Gotcha #10 — buttons with line-height > 1 inside fixed-height rows
if [[ "$filepath" == *.scss ]]; then
  if grep -qE 'button\s*\{[^}]*height:\s*3[0-9]px' "$filepath" && ! grep -qE 'line-height:\s*1(;|\s|$)' "$filepath"; then
    add "button with fixed height and no explicit line-height: 1 — body's line-height: 1.6 cascades and text overflows (LOGIN pill 37px-in-36px-nav bug). Set line-height: 1 and size via padding. (CLAUDE.md Gotchas)"
  fi
fi

if (( ${#warnings[@]} > 0 )); then
  {
    echo ""
    echo "=== scss-lint: $(basename "$filepath") — $(wc -l < "$filepath") lines ==="
    for w in "${warnings[@]}"; do
      echo "  ⚠  $w"
    done
    echo ""
  } >&2
fi

exit 0
