"""Regression guard for the IsoBoard rendering optimizations (2026-06-13).

Flicker root cause: the trace surface (`.surface`, translateZ 16) was COPLANAR with
the board slab's top face (c-board, h=16) → z-fighting, visible on mobile (low GPU
depth precision). Compute waste: 170 cube faces rendered both sides (no backface
cull) + the blurred `.iso-shadow` re-blurred every frame (animated). These guards
lock in the fixes so the flicker/cost can't silently return.

Mobile follow-up (same date): the real iOS flicker was the per-frame re-composite
of the ~210-layer preserve-3d scene driven by the translateZ float on the
preserve-3d `.iso-lift`, and the board's fixed 460px layout box overflowed the
phone viewport. Fixes guarded below: the mobile column is `minmax(0, 1fr)` (caps
the page width; .brand's overflow:clip contains the board), and the float moves to
a flat 2D translateY on `.iso-stage` while `.iso-lift` is silenced (no per-frame
3D recomposite).
"""

import re
from pathlib import Path

LOGIN = Path(__file__).resolve().parents[2] / "frontend/src/admin/pages/login"
SCSS = LOGIN / "LoginPage.module.scss"
ISOBOARD = LOGIN / "components/IsoBoard.tsx"
KEYFRAMES = LOGIN / "LoginPage.keyframes.scss"


def _rule_blocks(selector):
    # All CSS bodies for a selector, in source order (base rule + any @media
    # overrides). The matched bodies are brace-flat (no nested rules), so the
    # [^}]* capture is exact.
    return re.findall(re.escape(selector) + r"\s*\{([^}]*)\}", SCSS.read_text(), re.S)


def _surface_translate_z():
    m = re.search(r"\.surface\s*\{[^}]*?translateZ\((\d+)px\)", SCSS.read_text(), re.S)
    return int(m.group(1)) if m else None


def _board_height():
    m = re.search(r'h=\{(\d+)\}[^/>]*cls="c-board"', ISOBOARD.read_text())
    return int(m.group(1)) if m else None


def test_surface_not_coplanar_with_board_top():
    sz, bh = _surface_translate_z(), _board_height()
    assert sz is not None, "could not find .surface translateZ"
    assert bh is not None, "could not find c-board height"
    assert sz != bh, (
        f"trace surface translateZ ({sz}px) is coplanar with the board top "
        f"(h={bh}px) → z-fighting flicker. Lift the surface above the board face."
    )


def test_flat_traces_share_thickness_constant():
    # Horizontal + vertical trace segments must draw from ONE thickness constant
    # so they can never render different thicknesses.
    src = ISOBOARD.read_text()
    assert re.search(r"const TW\s*=\s*\d+", src), (
        "Trace thickness must come from a shared `const TW` so the horizontal and "
        "vertical segments stay equal."
    )
    assert "height: TW" in src and "width: TW" in src, (
        "both the horizontal (height: TW) and vertical (width: TW) trace segments "
        "must use the shared TW thickness."
    )


def test_no_blur_filters_in_scene():
    # The .iso-glow/.iso-shadow/.chip-cast filter:blur() layers were flatten-
    # layers that re-interleave/re-raster in the preserve-3d scene every frame on
    # iOS (flicker). Replaced with pre-blurred radial-gradients — none should
    # remain (matches CLAUDE.md's "pre-baked gradient over blur" gotcha).
    # Match an actual `filter: blur(...)` DECLARATION (line-start), not the words
    # in a `//` comment.
    assert not re.search(r"^\s*filter:\s*blur\(", SCSS.read_text(), re.M), (
        "filter: blur() re-rasters/re-composites inside the 3D scene on iOS. Use "
        "a pre-blurred radial-gradient instead."
    )


def test_iso_shadow_static():
    m = re.search(r"\.iso-shadow\s*\{([^}]*)\}", SCSS.read_text(), re.S)
    assert m, "no .iso-shadow rule found"
    assert "animation" not in m.group(1), ".iso-shadow must stay static (no per-frame work)."


def test_iso_stage_has_no_forced_layer():
    # REVERSE of the prior (wrong) guard: will-change/translateZ(0) on .iso-stage
    # pins a GPU layer that OOM-crashes iOS Safari at DPR 3 (renderer reload loop).
    # The base .iso-stage must NOT force a compositing layer.
    m = re.search(r"\.iso-stage\s*\{([^}]*)\}", SCSS.read_text(), re.S)
    assert m, "no .iso-stage rule found"
    body = m.group(1)
    # Match actual DECLARATIONS (line-start), not the words in the `//` NOTE.
    assert not re.search(r"^\s*will-change\s*:", body, re.M), (
        ".iso-stage must NOT declare will-change — it pins a GPU layer that "
        "OOM-crashes iOS Safari at DPR 3."
    )
    assert not re.search(r"^\s*transform\s*:\s*translateZ\(0\)", body, re.M), (
        ".iso-stage must NOT declare transform: translateZ(0) — same OOM risk."
    )


def test_mobile_grid_column_capped():
    # The board's fixed 460px layout box would inflate a bare `1fr` column (=
    # minmax(auto, 1fr)) past the phone width, rendering the whole page wider than
    # the viewport ("doesn't fit"). The mobile column MUST be minmax(0, 1fr) so it
    # can't grow past the viewport; .brand's overflow:clip then contains the board.
    # (A clip on the .iso-stage perspective container is deliberately NOT used — it
    # can crop the chip's +Z projection on iOS. See LoginPage.module.scss.)
    blocks = _rule_blocks(".auth")
    assert len(blocks) >= 2, "expected a base + @media(max-width:900px) .auth rule"
    mobile = blocks[1]
    assert re.search(r"grid-template-columns:\s*minmax\(\s*0", mobile), (
        "mobile .auth must use `grid-template-columns: minmax(0, 1fr)` (NOT bare "
        "1fr = minmax(auto, 1fr)) so the board's 460px layout box can't push the "
        "page wider than the mobile viewport (the 'page doesn't fit' bug)."
    )


def test_mobile_float_moved_off_preserve3d():
    # The iOS flicker is the per-frame re-composite of the ~210-layer preserve-3d
    # scene, driven by the translateZ float on the preserve-3d .iso-lift. On mobile
    # that float must move to the FLAT .iso-stage (a 2D translateY shifts the
    # composited board as one layer, no per-frame 3D recomposite).
    lift = _rule_blocks(".iso-lift")
    assert len(lift) >= 2, "expected a base + mobile .iso-lift rule"
    assert re.search(r"animation:\s*none", lift[1]), (
        "mobile .iso-lift must set `animation: none` — the float moves to the flat "
        ".iso-stage so the preserve-3d subtree stops re-compositing every frame."
    )
    stage = _rule_blocks(".iso-stage")
    assert len(stage) >= 2, "expected a base + mobile .iso-stage rule"
    assert "authIsoFloatFlat" in stage[1], (
        "mobile .iso-stage must run the flat float `authIsoFloatFlat`."
    )


def test_flat_float_keyframe_is_2d():
    # authIsoFloatFlat must animate translateY (a flat 2D move on the perspective
    # container), NEVER translateZ (that on a preserve-3d node is the very thing
    # that re-composites the scene every frame).
    # `^\}` (re.M) matches the keyframe's column-0 closing brace regardless of a
    # blank line before it; the indented step braces (`  }`) don't match.
    m = re.search(r"@keyframes authIsoFloatFlat\s*\{(.*?)^\}", KEYFRAMES.read_text(), re.S | re.M)
    assert m, "authIsoFloatFlat keyframe must exist in LoginPage.keyframes.scss"
    body = m.group(1)
    assert "translateY" in body, "authIsoFloatFlat must animate translateY (flat 2D float)."
    assert not re.search(r"translateZ\s*\(", body), (
        "authIsoFloatFlat must NOT use translateZ() — a Z move re-composites the 3D "
        "scene per frame (defeats the flat-layer fix)."
    )
