"""The customer's own badge — /api/account/badges.

A company that holds a badge may decide how its fire LOOKS; it may not decide
that it has one. That single line is the whole router, and it is why the body
here is `BadgeLookPatch` (the shared shape, `extra="forbid"`) rather than the
staff `StaffBadgePatch`: `enabled` is the staff off-switch, so a customer
naming it is REFUSED with 422 rather than quietly ignored — a silently-dropped
field lets a caller believe it worked.

Everything is scoped through ``account_scope``: the rows are the ones held by
MY supplier, and "I have no supplier" is a 404 (`no_supplier`), not an empty
list, because a free browsing account has no badge surface at all. The fixture
is a Venn diagram on purpose — a SECOND supplier holds a badge of the same
family in the same table for every "only mine" claim, so none of those
assertions can pass against an unscoped implementation.
"""

import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from app.models import Badge, Manufacturer, SupplierBadge, User
from app.models.badge import FOUNDER_BADGE_1, FOUNDER_BADGE_2
from app.services.auth_service import create_token


def as_(user):
    return {"Authorization": f"Bearer {create_token(str(user.id), user.role)}"}


def _holding(db, supplier, key=FOUNDER_BADGE_1, **kw):
    badge = db.query(Badge).filter_by(key=key).one()
    row = SupplierBadge(
        id=uuid.uuid4(),
        supplier_id=supplier.id,
        badge_id=badge.id,
        family=badge.family,
        **kw,
    )
    db.add(row)
    return row


@pytest.fixture
def badge_holders(db, seeded_db):
    """My supplier's badge, another supplier's badge, and my auth header."""
    customer = seeded_db["company_user"]  # linked to supplier2
    customer.activated_at = datetime.now(UTC)

    # The leak canary FIRST, on purpose: same family, same table, a company
    # that is not mine — and the row a `.first()` written without the supplier
    # filter would reach for.
    other = _holding(db, seeded_db["supplier1"], scheme="green", opacity=Decimal("0.3"))
    mine = _holding(db, seeded_db["supplier2"])
    db.commit()
    db.refresh(mine)
    db.refresh(other)
    return mine, other, as_(customer)


@pytest.fixture
def free_user(db):
    """An activated customer with neither company link."""
    user = User(
        id=uuid.uuid4(),
        username="free_badge_user",
        password_hash="x",
        role="user",
        email="free_badge_user@test.example",
        email_verified_at=datetime.now(UTC),
        activated_at=datetime.now(UTC),
    )
    db.add(user)
    db.commit()
    return user


@pytest.fixture
def maker_user(db):
    """An activated customer linked to a MANUFACTURER only.

    The realistic near-miss for ``is_supplier``: both links live on ``User`` and
    ``AccountScope`` has no ``elif``, so a route that asked "is this account
    linked to anything" instead of "does it have a supplier" would pass the
    neither-link case and fail here.
    """
    maker = Manufacturer(
        id=uuid.uuid4(),
        name="Badge Maker Co",
        slug="badge-maker-co",
        canonical_key="badgemakerco",
    )
    db.add(maker)
    db.flush()
    user = User(
        id=uuid.uuid4(),
        username="maker_badge_user",
        password_hash="x",
        role="user",
        email="maker_badge_user@test.example",
        email_verified_at=datetime.now(UTC),
        activated_at=datetime.now(UTC),
        manufacturer_id=maker.id,
    )
    db.add(user)
    db.commit()
    return user


def test_the_fixture_has_something_to_leak(badge_holders, db, seeded_db):
    """Guards every "only mine" assertion below from passing vacuously.

    Scoped to the fixture's OWN two claims rather than an absolute table count,
    so an unrelated holding seeded later cannot redden a badge-scoping test.
    """
    assert db.query(SupplierBadge).filter_by(supplier_id=seeded_db["supplier1"].id).count() == 1
    assert db.query(SupplierBadge).filter_by(supplier_id=seeded_db["supplier2"].id).count() == 1


def test_customer_reads_and_restyles_only_their_own(client, db, seeded_db, badge_holders):
    mine, other, h = badge_holders

    rows = client.get("/api/account/badges", headers=h)
    assert rows.status_code == 200, rows.text
    assert [r["id"] for r in rows.json()] == [str(mine.id)]

    r = client.patch(
        "/api/account/badges/founder", json={"scheme": "blue", "sparks": False}, headers=h
    )
    assert r.status_code == 200, r.text
    # The row that moved is MINE — the id is what makes this test able to tell
    # a scoped lookup from one that resolves on `family` alone.
    assert r.json()["id"] == str(mine.id)
    assert r.json()["supplier_id"] == str(seeded_db["supplier2"].id)
    assert r.json()["scheme"] == "blue" and r.json()["sparks"] is False

    # `enabled` is the staff off-switch and is not in the customer body at all.
    assert (
        client.patch("/api/account/badges/founder", json={"enabled": False}, headers=h).status_code
        == 422
    )
    # An unavailable artwork is not choosable by anybody.
    assert (
        client.patch(
            "/api/account/badges/founder", json={"key": FOUNDER_BADGE_2}, headers=h
        ).status_code
        == 422
    )

    # The other company's row is untouched, by identity and by look.
    db.expire_all()
    assert db.query(SupplierBadge).filter_by(id=other.id).one().scheme == "green"
    assert db.query(SupplierBadge).filter_by(id=mine.id).one().enabled is True


def test_the_customer_may_choose_the_alternate_artwork_once_it_is_released(
    client, db, seeded_db, badge_holders
):
    """`key` is a customer-legal field — but only inside the family they hold,
    and only for artwork the catalogue has released."""
    _mine, _other, h = badge_holders
    db.query(Badge).filter_by(key=FOUNDER_BADGE_2).one().available = True
    db.add(Badge(key="other_badge_1", family="other", label="Other", available=True, sort_order=9))
    db.commit()

    r = client.patch("/api/account/badges/founder", json={"key": FOUNDER_BADGE_2}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["key"] == FOUNDER_BADGE_2

    r = client.patch("/api/account/badges/founder", json={"key": "other_badge_1"}, headers=h)
    assert r.status_code == 422 and r.json()["detail"] == "badge_family_mismatch"


def test_ranges_and_unknown_fields_are_refused(client, badge_holders):
    _mine, _other, h = badge_holders
    for body in (
        {"intensity": 2.5},
        {"opacity": 0.1},
        {"scheme": "octarine"},
        {"scheme": None},
        {"supplier_id": str(uuid.uuid4())},
        {"colour": "red"},
    ):
        assert (
            client.patch("/api/account/badges/founder", json=body, headers=h).status_code == 422
        ), body


def test_a_family_my_supplier_does_not_hold_is_404(client, badge_holders):
    _mine, _other, h = badge_holders
    r = client.patch("/api/account/badges/other", json={"scheme": "red"}, headers=h)
    # The detail matters: without it an UNMOUNTED router would pass this test.
    assert r.status_code == 404 and r.json()["detail"] == "badge_not_held"


def test_free_account_gets_404(client, free_user, maker_user):
    """No supplier link, no badge surface — and the same answer on both verbs,
    so the reply never reveals whether SOMEBODY holds that family."""
    h = as_(free_user)
    r = client.get("/api/account/badges", headers=h)
    assert r.status_code == 404 and r.json()["detail"] == "no_supplier"
    r = client.patch("/api/account/badges/founder", json={"scheme": "red"}, headers=h)
    assert r.status_code == 404 and r.json()["detail"] == "no_supplier"

    # A maker-only account is linked to a company and still has no supplier —
    # `is_supplier`, not "linked to something", is the predicate.
    h = as_(maker_user)
    r = client.get("/api/account/badges", headers=h)
    assert r.status_code == 404 and r.json()["detail"] == "no_supplier"
    r = client.patch("/api/account/badges/founder", json={"scheme": "red"}, headers=h)
    assert r.status_code == 404 and r.json()["detail"] == "no_supplier"


def test_a_customer_cannot_reach_the_staff_badge_routes(client, db, seeded_db, badge_holders):
    """The other half of the wall (global-constraints.md:46): the staff door is
    `require_staff`, and a customer is not staff.

    Aimed at the customer's OWN supplier id on purpose — not even owning the
    badge buys the staff door, which is what pins `enabled` as unreachable to
    the company the badge belongs to.
    """
    _mine, _other, h = badge_holders
    sid = str(seeded_db["supplier2"].id)
    assert client.get("/api/badges", headers=h).status_code == 403
    assert client.get(f"/api/suppliers/{sid}/badges", headers=h).status_code == 403
    assert (
        client.post(
            f"/api/suppliers/{sid}/badges", json={"key": FOUNDER_BADGE_1}, headers=h
        ).status_code
        == 403
    )
    assert (
        client.patch(
            f"/api/suppliers/{sid}/badges/founder", json={"enabled": False}, headers=h
        ).status_code
        == 403
    )
    assert client.delete(f"/api/suppliers/{sid}/badges/founder", headers=h).status_code == 403


def test_staff_are_refused(client, db, seeded_db, badge_holders):
    """`account_scope` rides `require_account_user`, which refuses staff (the
    existing wall). The staff door is /api/suppliers/{id}/badges."""
    h = as_(seeded_db["admin_user"])
    assert client.get("/api/account/badges", headers=h).status_code == 403
    assert (
        client.patch("/api/account/badges/founder", json={"scheme": "red"}, headers=h).status_code
        == 403
    )


def test_anonymous_is_refused(client, badge_holders):
    assert client.get("/api/account/badges").status_code in (401, 403)
    assert client.patch("/api/account/badges/founder", json={"scheme": "red"}).status_code in (
        401,
        403,
    )


def test_an_unactivated_customer_is_refused(client, db, seeded_db, badge_holders):
    customer = seeded_db["company_user"]
    customer.activated_at = None
    db.commit()
    assert client.get("/api/account/badges", headers=as_(customer)).status_code == 403


def test_customer_write_invalidates(client, badge_holders, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.routes.account_badges.invalidate_catalog_caches", lambda: calls.append(1)
    )
    _mine, _other, h = badge_holders

    client.get("/api/account/badges", headers=h)
    assert calls == [], "reads must not drop the caches"

    assert (
        client.patch("/api/account/badges/founder", json={"scheme": "red"}, headers=h).status_code
        == 200
    )
    assert len(calls) == 1
