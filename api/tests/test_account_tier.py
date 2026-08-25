"""Account tier derivation — the tier is DERIVED, never stored.

The brief for this task wrote these tests against a ``db_session`` fixture; the
repo's session fixture is named ``db`` (tests/conftest.py), so that is what they
take. Nothing else about them changed.
"""

from app.models import Sponsor, User
from app.services.account_tier import account_tier


def _customer(db, supplier_id=None):
    u = User(
        username="c@test.example",
        email="c@test.example",
        password_hash="x",
        role="user",
        supplier_id=supplier_id,
    )
    db.add(u)
    db.flush()
    return u


def test_no_link_is_free(db):
    assert account_tier(db, _customer(db)) == "free"


def test_linked_with_no_sponsorship_is_free(db, seeded_db):
    supplier = db.query(Sponsor).first().supplier_id
    db.query(Sponsor).filter(Sponsor.supplier_id == supplier).delete()
    db.flush()
    assert account_tier(db, _customer(db, supplier)) == "free"


def test_highest_active_tier_wins(db, seeded_db):
    supplier = db.query(Sponsor).first().supplier_id
    db.add(Sponsor(supplier_id=supplier, keyword="kw-a", tier="Silver", status="Active"))
    db.add(Sponsor(supplier_id=supplier, keyword="kw-b", tier="Gold", status="Active"))
    db.flush()
    assert account_tier(db, _customer(db, supplier)) == "gold"


def test_null_status_counts_as_active(db, seeded_db):
    # Legacy seed rows omit status; `status != 'Expired'` is UNKNOWN for NULL
    # and would silently skip them.
    supplier = db.query(Sponsor).first().supplier_id
    db.query(Sponsor).filter(Sponsor.supplier_id == supplier).delete()
    db.add(Sponsor(supplier_id=supplier, keyword="kw-c", tier="platinum", status=None))
    db.flush()
    assert account_tier(db, _customer(db, supplier)) == "platinum"


def test_expired_does_not_count(db, seeded_db):
    supplier = db.query(Sponsor).first().supplier_id
    db.query(Sponsor).filter(Sponsor.supplier_id == supplier).delete()
    db.add(Sponsor(supplier_id=supplier, keyword="kw-d", tier="Gold", status="Expired"))
    db.flush()
    assert account_tier(db, _customer(db, supplier)) == "free"


def test_casing_does_not_matter(db, seeded_db):
    # The admin writes TitleCase, legacy seed rows are lowercase, and `tier`
    # is a free string with no enum behind it.
    supplier = db.query(Sponsor).first().supplier_id
    db.query(Sponsor).filter(Sponsor.supplier_id == supplier).delete()
    db.add(Sponsor(supplier_id=supplier, keyword="kw-e", tier="  SILVER ", status="Active"))
    db.flush()
    assert account_tier(db, _customer(db, supplier)) == "silver"
