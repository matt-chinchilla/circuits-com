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


# ── F3: status is canonicalised on every admin write ─────────────────────────
# The guard compares canonical values, so no spelling of "Expired" slips past
# it, and nothing but the three statuses the boards understand is stored.

STATUS_RULE = "Status must be Active, Paused or Expired."


@pytest.fixture
def unbilled(db, seeded_db):
    sponsor = Sponsor(
        supplier_id=seeded_db["supplier1"].id,
        keyword="unbilled-guard",
        tier="Silver",
        status="Active",
    )
    db.add(sponsor)
    db.commit()
    return sponsor


@pytest.mark.parametrize("spelling", ["expired", " Expired ", "EXPIRED", "Expired\n"])
def test_every_spelling_of_expired_is_refused_on_a_billed_sponsor(
    client, db, billed, auth_header, spelling
):
    resp = client.patch(
        f"/api/admin/sponsors/{billed.id}", json={"status": spelling}, headers=auth_header()
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == "billing_active"
    db.refresh(billed)
    assert billed.status == "Active"


@pytest.mark.parametrize("status", ["Inactive", "", "  ", "expired-ish", "Live"])
def test_an_unknown_status_is_a_string_422(client, db, unbilled, auth_header, status):
    resp = client.patch(
        f"/api/admin/sponsors/{unbilled.id}", json={"status": status}, headers=auth_header()
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == STATUS_RULE
    db.refresh(unbilled)
    assert unbilled.status == "Active"


def test_an_unknown_status_is_refused_on_create(client, db, seeded_db, auth_header):
    resp = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(seeded_db["supplier1"].id),
            "keyword": "status-create",
            "tier": "Silver",
            "status": "Inactive",
        },
        headers=auth_header(),
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == STATUS_RULE
    assert db.query(Sponsor).filter_by(keyword="status-create").count() == 0


def test_create_stores_the_canonical_spelling(client, db, seeded_db, auth_header):
    resp = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(seeded_db["supplier1"].id),
            "keyword": "status-create",
            "tier": "Silver",
            "status": " paused ",
        },
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "Paused"
    assert db.query(Sponsor).filter_by(keyword="status-create").one().status == "Paused"


def test_pausing_by_any_spelling_is_allowed_and_stored_canonically(client, db, billed, auth_header):
    resp = client.patch(
        f"/api/admin/sponsors/{billed.id}", json={"status": "paused"}, headers=auth_header()
    )
    assert resp.status_code == 200, resp.text
    db.refresh(billed)
    assert billed.status == "Paused"


def test_an_unbilled_sponsor_expires_by_any_spelling(client, db, unbilled, auth_header):
    resp = client.patch(
        f"/api/admin/sponsors/{unbilled.id}", json={"status": "expired"}, headers=auth_header()
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "Expired"
    db.refresh(unbilled)
    assert unbilled.status == "Expired"


def test_a_null_status_still_means_active(client, db, unbilled, auth_header):
    """Legacy seed rows omit status and every reader treats NULL as Active —
    an explicit null stays writable (it is not a fourth spelling)."""
    resp = client.patch(
        f"/api/admin/sponsors/{unbilled.id}", json={"status": None}, headers=auth_header()
    )
    assert resp.status_code == 200, resp.text
    db.refresh(unbilled)
    assert unbilled.status is None


@pytest.mark.parametrize("stored", ["expired", "EXPIRED", " Expired "])
def test_a_row_stored_expired_in_another_casing_is_not_guarded(
    client, db, billed, auth_header, stored
):
    """Rows written before canonicalisation keep whatever casing they had; the
    guard reads them canonically too, so an already-expired billed row deletes
    (and re-saves as Expired) like one spelled exactly."""
    billed.status = stored
    db.commit()
    resp = client.patch(
        f"/api/admin/sponsors/{billed.id}", json={"status": "Expired"}, headers=auth_header()
    )
    assert resp.status_code == 200, resp.text
    billed.status = stored  # the DELETE guard reads the stored value itself
    db.commit()
    resp = client.delete(f"/api/admin/sponsors/{billed.id}", headers=auth_header())
    assert resp.status_code == 204, resp.text
