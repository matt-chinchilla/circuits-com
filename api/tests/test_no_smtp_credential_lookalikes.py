"""Regression test: no SMTP-credential-shaped triplets in test fixtures.

GitGuardian flagged the repo on 2026-05-08 04:15 UTC because
test_email_service.py:39-42 paired a real-looking SMTP host with a
real-looking email username and a string named SMTP_PASSWORD adjacently.
None of those values were real credentials — but secret scanners can't
tell the difference, and the alert noise is its own cost.

This test prevents the same pattern from reappearing. Test fixtures must
either use RFC 6761 reserved TLDs (.invalid / .test / .example) for hosts
and emails, OR they must avoid pairing a real-looking host with a
real-looking username and a SMTP_PASSWORD assignment in the same test.
"""

import re
from pathlib import Path

# Heuristic: a "real-looking" SMTP host has at least one dot AND ends in
# a real-world TLD (.com / .net / .org / etc.) — i.e., NOT a reserved one.
_REAL_HOST_PATTERN = re.compile(
    r"SMTP_HOST.*?[\"']([^\"']*\.(?:com|net|org|io|co|us|eu))[\"']",
    re.IGNORECASE,
)

# Reserved TLDs that secret scanners universally ignore.
_RESERVED_TLDS = (".invalid", ".test", ".example", ".localhost")


def _is_reserved_value(s: str) -> bool:
    return any(s.endswith(tld) for tld in _RESERVED_TLDS)


def test_no_smtp_credential_triplet_in_test_fixtures():
    """Scan tests/ for any file that pairs a real-looking SMTP host with a
    SMTP_PASSWORD assignment. Such a triplet trips GitGuardian's
    SMTP-credential detector even when the password is an obvious test
    placeholder. Use .invalid / .test TLDs instead.
    """
    tests_dir = Path(__file__).parent
    offenders: list[str] = []

    for py_file in tests_dir.rglob("*.py"):
        if py_file.name == Path(__file__).name:
            continue  # don't flag this file's own pattern strings
        text = py_file.read_text()
        if "SMTP_PASSWORD" not in text:
            continue
        for match in _REAL_HOST_PATTERN.finditer(text):
            host = match.group(1)
            if not _is_reserved_value(host):
                offenders.append(f"{py_file.name}: SMTP_HOST={host!r}")

    assert not offenders, (
        "Test fixture pairs a real-looking SMTP host with SMTP_PASSWORD — "
        "GitGuardian will flag this as a credential leak. Use a reserved "
        "TLD (.invalid / .test / .example) for the host so secret "
        f"scanners ignore it.\n\nOffenders:\n  " + "\n  ".join(offenders)
    )
