"""Rep discount codes from /admin — /api/admin/sales-codes (spec §9).

A rep creates a code (1–15 points, optional tier / placement / company +
email / email locks, max uses, expiry, note) and gets back a READY link built
from the code's own locks. Codes are never deleted — a rep switches one off,
extends it or edits its note — and every create/edit writes a staff-only
``billing_audit`` row.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.config import settings
from app.models import Category, Sponsor
from app.models.sales import BillingAudit, SalesCode, SponsorBilling
from app.services import sales_codes as sc

BASE = "/api/admin/sales-codes/"


@pytest.fixture
def free_child(db, seeded_db):
    """A Gold slot nobody holds (the seeded child already has a Gold)."""
    child = Category(
        id=uuid.uuid4(),
        name="Oscillators",
        slug="oscillators",
        icon="wave-sine",
        parent_id=seeded_db["parent"].id,
        sort_order=1,
    )
    db.add(child)
    db.commit()
    return child


def _create(client, headers, **body):
    return client.post(BASE, json={"code_points": 10, **body}, headers=headers)


def test_create_returns_a_code_and_a_ready_link_from_its_own_locks(
    client, seeded_db, auth_header, free_child
):
    resp = _create(client, auth_header(), tier="gold", category_id=str(free_child.id))
    assert resp.status_code == 201, resp.text
    row = resp.json()
    assert len(row["code"]) == 8 and set(row["code"]) <= set(sc.ALPHABET)
    assert row["display"] == sc.display_code(row["code"])
    base = settings.APP_BASE_URL.rstrip("/")
    assert row["link"] == (f"{base}/join?code={row['display']}&tier=gold&slot={free_child.id}")
    assert row["code_points"] == 10
    assert row["tier"] == "gold"
    assert row["category_id"] == str(free_child.id)
    assert row["category_name"] == "Oscillators"
    assert row["status"] == "live"
    assert row["uses"] == 0 and row["max_uses"] == 1
    assert row["sales"] == []


def test_rep_defaults_to_the_caller_and_created_by_is_the_caller(client, seeded_db, auth_header):
    row = _create(client, auth_header()).json()
    assert row["rep"] == "admin"
    assert row["created_by"] == "admin"
    other = _create(client, auth_header(), rep="Daniel").json()
    assert other["rep"] == "Daniel"
    assert other["created_by"] == "admin"


def test_link_without_locks_names_only_the_code(client, seeded_db, auth_header):
    row = _create(client, auth_header()).json()
    base = settings.APP_BASE_URL.rstrip("/")
    assert row["link"] == f"{base}/join?code={row['display']}"
    assert row["tier"] is None


def test_a_placement_lock_implies_its_tier(client, seeded_db, auth_header, free_child):
    """A top-level category can only be Platinum and a child only Gold, so the
    lock carries the tier into the code and the link."""
    parent = seeded_db["parent"]
    row = _create(client, auth_header(), category_id=str(parent.id)).json()
    assert row["tier"] == "platinum"
    assert "&tier=platinum&slot=" in row["link"]
    row = _create(client, auth_header(), category_id=str(free_child.id)).json()
    assert row["tier"] == "gold"


def test_a_placement_that_contradicts_the_tier_is_refused(
    client, seeded_db, auth_header, free_child
):
    resp = _create(client, auth_header(), tier="platinum", category_id=str(free_child.id))
    assert resp.status_code == 422
    assert isinstance(resp.json()["detail"], str)
    resp = _create(client, auth_header(), tier="gold", category_id=str(seeded_db["parent"].id))
    assert resp.status_code == 422


def test_unknown_category_and_supplier_are_refused(client, seeded_db, auth_header):
    resp = _create(client, auth_header(), category_id=str(uuid.uuid4()))
    assert resp.status_code == 422
    resp = _create(
        client, auth_header(), supplier_id=str(uuid.uuid4()), email_lock="buyer@acme.test"
    )
    assert resp.status_code == 422


@pytest.mark.parametrize("tier", ["silver", "featured", "diamond"])
def test_codes_apply_to_gold_and_platinum_only(client, seeded_db, auth_header, tier):
    assert _create(client, auth_header(), tier=tier).status_code == 422


@pytest.mark.parametrize("pts", [0, 16, -3])
def test_points_must_be_one_to_fifteen(client, seeded_db, auth_header, pts):
    resp = client.post(BASE, json={"code_points": pts}, headers=auth_header())
    assert resp.status_code == 422


def test_a_code_tied_to_a_company_needs_the_customers_email(client, seeded_db, auth_header):
    resp = _create(client, auth_header(), supplier_id=str(seeded_db["supplier1"].id))
    assert resp.status_code == 422
    assert resp.json()["detail"] == "A code tied to a company needs the customer's email."


def test_bound_company_already_on_the_placement_is_refused(client, seeded_db, auth_header):
    """R7: Kennedy holds the seeded child's Gold (NULL status = live), so a
    code binding Kennedy to that child is 409 already_sponsor."""
    resp = _create(
        client,
        auth_header(),
        supplier_id=str(seeded_db["supplier2"].id),
        email_lock="info@kennedy.com",
        category_id=str(seeded_db["child"].id),
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "already_sponsor"


def test_bound_company_with_only_an_expired_row_may_get_a_code(client, db, seeded_db, auth_header):
    sponsor = db.get(Sponsor, seeded_db["sponsor"].id)
    sponsor.status = "Expired"
    db.commit()
    resp = _create(
        client,
        auth_header(),
        supplier_id=str(seeded_db["supplier2"].id),
        email_lock=" Info@Kennedy.com ",
        category_id=str(seeded_db["child"].id),
    )
    assert resp.status_code == 201, resp.text
    row = resp.json()
    assert row["supplier_name"] == "Kennedy Electronics"
    assert row["email_lock"] == "info@kennedy.com"


def test_email_lock_must_look_like_an_address(client, seeded_db, auth_header):
    assert _create(client, auth_header(), email_lock="not-an-email").status_code == 422


def test_create_writes_an_audit_row(client, db, seeded_db, auth_header):
    row = _create(client, auth_header(), note="Acme trade show").json()
    audit = db.query(BillingAudit).filter(BillingAudit.action == "code_created").one()
    assert audit.actor == "admin"
    assert str(audit.sales_code_id) == row["id"]


def test_patch_switches_off_extends_and_edits_the_note(client, db, seeded_db, auth_header):
    row = _create(client, auth_header()).json()
    url = f"{BASE}{row['id']}"

    off = client.patch(url, json={"active": False}, headers=auth_header())
    assert off.status_code == 200, off.text
    assert off.json()["status"] == "off"

    before = datetime.now(UTC)
    ext = client.patch(url, json={"expires_in_days": 30, "note": "extended"}, headers=auth_header())
    assert ext.status_code == 200
    body = ext.json()
    expires = datetime.fromisoformat(body["expires_at"])
    assert before + timedelta(days=29, hours=23) < expires < before + timedelta(days=30, hours=1)
    assert body["note"] == "extended"

    audits = db.query(BillingAudit).filter(BillingAudit.action == "code_updated").count()
    assert audits == 2


def test_patch_unknown_code_is_404(client, seeded_db, auth_header):
    resp = client.patch(f"{BASE}{uuid.uuid4()}", json={"active": False}, headers=auth_header())
    assert resp.status_code == 404
    resp = client.patch(f"{BASE}not-a-uuid", json={"active": False}, headers=auth_header())
    assert resp.status_code == 404


def test_there_is_no_delete(client, seeded_db, auth_header):
    row = _create(client, auth_header()).json()
    assert client.delete(f"{BASE}{row['id']}", headers=auth_header()).status_code == 405


def test_list_derives_status_and_carries_the_sales(client, db, seeded_db, auth_header):
    headers = auth_header()
    live = _create(client, headers).json()
    expired = _create(client, headers).json()
    used = _create(client, headers).json()
    db.get(SalesCode, uuid.UUID(expired["id"])).expires_at = datetime.now(UTC) - timedelta(days=1)
    used_row = db.get(SalesCode, uuid.UUID(used["id"]))
    used_row.uses = 1
    db.add(
        SponsorBilling(
            sponsor_id=seeded_db["sponsor"].id,
            channel="rep_code",
            list_usd=2500,
            founder_usd=2100,
            price_usd=1850,
            sales_code_id=used_row.id,
        )
    )
    db.commit()

    resp = client.get(BASE, headers=headers)
    assert resp.status_code == 200
    by_id = {c["id"]: c for c in resp.json()["codes"]}
    assert by_id[live["id"]]["status"] == "live"
    assert by_id[expired["id"]]["status"] == "expired"
    assert by_id[used["id"]]["status"] == "used_up"
    sale = by_id[used["id"]]["sales"][0]
    assert sale["sponsor_id"] == str(seeded_db["sponsor"].id)
    assert sale["company"] == "Kennedy Electronics"
    assert sale["tier"] == "gold"
    assert sale["price_usd"] == 1850
    assert sale["sold_at"]


def test_list_is_newest_first(client, seeded_db, auth_header):
    headers = auth_header()
    first = _create(client, headers).json()
    second = _create(client, headers).json()
    ids = [c["id"] for c in client.get(BASE, headers=headers).json()["codes"]]
    assert ids.index(second["id"]) < ids.index(first["id"])


def test_a_viewer_cannot_create_a_code(client, db, seeded_db, viewer_header):
    headers = viewer_header()
    resp = client.post(BASE, json={"code_points": 5}, headers=headers)
    assert resp.status_code == 403
    assert resp.json()["detail"] == "read_only"
