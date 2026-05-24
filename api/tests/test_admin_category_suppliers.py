"""Tests for /api/admin/category-suppliers/feature endpoint.

# Why this exists

The guided-tour wizard (frontend) uses this endpoint to mark a
freshly-created demo supplier as the Featured Supplier on a category,
so the live-site preview iframe actually shows the demo supplier in the
Featured slot — making the "your data propagated to the public site"
story visceral.

Two contract assertions matter most:
  1) Upsert semantics — calling the endpoint twice with the same pair
     should NOT create duplicate join rows.
  2) Cleanup is automatic — when the supplier is deleted (via the wizard's
     delete step), the CategorySupplier row cascades away without needing
     a separate unfeature call.

If either breaks, the wizard tours will start polluting the catalog with
"DEMO" suppliers persistently featured on real categories.
"""

import uuid

from app.models import CategorySupplier


def _auth_header(client):
    resp = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "testpass123"},
    )
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_feature_creates_join_row_when_missing(client, seeded_db, db):
    """First call inserts a CategorySupplier row with is_featured=True."""
    headers = _auth_header(client)
    # seeded_db's child category has no link to supplier1 in featured state
    # (only is_featured=False). After this call, the join row's is_featured
    # should flip to True for the parent category — fresh row.
    parent = seeded_db["parent"]
    supplier1 = seeded_db["supplier1"]

    resp = client.post(
        "/api/admin/category-suppliers/feature",
        json={
            "supplier_id": str(supplier1.id),
            "category_slug": parent.slug,
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["is_featured"] is True
    assert body["rank"] == 1

    # Verify the row landed
    rows = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == parent.id,
            CategorySupplier.supplier_id == supplier1.id,
        )
        .all()
    )
    assert len(rows) == 1
    assert rows[0].is_featured is True


def test_feature_is_idempotent(client, seeded_db, db):
    """Repeat calls update the existing row, don't insert duplicates."""
    headers = _auth_header(client)
    parent = seeded_db["parent"]
    supplier1 = seeded_db["supplier1"]
    payload = {
        "supplier_id": str(supplier1.id),
        "category_slug": parent.slug,
    }

    # Call three times — should leave exactly one row.
    for _ in range(3):
        resp = client.post(
            "/api/admin/category-suppliers/feature",
            json=payload,
            headers=headers,
        )
        assert resp.status_code == 200

    rows = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == parent.id,
            CategorySupplier.supplier_id == supplier1.id,
        )
        .all()
    )
    assert len(rows) == 1
    assert rows[0].is_featured is True


def test_feature_upserts_existing_unfeatured_row(client, seeded_db, db):
    """Existing (category, supplier) row with is_featured=False gets flipped."""
    headers = _auth_header(client)
    # seeded_db links supplier1 to child with is_featured=False, rank=1
    child = seeded_db["child"]
    supplier1 = seeded_db["supplier1"]

    resp = client.post(
        "/api/admin/category-suppliers/feature",
        json={
            "supplier_id": str(supplier1.id),
            "category_slug": child.slug,
            "rank": 5,
        },
        headers=headers,
    )
    assert resp.status_code == 200

    row = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == child.id,
            CategorySupplier.supplier_id == supplier1.id,
        )
        .first()
    )
    assert row is not None
    assert row.is_featured is True
    assert row.rank == 5


def test_feature_404s_on_unknown_supplier(client, seeded_db):
    headers = _auth_header(client)
    resp = client.post(
        "/api/admin/category-suppliers/feature",
        json={
            "supplier_id": str(uuid.uuid4()),
            "category_slug": seeded_db["parent"].slug,
        },
        headers=headers,
    )
    assert resp.status_code == 404


def test_feature_404s_on_unknown_category(client, seeded_db):
    headers = _auth_header(client)
    resp = client.post(
        "/api/admin/category-suppliers/feature",
        json={
            "supplier_id": str(seeded_db["supplier1"].id),
            "category_slug": "this-slug-does-not-exist",
        },
        headers=headers,
    )
    assert resp.status_code == 404


def test_feature_404s_on_malformed_uuid(client, seeded_db):
    """Non-UUID supplier_id should 404, not 500."""
    headers = _auth_header(client)
    resp = client.post(
        "/api/admin/category-suppliers/feature",
        json={
            "supplier_id": "not-a-uuid",
            "category_slug": seeded_db["parent"].slug,
        },
        headers=headers,
    )
    assert resp.status_code == 404


def test_feature_requires_auth(client, seeded_db):
    """Without an Authorization header the endpoint rejects."""
    resp = client.post(
        "/api/admin/category-suppliers/feature",
        json={
            "supplier_id": str(seeded_db["supplier1"].id),
            "category_slug": seeded_db["parent"].slug,
        },
    )
    # FastAPI security dependency surfaces 401 or 403 depending on the
    # auth scheme; both are acceptable here. 422 isn't (would mean schema).
    assert resp.status_code in (401, 403)
