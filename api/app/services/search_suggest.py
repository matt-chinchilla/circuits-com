"""Pure fuzzy scorers for the search v2 zero-result recovery (spec §1.5).

Kit-parity port of the handoff's Search.jsx scoring (srLev / srGrams /
srPrefixLen), dependency-free and ORM-free so it runs identically under
SQLite tests and Postgres prod. One deliberate divergence from the kit: the
did-you-mean vocabulary carries NO part SKUs (132k SKUs cannot be
vocabulary), so `kind` has no "part" member.
"""

import re
from collections.abc import Iterable

# Whole-query tokens (kit: /[\s\-_/,]+/) vs candidate-word split
# (kit: /[\s/·,]+/ — the middot spelled as an escape so no literal non-ASCII
# glyph rides in source).
_TOKEN_SPLIT = re.compile(r"[\s\-_/,]+")
_WORD_SPLIT = re.compile(r"[\s/\u00b7,]+")
_ALNUM_ONLY = re.compile(r"[^a-z0-9]")

SUGGESTION_FLOOR = 0.9
SUGGESTION_CAP = 4


def levenshtein(a: str, b: str) -> int:
    """Classic two-row edit distance — small strings only (vocab words)."""
    m, n = len(a), len(b)
    if m == 0:
        return n
    if n == 0:
        return m
    prev = list(range(n + 1))
    for i in range(1, m + 1):
        cur = [i]
        for j in range(1, n + 1):
            cur.append(
                min(
                    prev[j] + 1,
                    cur[j - 1] + 1,
                    prev[j - 1] + (0 if a[i - 1] == b[j - 1] else 1),
                )
            )
        prev = cur
    return prev[n]


def _suggestion_score(query_lower: str, tokens: list[str], candidate: str, kind: str) -> float:
    candidate_lower = candidate.lower()
    score = 0.0
    # Token containment: ≥3-char tokens only, cumulative (+3 each).
    for token in tokens:
        if len(token) >= 3 and token in candidate_lower:
            score += 3.0
    # Best Levenshtein ratio of the whole query against the whole candidate
    # AND each ≥3-char candidate word — "mauser" reaches "Mouser Electronics"
    # through the word "mouser", never through the whole string.
    ratio = levenshtein(query_lower, candidate_lower) / max(
        len(query_lower), len(candidate_lower), 1
    )
    for word in _WORD_SPLIT.split(candidate_lower):
        if len(word) < 3:
            continue
        word_ratio = levenshtein(query_lower, word) / max(len(query_lower), len(word))
        if word_ratio < ratio:
            ratio = word_ratio
    if ratio <= 0.5:
        score += (1.0 - ratio) * 4.0
    # Entities outrank generic category words at equal fuzzy distance —
    # a flat kit-parity nudge, not a graded ladder.
    if kind != "category":
        score += 0.25
    return score


def did_you_mean(query: str, vocab: Iterable[tuple[str, str, str | None]]) -> list[dict]:
    """Score `vocab` entries (term, kind, icon) against the failed query.

    Returns at most SUGGESTION_CAP suggestions as {term, kind, icon}, best
    first; only scores above SUGGESTION_FLOOR survive, so garbage queries
    yield zero chips rather than four random ones.
    """
    query_lower = query.lower()
    tokens = [t for t in _TOKEN_SPLIT.split(query_lower) if t]
    scored = []
    for term, kind, icon in vocab:
        score = _suggestion_score(query_lower, tokens, term, kind)
        if score > SUGGESTION_FLOOR:
            scored.append((score, term, kind, icon))
    scored.sort(key=lambda entry: (-entry[0], entry[1].lower()))
    return [
        {"term": term, "kind": kind, "icon": icon}
        for _, term, kind, icon in scored[:SUGGESTION_CAP]
    ]


def _clean(s: str) -> str:
    return _ALNUM_ONLY.sub("", s.lower())


def char_trigrams(s: str) -> set[str]:
    """Character trigrams over the lowercased alphanumeric skeleton."""
    t = _clean(s)
    return {t[i : i + 3] for i in range(len(t) - 2)}


def _prefix_len(a: str, b: str) -> int:
    i = 0
    while i < len(a) and i < len(b) and a[i] == b[i]:
        i += 1
    return i


def closest_score(query: str, sku: str, hay: str) -> float:
    """Trigram overlap ×2 over the part's haystack + shared-SKU-prefix bonus."""
    overlap = len(char_trigrams(hay) & char_trigrams(query))
    return overlap * 2.0 + _prefix_len(_clean(query), _clean(sku))
