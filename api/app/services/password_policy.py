"""Admin password policy — the single source of truth for the four rules.

Every server-side password write (forced change, self-service change, reset
link) validates through :func:`validate_password`; the admin UI mirrors the
same four rule keys in one frontend constant so the live checklist and the
422 body can never disagree.

The policy is EXACTLY:

    length     8-24 characters, inclusive
    uppercase  at least one uppercase letter
    digit      at least one number
    symbol     at least one symbol — a character that is neither a letter nor
               a number, in ANY script (``str.isalnum()`` is False)

**uppercase** and **digit** are deliberately ASCII-anchored (``[A-Z]``,
``[0-9]``) rather than Python's unicode-aware ``str.isupper()`` /
``str.isdigit()``. The frontend mirror is JavaScript, whose ``\\d`` and
``[A-Z]`` are ASCII-only; anchoring both sides to ASCII keeps the two
validators equivalent instead of quietly diverging on, say, ``Ä``
(unicode-uppercase) or ``٣`` (unicode-digit).

**symbol** is the one rule that must NOT be ASCII-anchored. ``[^A-Za-z0-9]``
reads "non-ASCII counts as punctuation", which is false: ``é``, ``中`` and
``Ä`` are LETTERS, so a naive class let ``Passw0rdé`` pass a rule the UI
describes as "anything that is not a letter or number" — a whole rule
satisfied by adding an accent. The honest test is Unicode's own answer,
``not ch.isalnum()``: ``☂``, ``→``, ``£``, ``!`` and a space are symbols;
``é``, ``中``, ``Ä`` and ``٣`` are not. Non-ASCII characters are still fully
accepted in a password — they simply count as the letters/numbers they are.
The JS mirror of this rule is ``/[^\\p{L}\\p{N}]/u``.

Length counts Python characters (code points). The JS mirror should count
``[...password].length``, not ``password.length``, so an astral character
(emoji) counts once on both sides.
"""

import re

# Inclusive bounds. Exported so callers (route error bodies, admin help text)
# never re-hardcode the numbers.
PASSWORD_MIN_LENGTH = 8
PASSWORD_MAX_LENGTH = 24

# Ordered (key, description). The order is the display order of the admin
# rule checklist and of the keys returned by validate_password.
PASSWORD_RULES: list[tuple[str, str]] = [
    ("length", f"Between {PASSWORD_MIN_LENGTH} and {PASSWORD_MAX_LENGTH} characters"),
    ("uppercase", "At least one uppercase letter"),
    ("digit", "At least one number"),
    ("symbol", "At least one symbol (anything that is not a letter or number)"),
]

# One human sentence for API error bodies / form hints.
PASSWORD_HELP = (
    f"Password must be {PASSWORD_MIN_LENGTH}-{PASSWORD_MAX_LENGTH} characters and include "
    "at least one uppercase letter, one number, and one symbol."
)

_UPPERCASE_RE = re.compile(r"[A-Z]")
_DIGIT_RE = re.compile(r"[0-9]")


def _has_symbol(value: str) -> bool:
    """True when at least one character is neither a letter nor a number.

    Not a regex: the rule is a Unicode-category question, and ``[^A-Za-z0-9]``
    answers a different one (see the module docstring — it counts ``é`` as a
    symbol). ``str.isalnum()`` is exactly "letter or number in some script",
    so its negation is exactly "symbol".
    """
    return any(not ch.isalnum() for ch in value)


def validate_password(password: str) -> list[str]:
    """Return the keys of the rules the password FAILS, in PASSWORD_RULES order.

    An empty list means the password is valid. A password may fail several
    rules at once — every unmet key is reported so the UI can tick the whole
    checklist from one response.
    """
    # Defensive: a missing/None body field must fail loudly-but-safely (all
    # four keys), never raise a TypeError out of a route handler.
    value = password or ""

    unmet: list[str] = []
    if not (PASSWORD_MIN_LENGTH <= len(value) <= PASSWORD_MAX_LENGTH):
        unmet.append("length")
    if not _UPPERCASE_RE.search(value):
        unmet.append("uppercase")
    if not _DIGIT_RE.search(value):
        unmet.append("digit")
    if not _has_symbol(value):
        unmet.append("symbol")
    return unmet
