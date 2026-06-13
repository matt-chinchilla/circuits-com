"""Regression guard: subcategory chips stay legible on mobile.

# Why this exists

2026-06-13: A user reported the subcategory pill-bar chips were
"borderline-impossible to view" on mobile past the midway point ("hard to see
past Battery Management ICs").

Root cause: the chips are white-text-on-transparent, styled for the dark hero
backdrop — but `BackdropLayer` is a FIXED 420px tall. On a phone the long
subcategory names wrap each chip onto its own row, so the chip stack overflows
the backdrop and the lower chips land on the light page surface (#eef1f5), where
white text is invisible.

Fix: at `<=$bp-mobile` (768px), fill INACTIVE chips with an opaque dark pill
(`rgba($executive-blue, .92)`) + white text so they read on BOTH the dark hero
and the light surface — in BOTH chip systems (the subpage `SubcategoryChips`
board and the parent page's inline `.chip`).

This test fails if either dark-fill is removed, so the chips can't silently
regress to transparent-on-light. If you intentionally restyle the chips (e.g. a
different dark token), update the expected fill below — that's a conscious
decision, not a silent drop.
"""

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CATEGORY_DIR = _REPO_ROOT / "frontend" / "src" / "public" / "pages" / "category"

# (stylesheet, inactive-chip selector) — each inactive-chip selector MUST set a
# non-transparent (dark) background in its mobile rule so the white chip text
# survives a wrap onto the light page surface below the fixed hero backdrop.
_CHIP_FILES = [
    (_CATEGORY_DIR / "components" / "SubcategoryChips.module.scss", r"\.chip:not\(\.active\)"),
    (_CATEGORY_DIR / "CategoryPage.module.scss", r"\.chip:not\(\.chipActive\)"),
]


def _dark_fill_pattern(selector: str) -> re.Pattern:
    # selector { ... background: rgba($executive-blue ... }
    # `[^}]*?` crosses a nested @media block + newlines but stops at the rule's
    # first close brace, so the background must belong to this selector.
    return re.compile(selector + r"\s*\{[^}]*?background:\s*rgba\(\s*\$executive-blue")


def test_mobile_chips_have_dark_fill():
    """Inactive subcategory chips must get an opaque dark fill on mobile so the
    white text stays legible where the chip stack wraps past the 420px hero
    backdrop onto the light page surface (the 2026-06-13 legibility bug)."""
    if not _CATEGORY_DIR.exists():
        return  # frontend tree absent in this CI shape — skip silently

    failures: list[str] = []
    for path, selector in _CHIP_FILES:
        if not path.exists():
            failures.append(f"{path} (file missing)")
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if not _dark_fill_pattern(selector).search(text):
            rel = path.relative_to(_REPO_ROOT)
            failures.append(
                f"{rel}: `{selector}` has no `background: rgba($executive-blue ...)` "
                f"mobile fill — white-on-transparent chips go invisible where the stack "
                f"wraps onto the light page surface."
            )

    assert not failures, "Mobile chip legibility regression:\n" + "\n".join(failures)
