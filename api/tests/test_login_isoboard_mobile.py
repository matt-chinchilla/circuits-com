"""Regression guard: the login IsoBoard must stay VISIBLE on mobile.

2026-06-13 change: the v13 design hid the 3D IsoBoard on phones
(`.iso-stage { display: none }` at <=900px). Per user request it now surfaces
above the sign-in form on mobile, scaled down to fit. This guards against the
board being hidden again and ensures a mobile-specific scale override exists.
"""

import re
from pathlib import Path

MODULE = (
    Path(__file__).resolve().parents[2]
    / "frontend/src/admin/pages/login/LoginPage.module.scss"
)


def test_isoboard_not_hidden_anywhere():
    src = MODULE.read_text()
    # The only place .iso-stage was ever `display: none` was the mobile hide.
    assert not re.search(r"\.iso-stage\s*\{[^}]*display:\s*none", src), (
        ".iso-stage is set to display:none — the IsoBoard must stay visible on "
        "mobile (surfaced above the sign-in form)."
    )


def test_isoboard_has_mobile_scale_override():
    src = MODULE.read_text()
    # base .iso-scene scale(0.84) + at least one smaller mobile scale → the board
    # is sized down to fit phone widths rather than overflowing.
    scales = re.findall(r"\.iso-scene\s*\{[^}]*scale\(([0-9.]+)\)", src)
    assert len(scales) >= 2, (
        "expected a mobile scale override on .iso-scene in addition to the base "
        f"desktop scale (found scales: {scales})"
    )
    assert any(float(s) < 0.84 for s in scales), (
        f"expected a mobile .iso-scene scale smaller than the 0.84 base (got {scales})"
    )
