"""Regression guard: the login IsoBoard must stay VISIBLE on mobile.

History: the v13 design hid the 3D board on phones; 2026-06-13 it was surfaced
above the sign-in form, scaled down. 2026-06-14: the live ~210-layer CSS-3D board
OOM-crashed iOS Safari on pinch-zoom at DPR 3 (and flickered once animating), so on
mobile it is now rendered as a single-element vector board (`.iso-svg`, IsoBoardSvg)
in place of the live scene — one SVG layer that keeps the full animation without the
crash or flicker. This guards that the board stays VISIBLE on mobile (the band
container isn't hidden and the SVG is shown) rather than disappearing entirely.
"""

import re
from pathlib import Path

MODULE = (
    Path(__file__).resolve().parents[2]
    / "frontend/src/admin/pages/login/LoginPage.module.scss"
)


def _rule_bodies(selector):
    return re.findall(re.escape(selector) + r"\s*\{([^}]*)\}", MODULE.read_text(), re.S)


def test_iso_stage_not_hidden_on_mobile():
    # .iso-stage is the band container that hosts the mobile vector board; it must
    # never be display:none or the board vanishes on phones.
    assert not re.search(r"\.iso-stage\s*\{[^}]*display:\s*none", MODULE.read_text()), (
        ".iso-stage is set to display:none — the IsoBoard band must stay visible "
        "on mobile (it now hosts the vector board)."
    )


def test_isoboard_shown_as_svg_on_mobile():
    # On mobile the live 3D scene is hidden (zoom-OOM + flicker) and the board is
    # rendered as the .iso-svg vector element — it must be display:block (the <=900
    # rule) so the board stays visible after the live scene is hidden.
    bodies = _rule_bodies(".iso-svg")
    assert any(re.search(r"display:\s*block", b) for b in bodies), (
        ".iso-svg (the mobile vector board) must be display:block on mobile so the "
        "board stays visible after the live 3D scene is hidden."
    )
