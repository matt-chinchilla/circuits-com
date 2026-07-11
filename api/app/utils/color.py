"""Hex-color validation for sponsor brand colors.

Write-boundary defense: these values are stored and later rendered into
inline CSS custom properties on the public site, so only exact #RRGGBB
values are accepted (CSS-injection guard; mirrors utils/image_url.py).
"""

import re

_HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")


def validate_optional_hex_color(value: str | None) -> str | None:
    if value is None:
        return value
    if _HEX_COLOR.fullmatch(value):
        return value
    raise ValueError("must be a hex color like #1d3a8f")
