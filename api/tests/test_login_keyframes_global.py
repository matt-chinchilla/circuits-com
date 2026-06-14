"""Regression guard: the admin-login @keyframes must live in a PLAIN (global)
.scss, never inside LoginPage.module.scss.

Bug (2026-06-13): CSS Modules hashes `@keyframes` *names* even inside a
`:global { … }` block (`authIsoFloat` → `_authIsoFloat_dynhf_1`) while leaving
the `animation:` shorthand reference literal (`authIsoFloat`). The name and the
reference then don't match, so EVERY login animation silently dies (PCB hover,
electron flow, spinner, screen-in, …) — and a screenshot can't catch zero motion.
Fix: keyframes go in LoginPage.keyframes.scss (plain global scss, names NOT
hashed) imported as a side-effect; the module keeps only the `animation:` refs.
"""

import re
from pathlib import Path

LOGIN_DIR = Path(__file__).resolve().parents[2] / "frontend/src/admin/pages/login"
MODULE_SCSS = LOGIN_DIR / "LoginPage.module.scss"
KEYFRAMES_SCSS = LOGIN_DIR / "LoginPage.keyframes.scss"


def test_module_scss_defines_no_keyframes():
    """@keyframes in the CSS module get name-hashed but refs stay literal."""
    src = MODULE_SCSS.read_text()
    # Match actual `@keyframes name {` declarations, not the word in a comment.
    assert not re.search(r"@keyframes\s+[\w-]+\s*\{", src), (
        "LoginPage.module.scss must NOT define @keyframes — CSS Modules hashes "
        "their names (e.g. authIsoFloat → _authIsoFloat_dynhf_1) while the "
        "`animation:` refs stay literal, so the animations never run. Move them "
        "to LoginPage.keyframes.scss (plain global scss)."
    )


def test_global_keyframes_file_exists():
    assert KEYFRAMES_SCSS.is_file(), (
        "LoginPage.keyframes.scss (plain global scss holding the auth* keyframes) "
        "is missing — it must be imported as a side-effect by AuthShell."
    )


def test_every_referenced_keyframe_is_defined_globally():
    """Each auth* animation-name used in the module must have a global keyframe."""
    module_src = MODULE_SCSS.read_text()
    kf_src = KEYFRAMES_SCSS.read_text()
    defined = set(re.findall(r"@keyframes\s+([A-Za-z][\w-]*)", kf_src))
    # First token after `animation:` or `animation-name:` is the name.
    referenced = set(re.findall(r"animation(?:-name)?\s*:\s*([A-Za-z][\w-]*)", module_src))
    auth_refs = {r for r in referenced if r.startswith("auth")}
    assert auth_refs, "expected the module to reference auth* keyframes"
    missing = auth_refs - defined
    assert not missing, f"animation refs with no global @keyframes definition: {sorted(missing)}"


def test_keyframes_imported_as_side_effect():
    """AuthShell must import the global keyframes scss so they ship with the page."""
    shell = (LOGIN_DIR / "components/AuthShell.tsx").read_text()
    assert "LoginPage.keyframes.scss" in shell, (
        "AuthShell.tsx must `import '../LoginPage.keyframes.scss'` (side-effect) "
        "so the global keyframes are bundled wherever the auth shell renders."
    )
