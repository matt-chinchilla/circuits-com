"""Regression guard: no `type="url"` on admin form text inputs.

# Why this exists

2026-05-24: A user reported "I cannot create a new supplier." Browser repro
showed click → no submit event → no fetch → no toast → no console error.

Root cause: `<input type="url">` on the Supplier form's Website field. HTML5
constraint validation rejects bare-domain strings ("example.com") because
they have no scheme. The browser refuses to fire `submit` and emits no
user-visible feedback unless `:invalid` is styled (we don't style it). The
React `onSubmit` handler never runs. Three different user complaints
("can't create supplier", "https:// should auto-appear", "phone won't
format") all collapsed to this one trap.

Fix: downgrade the input to `type="text"` and prepend the scheme in JS on
blur/submit (UX retained, gatekeeper removed).

This test makes the trap permanently unattractive: any future
`<input type="url"...>` inside `frontend/src/admin/pages/**/form/**/*.tsx`
fails the suite with a message pointing at the recurrence.
"""

import re
from pathlib import Path

# JSX wraps attributes per-line, so we can't rely on `<input` + `type="url"`
# being on the same line. Match the attribute by itself — admin TSX
# consistently double-quotes JSX attributes, so this won't catch anything
# else (CSS uses bare keywords, not quoted strings).
_TYPE_URL_PATTERN = re.compile(r"""\btype\s*=\s*["']url["']""", re.IGNORECASE)

# Scan both admin and public TSX trees. The original repro was on the
# admin Supplier form, but the same trap lives anywhere a user types into
# a URL-shaped field (Join form Website, Contact form, etc). Expanding
# the guard prevents the next dev from copy-pasting the broken pattern
# into a new form somewhere else in the tree.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_FORM_ROOTS = (
    _REPO_ROOT / "frontend" / "src" / "admin",
    _REPO_ROOT / "frontend" / "src" / "public",
)


def test_no_type_url_attribute_on_form_inputs():
    """Any `<input type="url">` inside frontend/src/{admin,public}/**/*.tsx
    is a silent submit-killer. Use `type="text"` (with `inputMode="url"`
    for mobile keyboards) and prepend the scheme in JS.
    """
    offenders: list[str] = []
    for root in _FORM_ROOTS:
        if not root.exists():
            # Frontend tree may be absent in some CI shapes — skip silently.
            continue
        for tsx in root.rglob("*.tsx"):
            text = tsx.read_text(encoding="utf-8", errors="ignore")
            for line_no, line in enumerate(text.splitlines(), start=1):
                if _TYPE_URL_PATTERN.search(line):
                    rel = tsx.relative_to(_REPO_ROOT)
                    offenders.append(f"{rel}:{line_no}  {line.strip()[:120]}")

    assert not offenders, (
        "Found `<input type=\"url\">` on form inputs.\n"
        "This silently blocks form submission when users enter bare-domain "
        "strings (e.g. \"example.com\"). Use `type=\"text\"` (with "
        "`inputMode=\"url\"` for mobile keyboards) and prepend the scheme "
        "on blur/submit instead.\n\n"
        + "\n".join(offenders)
    )
