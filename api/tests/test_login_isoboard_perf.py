"""Regression guard for the IsoBoard rendering optimizations (2026-06-13).

Flicker root cause: the trace surface (`.surface`, translateZ 16) was COPLANAR with
the board slab's top face (c-board, h=16) → z-fighting, visible on mobile (low GPU
depth precision). Compute waste: 170 cube faces rendered both sides (no backface
cull) + the blurred `.iso-shadow` re-blurred every frame (animated). These guards
lock in the fixes so the flicker/cost can't silently return.

Mobile follow-up: the live ~210-layer preserve-3d board could not survive the
iPhone's DPR 3 — pinch-zoom re-rasterized every layer and OOM-crashed iOS Safari,
and the per-frame recomposite flickered once the animation ran; the board's fixed
460px layout box also overflowed the viewport. Fixes guarded below: the mobile
column is `minmax(0, 1fr)` (page-fit), and on mobile the live 3D scene is HIDDEN and
replaced by a single-element vector board (`.iso-svg`, IsoBoardSvg) — one SVG layer
that re-rasters as one crisp vector element on zoom (no OOM) with no preserve-3d
subtree to flicker, while keeping the full animation (float + flowing electrons).
Desktop keeps the full live CSS-3D board.
"""

import re
from pathlib import Path

LOGIN = Path(__file__).resolve().parents[2] / "frontend/src/admin/pages/login"
SCSS = LOGIN / "LoginPage.module.scss"
ISOBOARD = LOGIN / "components/IsoBoard.tsx"
KEYFRAMES = LOGIN / "LoginPage.keyframes.scss"
GEOMETRY = LOGIN / "components/isoGeometry.ts"  # shared geometry/projection source


def _rule_blocks(selector):
    # All CSS bodies for a selector, in source order (base rule + any @media
    # overrides). The matched bodies are brace-flat (no nested rules), so the
    # [^}]* capture is exact.
    return re.findall(re.escape(selector) + r"\s*\{([^}]*)\}", SCSS.read_text(), re.S)


def _surface_translate_z():
    m = re.search(r"\.surface\s*\{[^}]*?translateZ\((\d+)px\)", SCSS.read_text(), re.S)
    return int(m.group(1)) if m else None


def _board_height():
    # BOARD_H now lives in the shared geometry module (the .c-board Cube uses it).
    m = re.search(r"BOARD_H\s*=\s*(\d+)", GEOMETRY.read_text())
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
    # Trace thickness comes from ONE shared constant (TW, in isoGeometry) so the
    # horizontal + vertical segments can't differ AND the desktop + mobile boards
    # stay in sync.
    assert re.search(r"const TW\s*=\s*\d+", GEOMETRY.read_text()), (
        "trace thickness must come from a shared `const TW` in isoGeometry.ts."
    )
    src = ISOBOARD.read_text()
    assert "height: TW" in src and "width: TW" in src, (
        "both the horizontal (height: TW) and vertical (width: TW) desktop trace "
        "segments must use the shared TW thickness."
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


def test_mobile_uses_vector_board():
    # At the iPhone's DPR 3 the live ~210-layer 3D board re-rasterizes on pinch-zoom
    # and OOM-crashes iOS (and the per-frame preserve-3d recomposite flickered once
    # the animation ran). On mobile the live scene MUST be hidden and the single
    # vector board (.iso-svg) shown — one layer that can neither crash nor flicker.
    text = SCSS.read_text()
    assert re.search(r"\.iso-glow,\s*\.iso-scene\s*\{[^}]*display:\s*none", text, re.S), (
        "mobile must hide the live .iso-glow + .iso-scene (display:none) so the "
        "~210-layer 3D board is not rendered on phones (zoom-OOM + flicker)."
    )
    svg = _rule_blocks(".iso-svg")
    assert any(re.search(r"display:\s*block", b) for b in svg), (
        "the mobile vector board (.iso-svg) must be display:block on mobile."
    )


def test_vector_board_component_present():
    assert (LOGIN / "components/IsoBoardSvg.tsx").exists(), "IsoBoardSvg component is missing."
    assert (LOGIN / "components/isoGeometry.ts").exists(), "shared isoGeometry module is missing."
    assert "IsoBoardSvg" in ISOBOARD.read_text(), "IsoBoard must render <IsoBoardSvg /> for mobile."
    # the dead static-image path must be gone (one mobile board, not two)
    assert "iso-board-mobile.webp" not in ISOBOARD.read_text(), "legacy .webp image path should be removed."


def test_svg_float_keyframe_is_2d():
    # The SVG board floats with a 2-D translateY (cheap, one layer) — never a
    # translateZ, which would imply a 3-D context (the very thing being avoided).
    # `^\}` (re.M) matches the keyframe's column-0 close regardless of blank lines.
    m = re.search(r"@keyframes isoSvgFloat\s*\{(.*?)^\}", KEYFRAMES.read_text(), re.S | re.M)
    assert m, "isoSvgFloat keyframe must exist in LoginPage.keyframes.scss"
    body = m.group(1)
    assert "translateY" in body, "isoSvgFloat must animate translateY (flat 2D float)."
    assert not re.search(r"translateZ\s*\(", body), "isoSvgFloat must NOT use translateZ()."
