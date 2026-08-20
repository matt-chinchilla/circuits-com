"""Manufacturer-name canonicalization — the SINGLE home (synthesis R3 rules).

Imported by seed_manufacturers, seed_leads, and the part_feed importer. The
canon key is the auto-merge boundary: equality here merges records, nothing
else does. Change a rule and the merge behavior changes — treat edits as
design events (the contract pairs live in test_manufacturer_canon.py).
"""

from __future__ import annotations

import re
import unicodedata
from urllib.parse import urlparse

# Trailing legal suffixes, folded repeatedly ("Foo Co., Ltd." -> "foo").
# usa / us / na are DELIBERATELY absent: "Microchip USA" is a different,
# independent company from Microchip Technology (the call list says so).
_LEGAL_SUFFIXES = frozenset(
    {
        "inc", "incorporated", "corp", "corporation", "co", "company",
        "ltd", "limited", "llc", "plc", "gmbh", "ag", "sa", "sas", "srl",
        "spa", "bv", "nv", "kk", "oy", "ab", "aps", "pty", "pvt",
    }
)

# A trailing parenthetical made ONLY of these adds no identity ("(Group)").
_PAREN_STOP = frozenset({"manufacturing", "mfg", "group", "holdings", "the"})

_TRAILING_PAREN = re.compile(r"\s*\(([^()]{1,60})\)\s*$")
_STRIP_CHARS = re.compile(r"[.,'®™]")  # . , ' (r) (tm)
_SEPARATORS = re.compile(r"[-_/()]")


def _tokens(text: str) -> list[str]:
    text = _STRIP_CHARS.sub("", text)
    text = _SEPARATORS.sub(" ", text)
    return text.split()


def canon(name: str) -> str:
    """Canonical merge key. Case/punctuation/legal-suffix insensitive."""
    s = unicodedata.normalize("NFKC", name or "").casefold()
    s = s.replace("&", " and ").replace("+", " and ")

    # Trailing parenthetical: keep unless it is an acronym of the base, a
    # repeat of a base word, or pure stop-words — those add no identity.
    m = _TRAILING_PAREN.search(s)
    inner_tokens: list[str] = []
    if m:
        base = s[: m.start()]
        inner = _tokens(m.group(1))
        base_toks = _tokens(base)
        acronym = "".join(t[0] for t in base_toks if t)
        drop = bool(inner) and (
            (len(inner) == 1 and inner[0] == acronym)
            or all(t in base_toks for t in inner)
            or all(t in _PAREN_STOP for t in inner)
        )
        s = base
        if not drop:
            inner_tokens = inner

    toks = _tokens(s) + inner_tokens
    while len(toks) > 1 and toks[-1] in _LEGAL_SUFFIXES:
        toks.pop()
    return " ".join(toks)


def split_branch(company: str) -> tuple[str, str | None]:
    """Display-string split: "Bisco Industries (Bohemia)" -> (head, branch).

    Returns ORIGINAL casing — this feeds company_name/branch_label columns,
    not the canon key.
    """
    company = (company or "").strip()
    m = _TRAILING_PAREN.search(company)
    if not m:
        return company, None
    return company[: m.start()].strip(), m.group(1).strip()


def domain_of(url: str | None) -> str | None:
    """Bare registrable host, lowercased, www-stripped. None when unusable."""
    if url is None or not url.strip():
        return None
    raw = url.strip()
    parsed = urlparse(raw if "//" in raw else "//" + raw)
    host = (parsed.netloc or "").split("@")[-1].split(":")[0].casefold()
    if host.startswith("www."):
        host = host[4:]
    return host or None
