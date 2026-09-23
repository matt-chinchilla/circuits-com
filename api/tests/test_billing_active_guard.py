"""R15 — a billed sponsor cannot be deleted or expired around its subscription.

Sponsor DELETE, supplier DELETE and a sponsor PATCH to ``status=Expired``
answer 409 ``billing_active`` while the sponsor has a stored subscription and
is not Expired: the row (and its cascading billing row) would vanish while
Stripe keeps charging, and no console page would be left to stop it. The way
out is Billing → Cancel, which sets Expired itself (as do the webhook's
``customer.subscription.deleted`` and the sweep) — and that lifts the guard.
No Stripe call is made by the guard.
"""

from decimal import Decimal

import pytest

from app.models import Sponsor, Supplier
from app.models.sales import SponsorBilling


@pytest.fixture
def billed(db, seeded_db):
    sponsor = Sponsor(
        supplier_id=seeded_db["supplier1"].id,
        keyword="billed-guard",
        tier="Gold",
        status="Active",
        amount=Decimal("2100"),
    )
    db.add(sponsor)
    db.flush()
    db.add(
        SponsorBilling(
            sponsor_id=sponsor.id,
            stripe_subscription_id="sub_guard000001",
            channel="rep_code",
            list_usd=2500,
            price_usd=2100,
        )
    )
    db.commit()
    return sponsor


def test_deleting_a_billed_sponsor_is_refused(client, db, billed, auth_header):
    resp = client.delete(f"/api/admin/sponsors/{billed.id}", headers=auth_header())
    assert resp.status_code == 409
    assert resp.json()["detail"] == "billing_active"
    assert db.get(Sponsor, billed.id) is not None


def test_deleting_a_billed_sponsors_supplier_is_refused(client, db, billed, auth_header):
    supplier_id = billed.supplier_id
    resp = client.delete(f"/api/suppliers/{supplier_id}", headers=auth_header())
    assert resp.status_code == 409
    assert resp.json()["detail"] == "billing_active"
    db.expire_all()
    assert db.get(Supplier, supplier_id) is not None
    assert db.get(Sponsor, billed.id) is not None


def test_expiring_a_billed_sponsor_is_refused(client, db, billed, auth_header):
    resp = client.patch(
        f"/api/admin/sponsors/{billed.id}", json={"status": "Expired"}, headers=auth_header()
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "billing_active"
    db.refresh(billed)
    assert billed.status == "Active"


def test_pausing_a_billed_sponsor_is_allowed(client, db, billed, auth_header):
    resp = client.patch(
        f"/api/admin/sponsors/{billed.id}", json={"status": "Paused"}, headers=auth_header()
    )
    assert resp.status_code == 200
    db.refresh(billed)
    assert billed.status == "Paused"


def test_other_edits_to_a_billed_sponsor_are_allowed(client, billed, auth_header):
    resp = client.patch(
        f"/api/admin/sponsors/{billed.id}",
        json={"description": "new copy"},
        headers=auth_header(),
    )
    assert resp.status_code == 200


def test_an_expired_billed_sponsor_deletes_normally(client, db, billed, auth_header):
    billed.status = "Expired"
    db.commit()
    resp = client.delete(f"/api/admin/sponsors/{billed.id}", headers=auth_header())
    assert resp.status_code == 204
    db.expire_all()
    assert db.get(Sponsor, billed.id) is None


def test_a_supplier_whose_billed_sponsor_expired_deletes_normally(client, db, billed, auth_header):
    billed.status = "Expired"
    db.commit()
    resp = client.delete(f"/api/suppliers/{billed.supplier_id}", headers=auth_header())
    assert resp.status_code in (200, 204)


def test_a_billing_row_without_a_subscription_does_not_guard(client, db, billed, auth_header):
    db.get(SponsorBilling, billed.id).stripe_subscription_id = None
    db.commit()
    resp = client.delete(f"/api/admin/sponsors/{billed.id}", headers=auth_header())
    assert resp.status_code == 204


def test_a_legacy_self_serve_row_is_guarded_by_its_own_subscription(
    client, db, seeded_db, auth_header
):
    """A row created before its billing row existed still names its owner."""
    row = Sponsor(
        supplier_id=seeded_db["supplier1"].id,
        keyword="legacy-guard",
        tier="Silver",
        status=None,
        stripe_subscription_id="sub_legacy00001",
    )
    db.add(row)
    db.commit()
    resp = client.delete(f"/api/admin/sponsors/{row.id}", headers=auth_header())
    assert resp.status_code == 409
    assert resp.json()["detail"] == "billing_active"
