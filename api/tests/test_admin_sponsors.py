"""Tests for /api/admin/sponsors — admin sponsor CRUD.

The admin console used to write sponsors only to browser localStorage, so
admin edits never reached the `sponsors` table and the public site (which
reads category sponsors from the DB) never saw them. These tests lock in
the DB-backed WRITE path: create / list / patch / delete, plus the
category_id-XOR-keyword 422 contract (enforced in Python so it holds on
SQLite, which ignores the model's CheckConstraint).
"""

import uuid
from decimal import Decimal

from app.models import Sponsor


def _auth_header(client):
    resp = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "testpass123"},
    )
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_create_category_sponsor_then_list_shows_it(client, seeded_db, db):
    """POST a category sponsor, then GET list returns it (joined names).

    Note: tier='Featured' attaches ONLY to top-level categories
    (2026-06-02 softened rule — Silver/Gold/Platinum are allowed on
    child categories or keywords; top-level is Featured-only).
    """
    headers = _auth_header(client)
    supplier = seeded_db["supplier1"]
    category = seeded_db["parent"]

    resp = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(supplier.id),
            "category_id": str(category.id),
            "tier": "Featured",
            "amount": "750.00",
            "status": "Active",
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    created = resp.json()
    assert created["supplier_id"] == str(supplier.id)
    assert created["supplier_name"] == supplier.name
    assert created["category_id"] == str(category.id)
    assert created["category_name"] == category.name
    assert created["category_icon"] == category.icon
    assert created["keyword"] is None
    assert created["tier"] == "Featured"
    assert created["amount"] == "750.00"
    assert created["status"] == "Active"

    # GET list shows the new sponsor (plus the one seeded by the fixture).
    resp = client.get("/api/admin/sponsors/", headers=headers)
    assert resp.status_code == 200
    rows = resp.json()
    ids = {r["id"] for r in rows}
    assert created["id"] in ids
    # seeded_db already inserts one category sponsor → expect at least 2 total.
    assert len(rows) >= 2


def test_create_status_defaults_to_active(client, seeded_db, db):
    headers = _auth_header(client)
    supplier = seeded_db["supplier1"]
    category = seeded_db["parent"]  # Featured requires top-level (2026-06-02 rule)

    resp = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(supplier.id),
            "category_id": str(category.id),
            "tier": "Featured",
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "Active"


def test_create_keyword_sponsor_persists(client, seeded_db, db):
    """A keyword sponsor (no category) is accepted and stored in the DB."""
    headers = _auth_header(client)
    supplier = seeded_db["supplier1"]

    resp = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(supplier.id),
            "keyword": "voltage regulator",
            "tier": "gold",
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    created = resp.json()
    assert created["keyword"] == "voltage regulator"
    assert created["category_id"] is None
    assert created["category_name"] is None

    row = db.query(Sponsor).filter(Sponsor.id == uuid.UUID(created["id"])).first()
    assert row is not None
    assert row.keyword == "voltage regulator"


def test_patch_updates_a_field(client, seeded_db, db):
    """PATCH updates a single field and persists it.

    Seeded sponsor is tier='gold' + category_id=child. Under the
    2026-06-02 softened rule, non-Featured + child is the
    "Subcategory Sponsor" slot — fully legal. We PATCH only the amount
    so we don't trip the tier/placement validator.
    """
    headers = _auth_header(client)
    sponsor = seeded_db["sponsor"]

    resp = client.patch(
        f"/api/admin/sponsors/{sponsor.id}",
        json={"amount": "999.00"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["amount"] == "999.00"

    # Reload from DB to confirm persistence.
    db.expire_all()
    row = db.query(Sponsor).filter(Sponsor.id == sponsor.id).first()
    assert row.amount == Decimal("999.00")


def test_patch_unknown_id_returns_404(client, seeded_db):
    headers = _auth_header(client)
    fake_id = str(uuid.uuid4())
    resp = client.patch(
        f"/api/admin/sponsors/{fake_id}",
        json={"tier": "gold"},
        headers=headers,
    )
    assert resp.status_code == 404


def test_delete_removes_sponsor(client, seeded_db, db):
    """DELETE removes the row and returns 204."""
    headers = _auth_header(client)
    sponsor = seeded_db["sponsor"]
    sponsor_id = sponsor.id

    resp = client.delete(f"/api/admin/sponsors/{sponsor_id}", headers=headers)
    assert resp.status_code == 204

    db.expire_all()
    row = db.query(Sponsor).filter(Sponsor.id == sponsor_id).first()
    assert row is None


def test_post_with_both_category_and_keyword_returns_422(client, seeded_db, db):
    """XOR violation: both category_id and keyword set → 422."""
    headers = _auth_header(client)
    supplier = seeded_db["supplier1"]
    category = seeded_db["child"]

    resp = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(supplier.id),
            "category_id": str(category.id),
            "keyword": "both set",
            "tier": "gold",
        },
        headers=headers,
    )
    assert resp.status_code == 422


def test_post_with_neither_category_nor_keyword_returns_422(client, seeded_db, db):
    """XOR violation: neither category_id nor keyword set → 422."""
    headers = _auth_header(client)
    supplier = seeded_db["supplier1"]

    resp = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(supplier.id),
            "tier": "gold",
        },
        headers=headers,
    )
    assert resp.status_code == 422


def test_list_requires_auth(client, seeded_db):
    resp = client.get("/api/admin/sponsors/")
    assert resp.status_code == 401


def test_create_requires_auth(client, seeded_db):
    resp = client.post(
        "/api/admin/sponsors/",
        json={"supplier_id": str(uuid.uuid4()), "keyword": "x", "tier": "gold"},
    )
    assert resp.status_code == 401


def test_create_unknown_supplier_returns_404(client, seeded_db, db):
    headers = _auth_header(client)
    resp = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(uuid.uuid4()),
            "keyword": "orphan",
            "tier": "gold",
        },
        headers=headers,
    )
    assert resp.status_code == 404
