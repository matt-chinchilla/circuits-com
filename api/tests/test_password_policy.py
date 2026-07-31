"""Contract tests for the admin password policy (P1 auth overhaul, task 2).

The policy is the shared law between the API's 422 bodies and the admin UI's
live rule checklist — the four rule KEYS are what both sides speak, so these
tests pin the keys, their order, and every boundary.
"""

import pytest

from app.services.password_policy import (
    PASSWORD_HELP,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    PASSWORD_RULES,
    validate_password,
)

# A password that satisfies all four rules (10 chars: upper, digits, symbol).
VALID = "Abcdef1!gh"


# ── Shape of the exported constants ────────────────────────────────────────


def test_bounds_are_8_to_24_inclusive():
    assert (PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH) == (8, 24)


def test_password_rules_is_ordered_key_description_pairs():
    """Four rules, in checklist order, each a (key, human description)."""
    assert [key for key, _ in PASSWORD_RULES] == ["length", "uppercase", "digit", "symbol"]
    for key, description in PASSWORD_RULES:
        assert isinstance(key, str) and key
        assert isinstance(description, str) and description.strip()


def test_password_help_is_one_sentence_naming_the_bounds():
    assert isinstance(PASSWORD_HELP, str)
    assert "8-24" in PASSWORD_HELP
    assert PASSWORD_HELP.rstrip().endswith(".")
    assert "\n" not in PASSWORD_HELP


# ── Valid passwords ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "password",
    [
        VALID,
        "Aa1!aaaa",  # exactly the minimum length
        "Aa1!aaaaaaaaaaaaaaaaaaaa",  # exactly the maximum length
        "Passw0rd ",  # a space is a non-alphanumeric character
        "Passw0rd☂",  # unicode symbol
        "P@ssw0rd",
    ],
)
def test_valid_password_returns_empty_list(password):
    assert validate_password(password) == []


# ── Each rule independently unmet ──────────────────────────────────────────


def test_only_length_unmet_when_too_short():
    # Has upper + digit + symbol, but only 7 characters.
    assert validate_password("Ab1!cde") == ["length"]


def test_only_length_unmet_when_too_long():
    assert validate_password("Ab1!" + "c" * 21) == ["length"]


def test_only_uppercase_unmet():
    assert validate_password("abcdef1!gh") == ["uppercase"]


def test_only_digit_unmet():
    assert validate_password("Abcdefg!hi") == ["digit"]


def test_only_symbol_unmet():
    assert validate_password("Abcdef1ghi") == ["symbol"]


# ── Boundary lengths 7 / 8 / 24 / 25 ───────────────────────────────────────


@pytest.mark.parametrize(
    "length,expect_length_unmet",
    [(7, True), (8, False), (24, False), (25, True)],
)
def test_length_boundaries(length, expect_length_unmet):
    """Only the length rule moves across 7/8 and 24/25 — the other three stay met."""
    password = "Aa1!" + "b" * (length - 4)
    assert len(password) == length
    unmet = validate_password(password)
    assert unmet == (["length"] if expect_length_unmet else [])


# ── Several rules unmet at once ────────────────────────────────────────────


def test_multiple_unmet_rules_are_all_reported_in_order():
    # "abc" — too short, no uppercase, no digit, no symbol.
    assert validate_password("abc") == ["length", "uppercase", "digit", "symbol"]


def test_empty_password_reports_every_rule():
    assert validate_password("") == [key for key, _ in PASSWORD_RULES]


def test_long_lowercase_password_reports_the_three_character_rules():
    assert validate_password("abcdefghij") == ["uppercase", "digit", "symbol"]


def test_unmet_keys_are_always_a_subset_of_the_rule_keys():
    keys = {key for key, _ in PASSWORD_RULES}
    for password in ["", "abc", "abcdefghij", VALID, "A" * 30]:
        assert set(validate_password(password)) <= keys


# ── Unicode ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("symbol", ["☂", "é", "中", "→", "£"])
def test_unicode_characters_count_as_symbols(symbol):
    """Non-ASCII characters satisfy the symbol rule (JS-mirrored [^A-Za-z0-9])."""
    assert validate_password(f"Passw0rd{symbol}") == []


def test_unicode_uppercase_does_not_satisfy_the_uppercase_rule():
    """ASCII-anchored by design so the JS mirror ([A-Z]) can't diverge —
    the unicode 'Ä' counts as a SYMBOL, not as an uppercase letter."""
    assert validate_password("Äbcdef1gh") == ["uppercase"]


def test_unicode_digit_does_not_satisfy_the_digit_rule():
    """Same ASCII anchoring for digits: '٣' is a symbol, not a number."""
    assert validate_password("Abcdefg٣h") == ["digit"]


def test_length_counts_code_points_not_bytes():
    password = "Aa1!" + "é" * 4  # 8 code points, 12 UTF-8 bytes
    assert validate_password(password) == []
