"""Regression guard for the IsoBoard rendering optimizations (2026-06-13).

Flicker root cause: the trace surface (`.surface`, translateZ 16) was COPLANAR with
the board slab's top face (c-board, h=16) → z-fighting, visible on mobile (low GPU
depth precision). Compute waste: 170 cube faces rendered both sides (no backface
cull) + the blurred `.iso-shadow` re-blurred every frame (animated). These guards
lock in the fixes so the flicker/cost can't silently return.
"""

import re
from pathlib import Path

LOGIN = Path(__file__).resolve().parents[2] / "frontend/src/admin/pages/login"
SCSS = LOGIN / "LoginPage.module.scss"
ISOBOARD = LOGIN / "components/IsoBoard.tsx"


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


def test_cube_faces_cull_backface():
    assert re.search(r"\.cf\s*\{[^}]*backface-visibility:\s*hidden", SCSS.read_text(), re.S), (
        ".cf must set backface-visibility: hidden — halves rendered faces and "
        "stops back faces flickering through the 3D scene."
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


def test_blurred_shadow_not_animated():
    m = re.search(r"\.iso-shadow\s*\{([^}]*)\}", SCSS.read_text(), re.S)
    assert m, "no .iso-shadow rule found"
    body = m.group(1)
    assert "blur(" in body, ".iso-shadow should keep its static blur"
    assert "animation" not in body, (
        ".iso-shadow is blurred; animating it re-rasterizes the blur every frame "
        "(mobile lag). Keep the shadow static."
    )
