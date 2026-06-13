"""Regression guard: admin Message relative-times use the real clock.

# Why this exists

2026-06-13: A user reported the admin /admin/messages inbox showed no real
timestamps — every message read "now" (and they all bucketed under "Today").

Root cause: `frontend/src/admin/components/messages/messageHelpers.ts` anchored
relative time to a HARDCODED demo date —
`export const NOW_REF = new Date('2026-05-07T15:00:00Z')` — which was left in
after backend Messages persistence shipped (the anchor's own comment said to
drop it and "use Date.now() directly" once persistence landed). Every real
message is created AFTER that frozen anchor, so `NOW_REF - messageTime` is
negative → `relTime()` returns "now" and `dayBucket()` returns "Today" for
everything.

Fix: compute the reference time from the real clock (`Date.now()`) at call time.

This guard fails if a hardcoded calendar-date "now" anchor is reintroduced into
the relative-time helper, so the inbox can't silently freeze again.
"""

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_HELPERS = (
    _REPO_ROOT
    / "frontend"
    / "src"
    / "admin"
    / "components"
    / "messages"
    / "messageHelpers.ts"
)

# A literal calendar date handed to `new Date(...)` — a frozen "now" anchor.
# `new Date(iso)` with a variable (the message's own timestamp) is fine and
# does NOT match; only `new Date('2026-..')` / `new Date("2026-..")` does.
_HARDCODED_DATE = re.compile(r"""new\s+Date\(\s*['"]\d{4}-\d{2}-\d{2}""")


def test_reltime_uses_real_clock_not_hardcoded_anchor():
    """The relative-time helper must reference the real clock, never a frozen
    demo date — a hardcoded anchor makes every message after it read
    'now'/'Today' (the 2026-06-13 admin-inbox bug)."""
    if not _HELPERS.exists():
        return  # frontend tree absent in this CI shape — skip silently

    text = _HELPERS.read_text(encoding="utf-8", errors="ignore")

    hardcoded = _HARDCODED_DATE.findall(text)
    assert not hardcoded, (
        f"messageHelpers.ts hardcodes a 'now' anchor ({hardcoded}). Relative "
        f"times (relTime/dayBucket) must use the real clock (Date.now()) — a "
        f"frozen anchor makes every later message read 'now'/'Today'."
    )
    assert "Date.now()" in text, (
        "messageHelpers.ts must use Date.now() as the relative-time reference "
        "(relTime/dayBucket)."
    )
