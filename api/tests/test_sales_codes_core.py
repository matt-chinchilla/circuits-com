"""Rep discount codes — generation, normalisation and usability (spec §6).

Every "not usable" answer is the same ``None`` (the public route turns it into
ONE sentence), so no test here may be able to tell WHY a code was refused."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.models import CheckoutIntent, SalesCode
from app.services import sales_codes as sc

NOW = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)


def test_generate_is_eight_unambiguous_chars():
    for _ in range(200):
        c = sc.generate_code()
        assert len(c) == 8 and set(c) <= set(sc.ALPHABET)
        assert sc.normalize_code(c) == c


def test_alphabet_is_crockford_without_the_confusables():
    assert len(sc.ALPHABET) == 32 and len(set(sc.ALPHABET)) == 32
    assert not set("ILOU") & set(sc.ALPHABET)


def test_normalize_code_variants():
    assert sc.normalize_code(" ab1c-d2ef ") == "AB1CD2EF"
    assert sc.normalize_code("abic-dzef".replace("z", "2")) == "AB1CD2EF"  # I → 1
    assert sc.normalize_code("OOOO-LLLL") == "00001111"  # O → 0, L → 1
    assert sc.normalize_code("ab1c d2ef") == "AB1CD2EF"
    assert sc.normalize_code("AB1C–D2EF") == "AB1CD2EF"  # a pasted en dash
    assert sc.normalize_code("short") is None
    assert sc.normalize_code("AB1CD2EFG") is None  # nine
    assert sc.normalize_code("ABCD-EFGU") is None  # U is not in the alphabet
    assert sc.normalize_code("AB1C*D2E") is None
    assert sc.normalize_code("") is None
    assert sc.normalize_code(None) is None
    assert sc.normalize_code(12345678) is None
    assert sc.normalize_code("A" * 10_000) is None


def test_display_code():
    assert sc.display_code("AB1CD2EF") == "AB1C-D2EF"


def test_not_valid_message_is_the_one_sentence():
    assert sc.NOT_VALID_MESSAGE == "This code isn't valid for this purchase."


# ── usable_code against the DB ───────────────────────────────────────────────


def _code(db, **kw) -> SalesCode:
    base = dict(
        code="AB1CD2EF",
        code_points=10,
        rep="Daniel",
        created_by="Daniel",
        expires_at=NOW + timedelta(days=3),
    )
    base.update(kw)
    row = SalesCode(**base)
    db.add(row)
    db.commit()
    return row


def _intent(db, code: SalesCode, *, status: str = "open") -> CheckoutIntent:
    row = CheckoutIntent(
        tier="gold",
        category_id=uuid.uuid4(),
        sales_code_id=code.id,
        list_usd=2500,
        founder_usd=2100,
        price_usd=1850,
        channel="rep_code",
        sold_by="Daniel",
        company_name="Acme",
        email="buyer@acme.test",
        status=status,
        expires_at=NOW + timedelta(minutes=45),
    )
    db.add(row)
    db.commit()
    return row


def _usable(db, raw="ab1c-d2ef", *, tier="gold", category_id=None, email=None, lock=False):
    return sc.usable_code(
        db, raw, tier=tier, category_id=category_id, email=email, lock=lock, now=NOW
    )


def test_happy_path(db):
    row = _code(db)
    assert _usable(db) is row
    assert _usable(db, tier="Platinum") is row  # tier NULL = either exclusive tier


def test_lock_true_takes_the_row(db):
    row = _code(db)
    assert _usable(db, lock=True) is row


def test_garbage_and_unknown_codes(db):
    _code(db)
    assert _usable(db, "nope") is None
    assert _usable(db, None) is None
    assert _usable(db, "ZZZZ-ZZZZ") is None


def test_inactive(db):
    _code(db, active=False)
    assert _usable(db) is None


def test_expired(db):
    _code(db, expires_at=NOW - timedelta(seconds=1))
    assert _usable(db) is None


def test_expiry_is_exclusive_at_the_instant(db):
    _code(db, expires_at=NOW)
    assert _usable(db) is None


def test_exhausted_by_uses(db):
    _code(db, max_uses=2, uses=2)
    assert _usable(db) is None


def test_exhausted_by_an_open_intent(db):
    row = _code(db, max_uses=2, uses=1)
    assert _usable(db) is row
    _intent(db, row)
    assert _usable(db) is None


@pytest.mark.parametrize("status", ["expired", "released", "completed", "conflict"])
def test_only_open_intents_count(db, status):
    row = _code(db)
    _intent(db, row, status=status)
    assert _usable(db) is row


def test_tier_lock_mismatch(db):
    row = _code(db, tier="platinum")
    assert _usable(db, tier="gold") is None
    assert _usable(db, tier="PLATINUM") is row


def test_codes_are_for_exclusive_tiers_only(db):
    """R8: Silver takes no code in this release."""
    _code(db)
    assert _usable(db, tier="silver") is None
    assert _usable(db, tier="diamond") is None


def test_category_lock(db):
    cat = uuid.uuid4()
    row = _code(db, category_id=cat)
    assert _usable(db, category_id=cat) is row
    assert _usable(db, category_id=uuid.uuid4()) is None
    assert _usable(db, category_id=None) is None


def test_email_lock_checked_only_when_email_given(db):
    row = _code(db, email_lock="Buyer@Acme.test")
    assert _usable(db, email=None) is row  # /quote without an email (LU-F18)
    assert _usable(db, email=" buyer@ACME.test ") is row  # case-insensitive
    assert _usable(db, email="other@acme.test") is None
    assert _usable(db, email="") is None


def test_no_email_lock_accepts_any_email(db):
    row = _code(db)
    assert _usable(db, email="anyone@anywhere.test") is row


def test_a_naive_expiry_reads_as_utc(db):
    """SQLite hands back naive datetimes; they are UTC by construction."""
    row = _code(db, expires_at=(NOW + timedelta(hours=1)).replace(tzinfo=None))
    assert _usable(db) is row
