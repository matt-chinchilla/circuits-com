"""Migration 014 — Supplier board fields (sponsor tier boards, 2026-06-11).

The Platinum/Gold/Silver boards render four supplier attributes the model
lacked: `contact_role`, `coverage_hours`, and two brand-takeover hex colors.
SQLite ignores `String(N)` at runtime, so the length contract is asserted on
the column METADATA (matching the established `Category.icon` pattern), not a
live insert.
"""

from app.models.supplier import Supplier


def test_supplier_has_board_fields():
    cols = Supplier.__table__.c
    for name in ("contact_role", "coverage_hours", "brand_primary", "brand_secondary"):
        assert name in cols, f"Supplier.{name} column missing"


def test_supplier_contact_role_length():
    # Metadata length contract (SQLite drops VARCHAR(N) — assert on the type, not
    # a runtime insert). 120 chars accommodates a full job title.
    assert Supplier.__table__.c.contact_role.type.length >= 120


def _auth_header(client):
    resp = client.post(
        "/api/auth/login", json={"username": "admin", "password": "testpass123"}
    )
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def test_create_supplier_round_trips_board_fields(client, seeded_db):
    """The admin supplier form writes job title (contact_role) + working hours
    (coverage_hours) so the sponsor boards can render them. The API must accept
    AND return both.

    Regression (2026-06-12): the boards showed blank job title / working hours
    because SupplierCreate dropped the keys (Pydantic ignored the unknown fields)
    and supplier_to_dict never serialized coverage_hours — so the admin could
    never populate them. This guards the full write→read round-trip.
    """
    headers = _auth_header(client)
    resp = client.post(
        "/api/suppliers/",
        json={
            "name": "Board Fields Co",
            "contact_role": "Field Sales Engineer",
            "coverage_hours": "Mon-Fri 8am-6pm ET",
        },
        headers=headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["contact_role"] == "Field Sales Engineer"
    assert data["coverage_hours"] == "Mon-Fri 8am-6pm ET"

    # Re-fetch via the detail route → fields persisted + serialize back out.
    got = client.get(f"/api/suppliers/{data['id']}").json()
    assert got["contact_role"] == "Field Sales Engineer"
    assert got["coverage_hours"] == "Mon-Fri 8am-6pm ET"


def test_update_supplier_sets_board_fields(client, seeded_db):
    headers = _auth_header(client)
    created = client.post(
        "/api/suppliers/", json={"name": "Update Me Inc"}, headers=headers
    ).json()
    assert created["contact_role"] is None
    assert created["coverage_hours"] is None

    resp = client.put(
        f"/api/suppliers/{created['id']}",
        json={
            "contact_role": "Regional Distribution Lead",
            "coverage_hours": "24/7 global support",
        },
        headers=headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["contact_role"] == "Regional Distribution Lead"
    assert data["coverage_hours"] == "24/7 global support"
